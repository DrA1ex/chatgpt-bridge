import path from 'node:path';
import { config as appConfig } from '../../config.js';
import { detectProjectChecks } from './checkDetection.js';
import { loadGlobalWorkflowConfig, findWorkflowProfile, resolveWorkflowDefaults, saveGlobalWorkflowConfig, updateGlobalWorkflowProfile } from './globalConfig.js';
import { WORKFLOW_PRESETS, buildPresetWorkflowConfig, writePresetWorkflowConfig } from './presets.js';
import { attachWorkflowInstructions, bootstrapWorkflowChat } from '../session/bootstrap.js';
import { workflowActionLabels, workflowActionTitle } from './workflowActions.js';
import * as workflowView from './workflowView.js';
const { workflowActive, workflowRunActive, workflowStage, workflowWatcherActive } = workflowView;
import { buildWorkflowActionsScreen, buildWorkflowStartedScreen, buildWorkflowStopScreen, continueWorkflowFromWizard } from './workflowWizardControl.js';
import { dispatchWorkflowPendingAction } from './workflowPendingAction.js';
function text(value) { return String(value || '').trim(); }
function isSpaceKey(key = {}) {
  return key.name === 'space' || key.code === 'Space' || key.key === ' ' || key.text === ' ' || key.sequence === ' ';
}
function projectName(root) { return path.basename(path.resolve(root || process.cwd())) || 'project'; }
function mergeObject(base = {}, override = {}) {
  const result = JSON.parse(JSON.stringify(base || {}));
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = mergeObject(result[key], value);
    } else result[key] = value;
  }
  return result;
}
export class WorkflowWizardController {
  constructor(runtime) {
    this.runtime = runtime;
    this.opened = false;
    this.busy = false;
    this.index = 0;
    this.screen = null;
    this.global = null;
    this.draft = null;
    this.returnScreen = null;
    this.screenHistory = [];
    this.replaceNextScreen = false;
    this.lastSetupError = null;
    this.defaultsCustomized = false;
  }
  model() {
    return this.opened ? {
      opened: true,
      busy: this.busy,
      index: this.index,
      canGoBack: this.screenHistory.length > 0 || Boolean(this.returnScreen),
      ...this.screen,
    } : null;
  }
  async open({ pendingOnly = false, view = '' } = {}) {
    if (this.busy) return;
    this.global = await loadGlobalWorkflowConfig({ dataDir: appConfig.dataDir });
    const workflows = this.runtime.options.workflowManager?.list?.() || [];
    const pending = workflows.find((item) => item.lifecycle === 'waiting_action' || item.lifecycle === 'paused');
    this.opened = true;
    this.index = 0;
    this.screen = null;
    this.screenHistory = [];
    this.returnScreen = null;
    if (view === 'new') this.showGoal();
    else if (view === 'settings') this.showConfigActions();
    else if (view === 'active') {
      const active = workflows.find(workflowActive) || workflows[0] || null;
      if (active) this.showWorkflowActions(active);
      else this.showGoal();
    } else if (pending) this.showPending(pending);
    else if (pendingOnly || view === 'action') return this.close();
    else if (workflows.length) this.showExistingMenu(workflows);
    else this.showGoal();
    this.runtime.invalidate();
  }
  async openForWorkflow(workflowId) {
    if (this.busy) return;
    this.global = await loadGlobalWorkflowConfig({ dataDir: appConfig.dataDir });
    const workflow = this.runtime.options.workflowManager?.get?.(workflowId);
    if (!workflow) return;
    this.opened = true;
    this.index = 0;
    this.screen = null;
    this.screenHistory = [];
    this.returnScreen = null;
    await this.showPending(workflow);
    this.runtime.invalidate();
  }
  close() {
    this.opened = false;
    this.busy = false;
    this.screen = null;
    this.returnScreen = null;
    this.screenHistory = [];
    this.replaceNextScreen = false;
    this.runtime.invalidate();
  }
  setScreen(screen, { replace = false } = {}) {
    const shouldReplace = replace || this.replaceNextScreen;
    this.replaceNextScreen = false;
    if (this.screen && !shouldReplace) this.screenHistory.push({ screen: this.screen, index: this.index });
    this.screen = screen;
    this.index = Math.max(0, Math.min(screen.options?.length - 1 || 0, screen.defaultIndex || 0));
    this.runtime.invalidate();
  }
  goBack() {
    const previous = this.screenHistory.pop();
    if (!previous) {
      this.close();
      return true;
    }
    this.screen = previous.screen;
    this.index = Math.max(0, Math.min(previous.index || 0, Math.max(0, (this.screen.options?.length || 1) - 1)));
    this.returnScreen = null;
    this.runtime.invalidate();
    return true;
  }
  showGoal() {
    this.draft = {
      preset: '',
      chat: { mode: 'current', sessionId: '', clientId: '', sendInstructions: false },
      projectRoot: path.resolve(this.runtime.state.projectRoot || this.runtime.options.projectPath || process.cwd()),
      checks: [],
      checksInitialized: false,
      profileName: '',
      profile: null,
      overrides: {},
    };
    this.defaultsCustomized = false;
    this.setScreen({
      id: 'goal',
      title: 'What would you like Bridge to do?',
      message: 'Choose a goal. Bridge will configure the implementation details.',
      options: WORKFLOW_PRESETS.map((preset) => ({
        label: preset.label,
        detail: preset.description,
        value: preset.id,
        action: () => this.chooseGoal(preset.id),
      })),
    });
  }
  chooseGoal(preset) {
    this.draft.preset = preset;
    const health = this.runtime.options.bridge.health();
    const clients = Array.from(health.clients || []);
    this.setScreen({
      id: 'chat',
      title: 'Which ChatGPT chat should Bridge use?',
      message: 'The existing chat is used quietly by default. Bridge sends setup files only when a new chat is created.',
      options: [
        { label: 'Use the current ChatGPT tab', value: 'current', action: () => this.chooseChat('current', health.activeClient || clients[0] || null) },
        { label: 'Start a new chat', value: 'new', action: () => this.chooseChat('new', health.activeClient || clients[0] || null) },
        { label: 'Choose another open tab', value: 'other', action: () => this.showOtherTabs(clients) },
      ],
    });
  }
  matchDraftProfile() {
    const match = findWorkflowProfile(this.global?.config, {
      preset: this.draft?.preset,
      project: this.draft?.projectRoot,
    });
    this.draft.profileName = match?.name || '';
    this.draft.profile = match?.profile || null;
  }
  effectiveDefaults() {
    return resolveWorkflowDefaults(
      this.global?.config,
      this.draft?.profile || {},
      this.draft?.overrides || {},
    );
  }
  showOtherTabs(clients) {
    const usable = clients.filter((client) => client?.id);
    if (!usable.length) {
      this.runtime.pushEntry({ kind: 'error', title: 'No ChatGPT tabs', body: 'No connected ChatGPT tabs are available.' });
      return;
    }
    this.setScreen({
      id: 'other-tab',
      title: 'Choose an open ChatGPT tab',
      message: 'Bridge will bind this workflow to the selected tab and conversation.',
      options: usable.map((client) => ({
        label: client.title || client.url || client.id,
        detail: client.session?.id || client.sessionId || client.url || '',
        action: () => this.chooseChat('other', client),
      })),
    });
  }
  chooseChat(mode, client) {
    this.draft.chat = {
      mode,
      clientId: text(client?.id),
      sessionId: mode === 'new' ? '' : text(client?.session?.id || client?.sessionId),
      sendInstructions: false,
    };
    this.showProject();
  }
  showProject() {
    this.matchDraftProfile();
    const root = this.draft.projectRoot;
    this.setScreen({
      id: 'project',
      title: 'I found this project',
      message: `${projectName(root)}\n${root}`,
      options: [
        { label: 'Use this project', detail: this.draft.chat.mode === 'new' ? 'Bridge will initialize the new chat with the project and workflow instructions.' : 'Use the existing chat context and intervene only when needed.', action: () => this.showChecks() },
        ...(this.draft.chat.mode === 'new' ? [] : [{ label: 'Use this project and send workflow instructions now', action: () => { this.draft.chat.sendInstructions = true; return this.showChecks(); } }]),
        { label: 'Choose another folder', action: () => this.showTextInput({
          title: 'Choose another project folder',
          message: 'Enter an absolute or relative folder path.',
          initialValue: root,
          submit: (value) => {
            this.draft.projectRoot = path.resolve(value);
            this.draft.checksInitialized = false;
            this.draft.profile = null;
            this.draft.profileName = '';
            this.showProject();
          },
        }) },
      ],
    });
  }
  async showChecks() {
    return await this.run(async () => {
      const detected = await detectProjectChecks(this.draft.projectRoot);
      if (!this.draft.checksInitialized) {
        this.draft.checks = Array.isArray(this.draft.profile?.checks)
          ? [...this.draft.profile.checks]
          : detected.filter((item) => item.selected).map((item) => item.command);
        this.draft.checksInitialized = true;
      }
      this.setScreen({
        id: 'checks',
        title: detected.length ? 'I found these project checks' : 'No project checks were detected',
        message: 'Space toggles a check. Enter continues. A custom command is always available.',
        multi: true,
        options: [
          ...detected.map((item) => ({
            label: item.label,
            detail: item.command,
            value: item.command,
            checked: this.draft.checks.includes(item.command),
          })),
          { label: 'Add another command', special: 'custom-check' },
          { label: 'Do not run checks', special: 'no-checks' },
        ],
        submit: () => this.afterChecks(),
      });
    });
  }

