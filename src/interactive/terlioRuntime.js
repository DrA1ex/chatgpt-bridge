import {
  InputEditor,
  TerminalRenderer,
  ansi,
} from 'terlio.js';
import { config } from '../config.js';
import { captureConsoleLines } from './consoleCapture.js';
import {
  EXIT_COMMANDS,
  buildHelpText,
  commandSuggestions,
  completeCommand,
  normalizeCommand,
  shouldCompleteSlashCommand,
} from './commands.js';
import {
  loadInteractiveState,
  saveInteractiveState,
  handleCommand,
  reconcileVisibleProgressSnapshot,
  renderEvent,
  rememberResponse,
  runProjectTask,
} from './runtime.js';
import {
  activityEntryForLine,
  compactActivityLine,
  isUserFacingActivity,
  nextPhaseFromEvent,
  shouldNavigateCommandSuggestions,
  shouldRouteToProjectTask,
  shouldShowDebugEvents,
  splitActivityMessages,
} from './view.js';
import { workflowHasBlockingAction, workflowRunActive } from '../workflow/ux/workflowView.js';
import { prepareInteractiveView } from './terlioView.js';
import {
  createTranscriptScrollState,
  followTranscript,
  resetTranscriptScroll,
  scrollTranscript,
} from './terlioScroll.js';
import { TerlioInputDecoder, applyTerlioEditorKey } from './terlioInput.js';

const MAX_ACTIVITY_LINES = 6;
const MAX_EVENT_LINES = 10;
const MAX_TRANSCRIPT_ENTRIES = 240;

export class TerlioInteractiveRuntime {
  constructor(options, state) {
    this.options = options;
    this.state = state;
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.renderer = new TerminalRenderer({ output: this.output });
    this.editor = new InputEditor();
    this.inputDecoder = new TerlioInputDecoder();
    this.inputFlushTimer = null;
    this.entries = [{ id: 'entry-0', kind: 'system', title: 'Ready', body: `Type a prompt directly, or use /help. Server: ${config.publicBaseUrl}` }];
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
    this.interruptPrompt = false;
    this.workflowExitPrompt = null;
    this.confirmPrompt = '';
    this.confirmResolver = null;
    this.abortController = null;
    this.history = [];
    this.historyIndex = null;
    this.historyDraft = null;
    this.historyBrowsing = false;
    this.activitySummary = [];
    this.lastActivityPrint = { line: '', at: 0 };
    this.entrySequence = 1;
    this.chatProgressState = { records: {} };
    this.detachOnExit = false;
    this.detailsOpen = false;
    this.transcriptScroll = createTranscriptScrollState();
    this.running = false;
    this.exitCode = 0;
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    this.boundData = (data) => this.handleData(data);
    this.boundResize = () => this.handleResize();
    this.statusTimer = null;
    this.unsubscribeLifecycle = () => {};
    this.forceExitArmedAt = 0;
    this.context = this.createContext();
  }

  static async create(options) {
    const state = await loadInteractiveState(options.fileStore);
    if (options.projectPath) state.projectRoot = options.projectPath;
    return new TerlioInteractiveRuntime(options, state);
  }

  start() {
    if (this.running) return this;
    if (!this.input.isTTY || !this.output.isTTY) throw new Error('Interactive mode requires a TTY. Use `bridge workflow run`, `bridge workflow serve`, or `bridge --server` for headless operation.');
    this.running = true;
    this.output.write(ansi.altScreen + ansi.hideCursor + ansi.clear + ansi.home);
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
      ? this.options.bridge.onClientLifecycle(() => this.invalidate())
      : () => {};
    this.invalidate();
    return this;
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
    this.input.off('data', this.boundData);
    this.output.off?.('resize', this.boundResize);
    if (this.input.isTTY) this.input.setRawMode?.(false);
    this.input.pause?.();
    this.renderer.reset();
    this.output.write(ansi.showCursor + ansi.normalScreen + ansi.reset + '\n');
    this.resolveExit?.({ code, preserveActiveWork: this.detachOnExit });
    this.resolveExit = null;
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
    const width = Math.max(40, Number(this.output.columns) || 100);
    const height = Math.max(18, Number(this.output.rows) || 34);
    const workflows = this.options.workflowManager?.list?.() || [];
    const workflow = workflows.find((item) => workflowRunActive(item)) || workflows[0] || null;
    const prepared = prepareInteractiveView({
      state: this.state,
      health: this.options.bridge.health(),
      workflow,
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
      interruptPrompt: this.interruptPrompt,
      workflowExitPrompt: this.workflowExitPrompt,
      confirmPrompt: this.confirmPrompt,
      detailsOpen: this.detailsOpen,
      transcriptScroll: this.transcriptScroll,
    }, { width, height });
    this.transcriptScroll = prepared.transcript;
    this.renderer.renderNode(prepared.node, { width, height });
  }

