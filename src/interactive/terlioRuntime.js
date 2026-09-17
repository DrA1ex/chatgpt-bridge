import { writeSync } from 'node:fs';
import {
  TerminalRenderer,
  ansi,
  clearTextSelection,
  copyTextToClipboard,
  createTerminalPolicy,
  createTextSelectionState,
  mouseReportingSequence,
  requestsPointerReporting,
} from 'terlio.js';
import { config } from '../config.js';
import { captureConsoleLines } from './consoleCapture.js';
import { EXIT_COMMANDS, buildHelpText, normalizeCommand, parseInteractiveRequestCommand } from './commands.js';
import {
  loadInteractiveState,
  saveInteractiveState,
  handleCommand,
  reconcileVisibleProgressSnapshot,
  renderEvent,
  rememberResponse,
} from './runtime.js';
import {
  activityEntryForLine,
  compactActivityLine,
  isUserFacingActivity,
  nextPhaseFromEvent,
  resolvePromptRoute,
  shouldShowDebugEvents,
  splitActivityMessages,
} from './view.js';
import { workflowRunActive } from '../workflow/ux/workflowView.js';
import { prepareInteractiveView } from './terlioView.js';
import {
  createTranscriptScrollState,
  followTranscript,
  resetTranscriptScroll,
  scrollTranscript,
  scrollTranscriptByDelta,
  scrollTranscriptToRatio,
} from './terlioScroll.js';
import {
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
  TerlioInputDecoder,
  isLikelyRawPaste,
} from './terlioInput.js';
import { resolveInteractiveTheme } from './terlioThemes.js';
import { PromptEditor } from './terlioPromptEditor.js';
import {
  activeSuggestions as runtimeActiveSuggestions,
  clearThemePreview as clearRuntimeThemePreview,
  completeInput as completeRuntimeInput,
  handleRuntimeKey,
  markInputTouched as markRuntimeInputTouched,
  resetInputNavigation as resetRuntimeInputNavigation,
  setInputFromHistory as setRuntimeInputFromHistory,
  submitEditor as submitRuntimeEditor,
  suggestionContext as runtimeSuggestionContext,
  syncThemePreview as syncRuntimeThemePreview,
} from './terlioKeyHandling.js';
import { addInputHistoryRecord, inputHistoryScopeKey, readInputHistory, writeInputHistory } from './terlioHistory.js';
import { WorkflowWizardController } from '../workflow/ux/workflowWizard.js';
import { runGuidedWorkflow as executeGuidedWorkflow } from './guidedWorkflowRuntime.js';
import { ApplyWorkflowLiveMonitor } from './applyWorkflowLiveMonitor.js';
import { InteractiveIntelligenceSync } from './intelligenceSync.js';
import { InteractiveStartupTurnRecovery } from './startupTurnRecovery.js';
import { offerWorkflowContinuation, resolveInteractiveStartup } from './startupWorkflow.js';
import { handleConfirmationKey, handleInteractiveInterrupt, handleRequestInterruptKey, handleWorkflowExitKey as handleExitWorkflowKey } from './interruptControl.js';
import { InteractiveWorkflowSurfaceRuntime } from './workflowSurfaceRuntime.js';
import { runInteractiveProjectTurn } from './projectTurnRuntime.js';

const MAX_ACTIVITY_LINES = 6;
const MAX_EVENT_LINES = 10;
const MAX_TRANSCRIPT_ENTRIES = 240;