  afterChecks() {
    this.showSummary();
  }

  showFirstRunSession() {
    this.setScreen({
      id: 'default-session',
      title: 'What should Bridge do when the ChatGPT chat can no longer continue?',
      message: 'This global default is stored in a human-editable configuration file.',
      options: [
        { label: 'Start a new chat automatically', action: () => { this.global.config.defaults.sessionExhaustion = 'start-new-chat'; this.showFirstRunCommits(); } },
        { label: 'Ask me before starting a new chat', action: () => { this.global.config.defaults.sessionExhaustion = 'ask'; this.showFirstRunCommits(); } },
        { label: 'Stop the workflow', action: () => { this.global.config.defaults.sessionExhaustion = 'stop'; this.showFirstRunCommits(); } },
      ],
    });
  }

  showFirstRunCommits() {
    this.setScreen({
      id: 'default-commits',
      title: 'How should Bridge save workflow changes?',
      message: 'Automatic mode creates checkpoint commits and squashes workflow-owned checkpoints on success.',
      options: [
        { label: 'Create commits automatically', action: () => {
          this.global.config.defaults.commits.mode = 'automatic';
          this.showFirstRunIterationStrategy();
        } },
        { label: 'Ask before each commit', action: () => { this.global.config.defaults.commits.mode = 'ask'; this.showFirstRunNotifications(); } },
        { label: 'Do not create commits', action: () => { this.global.config.defaults.commits.mode = 'disabled'; this.showFirstRunNotifications(); } },
      ],
    });
  }