  createContext() {
    return {
      bridge: this.options.bridge,
      fileStore: this.options.fileStore,
      state: this.state,
      projectService: this.options.projectService,
      turnManager: this.options.turnManager,
      workflowManager: this.options.workflowManager,
      createConsoleStream: (label = 'Working') => this.createConsoleStream(label),
      captureConsoleForStream: true,
      confirm: async (question) => new Promise((resolve) => {
        this.confirmResolver = resolve;
        this.confirmPrompt = String(question || 'Confirm? [y/N]');
        this.invalidate();
      }),
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
        this.answer = value;
        this.invalidate();
      },
      onArtifactUpdate: (artifacts = []) => {
        if (!artifacts.length) return;
        const line = `[artifact] discovered ${artifacts.length}`;
        this.pushEventLine(line);
        this.pushActivityLine(line);
      },
      finish: (finalAnswer = '') => {
        const text = String(finalAnswer || printedAnswer || '').trim();
        this.clearLive();
        this.flushActivitySummary();
        if (text) this.pushEntry({ kind: 'assistant', title: 'Assistant', body: text });
        else this.pushEventLine('[answer] empty final answer');
      },
      fail: () => {
        this.clearLive();
        this.flushActivitySummary();
      },
    };
  }

  handleData(data) {
    if (!this.running) return;
    if (this.inputFlushTimer) clearTimeout(this.inputFlushTimer);
    this.inputFlushTimer = null;
    const keys = this.inputDecoder.feed(data);
    for (const key of keys) this.dispatchKey(key);
    if (this.inputDecoder.hasPending()) {
      this.inputFlushTimer = setTimeout(() => {
        this.inputFlushTimer = null;
        for (const key of this.inputDecoder.flush()) this.dispatchKey(key);
      }, 45);
      this.inputFlushTimer.unref?.();
    }
  }

  dispatchKey(key) {
    void this.handleKey(key).catch((err) => {
      this.pushEntry({ kind: 'error', title: 'Input failed', body: err.message });
    });
  }

  async handleKey(key) {
    const text = key.text || (key.printable ? key.sequence : '');

    if (this.confirmPrompt) return this.handleConfirmKey(key, text);
    if (this.workflowExitPrompt) return this.handleWorkflowExitKey(key, text);
    if (this.interruptPrompt) return this.handleInterruptKey(key, text);

    if (key.name === 'ctrl-c') return this.handleInterrupt();
    if (key.ctrl && key.name === 'b') {
      this.detailsOpen = !this.detailsOpen;
      return this.invalidate();
    }
    if (key.name === 'page-up' || key.name === 'page-down') return this.scrollChat(key.name);
    if ((key.shift || key.meta) && (key.name === 'up' || key.name === 'down')) return this.scrollChat(key.name);
    if (key.ctrl && (key.name === 'home' || key.name === 'end')) return this.scrollChat(key.name);
    if (key.name === 'ctrl-d') {
      if (this.editor.value) this.editor.deleteForward();
      else this.exit(0);
      return this.invalidate();
    }
    if (key.name === 'redraw') return this.clearTranscript();
    if (key.name === 'escape') {
      this.editor.clear();
      this.resetInputNavigation();
      return this.invalidate();
    }
    if (key.name === 'tab') return this.completeInput();
    if (key.name === 'enter' && !key.shift && !key.ctrl) return this.submitEditor();
    if (key.name === 'enter' && (key.shift || key.ctrl)) {
      this.markInputTouched();
      this.editor.insertLineBreak();
      return this.invalidate();
    }
    if (key.name === 'up') return this.navigateUp();
    if (key.name === 'down') return this.navigateDown();

    const result = applyTerlioEditorKey(this.editor, key, { multiline: false });
    if (result.handled) {
      this.markInputTouched();
      this.suggestionIndex = 0;
      this.invalidate();
    }
  }

  handleConfirmKey(key, text) {
    if (key.name === 'escape' || key.name === 'enter' || /^n$/i.test(text)) {
      const resolver = this.confirmResolver;
      this.confirmResolver = null;
      this.confirmPrompt = '';
      resolver?.(false);
      return this.invalidate();
    }
    if (/^y$/i.test(text)) {
      const resolver = this.confirmResolver;
      this.confirmResolver = null;
      this.confirmPrompt = '';
      resolver?.(true);
      return this.invalidate();
    }
  }

  handleWorkflowExitKey(key, text) {
    if (key.name === 'ctrl-c') {
      if (Date.now() - this.forceExitArmedAt < 1_500) return this.exit(130, { preserveActiveWork: true });
      this.forceExitArmedAt = Date.now();
      return this.invalidate();
    }
    if (key.name === 'escape' || /^n$/i.test(text)) {
      this.workflowExitPrompt = null;
      return this.invalidate();
    }
    if (/^y$/i.test(text)) {
      const workflowId = this.workflowExitPrompt.id;
      this.workflowExitPrompt = null;
      this.invalidate();
      void this.options.workflowManager.stopAutomation(workflowId, 'stopped during graceful shutdown')
        .catch((err) => this.pushEntry({ kind: 'error', title: 'Workflow stop failed', body: err.message }))
        .finally(() => this.exit());
    }
  }

  handleInterruptKey(key, text) {
    if (key.name === 'escape') {
      this.interruptPrompt = false;
      return this.invalidate();
    }
    if (/^c$/i.test(text)) {
      this.interruptPrompt = false;
      if (this.abortController && !this.abortController.signal.aborted) {
        this.abortController.abort('Cancelled by Ctrl+C');
        this.pushEntry({ kind: 'system', title: 'Cancelling', body: 'Active request cancellation requested.' });
      }
      return;
    }
    if (/^d$/i.test(text)) {
      this.detachOnExit = true;
      return this.exit();
    }
  }

  handleInterrupt() {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.interruptPrompt = true;
      return this.invalidate();
    }
    const workflows = this.options.workflowManager?.list?.() || [];
    const blockingWorkflow = workflows.find(workflowHasBlockingAction) || null;
    if (blockingWorkflow) {
      this.workflowExitPrompt = blockingWorkflow;
      this.forceExitArmedAt = Date.now();
      return this.invalidate();
    }
    if (workflows.some(workflowRunActive)) this.detachOnExit = true;
    this.exit();
  }

  scrollChat(keyName) {
    if (this.detailsOpen) return;
    this.transcriptScroll = scrollTranscript(this.transcriptScroll, keyName);
    if (this.transcriptScroll.handled) this.invalidate();
  }

  followChat() {
    this.transcriptScroll = followTranscript(this.transcriptScroll);
  }

  navigateUp() {
    const suggestions = this.activeSuggestions();
    if (suggestions.length) {
      this.suggestionIndex = Math.max(0, this.suggestionIndex - 1);
      return this.invalidate();
    }
    if (!this.history.length) return;
    if (this.historyIndex == null) this.historyDraft = { value: this.editor.value, cursor: this.editor.cursor };
    this.historyIndex = this.historyIndex == null ? 0 : Math.min(this.historyIndex + 1, this.history.length - 1);
    this.setInputFromHistory(this.history[this.historyIndex] || '');
  }

  navigateDown() {
    const suggestions = this.activeSuggestions();
    if (suggestions.length) {
      this.suggestionIndex = Math.min(suggestions.length - 1, this.suggestionIndex + 1);
      return this.invalidate();
    }
    if (!this.history.length || this.historyIndex == null) return;
    const next = this.historyIndex - 1;
    if (next < 0) {
      const draft = this.historyDraft || { value: '', cursor: 0 };
      this.historyIndex = null;
      this.historyDraft = null;
      this.historyBrowsing = false;
      this.completionActive = false;
      this.editor.set(draft.value);
      this.editor.cursor = draft.cursor;
    } else {
      this.historyIndex = next;
      this.setInputFromHistory(this.history[next] || '');
    }
    this.invalidate();
  }

  completeInput() {
    this.markInputTouched();
    const suggestions = commandSuggestions(this.editor.value);
    if (this.editor.value.trimStart().startsWith('/') && suggestions.length) {
      const selected = suggestions[Math.max(0, Math.min(this.suggestionIndex, suggestions.length - 1))];
      if (selected && shouldCompleteSlashCommand(this.editor.value, selected)) {
        this.editor.set(`${selected.cmd} `);
        this.suggestionIndex = 0;
        return this.invalidate();
      }
    }
    this.editor.set(completeCommand(this.editor.value));
    this.invalidate();
  }

  submitEditor() {
    const suggestions = this.activeSuggestions();
    if (suggestions.length) {
      const selected = suggestions[Math.max(0, Math.min(this.suggestionIndex, suggestions.length - 1))];
      if (selected && shouldCompleteSlashCommand(this.editor.value, selected)) {
        this.editor.set(`${selected.cmd} `);
        this.suggestionIndex = 0;
        return this.invalidate();
      }
    }
    const line = this.editor.value;
    this.editor.clear();
    this.resetInputNavigation();
    this.invalidate();
    void this.submitLine(line);
  }

  activeSuggestions() {
    return shouldNavigateCommandSuggestions(this.editor.value, this.completionActive)
      ? commandSuggestions(this.editor.value)
      : [];
  }

  setInputFromHistory(value) {
    this.historyBrowsing = true;
    this.completionActive = false;
    this.suggestionIndex = 0;
    this.editor.set(value || '');
    this.invalidate();
  }

  markInputTouched({ completion = true } = {}) {
    if (this.historyBrowsing) {
      this.historyIndex = null;
      this.historyDraft = null;
    }
    this.historyBrowsing = false;
    if (completion) this.completionActive = true;
  }

  resetInputNavigation() {
    this.historyBrowsing = false;
    this.historyIndex = null;
    this.historyDraft = null;
    this.completionActive = false;
    this.suggestionIndex = 0;
  }

  async submitLine(line) {
    const message = String(line || '').trim();
    if (!message) return;
    this.followChat();
    this.history = [message, ...this.history.filter((item) => item !== message)].slice(0, 80);
    this.resetInputNavigation();

    if (EXIT_COMMANDS.has(message.toLowerCase())) return this.exit();
    if (message === '/clear') return this.clearTranscript();
    if (message === '/info') {
      this.detailsOpen = !this.detailsOpen;
      return this.invalidate();
    }
    if (message === '/help') return this.pushEntry({ kind: 'system', title: 'Help', body: buildHelpText() });
    if (message === '/stop') return this.stopActiveRequest();

    if (message.startsWith('/')) return this.runCommand(message);
    if (this.busy) return this.pushEntry({ kind: 'system', title: 'Request already running', body: 'Use /stop or Ctrl+C to cancel before sending another prompt.' });
    if (shouldRouteToProjectTask(this.state, this.options, message)) return this.runProjectChat(message);
    return this.runChat(message);
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
        await handleCommand(normalized, this.context);
        await saveInteractiveState(this.state).catch(() => {});
      }, (line) => this.pushEventLine(line));
      this.pushEntry({ kind: 'command', title: normalized === message ? message : `${message}  →  ${normalized}`, body: output || 'OK' });
    } catch (err) {
      this.pushEntry({ kind: 'error', title: message, body: err.message });
    } finally {
      this.busy = false;
      this.phase = 'idle';
      this.invalidate();
    }
  }

  async runProjectChat(message) {
    if (!this.options.bridge.health().ok && !this.options.bridge.canAutoOpenPromptTab?.()) {
      return this.pushEntry({ kind: 'error', title: 'Not connected', body: 'No ChatGPT browser extension is connected. Use /connect, or restart with --auto-open-tab.' });
    }
    const controller = new AbortController();
    this.abortController = controller;
    this.busy = true;
    this.phase = 'running project task';
    this.clearLive();
    this.resetActivity();
    this.chatProgressState = { records: {} };
    this.pushEntry({ kind: 'user', title: 'You', subtitle: `project: ${this.state.projectRoot}`, body: message });
    try {
      await runProjectTask(message, { ...this.context, signal: controller.signal });
      this.flushActivitySummary('Result activity');
      await saveInteractiveState(this.state).catch(() => {});
    } catch (err) {
      this.flushActivitySummary('Result activity');
      this.pushEntry({ kind: 'error', title: 'Project task failed', body: err.message });
      await saveInteractiveState(this.state).catch(() => {});
    } finally {
      this.abortController = null;
      this.busy = false;
      this.phase = 'idle';
      this.invalidate();
    }
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
        onAnswerUpdate: (text) => { this.answer = text || ''; this.invalidate(); },
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
      this.clearLive();
      this.flushActivitySummary();
      this.pushEntry({ kind: 'assistant', title: 'Assistant', body: finalAnswer || '(empty answer)' });
      if (response.artifacts?.length) {
        this.pushEntry({
          kind: 'artifact',
          title: `Artifacts (${response.artifacts.length})`,
          body: response.artifacts.map((artifact, index) => `[${index + 1}] ${artifact.name || artifact.filename || artifact.id || 'artifact'}`).join('\n'),
        });
      }
      await saveInteractiveState(this.state).catch(() => {});
    } catch (err) {
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

  pushEntry(entry) {
    const id = `entry-${this.entrySequence++}`;
    this.entries = [...this.entries, { id, time: new Date().toISOString(), ...entry }].slice(-MAX_TRANSCRIPT_ENTRIES);
    this.invalidate();
  }

  clearTranscript() {
    const id = `entry-${this.entrySequence++}`;
    this.entries = [{ id, time: new Date().toISOString(), kind: 'system', title: 'Cleared', body: 'Transcript cleared.' }];
    this.eventLines = [];
    this.activityLines = [];
    this.activitySummary = [];
    this.lastActivityPrint = { line: '', at: 0 };
    this.transcriptScroll = resetTranscriptScroll();
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

export async function runTerlioInteractive(options) {
  const runtime = await TerlioInteractiveRuntime.create(options);
  runtime.start();
  return runtime.waitUntilExit();
}