export class TerlioInteractiveRuntime {
  constructor(options, state) {
    this.options = options;
    this.state = state;
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.terminalPolicy = createTerminalPolicy({ mode: 'safe', clipboard: 'native' });
    this.renderer = new TerminalRenderer({ output: this.output, policy: this.terminalPolicy });
    this.editor = new PromptEditor();
    this.inputDecoder = new TerlioInputDecoder();
    this.inputFlushTimer = null;
    this.renderBatchDepth = 0;
    this.renderPending = false;
    this.entries = [{ id: 'entry-0', kind: 'system', title: 'Ready',
      body: `Plain prompts attach the opened project ZIP. Use /chat to skip it or /task to require a ZIP result. Server: ${config.publicBaseUrl}` }];
    this.eventLines = [];
    this.activityLines = [];
    this.answer = '';
    this.thinking = '';
    this.progress = '';
    this.phase = 'idle';
    this.busy = false;
    this.tick = 0;
    this.suggestionIndex = 0;
    this.completionActive = false;
    this.themePreviewName = '';
    this.interruptPrompt = false;
    this.workflowExitPrompt = null;
    this.workflowWizard = new WorkflowWizardController(this);
    this.workflowSurface = options.zipflowWorkflowRuntime
      ? new InteractiveWorkflowSurfaceRuntime(this, options.zipflowWorkflowRuntime)
      : null;
    this.applyWorkflowLiveMonitor = new ApplyWorkflowLiveMonitor(this);
    this.intelligenceSync = new InteractiveIntelligenceSync(this);
    this.startupTurnRecovery = new InteractiveStartupTurnRecovery(this);
    this.confirmPrompt = '';
    this.confirmResolver = null;
    this.abortController = null;
    this.historyScopeKey = inputHistoryScopeKey(state, options.projectPath || process.cwd());
    this.history = readInputHistory(state, this.historyScopeKey);
    this.historyIndex = null;
    this.historyDraft = null;
    this.historyBrowsing = false;
    this.historyRevision = -1;
    this.inputRevision = 0;
    this.suggestionNavigationActive = false;
    this.suggestionRevision = -1;
    this.activitySummary = [];
    this.lastActivityPrint = { line: '', at: 0 };
    this.entrySequence = 1;
    this.chatProgressState = { records: {} };
    this.detachOnExit = false;
    this.detailsOpen = false;
    this.detailsScroll = createTranscriptScrollState();
    this.transcriptScroll = createTranscriptScrollState();
    this.transcriptSelection = createTextSelectionState();
    this.pointerActive = false;
    this.pointerOverride = null;
    this.streamingEntryId = '';
    this.running = false;
    this.exitCode = 0;
    this.pendingStateSave = Promise.resolve();
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    this.boundData = (data) => this.handleData(data);
    this.boundResize = () => this.handleResize();
    this.statusTimer = null;
    this.unsubscribeLifecycle = () => {};
    this.unsubscribeWorkflowEvents = () => {};
    this.forceExitArmedAt = 0;
    this.context = this.createContext();
  }

  static async create(options) {
    const state = await loadInteractiveState(options.fileStore);
    const useLegacyWorkflows = !options.zipflowWorkflowRuntime;
    const startup = resolveInteractiveStartup({
      projectPath: options.projectPath,
      workflows: useLegacyWorkflows ? options.workflowManager?.list?.() || [] : [],
      state,
      cwd: options.cwd || process.cwd(),
    });
    state.projectRoot = startup.projectRoot;
    state.focusedWorkflowId = useLegacyWorkflows && startup.workflow?.id ? startup.workflow.id : '';
    return new TerlioInteractiveRuntime(options, state);
  }

  start() {
    if (this.running) return this;
    if (!this.input.isTTY || !this.output.isTTY) throw new Error('Interactive mode requires a TTY. Use `bridge workflow run`, `bridge workflow serve`, or `bridge --server` for headless operation.');
    this.running = true;
    this.renderer.reset();
    this.output.write(ansi.altScreen + ansi.hideCursor + ansi.autoWrapOff + BRACKETED_PASTE_ENABLE + ansi.clear + ansi.home);
    this.input.setEncoding?.('utf8');
    this.input.setRawMode?.(true);
    this.input.resume?.();
    this.input.on('data', this.boundData);
    this.output.on?.('resize', this.boundResize);
    this.statusTimer = setInterval(() => {
      this.tick += 1;
      this.invalidate();
    }, 180);
    this.statusTimer.unref?.();
    this.unsubscribeLifecycle = typeof this.options.bridge.onClientLifecycle === 'function'
      ? this.options.bridge.onClientLifecycle(() => {
        this.intelligenceSync.schedule('browser tab connected or changed');
        this.startupTurnRecovery.schedule('browser tab connected or changed');
        this.invalidate();
      })
      : () => {};
    this.intelligenceSync.schedule('interactive startup', { force: true, delayMs: 0 });
    this.startupTurnRecovery.schedule('interactive startup');
    queueMicrotask(() => {
      void offerWorkflowContinuation(this).catch((error) => {
        this.pushEntry({ kind: 'error', title: 'Could not continue the saved workflow', body: error.message || String(error) });
      });
    });
    const workflowEventBus = this.options.zipflowWorkflowRuntime ? null : this.options.workflowManager?.eventBus;
    if (workflowEventBus?.on) {
      const listener = (event) => {
        if (['workflow.started', 'workflow.loaded'].includes(String(event?.type || ''))) {
          this.intelligenceSync.schedule(event.type, { force: true });
        }
        if (this.applyWorkflowLiveMonitor.handle(event)) return;
        const workflowId = String(event?.data?.workflowId || '');
        if (!workflowId) return;
        const workflow = this.options.workflowManager.get(workflowId);
        if (!workflow?.nextAction) return;
        void this.workflowWizard.openForWorkflow(workflowId).catch((error) => {
          this.pushEntry({ kind: 'error', title: 'Workflow attention failed', body: error.message });
        });
      };
      workflowEventBus.on('event', listener);
      this.unsubscribeWorkflowEvents = () => workflowEventBus.off('event', listener);
    }
    this.invalidate();
    return this;
  }