  showFirstRunIterationStrategy() {
    this.setScreen({
      id: 'default-iteration-commits',
      title: 'How should iterative fixes be saved?',
      message: 'This applies to workflows that may need several ChatGPT updates before checks pass.',
      options: [
        { label: 'Create checkpoint commits and squash them when the workflow succeeds', action: () => {
          Object.assign(this.global.config.defaults.commits, { iterationStrategy: 'checkpoint', completionStrategy: 'squash' });
          this.showFirstRunNotifications();
        } },
        { label: 'Keep every checkpoint commit', action: () => {
          Object.assign(this.global.config.defaults.commits, { iterationStrategy: 'checkpoint', completionStrategy: 'keep-checkpoints' });
          this.showFirstRunNotifications();
        } },
        { label: 'Create only one final commit', action: () => {
          Object.assign(this.global.config.defaults.commits, { iterationStrategy: 'final-only', completionStrategy: 'squash' });
          this.showFirstRunNotifications();
        } },
      ],
    });
  }

  showFirstRunNotifications() {
    this.setScreen({
      id: 'default-notifications',
      title: 'Notify you when a workflow needs attention or finishes?',
      message: 'Bridge uses a terminal bell and best-effort native desktop notifications.',
      options: [
        { label: 'Yes', action: () => { this.global.config.defaults.notifications.enabled = true; this.defaultsCustomized = true; this.showSummary(); } },
        { label: 'No', action: () => { this.global.config.defaults.notifications.enabled = false; this.defaultsCustomized = true; this.showSummary(); } },
      ],
    });
  }

  showSummary() {
    const preset = WORKFLOW_PRESETS.find((item) => item.id === this.draft.preset);
    const defaults = this.effectiveDefaults();
    const commits = defaults.commits;
    const chatLabel = this.draft.chat.mode === 'new' ? 'New ChatGPT chat' : this.draft.chat.sessionId || 'Current ChatGPT tab';
    const firstRunDefaults = this.global.firstRun ? [
      '',
      'First-run global defaults:',
      `Session recovery: ${defaults.sessionExhaustion}`,
      `Commit policy:    ${commits.mode}, ${commits.iterationStrategy}, ${commits.completionStrategy}`,
      `Notifications:    ${defaults.notifications.enabled ? 'Enabled' : 'Disabled'}`,
      `Configuration:    ${this.global.path}`,
    ] : [];
    const startLabel = this.global.firstRun && !this.defaultsCustomized
      ? 'Start with these recommended global defaults'
      : 'Start workflow';
    this.setScreen({
      id: 'summary',
      title: 'Ready to start',
      message: [
        `Mode:       ${preset?.label || this.draft.preset}`,
        `Chat:       ${chatLabel}`,
        `Project:    ${projectName(this.draft.projectRoot)}`,
        `Checks:     ${this.draft.checks.join(', ') || 'None'}`,
        `Changes:    ${this.draft.preset === 'guided-task' ? 'Ask before applying' : 'Apply automatically'}`,
        `Commits:    ${commits.mode === 'disabled' ? 'Disabled' : commits.mode === 'ask' ? 'Ask before commits' : `${commits.iterationStrategy}, ${commits.completionStrategy}`}`,
        `Recovery:   ${defaults.sessionExhaustion}`,
        ...firstRunDefaults,
      ].join('\n'),
      options: [
        { label: startLabel, action: () => this.startWorkflow() },
        ...(this.global.firstRun && !this.defaultsCustomized ? [{ label: 'Customize global defaults', action: () => this.showFirstRunSession() }] : []),
        { label: 'Back to project checks', action: () => this.showChecks() },
        { label: 'Cancel', action: () => this.close() },
      ],
    });
  }

  showGuidedResponse(workflow, response = {}) {
    this.opened = true;
    const artifacts = Array.isArray(response.artifacts) ? response.artifacts : [];
    const options = [
      { label: 'Continue with a follow-up question', action: () => this.close() },
    ];
    if (artifacts.length) {
      options.push({ label: 'Review returned files', action: () => {
        this.runtime.pushEntry({
          kind: 'artifact',
          title: 'Returned files',
          body: artifacts.map((item, index) => `[${index + 1}] ${item.name || item.filename || item.id || 'artifact'}`).join('\n'),
        });
        this.close();
      } });
      options.push({ label: 'Apply returned files', action: async () => {
        const latest = this.runtime.options.workflowManager.get(workflow.id);
        if (latest?.nextAction) await this.openForWorkflow(workflow.id);
        else {
          this.runtime.pushEntry({ kind: 'system', title: 'Returned package', body: 'Bridge is still validating the returned package. Open /workflow again to act on it.' });
          this.close();
        }
      } });
    }
    options.push(
      { label: 'Run project checks', action: () => this.runGuidedChecks(workflow) },
      { label: 'Attach logs or files to the next prompt', action: () => this.showGuidedAttachments(workflow) },
      { label: 'Refresh the remote project context', action: () => this.refreshGuidedContext(workflow) },
      { label: 'Finish the task', action: async () => {
        await this.runtime.options.workflowManager.completeGuidedWorkflow(workflow.id);
        this.runtime.state.focusedWorkflowId = '';
        await this.runtime.saveState?.();
        this.close();
      } },
    );
    this.setScreen({
      id: 'guided-response',
      title: 'What would you like to do next?',
      message: artifacts.length
        ? `ChatGPT returned ${artifacts.length} file package${artifacts.length === 1 ? '' : 's'} and a response.`
        : 'ChatGPT returned a text response. File changes are optional for a guided task.',
      options,
    });
  }

  showGuidedAttachments(workflow) {
    const suggestions = Array.isArray(this.runtime.state.lastArtifacts) ? this.runtime.state.lastArtifacts : [];
    const pending = new Set((this.runtime.state.pendingAttachments || []).map((item) => item.id));
    this.setScreen({
      id: 'guided-attachments',
      title: 'Attach context to the next prompt',
      message: `${pending.size} attachment${pending.size === 1 ? '' : 's'} selected. Choose a recent local artifact or add a file by path.`,
      options: [
        ...suggestions.slice(0, 8).map((artifact) => ({
          label: artifact.name || artifact.filename || artifact.id || 'Recent artifact',
          detail: pending.has(artifact.id) ? 'Selected' : 'Recent artifact',
          action: () => this.addGuidedExistingAttachment(workflow, artifact),
        })),
        { label: 'Choose a local file', action: () => this.showTextInput({
          title: 'Choose a local file',
          message: 'Enter a file path. Bridge will import it and attach it to the next guided prompt.',
          submit: (value) => this.addGuidedLocalAttachment(workflow, value),
        }) },
        { label: 'Continue to the prompt', action: () => this.close() },
      ],
    });
  }

  async addGuidedExistingAttachment(workflow, artifact) {
    return await this.run(async () => {
      const readable = await this.runtime.options.fileStore.getReadable(artifact.id).catch(() => null);
      if (!readable) throw new Error('This returned artifact is not available as a local attachment. Save it locally or choose another file.');
      const pending = this.runtime.state.pendingAttachments || [];
      if (!pending.some((item) => item.id === artifact.id)) pending.push({ ...artifact, ...readable, id: artifact.id });
      this.runtime.state.pendingAttachments = pending;
      await this.runtime.saveState?.();
      this.showGuidedAttachments(workflow);
    });
  }

  async addGuidedLocalAttachment(workflow, value) {
    return await this.run(async () => {
      const filePath = path.resolve(String(value || '').trim());
      const imported = await this.runtime.options.fileStore.importLocalPath({ filePath, name: path.basename(filePath) });
      const pending = this.runtime.state.pendingAttachments || [];
      if (!pending.some((item) => item.id === imported.id)) pending.push(imported);
      this.runtime.state.pendingAttachments = pending;
      await this.runtime.saveState?.();
      this.showGuidedAttachments(workflow);
    });
  }

  async runGuidedChecks(workflow) {
    return await this.run(async () => {
      const result = await this.runtime.options.workflowManager.runChecks(workflow.id);
      const lines = result.results?.map((item) => `${item.ok ? 'PASS' : 'FAIL'}  ${item.command}${item.code == null ? '' : ` (exit ${item.code})`}`) || [];
      this.runtime.pushEntry({ kind: result.ok ? 'system' : 'error', title: result.ok ? 'Project checks passed' : 'Project checks failed', body: lines.join('\n') || 'No checks are configured.' });
      this.showGuidedResponse(workflow, {});
    });
  }