  async saveState() {
    await saveInteractiveState(this.state);
  }

  async waitUntilExit() {
    return this.exitPromise;
  }

  stop({ code = 0 } = {}) {
    if (!this.running) return;
    this.running = false;
    this.exitCode = code;
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.inputFlushTimer) clearTimeout(this.inputFlushTimer);
    this.inputFlushTimer = null;
    this.statusTimer = null;
    this.unsubscribeLifecycle?.();
    this.unsubscribeLifecycle = () => {};
    this.unsubscribeWorkflowEvents?.();
    this.unsubscribeWorkflowEvents = () => {};
    this.intelligenceSync.close();
    this.startupTurnRecovery.close();
    this.workflowSurface?.closeRuntime();
    this.input.off('data', this.boundData);
    this.output.off?.('resize', this.boundResize);
    this.pointerActive = false;
    if (this.input.isTTY) this.input.setRawMode?.(false);
    this.input.pause?.();
    this.renderer.reset();
    writeTerminalRestore(this.output,
      mouseReportingSequence(false, { drag: true, motion: false })
      + BRACKETED_PASTE_DISABLE
      + ansi.autoWrapOn
      + ansi.showCursor
      + ansi.normalScreen
      + ansi.reset
      + '\n');
    const resolveExit = this.resolveExit;
    this.resolveExit = null;
    Promise.resolve(this.pendingStateSave)
      .catch(() => {})
      .finally(() => resolveExit?.({ code, preserveActiveWork: this.detachOnExit }));
  }

  exit(code = 0, { preserveActiveWork = this.detachOnExit } = {}) {
    this.detachOnExit = Boolean(preserveActiveWork);
    this.stop({ code });
  }

  handleResize() {
    if (!this.running) return;
    this.renderer.reset();
    this.output.write(ansi.clear + ansi.home);
    this.invalidate();
  }

  invalidate() {
    if (!this.running) return;
    if (this.renderBatchDepth > 0) {
      this.renderPending = true;
      return false;
    }
    this.renderPending = false;
    const width = Math.max(40, Number(this.output.columns) || 100);
    const height = Math.max(18, Number(this.output.rows) || 34);
    const workflows = this.options.zipflowWorkflowRuntime ? [] : this.options.workflowManager?.list?.() || [];
    const workflow = workflows.find((item) => workflowRunActive(item))
      || workflows.find((item) => item.lifecycle === 'ready' && item.execution?.subscription?.enabled)
      || workflows[0]
      || null;
    const workflowActivity = workflow ? this.applyWorkflowLiveMonitor.activityFor(workflow) : null;
    const prepared = prepareInteractiveView({
      state: this.state,
      health: this.options.bridge.health(),
      workflow,
      workflowActivity,
      editor: this.editor,
      entries: this.entries,
      eventLines: this.eventLines,
      activityLines: this.activityLines,
      answer: this.answer,
      thinking: this.thinking,
      progress: this.progress,
      phase: this.phase,
      busy: this.busy,
      tick: this.tick,
      suggestionIndex: this.suggestionIndex,
      completionActive: this.completionActive,
      theme: resolveInteractiveTheme(this.themePreviewName || this.state.themeName),
      themePreviewName: this.themePreviewName,
      interruptPrompt: this.interruptPrompt,
      workflowExitPrompt: this.workflowExitPrompt,
      workflowWizard: this.workflowWizard.model(),
      workflowSurface: this.workflowSurface?.model() || null,
      confirmPrompt: this.confirmPrompt,
      detailsOpen: this.detailsOpen,
      transcriptScroll: this.transcriptScroll,
      detailsScroll: this.detailsScroll,
      transcriptSelection: this.transcriptSelection,
      onTranscriptSelectionChange: () => this.invalidate(),
      onTranscriptCopy: (text) => this.copyTranscriptSelection(text),
      onTranscriptWheel: (event) => this.handleTranscriptWheel(event),
      onTranscriptPointer: (event) => this.handleTranscriptPointer(event),
      onDetailsWheel: (event) => this.handleDetailsWheel(event),
      onDetailsPointer: (event) => this.handleDetailsPointer(event),
    }, { width, height });
    this.transcriptScroll = prepared.transcript;
    this.detailsScroll = prepared.details || this.detailsScroll;
    this.renderer.renderNode(prepared.node, { width, height });
    this.syncPointerMode();
    return true;
  }

  withRenderBatch(callback) {
    this.renderBatchDepth += 1;
    try {
      return callback();
    } finally {
      this.renderBatchDepth = Math.max(0, this.renderBatchDepth - 1);
      if (this.renderBatchDepth === 0 && this.renderPending) this.invalidate();
    }
  }

  createContext() {
    return {
      bridge: this.options.bridge,
      fileStore: this.options.fileStore,
      state: this.state,
      projectService: this.options.projectService,
      turnManager: this.options.turnManager,
      workflowManager: this.options.workflowManager,
      zipflowWorkflowRuntime: this.options.zipflowWorkflowRuntime,
      zipflowMigrationRuntime: this.options.zipflowMigrationRuntime,
      workflowBackendRouter: this.options.workflowBackendRouter,
      createConsoleStream: (label = 'Working') => this.createConsoleStream(label),
      captureConsoleForStream: true,
      confirm: async (question) => new Promise((resolve) => {
        this.confirmResolver = resolve;
        this.confirmPrompt = String(question || 'Confirm? [y/N]');
        this.invalidate();
      }),
      openWorkflowWizard: async (options = {}) => await this.workflowWizard.open(options),
      openWorkflowSurface: async (options = {}) => {
        if (!this.workflowSurface) throw new Error('Workflow service is not available');
        return await this.workflowSurface.open(options);
      },
    };
  }

  createConsoleStream(label = 'Working') {
    let printedAnswer = '';
    let printedThinking = '';
    this.pushEventLine(`[command] ${label}`);
    return {
      status: (line) => {
        if (!line) return;
        this.pushEventLine(line);
        this.pushActivityLine(line);
      },
      onThinkingUpdate: (text) => {
        const value = String(text || '');
        if (value === printedThinking) return;
        printedThinking = value;
        this.thinking = value;
        this.invalidate();
      },
      onProgressUpdate: (text) => {
        this.progress = String(text || '');
        this.invalidate();
      },
      onAnswerUpdate: (text) => {
        const value = String(text || '');
        if (value === printedAnswer) return;
        printedAnswer = value;
        this.updateAssistantStream(value);
      },
      onArtifactUpdate: (artifacts = []) => {
        if (!artifacts.length) return;
        const line = `[artifact] discovered ${artifacts.length}`;
        this.pushEventLine(line);
        this.pushActivityLine(line);
      },
      finish: (finalAnswer = '') => {
        const text = String(finalAnswer || printedAnswer || '').trim();
        this.flushActivitySummary();
        if (text || this.streamingEntryId) this.completeAssistantStream(text || '(empty answer)');
        else this.pushEventLine('[answer] empty final answer');
        this.clearLive();
      },
      fail: () => {
        this.failAssistantStream('Assistant · interrupted');
        this.clearLive();
        this.flushActivitySummary();
      },
    };
  }

  handleData(data) {
    if (!this.running) return;
    return this.withRenderBatch(() => {
      if (this.inputFlushTimer) clearTimeout(this.inputFlushTimer);
      this.inputFlushTimer = null;
      if (isLikelyRawPaste(data)) {
        this.dispatchKey({ name: 'paste', text: Buffer.isBuffer(data) ? data.toString('utf8') : String(data || ''), printable: false, sequence: '' });
        return;
      }
      const keys = this.inputDecoder.feed(data);
      for (const key of keys) {
        if (key?.type === 'pointer') this.handlePointer(key);
        else this.dispatchKey(key);
      }
      if (this.inputDecoder.hasPending()) {
        this.inputFlushTimer = setTimeout(() => {
          this.inputFlushTimer = null;
          this.withRenderBatch(() => {
            for (const key of this.inputDecoder.flush()) {
              if (key?.type === 'pointer') this.handlePointer(key);
              else this.dispatchKey(key);
            }
          });
        }, 45);
        this.inputFlushTimer.unref?.();
      }
    });
  }

  handlePointer(pointer) {
    return this.withRenderBatch(() => {
      const routed = this.renderer.dispatchPointer(pointer, {
        pointer,
        runtime: this,
        state: this.state,
      });
      if (routed.event?.handled) this.invalidate();
      return routed.event;
    });
  }

  syncPointerMode() {
    if (!this.running) return false;
    const automatic = requestsPointerReporting(this.renderer.pointerRegions);
    const enabled = this.pointerOverride === null ? automatic : this.pointerOverride;
    return this.setPointerActive(enabled);
  }

  setPointerActive(enabled) {
    const next = Boolean(enabled);
    if (next === this.pointerActive) return false;
    this.pointerActive = next;
    this.output.write(mouseReportingSequence(next, { drag: true, motion: false }));
    return true;
  }

  togglePointerOverride() {
    const automatic = requestsPointerReporting(this.renderer.pointerRegions);
    this.pointerOverride = this.pointerOverride === null ? !automatic : null;
    this.syncPointerMode();
    return this.invalidate();
  }

  handleTranscriptWheel(event) {
    const step = Math.max(1, Math.abs(Number(event?.deltaY) || 1) * 3);
    const delta = Number(event?.deltaY) < 0 ? -step : step;
    this.transcriptScroll = scrollTranscriptByDelta(this.transcriptScroll, delta);
    event?.preventDefault?.();
    return true;
  }

  handleTranscriptPointer(event) {
    if (!event || (event.action !== 'click' && event.action !== 'drag')) return false;
    const bounds = event.currentTarget?.bounds || event.target?.bounds || {};
    const localX = Number(event.localX);
    const localY = Number(event.localY);
    const width = Math.max(1, Number(bounds.width) || 1);
    const height = Math.max(3, Number(bounds.height) || this.transcriptScroll.visibleRows + 2);
    if (!Number.isFinite(localX) || localX < width - 3) return false;
    const ratio = Math.max(0, Math.min(1, (localY - 1) / Math.max(1, height - 3)));
    this.transcriptScroll = scrollTranscriptToRatio(this.transcriptScroll, ratio);
    if (event.action === 'drag') event.capturePointer?.();
    event.preventDefault?.();
    return true;
  }

  handleDetailsWheel(event) {
    const step = Math.max(1, Math.abs(Number(event?.deltaY) || 1) * 3);
    const delta = Number(event?.deltaY) < 0 ? -step : step;
    this.detailsScroll = scrollTranscriptByDelta(this.detailsScroll, delta);
    event?.preventDefault?.();
    return true;
  }

  handleDetailsPointer(event) {
    if (!event || (event.action !== 'click' && event.action !== 'drag')) return false;
    const bounds = event.currentTarget?.bounds || event.target?.bounds || {};
    const localX = Number(event.localX);
    const localY = Number(event.localY);
    const width = Math.max(1, Number(bounds.width) || 1);
    const height = Math.max(3, Number(bounds.height) || this.detailsScroll.visibleRows + 2);
    if (!Number.isFinite(localX) || localX < width - 3) return false;
    const ratio = Math.max(0, Math.min(1, (localY - 1) / Math.max(1, height - 3)));
    this.detailsScroll = scrollTranscriptToRatio(this.detailsScroll, ratio);
    if (event.action === 'drag') event.capturePointer?.();
    event.preventDefault?.();
    return true;
  }

  dispatchKey(key) {
    void this.handleKey(key).catch((err) => {
      this.pushEntry({ kind: 'error', title: 'Input failed', body: err.message });
    });
  }

  async handleKey(key) {
    return handleRuntimeKey(this, key);
  }

  handleWorkflowWizardKey(key) {
    return this.workflowWizard.handleKey(key);
  }

  handleWorkflowSurfaceKey(key) {
    return this.workflowSurface.handleKey(key);
  }

  handleConfirmKey(key, text) { return handleConfirmationKey(this, key, text); }

  handleWorkflowExitKey(key, text) { return handleExitWorkflowKey(this, key, text); }

  handleInterruptKey(key, text) { return handleRequestInterruptKey(this, key, text); }

  handleInterrupt() { return handleInteractiveInterrupt(this); }

  scrollVisiblePane(keyName) {
    if (this.detailsOpen) this.detailsScroll = scrollTranscript(this.detailsScroll, keyName, { lineStep: 1 });
    else this.transcriptScroll = scrollTranscript(this.transcriptScroll, keyName, { lineStep: 1 });
    this.invalidate();
  }

  scrollChat(keyName) {
    return this.scrollVisiblePane(keyName);
  }

  followChat() {
    this.transcriptScroll = followTranscript(this.transcriptScroll);
  }

  activeSuggestions() {
    return runtimeActiveSuggestions(this);
  }

  suggestionContext() {
    return runtimeSuggestionContext(this);
  }

  completeInput() {
    return completeRuntimeInput(this);
  }

  submitEditor() {
    return submitRuntimeEditor(this);
  }

  setInputFromHistory(record) {
    return setRuntimeInputFromHistory(this, record);
  }

  markInputTouched(options = {}) {
    return markRuntimeInputTouched(this, options);
  }

  resetInputNavigation(options = {}) {
    return resetRuntimeInputNavigation(this, options);
  }

  syncThemePreview() {
    return syncRuntimeThemePreview(this);
  }

  clearThemePreview() {
    return clearRuntimeThemePreview(this);
  }

  shouldNavigateSuggestions() {
    if (!this.completionActive || !String(this.editor.value || '').trimStart().startsWith('/')) return false;
    if (!this.suggestionNavigationActive) return true;
    return this.suggestionRevision === this.inputRevision;
  }

  editorContentWidth() {
    return Math.max(4, (Number(this.output.columns) || 100) - 4);
  }

  ensureHistoryScope() {
    const next = inputHistoryScopeKey(this.state, this.options.projectPath || process.cwd());
    if (next === this.historyScopeKey) return this.history;
    writeInputHistory(this.state, this.historyScopeKey, this.history);
    this.historyScopeKey = next;
    this.history = readInputHistory(this.state, next);
    this.historyIndex = null;
    this.historyDraft = null;
    this.historyBrowsing = false;
    return this.history;
  }

  rememberEditorDraft() {
    const record = this.editor.serialize?.() || { text: this.editor.value, pastes: [] };
    return this.rememberInputRecord(record);
  }

  rememberInputRecord(record) {
    this.ensureHistoryScope();
    this.history = addInputHistoryRecord(this.history, record);
    writeInputHistory(this.state, this.historyScopeKey, this.history);
    this.queueStateSave();
    return record;
  }

  queueStateSave() {
    this.pendingStateSave = Promise.resolve(this.pendingStateSave)
      .catch(() => {})
      .then(() => saveInteractiveState(this.state));
    return this.pendingStateSave;
  }

  copyTranscriptSelection(text = this.transcriptSelection?.text) {
    const value = String(text || '');
    if (!value) return false;
    const result = copyTextToClipboard(value, { output: this.output, clipboardPolicy: 'native' });
    if (result.copied) clearTextSelection(this.transcriptSelection);
    this.pushActivityLine(result.copied
      ? `[clipboard] copied ${Array.from(value).length} characters`
      : '[clipboard] selection is ready but clipboard transfer failed');
    this.invalidate();
    return result;
  }

  async submitLine(line, { historyRecord = null } = {}) {
    const raw = String(line || '');
    const command = raw.trim();
    if (!command) return;
    this.followChat();
    this.rememberInputRecord(historyRecord || { text: raw, pastes: [] });
    this.resetInputNavigation();

    if (EXIT_COMMANDS.has(command.toLowerCase())) return this.exit();
    if (command === '/clear') return this.clearTranscript();
    if (command === '/help') return this.pushEntry({ kind: 'system', title: 'Help', body: buildHelpText() });
    if (command === '/stop') return this.stopActiveRequest();

    const requestCommand = parseInteractiveRequestCommand(command);
    if (requestCommand) {
      if (this.busy) {
        return this.pushEntry({
          kind: 'system',
          title: 'Request already running',
          body: 'Use /stop or Ctrl+C to cancel before sending another prompt.',
        });
      }
      if (!requestCommand.prompt) {
        const direct = requestCommand.kind === 'chat';
        return this.pushEntry({
          kind: 'system',
          title: direct ? 'Usage: /chat <text>' : 'Usage: /task <prompt>',
          body: direct
            ? 'Send a direct ChatGPT prompt without attaching the project ZIP.'
            : 'Run a project edit turn that requires a complete ZIP result.',
        });
      }
      if (requestCommand.kind === 'chat') return this.runChat(requestCommand.prompt);
      return this.runProjectTurn(requestCommand.prompt, { requireZip: true });
    }

    if (command.startsWith('/')) return this.runCommand(command);
    if (this.busy) return this.pushEntry({ kind: 'system', title: 'Request already running', body: 'Use /stop or Ctrl+C to cancel before sending another prompt.' });
    const route = resolvePromptRoute(this.state, this.options, raw);
    if (route.kind === 'legacy-guided') return this.runGuidedWorkflow(raw, route.workflow);
    if (route.kind === 'project-chat') return this.runProjectChat(raw);
    return this.runChat(raw);
  }

  async stopActiveRequest() {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort('Cancelled by /stop');
      return this.pushEntry({ kind: 'system', title: 'Cancelling', body: 'Active request cancellation requested.' });
    }
    const output = await captureConsoleLines(() => handleCommand('/stop', this.context), (line) => this.pushEventLine(line));
    this.pushEntry({ kind: 'command', title: '/stop', body: output || 'No active request.' });
  }

  async runCommand(message) {
    const normalized = normalizeCommand(message);
    this.busy = true;
    this.phase = 'running command';
    this.invalidate();
    try {
      this.pushEventLine(`[command] ${normalized}`);
      const output = await captureConsoleLines(async () => {
        const handled = await handleCommand(normalized, this.context);
        if (!handled) throw new Error(`Unknown command: ${normalized}. Type /help to see available commands.`);
        await saveInteractiveState(this.state).catch(() => {});
      }, (line) => this.pushEventLine(line));
      this.pushEntry({ kind: 'command', title: normalized === message ? message : `${message}  →  ${normalized}`, body: output || 'OK' });
      if (/^\/(?:model|effort|tab|session)(?:\s|$)/i.test(normalized)) {
        await this.intelligenceSync.sync('interactive tab, session, model, or effort setting changed', { force: true });
      }
    } catch (err) {
      this.pushEntry({ kind: 'error', title: message, body: err.message });
    } finally {
      this.clearThemePreview();
      this.ensureHistoryScope();
      this.busy = false;
      this.phase = 'idle';
      this.invalidate();
    }
  }

  async runProjectChat(message) {
    return runInteractiveProjectTurn(this, message, { requireZip: false });
  }

  async runProjectTurn(message, options = {}) {
    return runInteractiveProjectTurn(this, message, options);
  }

  async runGuidedWorkflow(message, workflow) {
    return await executeGuidedWorkflow(this, message, workflow);
  }

  async runChat(message) {
    if (!this.options.bridge.health().ok && !this.options.bridge.canAutoOpenPromptTab?.()) {
      return this.pushEntry({ kind: 'error', title: 'Not connected', body: 'No ChatGPT browser extension is connected. Use /connect, or restart with --auto-open-tab.' });
    }
    const attachments = this.state.pendingAttachments.map((file) => file.id);
    const controller = new AbortController();
    this.abortController = controller;
    this.busy = true;
    this.phase = 'starting';
    this.clearLive();
    this.resetActivity();
    this.chatProgressState = { records: {} };
    this.pushEntry({
      kind: 'user',
      title: 'You',
      subtitle: attachments.length ? `files: ${this.state.pendingAttachments.map((file) => file.name).join(', ')}` : '',
      body: message,
    });
    try {
      const response = await this.options.bridge.sendRequest({
        message,
        sessionId: this.state.sessionId,
        model: this.state.model,
        effort: this.state.effort,
        attachments,
      }, {
        onEvent: (event) => this.onChatEvent(event),
        onThinkingUpdate: (text) => { this.thinking = text || ''; this.invalidate(); },
        onProgressUpdate: (text) => { this.progress = text || ''; this.invalidate(); },
        onAnswerUpdate: (text) => this.updateAssistantStream(text || ''),
        onArtifactUpdate: (artifacts) => this.onArtifactUpdate(artifacts),
      }, {
        signal: controller.signal,
        fullResponse: true,
        confirmClientSelection: ({ message: question }) => this.context.confirm(question),
      });
      if (response.session?.id) this.state.sessionId = response.session.id;
      if (Array.isArray(response.artifacts) && response.artifacts.length) this.state.lastArtifacts = response.artifacts;
      this.state.pendingAttachments = [];
      const finalAnswer = String(response.answer || response.response || '');
      rememberResponse(this.state, {
        id: response.requestId || response.id || '',
        source: 'chat',
        title: 'Assistant answer',
        text: finalAnswer,
        artifactCount: Array.isArray(response.artifacts) ? response.artifacts.length : 0,
        createdAt: response.createdAt,
      });
      this.flushActivitySummary();
      this.completeAssistantStream(finalAnswer || '(empty answer)');
      this.clearLive();
      if (response.artifacts?.length) {
        this.pushEntry({
          kind: 'artifact',
          title: `Artifacts (${response.artifacts.length})`,
          body: response.artifacts.map((artifact, index) => `[${index + 1}] ${artifact.name || artifact.filename || artifact.id || 'artifact'}`).join('\n'),
        });
      }
      await saveInteractiveState(this.state).catch(() => {});
    } catch (err) {
      this.failAssistantStream('Assistant · interrupted');
      this.flushActivitySummary();
      this.pushEntry({ kind: 'error', title: 'Request failed', body: err.message });
      this.pushEventLine('Queued attachments were kept for retry. Use /file clear to clear them.');
      await saveInteractiveState(this.state).catch(() => {});
    } finally {
      this.abortController = null;
      this.busy = false;
      this.phase = 'idle';
      this.invalidate();
    }
  }

  onChatEvent(event) {
    this.phase = nextPhaseFromEvent(event, this.phase);
    if (event?.type === 'assistant.progress.snapshot') {
      const reconciled = reconcileVisibleProgressSnapshot(event, this.chatProgressState);
      this.chatProgressState = reconciled.state;
      this.progress = reconciled.liveText;
      for (const completedLine of reconciled.completedLines) {
        this.pushEventLine(completedLine);
        this.pushActivityLine(completedLine);
      }
      return this.invalidate();
    }
    const line = renderEvent(event, this.state.eventLevel);
    if (line) {
      this.pushEventLine(line);
      this.pushActivityLine(line);
    }
    this.invalidate();
  }

  onArtifactUpdate(artifacts = []) {
    this.state.lastArtifacts = artifacts;
    if (artifacts?.length) {
      const line = `[artifact] discovered ${artifacts.length}`;
      this.pushEventLine(line);
      this.pushActivityLine(line);
    }
  }

  beginAssistantStream() {
    const existing = this.entries.find((entry) => entry.id === this.streamingEntryId);
    if (existing) return existing;
    const entry = this.pushEntry({ kind: 'assistant', title: 'Assistant · streaming', body: '', streaming: true });
    this.streamingEntryId = entry.id;
    return entry;
  }

  updateAssistantStream(text = '') {
    const value = String(text || '');
    clearTextSelection(this.transcriptSelection);
    const entry = this.beginAssistantStream();
    this.answer = value;
    this.entries = this.entries.map((item) => item.id === entry.id
      ? { ...item, body: value, title: 'Assistant · streaming', streaming: true }
      : item);
    this.invalidate();
    return entry;
  }

  completeAssistantStream(text = '') {
    const value = String(text || '');
    clearTextSelection(this.transcriptSelection);
    const existing = this.entries.find((entry) => entry.id === this.streamingEntryId);
    if (!existing) {
      const entry = this.pushEntry({ kind: 'assistant', title: 'Assistant', body: value, streaming: false });
      this.streamingEntryId = '';
      this.answer = '';
      return entry;
    }
    this.entries = this.entries.map((item) => item.id === existing.id
      ? { ...item, body: value || item.body || '(empty answer)', title: 'Assistant', streaming: false }
      : item);
    this.streamingEntryId = '';
    this.answer = '';
    this.invalidate();
    return existing;
  }

  failAssistantStream(title = 'Assistant · interrupted') {
    clearTextSelection(this.transcriptSelection);
    const existing = this.entries.find((entry) => entry.id === this.streamingEntryId);
    if (!existing) return null;
    this.entries = this.entries.map((item) => item.id === existing.id
      ? { ...item, title, streaming: false }
      : item);
    this.streamingEntryId = '';
    this.answer = '';
    this.invalidate();
    return existing;
  }

  pushEntry(entry) {
    const id = `entry-${this.entrySequence++}`;
    const created = { id, time: new Date().toISOString(), ...entry };
    this.entries = [...this.entries, created].slice(-MAX_TRANSCRIPT_ENTRIES);
    clearTextSelection(this.transcriptSelection);
    this.invalidate();
    return created;
  }

  clearTranscript() {
    const id = `entry-${this.entrySequence++}`;
    this.entries = [{ id, time: new Date().toISOString(), kind: 'system', title: 'Cleared', body: 'Transcript cleared.' }];
    this.eventLines = [];
    this.activityLines = [];
    this.activitySummary = [];
    this.lastActivityPrint = { line: '', at: 0 };
    this.transcriptScroll = resetTranscriptScroll();
    clearTextSelection(this.transcriptSelection);
    this.streamingEntryId = '';
    this.applyWorkflowLiveMonitor.clear();
    this.clearLive();
    this.renderer.reset();
    this.output.write(ansi.clear + ansi.home);
    this.invalidate();
  }

  pushEventLine(line = '') {
    const text = String(line).trimEnd();
    if (!text) return;
    this.eventLines = [...this.eventLines, ...text.split('\n').filter(Boolean)].slice(-MAX_EVENT_LINES);
    this.invalidate();
  }

  pushActivityLine(line = '') {
    const items = splitActivityMessages(line).map(compactActivityLine).filter(isUserFacingActivity);
    if (!items.length) return;
    if (shouldShowDebugEvents(this.state)) {
      this.activityLines = [...this.activityLines, ...items].slice(-MAX_ACTIVITY_LINES);
      for (const item of items) {
        if (this.activitySummary.at(-1) === item) continue;
        this.activitySummary = [...this.activitySummary, item].slice(-12);
      }
      return this.invalidate();
    }
    const now = Date.now();
    for (const item of items) {
      if (this.lastActivityPrint.line === item && now - this.lastActivityPrint.at < 1_500) continue;
      this.lastActivityPrint = { line: item, at: now };
      const entry = activityEntryForLine(item);
      if (entry) this.pushEntry(entry);
    }
  }

  resetActivity() {
    this.activitySummary = [];
    this.lastActivityPrint = { line: '', at: 0 };
    this.activityLines = [];
    this.eventLines = [];
    this.invalidate();
  }

  flushActivitySummary(title = 'Task activity') {
    if (!shouldShowDebugEvents(this.state)) {
      this.activitySummary = [];
      return;
    }
    if (!this.activitySummary.length) return;
    this.pushEntry({ kind: 'system', title, body: this.activitySummary.join('\n') });
    this.activitySummary = [];
  }

  clearLive() {
    this.thinking = '';
    this.progress = '';
    this.answer = '';
    this.invalidate();
  }
}

function writeTerminalRestore(output, sequence) {
  if (Number.isInteger(output?.fd)) {
    try {
      writeSync(output.fd, sequence);
      return;
    } catch {
      // Fall back to the configured output stream for tests and wrapped TTYs.
    }
  }
  output?.write?.(sequence);
}

export async function runTerlioInteractive(options) {
  const runtime = await TerlioInteractiveRuntime.create(options);
  runtime.start();
  return runtime.waitUntilExit();
}