  async refreshGuidedContext(workflow) {
    return await this.run(async () => {
      const health = this.runtime.options.bridge.health();
      const result = await this.runtime.options.workflowManager.refreshProjectContext(workflow.id, {
        sessionId: this.runtime.state.sessionId || workflow.binding?.sessionId || '',
        sourceClientId: workflow.binding?.clientId || health.activeClient?.id || '',
      });
      this.runtime.pushEntry({ kind: 'system', title: 'Project context', body: result.synced ? 'The current project archive was uploaded to ChatGPT.' : 'The ChatGPT project context is already up to date.' });
      this.showGuidedResponse(workflow, {});
    });
  }

  showExistingMenu(workflows) {
    const active = workflows.find(workflowActive) || workflows[0];
    const attention = workflows.filter((item) => item.nextAction || item.lifecycle === 'paused');
    this.setScreen({
      id: 'existing',
      title: 'What would you like to do?',
      message: `${workflows.length} workflow${workflows.length === 1 ? '' : 's'} available.`,
      options: [
        { label: 'Continue the active workflow', disabled: !active, action: () => this.showWorkflowActions(active) },
        { label: 'View workflows that need attention', disabled: !attention.length, action: async () => this.showPending(attention[0]) },
        { label: 'Start a new workflow', action: () => this.showGoal() },
        { label: 'Change workflow settings', action: () => this.showWorkflowSettingsSelection(workflows) },
        { label: 'Pause or stop a workflow', action: () => this.showStopChoices(workflows) },
        { label: 'Change global workflow defaults', action: () => this.showConfigActions() },
      ],
    });
  }

  showWorkflowActions(workflow) {
    this.setScreen(buildWorkflowActionsScreen(workflow, {
      continueAction: () => this.continueWorkflow(workflow),
      stopAction: () => this.stopWorkflow(workflow),
      startAnother: () => this.showGoal(),
    }));
  }

  async continueWorkflow(workflow) {
    return await this.run(async () => {
      await continueWorkflowFromWizard(this.runtime, workflow);
      this.close();
    });
  }

  showWorkflowSettingsSelection(workflows) {
    this.setScreen({
      id: 'workflow-settings-select',
      title: 'Change workflow settings',
      message: 'Choose the workflow whose settings should override the global defaults.',
      options: workflows.map((workflow) => ({
        label: workflow.label || workflow.id,
        detail: workflow.projectRoot,
        action: () => this.showWorkflowSettings(workflow),
      })),
    });
  }

  showWorkflowSettings(workflow) {
    const current = this.runtime.options.workflowManager.get(workflow.id) || workflow;
    const settings = current.settings || {};
    this.setScreen({
      id: 'workflow-settings',
      title: current.label || current.id,
      message: `These values override global defaults for this workflow.\nConfiguration: ${current.configPath}`,
      options: [
        { label: 'Chat exhaustion policy', detail: settings.sessionExhaustion || 'start-new-chat', action: () => this.chooseWorkflowSetting(current, 'sessionExhaustion', [
          ['Start a new chat automatically', 'start-new-chat'],
          ['Ask before starting a new chat', 'ask'],
          ['Stop the workflow', 'stop'],
        ]) },
        { label: 'Maximum ChatGPT turns per chat', detail: String(settings.session?.maxTurns || 40), action: () => this.showTextInput({
          title: 'Maximum ChatGPT turns per chat',
          message: 'Enter a positive integer. Bridge starts session recovery before sending another workflow request.',
          initialValue: String(settings.session?.maxTurns || 40),
          submit: (value) => this.saveWorkflowOverrides(current, { session: { maxTurns: Math.max(1, Number.parseInt(value, 10) || 40) } }),
        }) },
        { label: 'Invalid result handling', detail: `${settings.invalidResponseAction || 'repair'} · ${settings.invalidResponseAttempts ?? 2} attempt(s)`, action: () => this.chooseWorkflowSetting(current, 'invalidResponseAction', [
          ['Request a corrected package automatically', 'repair'],
          ['Ask me what to do', 'ask'],
          ['Stop the workflow', 'stop'],
        ]) },
        { label: 'Commit mode', detail: settings.commits?.mode || 'automatic', action: () => this.chooseWorkflowSetting(current, 'commits.mode', [
          ['Create commits automatically', 'automatic'],
          ['Ask before each commit', 'ask'],
          ['Do not create commits', 'disabled'],
        ]) },
        { label: 'Iterative commit strategy', detail: `${settings.commits?.iterationStrategy || 'checkpoint'} · ${settings.commits?.completionStrategy || 'squash'}`, action: () => this.chooseCommitStrategy(current) },
        { label: 'Notifications', detail: settings.notifications?.enabled === false ? 'Disabled' : 'Enabled', action: () => this.saveWorkflowOverrides(current, { notifications: { enabled: settings.notifications?.enabled === false } }) },
        { label: 'Maximum check attempts', detail: String(settings.checks?.maxAttempts || 8), action: () => this.showTextInput({
          title: 'Maximum check attempts',
          message: 'Enter a positive integer.',
          initialValue: String(settings.checks?.maxAttempts || 8),
          submit: (value) => this.saveWorkflowOverrides(current, { checks: { maxAttempts: Math.max(1, Number.parseInt(value, 10) || 8) } }),
        }) },
        { label: 'No-progress limit', detail: String(settings.checks?.noProgressLimit || 3), action: () => this.showTextInput({
          title: 'No-progress limit',
          message: 'Enter the number of repeated identical failures allowed before Bridge asks what to do.',
          initialValue: String(settings.checks?.noProgressLimit || 3),
          submit: (value) => this.saveWorkflowOverrides(current, { checks: { noProgressLimit: Math.max(1, Number.parseInt(value, 10) || 3) } }),
        }) },
        { label: 'Show workflow configuration path', action: () => {
          this.runtime.pushEntry({ kind: 'system', title: 'Workflow configuration', body: current.configPath });
          this.close();
        } },
        { label: 'Back', action: () => this.open() },
      ],
    });
  }

  chooseWorkflowSetting(workflow, pathName, choices) {
    this.setScreen({
      id: 'workflow-setting-choice',
      title: workflow.label || workflow.id,
      message: 'Choose the value for this workflow only.',
      options: choices.map(([label, value]) => ({
        label,
        action: () => {
          const parts = pathName.split('.');
          const override = parts.length === 1 ? { [parts[0]]: value } : { [parts[0]]: { [parts[1]]: value } };
          return this.saveWorkflowOverrides(workflow, override);
        },
      })),
    });
  }

  chooseCommitStrategy(workflow) {
    this.setScreen({
      id: 'workflow-commit-strategy',
      title: 'How should iterative fixes be saved?',
      message: 'This setting applies only to this workflow.',
      options: [
        { label: 'Create checkpoints and squash them on success', action: () => this.saveWorkflowOverrides(workflow, { commits: { iterationStrategy: 'checkpoint', completionStrategy: 'squash' } }) },
        { label: 'Keep every checkpoint commit', action: () => this.saveWorkflowOverrides(workflow, { commits: { iterationStrategy: 'checkpoint', completionStrategy: 'keep-checkpoints' } }) },
        { label: 'Create only one final commit', action: () => this.saveWorkflowOverrides(workflow, { commits: { iterationStrategy: 'final-only', completionStrategy: 'squash' } }) },
      ],
    });
  }

  async saveWorkflowOverrides(workflow, override) {
    return await this.run(async () => {
      const matched = findWorkflowProfile(this.global.config, {
        id: workflow.id,
        preset: workflow.preset,
        project: workflow.projectRoot,
      });
      const profileName = matched?.name || workflow.id;
      const currentProfile = matched?.profile || {
        preset: workflow.preset,
        project: workflow.projectRoot,
        checks: Array.isArray(workflow.checks) ? [...workflow.checks] : [],
        configPath: workflow.configPath,
      };
      const nextProfile = {
        ...currentProfile,
        defaults: mergeObject(currentProfile.defaults || {}, override),
      };
      const nextConfig = JSON.parse(JSON.stringify(this.global.config));
      nextConfig.profiles[profileName] = nextProfile;
      const saved = await saveGlobalWorkflowConfig(nextConfig, { filePath: this.global.path });
      this.global = { ...this.global, config: saved.config, exists: true, firstRun: false };
      const effective = resolveWorkflowDefaults(saved.config, nextProfile);
      await this.runtime.options.workflowManager.updateWorkflowSettings(workflow.id, effective);
      this.runtime.pushEntry({ kind: 'system', title: 'Workflow settings updated', body: workflow.label || workflow.id });
      this.showWorkflowSettings(this.runtime.options.workflowManager.get(workflow.id) || workflow);
    });
  }

  async showPending(workflow) {
    const actions = workflow.lifecycle === 'paused'
      ? ['Resume the workflow', 'Stop the workflow']
      : workflowActionLabels(workflow).map((item) => item.label);
    this.setScreen({
      id: 'pending',
      title: workflowActionTitle(workflow),
      message: workflow.nextAction?.reason || workflow.lastOutcome?.message || 'Choose what Bridge should do next.',
      options: actions.map((label, index) => ({
        label,
        action: () => this.applyPendingAction({ workflow, index }),
      })),
    });
  }

  async applyPendingAction({ workflow, index }) {
    const manager = this.runtime.options.workflowManager;
    return await this.run(async () => {
      const result = await dispatchWorkflowPendingAction({
        runtime: this.runtime, manager, workflow, index, showGoal: () => this.showGoal(),
      });
      if (result.close && this.opened) this.close();
    }, { onError: async (error) => {
      this.runtime.pushEntry({ kind: 'error', title: 'Why the changes were not applied', body: error?.message || String(error) });
      await this.showPending(manager.get(workflow.id) || workflow);
    } });
  }

  showStopChoices(workflows) {
    this.setScreen({
      id: 'stop-select',
      title: 'Pause or stop a workflow',
      message: 'Choose the workflow to control.',
      options: workflows.map((workflow) => ({ label: workflow.label || workflow.id, detail: workflowStage(workflow).label, action: () => this.stopWorkflow(workflow) })),
    });
  }

  stopWorkflow(workflow) {
    const manager = this.runtime.options.workflowManager;
    this.setScreen(buildWorkflowStopScreen(this.runtime, workflow, {
      close: () => this.close(),
      goBack: () => this.showWorkflowActions(manager.get(workflow.id) || workflow),
    }));
  }

  showConfigActions() {
    this.setScreen({
      id: 'config',
      title: 'Global workflow defaults',
      message: `Configuration file:\n${this.global.path}\n\nThe file is formatted JSON and is safe to edit manually. JSON comments are not supported.`,
      options: [
        { label: 'Reload the configuration file', action: () => this.reloadConfig() },
        { label: 'Show the path in the transcript', action: () => { this.runtime.pushEntry({ kind: 'system', title: 'Workflow configuration', body: this.global.path }); this.close(); } },
        { label: 'Back', action: () => this.open() },
      ],
    });
  }

  async reloadConfig() {
    return await this.run(async () => {
      this.global = await loadGlobalWorkflowConfig({ dataDir: appConfig.dataDir });
      this.runtime.options.workflowManager.reloadGlobalConfig();
      this.runtime.pushEntry({ kind: 'system', title: 'Workflow configuration reloaded', body: this.global.path });
      this.showConfigActions();
    });
  }

  showTextInput({ title, message, initialValue = '', submit }) {
    this.returnScreen = this.screen;
    this.setScreen({ id: 'text-input', title, message, input: true, inputValue: String(initialValue), submitInput: submit, options: [] });
  }

  showStartedWorkflow(workflow, configPath) {
    this.setScreen(buildWorkflowStartedScreen(workflow, configPath, {
      close: () => this.close(),
      openControls: () => this.showWorkflowActions(this.runtime.options.workflowManager.get(workflow.id) || workflow),
    }));
  }

  async startWorkflow() {
    return await this.run(async () => {
      const savedFirstRunDefaults = this.global.firstRun;
      if (savedFirstRunDefaults) {
        await saveGlobalWorkflowConfig(this.global.config, { filePath: this.global.path });
        this.global.firstRun = false;
      }
      let raw = await buildPresetWorkflowConfig({
        preset: this.draft.preset,
        projectRoot: this.draft.projectRoot,
        checks: this.draft.checks,
        chat: this.draft.chat,
        intelligence: {
          model: this.runtime.state.model || '',
          effort: this.runtime.state.effort || 'auto',
        },
        defaults: this.effectiveDefaults(),
      });
      if (this.draft.chat.mode === 'new') {
        const boot = await bootstrapWorkflowChat({
          workflow: raw,
          bridge: this.runtime.options.bridge,
          fileStore: this.runtime.options.fileStore,
          projectService: this.runtime.options.projectService,
          dataDir: appConfig.dataDir,
          sourceClientId: this.draft.chat.clientId,
        });
        raw.watch.sessionId = boot.sessionId;
        raw.watch.clientId = boot.sourceClientId;
        raw.automation.session = { policy: 'pinned', id: boot.sessionId };
        raw.projectContext.syncOnStart = false;
      } else if (this.draft.chat.sendInstructions) {
        await attachWorkflowInstructions({
          workflow: raw,
          bridge: this.runtime.options.bridge,
          fileStore: this.runtime.options.fileStore,
          dataDir: appConfig.dataDir,
          sessionId: this.draft.chat.sessionId,
          sourceClientId: this.draft.chat.clientId,
        });
      }
      const configPath = await writePresetWorkflowConfig(raw, { dataDir: appConfig.dataDir });
      const loaded = await this.runtime.options.workflowManager.load(configPath, { start: true, includeLatest: false, triggerAutomation: false });
      if (raw.watch.sessionId) await this.runtime.options.workflowManager.assumeProjectContext(loaded.id, raw.watch.sessionId);
      if (raw.preset === 'fix-until-pass') {
        await this.runtime.options.workflowManager.runAutomation(loaded.id, {
          trigger: 'workflow-wizard',
          sessionPolicy: raw.automation.session.policy,
          sessionId: raw.automation.session.id || this.draft.chat.sessionId,
          model: this.runtime.state.model || '',
          effort: this.runtime.state.effort || '',
        });
      }
      if (raw.preset === 'guided-task') {
        this.runtime.state.focusedWorkflowId = loaded.id;
        await this.runtime.saveState?.();
      }
      await updateGlobalWorkflowProfile(loaded.id, {
        preset: raw.preset,
        project: raw.projectRoot,
        checks: this.draft.checks,
        configPath,
        defaults: mergeObject(this.draft.profile?.defaults || {}, this.draft.overrides || {}),
      }, { filePath: this.global.path });
      let current = this.runtime.options.workflowManager.get(loaded.id) || loaded;
      if ((raw.preset === 'apply-changes' || raw.preset === 'guided-task') && !workflowWatcherActive(current)) {
        current = await this.runtime.options.workflowManager.start(loaded.id);
      }
      const entryTitle = raw.preset === 'apply-changes' ? 'Watching the ChatGPT tab' : 'Workflow started';
      const entryBody = raw.preset === 'apply-changes'
        ? `Continue the conversation in the selected ChatGPT browser tab. Bridge is watching for new responses and valid result packages.\n\nChat: ${current.sessionId || current.boundSessionId || 'selected tab'}\nProject: ${raw.projectRoot}`
        : `${raw.ux.label}\nProject: ${raw.projectRoot}\nConfiguration: ${configPath}`;
      this.runtime.pushEntry({ kind: 'system', title: entryTitle, body: entryBody });
      this.showStartedWorkflow(current, configPath);
    }, { onError: (error) => this.showStartFailure(error) });
  }

  showStartFailure(error) {
    this.lastSetupError = error;
    this.setScreen({
      id: 'setup-failed',
      title: 'Workflow setup failed',
      message: `${error?.message || error || 'Workflow setup failed'}\n\nYou can retry after the browser tab is ready, return to the summary, or close the wizard.`,
      options: [
        { label: 'Retry starting the workflow', action: () => this.startWorkflow() },
        { label: 'Return to the setup summary', action: () => { this.replaceNextScreen = true; this.showSummary(); } },
        { label: 'Close the wizard', action: () => this.close() },
      ],
    }, { replace: true });
  }

  async run(operation, { onError = null, errorTitle = 'Workflow setup failed' } = {}) {
    if (this.busy) return;
    this.busy = true;
    this.runtime.invalidate();
    try {
      return await operation();
    } catch (error) {
      if (typeof onError !== 'function') {
        this.runtime.pushEntry({ kind: 'error', title: errorTitle, body: error.message || String(error) });
      }
      this.busy = false;
      if (typeof onError === 'function') await onError(error);
      this.runtime.invalidate();
      return null;
    } finally {
      if (this.opened) {
        this.busy = false;
        this.runtime.invalidate();
      }
    }
  }

  async handleKey(key) {
    if (!this.opened || this.busy) return true;
    const screen = this.screen || {};
    if (screen.input) return this.handleInputKey(key);
    if (key.name === 'escape' || key.name === 'left' && key.alt) return this.goBack();
    if (key.name === 'up' || key.name === 'down') {
      const direction = key.name === 'up' ? -1 : 1;
      const count = screen.options?.length || 0;
      if (count) this.index = (this.index + direction + count) % count;
      this.runtime.invalidate();
      return true;
    }
    if (isSpaceKey(key) && screen.multi) {
      const option = screen.options[this.index];
      if (!option) return true;
      if (option.special === 'custom-check') {
        this.showTextInput({
          title: 'Add a project check',
          message: 'Enter the command Bridge should run.',
          submit: (value) => {
            const command = text(value);
            if (command && !this.draft.checks.includes(command)) this.draft.checks.push(command);
            this.showChecksWithCurrent();
          },
        });
      } else if (option.special === 'no-checks') {
        this.draft.checks = [];
        for (const item of screen.options) item.checked = false;
      } else {
        option.checked = !option.checked;
        this.draft.checks = screen.options.filter((item) => item.checked && item.value).map((item) => item.value);
      }
      this.runtime.invalidate();
      return true;
    }
    const numeric = Number(key.text || key.sequence);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= (screen.options?.length || 0)) this.index = numeric - 1;
    if (key.name === 'enter' || (Number.isInteger(numeric) && numeric >= 1)) {
      if (screen.multi) return await screen.submit?.();
      const option = screen.options?.[this.index];
      if (!option || option.disabled) return true;
      await option.action?.();
      return true;
    }
    return true;
  }

  showChecksWithCurrent() {
    const commands = [...this.draft.checks];
    this.setScreen({
      id: 'checks',
      title: 'Project checks',
      message: 'Space toggles a check. Enter continues. A custom command is always available.',
      multi: true,
      options: [
        ...commands.map((command) => ({ label: command, detail: command, value: command, checked: true })),
        { label: 'Add another command', special: 'custom-check' },
        { label: 'Do not run checks', special: 'no-checks' },
      ],
      submit: () => this.afterChecks(),
    });
  }

  async handleInputKey(key) {
    if (key.name === 'escape') return this.goBack();
    if (key.name === 'enter') {
      const submit = this.screen.submitInput;
      const value = this.screen.inputValue;
      this.returnScreen = null;
      this.replaceNextScreen = true;
      await submit?.(value);
      return true;
    }
    if (key.name === 'backspace') this.screen.inputValue = this.screen.inputValue.slice(0, -1);
    else if (key.name === 'paste') this.screen.inputValue += String(key.text || '');
    else if (key.printable || key.text) this.screen.inputValue += String(key.text || key.sequence || '');
    this.runtime.invalidate();
    return true;
  }
}
