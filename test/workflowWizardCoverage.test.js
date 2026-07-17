import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function temporaryRoot(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const isolatedDataDir = await temporaryRoot('bridge-wizard-data-');
process.env.DATA_DIR = isolatedDataDir;
process.env.ENV_FILE = path.join(isolatedDataDir, '.env');
const { WorkflowWizardController } = await import('../src/workflow/ux/workflowWizard.js');
const { loadGlobalWorkflowConfig, saveGlobalWorkflowConfig, defaultGlobalWorkflowConfig } = await import('../src/workflow/ux/globalConfig.js');

function workflowSnapshot(overrides = {}) {
  return {
    id: 'workflow-1',
    label: 'Fix project checks',
    preset: 'fix-until-pass',
    projectRoot: '/tmp/project',
    configPath: '/tmp/workflow-1.json',
    sessionId: 'c/current',
    clientId: 'client-1',
    checks: ['npm test'],
    settings: {
      sessionExhaustion: 'start-new-chat', session: { maxTurns: 40 }, invalidResponseAction: 'repair', invalidResponseAttempts: 2,
      notifications: { enabled: true }, commits: { mode: 'automatic', iterationStrategy: 'checkpoint', completionStrategy: 'squash' },
      checks: { maxAttempts: 8, noProgressLimit: 3 },
    },
    attention: null,
    automationInterrupted: false,
    status: 'running',
    watcher: { status: 'running' },
    automation: { status: 'idle' },
    pipeline: { status: 'idle' },
    ...overrides,
  };
}

function createRuntime({ projectRoot = '/tmp/project', workflows = [], approvals = [], clients = null } = {}) {
  const calls = [];
  const entries = [];
  const sent = [];
  const imported = [];
  const packed = [];
  const marked = [];
  const activeClients = clients || [{ id: 'client-1', title: 'Current tab', session: { id: 'c/current' }, url: 'https://chatgpt.com/c/current' }];
  const managerMethods = {
    list: () => workflows,
    get: (id) => workflows.find((item) => item.id === id) || null,
    approvals: async () => approvals,
    async load(configPath) {
      calls.push(['load', configPath]);
      const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const item = workflowSnapshot({
        id: raw.id,
        label: raw.ux?.label || raw.id,
        preset: raw.preset,
        projectRoot: raw.projectRoot,
        configPath,
        sessionId: raw.watch?.sessionId || '',
        clientId: raw.watch?.clientId || '',
        boundSessionId: raw.watch?.sessionId || '',
        boundSourceClientId: raw.watch?.clientId || '',
        status: 'running',
        watcher: { status: 'running' },
        checks: (raw.automation?.steps || []).map((step) => step.command),
      });
      workflows.push(item);
      return item;
    },
    async start(id) {
      calls.push(['start', id]);
      const item = workflows.find((workflow) => workflow.id === id);
      if (!item) throw new Error(`Unknown workflow: ${id}`);
      item.status = 'running';
      item.watcher = { ...(item.watcher || {}), status: 'running' };
      return item;
    },
    async stop(id) {
      calls.push(['stop', id]);
      const item = workflows.find((workflow) => workflow.id === id);
      if (!item) throw new Error(`Unknown workflow: ${id}`);
      item.status = 'stopped';
      item.watcher = { ...(item.watcher || {}), status: 'stopped' };
      return item;
    },
    async unload(id) {
      calls.push(['unload', id]);
      const index = workflows.findIndex((workflow) => workflow.id === id);
      if (index < 0) return false;
      workflows.splice(index, 1);
      return true;
    },
  };
  const returnValues = {
    runAutomation: { started: true },
    runChecks: { ok: true, results: [{ ok: true, command: 'npm test', code: 0 }] },
    refreshProjectContext: { synced: true },
    startFixLoopAfterFailedChecks: { started: true },
  };
  const manager = new Proxy(managerMethods, {
    get(target, property) {
      if (property in target) return target[property];
      return async (...args) => {
        calls.push([String(property), ...args]);
        return returnValues[property] || { ok: true };
      };
    },
  });
  const bridge = {
    health() { return { activeClient: activeClients[0] || null, clients: activeClients }; },
    async newSession(options) { calls.push(['newSession', options]); return { session: { id: 'c/new' } }; },
    async sendRequest(options) {
      sent.push(options);
      calls.push(['sendRequest', options]);
      return { answer: 'Ready', session: { id: options.sessionId || 'c/new' }, sourceClientId: options.sourceClientId || 'client-1' };
    },
  };
  const fileStore = {
    async importLocalPath(options) {
      imported.push(options);
      calls.push(['importLocalPath', options]);
      return { id: `file-${imported.length}`, name: options.name, path: options.filePath };
    },
    async getReadable(id) { calls.push(['getReadable', id]); return { path: `/tmp/${id}`, name: `${id}.zip` }; },
  };
  const projectService = {
    async pack(root, options) {
      packed.push({ root, options });
      calls.push(['pack', root, options]);
      return { file: { id: 'project-file' }, project: { id: 'project-1' }, snapshotId: 'snapshot-1', sha256: 'sha-1' };
    },
    async markSnapshotUploaded(options) { marked.push(options); calls.push(['markSnapshotUploaded', options]); },
  };
  const runtime = {
    state: {
      projectRoot,
      sessionId: 'c/current',
      model: 'gpt-test', effort: 'high', focusedWorkflowId: '',
      pendingAttachments: [], lastArtifacts: [],
    },
    detailsOpen: false,
    invalidations: 0,
    saved: 0,
    options: { workflowManager: manager, bridge, fileStore, projectService, projectPath: projectRoot },
    invalidate() { this.invalidations += 1; },
    pushEntry(entry) { entries.push(entry); },
    async saveState() { this.saved += 1; },
  };
  return { runtime, manager, calls, entries, sent, imported, packed, marked, workflows, approvals };
}

async function createNodeProject(prefix = 'bridge-wizard-project-') {
  const root = await temporaryRoot(prefix);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'wizard-project', scripts: { test: 'node --test', check: 'node check.js' } }));
  return root;
}

function labels(wizard) {
  return wizard.screen.options.map((item) => item.label);
}

test('opening /workflow is context-sensitive for empty, existing, pending, and pending-only states', async () => {
  const projectRoot = await createNodeProject();
  const empty = createRuntime({ projectRoot });
  const wizard = new WorkflowWizardController(empty.runtime);
  await wizard.open();
  assert.equal(wizard.screen.id, 'goal');
  assert.deepEqual(labels(wizard), ['Apply changes from ChatGPT', 'Fix the project until checks pass', 'Work through a task']);
  wizard.close();
  assert.equal(wizard.model(), null);

  await wizard.open({ pendingOnly: true });
  assert.equal(wizard.opened, false);

  const existingItem = workflowSnapshot({ projectRoot });
  const existing = createRuntime({ projectRoot, workflows: [existingItem] });
  const existingWizard = new WorkflowWizardController(existing.runtime);
  await existingWizard.open();
  assert.equal(existingWizard.screen.id, 'existing');
  assert.deepEqual(labels(existingWizard), [
    'Continue the active workflow', 'View workflows that need attention', 'Start a new workflow',
    'Change workflow settings', 'Pause or stop a workflow', 'Change global workflow defaults',
  ]);

  const pendingItem = workflowSnapshot({ projectRoot, attention: { required: true, kind: 'invalid-response', title: 'Result needs attention', message: 'Missing manifest' } });
  const pending = createRuntime({ projectRoot, workflows: [pendingItem] });
  const pendingWizard = new WorkflowWizardController(pending.runtime);
  await pendingWizard.open();
  assert.equal(pendingWizard.screen.id, 'pending');
  assert.equal(pendingWizard.screen.title, 'Result needs attention');
  assert.deepEqual(labels(pendingWizard), ['Send the instructions again', 'Review the response', 'Ignore this response and keep waiting', 'Stop the workflow']);

  const missingWizard = new WorkflowWizardController(pending.runtime);
  await missingWizard.openForWorkflow('missing');
  assert.equal(missingWizard.opened, false);
});

test('the normal wizard reaches a start summary in five primary decisions and supports custom checks', async () => {
  const projectRoot = await createNodeProject();
  const env = createRuntime({ projectRoot });
  const wizard = new WorkflowWizardController(env.runtime);
  await wizard.open();
  const screens = [wizard.screen.id];

  await wizard.screen.options[0].action();
  screens.push(wizard.screen.id);
  await wizard.screen.options[0].action();
  screens.push(wizard.screen.id);
  await wizard.screen.options[0].action();
  screens.push(wizard.screen.id);
  assert.equal(wizard.screen.id, 'checks');
  assert.deepEqual(wizard.draft.checks, ['npm test', 'npm run check']);

  wizard.index = wizard.screen.options.findIndex((item) => item.special === 'custom-check');
  await wizard.handleKey({ name: 'space' });
  assert.equal(wizard.screen.id, 'text-input');
  await wizard.handleKey({ name: 'paste', text: 'npm run integration' });
  await wizard.handleKey({ name: 'enter' });
  assert.equal(wizard.screen.id, 'checks');
  assert.equal(wizard.draft.checks.includes('npm run integration'), true);
  await wizard.handleKey({ name: 'enter' });
  screens.push(wizard.screen.id);

  assert.deepEqual(screens, ['goal', 'chat', 'project', 'checks', 'summary']);
  assert.match(wizard.screen.message, /Mode:\s+Apply changes from ChatGPT/);
  assert.match(wizard.screen.message, /npm run integration/);
  assert.equal(wizard.screen.options[0].label, 'Start with these recommended global defaults');

  await wizard.screen.options[0].action();
  assert.equal(wizard.opened, true);
  assert.equal(wizard.screen.id, 'started');
  assert.equal(wizard.screen.title, 'Workflow is now watching ChatGPT');
  assert.match(wizard.screen.message, /No \/workflow run command is needed/);
  assert.equal(env.calls.filter((item) => item[0] === 'load').length, 1);
  assert.equal(env.calls.some((item) => item[0] === 'runAutomation'), false);
  assert.equal(env.entries.at(-1).title, 'Watching the ChatGPT tab');
  await wizard.screen.options[0].action();
  assert.equal(wizard.opened, false);

  const global = await loadGlobalWorkflowConfig({ dataDir: isolatedDataDir });
  const profile = Object.values(global.config.profiles).find((item) => item.project === projectRoot && item.preset === 'apply-changes');
  assert.deepEqual(profile.checks, ['npm test', 'npm run check', 'npm run integration']);
});

test('first-run customization covers recovery, commit, iteration, and notification choices', async () => {
  const env = createRuntime();
  const wizard = new WorkflowWizardController(env.runtime);
  wizard.opened = true;
  wizard.global = { firstRun: true, path: path.join(isolatedDataDir, 'custom-first-run.json'), config: defaultGlobalWorkflowConfig() };
  wizard.draft = { preset: 'fix-until-pass', chat: { mode: 'current' }, projectRoot: '/tmp/project', checks: [] };
  wizard.showSummary();
  await wizard.screen.options[1].action();
  assert.equal(wizard.screen.id, 'default-session');
  await wizard.screen.options[1].action();
  assert.equal(wizard.global.config.defaults.sessionExhaustion, 'ask');
  assert.equal(wizard.screen.id, 'default-commits');
  await wizard.screen.options[0].action();
  assert.equal(wizard.screen.id, 'default-iteration-commits');
  await wizard.screen.options[1].action();
  assert.equal(wizard.global.config.defaults.commits.completionStrategy, 'keep-checkpoints');
  assert.equal(wizard.screen.id, 'default-notifications');
  await wizard.screen.options[1].action();
  assert.equal(wizard.global.config.defaults.notifications.enabled, false);
  assert.equal(wizard.defaultsCustomized, true);
  assert.equal(wizard.screen.id, 'summary');
  assert.equal(wizard.screen.options[0].label, 'Start workflow');
});

test('new-chat Fix Until Checks Pass bootstrap uploads two attachments and starts the shared runner', async () => {
  const projectRoot = await createNodeProject('bridge-wizard-new-chat-');
  const env = createRuntime({ projectRoot });
  const wizard = new WorkflowWizardController(env.runtime);
  wizard.global = await loadGlobalWorkflowConfig({ dataDir: isolatedDataDir });
  wizard.global.firstRun = false;
  wizard.draft = {
    preset: 'fix-until-pass',
    chat: { mode: 'new', clientId: 'client-1', sessionId: '', sendInstructions: false },
    projectRoot, checks: ['npm test'], checksInitialized: true, profileName: '', profile: null, overrides: {},
  };
  wizard.opened = true;
  await wizard.startWorkflow();

  assert.equal(env.calls.filter((item) => item[0] === 'newSession').length, 1);
  assert.deepEqual(env.sent[0].attachments, ['project-file', 'file-1']);
  assert.equal(env.marked[0].threadId, 'c/new');
  assert.equal(env.calls.some((item) => item[0] === 'assumeProjectContext' && item[2] === 'c/new'), true);
  const run = env.calls.find((item) => item[0] === 'runAutomation');
  assert.equal(run[2].sessionPolicy, 'pinned');
  assert.equal(run[2].sessionId, 'c/new');
  assert.equal(run[2].model, 'gpt-test');
});

test('existing-chat instruction attachment and Guided Task focus use the same wizard start path', async () => {
  const projectRoot = await createNodeProject('bridge-wizard-guided-');
  const env = createRuntime({ projectRoot });
  const wizard = new WorkflowWizardController(env.runtime);
  wizard.global = await loadGlobalWorkflowConfig({ dataDir: isolatedDataDir });
  wizard.global.firstRun = false;
  wizard.draft = {
    preset: 'guided-task',
    chat: { mode: 'current', clientId: 'client-1', sessionId: 'c/current', sendInstructions: true },
    projectRoot, checks: [], checksInitialized: true, profileName: '', profile: null, overrides: {},
  };
  wizard.opened = true;
  await wizard.startWorkflow();
  assert.deepEqual(env.sent[0].attachments, ['file-1']);
  assert.equal(env.sent[0].sessionId, 'c/current');
  assert.equal(env.runtime.state.focusedWorkflowId.includes('guided-task'), true);
  assert.equal(env.runtime.saved, 1);
  assert.equal(env.calls.some((item) => item[0] === 'runAutomation'), false);
});

test('chat and project selection handle missing tabs, another tab, and typed folder changes', async () => {
  const root = await createNodeProject('bridge-wizard-folder-a-');
  const other = await createNodeProject('bridge-wizard-folder-b-');
  const noTabs = createRuntime({ projectRoot: root, clients: [] });
  const noTabsWizard = new WorkflowWizardController(noTabs.runtime);
  noTabsWizard.opened = true;
  noTabsWizard.showGoal();
  noTabsWizard.chooseGoal('apply-changes');
  noTabsWizard.screen.options[2].action();
  assert.equal(noTabs.entries.at(-1).title, 'No ChatGPT tabs');

  const clients = [
    { id: 'client-1', title: 'One', session: { id: 'c/one' } },
    { id: 'client-2', title: 'Two', session: { id: 'c/two' } },
  ];
  const env = createRuntime({ projectRoot: root, clients });
  const wizard = new WorkflowWizardController(env.runtime);
  wizard.global = await loadGlobalWorkflowConfig({ dataDir: isolatedDataDir });
  wizard.opened = true;
  wizard.showGoal();
  wizard.chooseGoal('guided-task');
  wizard.screen.options[2].action();
  assert.equal(wizard.screen.id, 'other-tab');
  await wizard.screen.options[1].action();
  assert.equal(wizard.draft.chat.clientId, 'client-2');
  assert.equal(wizard.draft.chat.sessionId, 'c/two');
  assert.equal(wizard.screen.id, 'project');

  await wizard.screen.options.at(-1).action();
  assert.equal(wizard.screen.id, 'text-input');
  wizard.screen.inputValue = '';
  await wizard.handleKey({ name: 'paste', text: other });
  await wizard.handleKey({ name: 'backspace' });
  await wizard.handleKey({ printable: true, text: path.basename(other).at(-1) });
  await wizard.handleKey({ name: 'enter' });
  assert.equal(wizard.draft.projectRoot, other);
  assert.equal(wizard.screen.id, 'project');
});

test('check selection supports toggling, no-checks, custom input cancellation, and keyboard navigation', async () => {
  const projectRoot = await createNodeProject('bridge-wizard-check-keys-');
  const env = createRuntime({ projectRoot });
  const wizard = new WorkflowWizardController(env.runtime);
  wizard.global = await loadGlobalWorkflowConfig({ dataDir: isolatedDataDir });
  wizard.opened = true;
  wizard.showGoal();
  wizard.chooseGoal('apply-changes');
  wizard.chooseChat('current', { id: 'client-1', session: { id: 'c/current' } });
  await wizard.showChecks();

  const count = wizard.screen.options.length;
  wizard.index = 0;
  await wizard.handleKey({ name: 'up' });
  assert.equal(wizard.index, count - 1);
  await wizard.handleKey({ name: 'down' });
  assert.equal(wizard.index, 0);
  const firstCommand = wizard.screen.options[0].value;
  await wizard.handleKey({ name: 'space' });
  assert.equal(wizard.draft.checks.includes(firstCommand), false);

  wizard.index = wizard.screen.options.findIndex((item) => item.special === 'no-checks');
  await wizard.handleKey({ name: 'space' });
  assert.deepEqual(wizard.draft.checks, []);
  assert.equal(wizard.screen.options.filter((item) => item.checked).length, 0);

  wizard.index = wizard.screen.options.findIndex((item) => item.special === 'custom-check');
  await wizard.handleKey({ name: 'space' });
  const prior = wizard.returnScreen;
  await wizard.handleKey({ name: 'escape' });
  assert.equal(wizard.screen, prior);

  wizard.setScreen({ id: 'numeric', options: [
    { label: 'Disabled', disabled: true, action: () => { throw new Error('must not run'); } },
    { label: 'Enabled', action: () => { wizard.screen.selected = true; } },
  ] });
  await wizard.handleKey({ text: '2', name: '' });
  assert.equal(wizard.screen.selected, true);
  wizard.screenHistory = [];
  wizard.returnScreen = null;
  wizard.setScreen({ id: 'close-me', options: [] }, { replace: true });
  await wizard.handleKey({ name: 'escape' });
  assert.equal(wizard.opened, false);
});

test('Guided Task response actions cover text responses, files, checks, attachments, refresh, and finish', async () => {
  const projectRoot = await createNodeProject('bridge-wizard-guided-actions-');
  const item = workflowSnapshot({ id: 'guided-1', preset: 'guided-task', projectRoot });
  const env = createRuntime({ projectRoot, workflows: [item] });
  env.runtime.state.lastArtifacts = [{ id: 'artifact-1', name: 'result.zip' }];
  const localFile = path.join(projectRoot, 'log.txt');
  await fs.writeFile(localFile, 'log output');
  const wizard = new WorkflowWizardController(env.runtime);
  wizard.global = await loadGlobalWorkflowConfig({ dataDir: isolatedDataDir });

  wizard.showGuidedResponse(item, {});
  assert.equal(wizard.screen.id, 'guided-response');
  assert.deepEqual(labels(wizard), [
    'Continue with a follow-up question', 'Run project checks', 'Attach logs or files to the next prompt',
    'Refresh the remote project context', 'Finish the task',
  ]);
  await wizard.screen.options[1].action();
  assert.equal(env.entries.at(-1).title, 'Project checks passed');
  assert.equal(wizard.screen.id, 'guided-response');

  await wizard.screen.options.find((option) => option.label.startsWith('Attach logs')).action();
  assert.equal(wizard.screen.id, 'guided-attachments');
  await wizard.screen.options[0].action();
  assert.equal(env.runtime.state.pendingAttachments[0].id, 'artifact-1');
  await wizard.screen.options[0].action();
  assert.equal(env.runtime.state.pendingAttachments.length, 1, 'recent attachments are deduplicated');
  await wizard.screen.options.find((option) => option.label === 'Choose a local file').action();
  wizard.screen.inputValue = localFile;
  await wizard.handleKey({ name: 'enter' });
  assert.equal(env.runtime.state.pendingAttachments.length, 2);

  wizard.showGuidedResponse(item, {});
  await wizard.screen.options.find((option) => option.label.startsWith('Refresh')).action();
  assert.equal(env.entries.at(-1).title, 'Project context');
  assert.match(env.entries.at(-1).body, /uploaded/);

  wizard.showGuidedResponse(item, { artifacts: [{ id: 'zip-1', name: 'changes.zip' }] });
  assert.equal(labels(wizard).includes('Review returned files'), true);
  assert.equal(labels(wizard).includes('Apply returned files'), true);
  await wizard.screen.options.find((option) => option.label === 'Review returned files').action();
  assert.equal(env.entries.at(-1).title, 'Returned files');

  wizard.showGuidedResponse(item, {});
  await wizard.screen.options.find((option) => option.label === 'Finish the task').action();
  assert.equal(env.calls.some((call) => call[0] === 'completeGuidedWorkflow' && call[1] === 'guided-1'), true);
  assert.equal(env.runtime.state.focusedWorkflowId, '');
  assert.equal(wizard.opened, false);
});

test('existing workflow menus expose start, settings, pause, stop, config reload, and config path actions', async () => {
  const projectRoot = await createNodeProject('bridge-wizard-existing-actions-');
  const item = workflowSnapshot({ projectRoot, automation: { status: 'idle' } });
  const env = createRuntime({ projectRoot, workflows: [item] });
  const wizard = new WorkflowWizardController(env.runtime);
  wizard.global = await loadGlobalWorkflowConfig({ dataDir: isolatedDataDir });
  wizard.opened = true;

  wizard.showExistingMenu([item]);
  await wizard.screen.options[0].action();
  assert.equal(wizard.screen.id, 'workflow-actions');
  await wizard.screen.options[0].action();
  assert.equal(env.calls.some((call) => call[0] === 'runAutomation'), true);

  wizard.opened = true;
  wizard.showWorkflowSettingsSelection([item]);
  await wizard.screen.options[0].action();
  assert.equal(wizard.screen.id, 'workflow-settings');
  assert.equal(labels(wizard).includes('Notifications'), true);
  await wizard.screen.options.find((option) => option.label === 'Notifications').action();
  const update = env.calls.find((call) => call[0] === 'updateWorkflowSettings');
  assert.equal(update[1], item.id);
  assert.equal(update[2].notifications.enabled, false);
  const global = await loadGlobalWorkflowConfig({ dataDir: isolatedDataDir });
  assert.equal(global.config.profiles[item.id].defaults.notifications.enabled, false);

  wizard.opened = true;
  wizard.global = global;
  wizard.showStopChoices([item]);
  await wizard.screen.options[0].action();
  assert.equal(wizard.screen.id, 'stop-action');
  assert.deepEqual(labels(wizard), ['Pause the workflow', 'Stop the active run', 'Go back']);
  await wizard.screen.options[0].action();
  assert.equal(env.calls.some((call) => call[0] === 'pauseAutomation'), true);

  wizard.opened = true;
  wizard.global = global;
  wizard.showConfigActions();
  await wizard.screen.options[1].action();
  assert.equal(env.entries.at(-1).title, 'Workflow configuration');
  wizard.opened = true;
  wizard.global = global;
  wizard.showConfigActions();
  await wizard.screen.options[0].action();
  assert.equal(env.calls.some((call) => call[0] === 'reloadGlobalConfig'), true);
  assert.equal(env.entries.at(-1).title, 'Workflow configuration reloaded');
});

test('per-workflow setting screens persist enum, numeric, and commit strategy overrides', async () => {
  const projectRoot = await createNodeProject('bridge-wizard-settings-');
  const item = workflowSnapshot({ id: 'settings-1', projectRoot });
  const env = createRuntime({ projectRoot, workflows: [item] });
  const wizard = new WorkflowWizardController(env.runtime);
  wizard.global = await loadGlobalWorkflowConfig({ dataDir: isolatedDataDir });
  wizard.opened = true;

  wizard.chooseWorkflowSetting(item, 'sessionExhaustion', [['Stop', 'stop']]);
  await wizard.screen.options[0].action();
  let update = env.calls.filter((call) => call[0] === 'updateWorkflowSettings').at(-1);
  assert.equal(update[2].sessionExhaustion, 'stop');

  wizard.chooseWorkflowSetting(item, 'commits.mode', [['Disable', 'disabled']]);
  await wizard.screen.options[0].action();
  update = env.calls.filter((call) => call[0] === 'updateWorkflowSettings').at(-1);
  assert.equal(update[2].commits.mode, 'disabled');

  wizard.chooseCommitStrategy(item);
  await wizard.screen.options[2].action();
  update = env.calls.filter((call) => call[0] === 'updateWorkflowSettings').at(-1);
  assert.equal(update[2].commits.iterationStrategy, 'final-only');

  wizard.showWorkflowSettings(item);
  await wizard.screen.options.find((option) => option.label === 'Maximum ChatGPT turns per chat').action();
  wizard.screen.inputValue = '0';
  await wizard.handleKey({ name: 'enter' });
  update = env.calls.filter((call) => call[0] === 'updateWorkflowSettings').at(-1);
  assert.equal(update[2].session.maxTurns, 40, 'invalid numeric input falls back to the documented default');
});

test('pending approvals and interrupted workflows dispatch through the same contextual decision screen', async () => {
  const item = workflowSnapshot();
  const approval = { id: 'approval-1', workflowId: item.id, status: 'pending', plan: { create: ['a.js'] } };
  const env = createRuntime({ workflows: [item], approvals: [approval] });
  const wizard = new WorkflowWizardController(env.runtime);
  wizard.opened = true;
  await wizard.showPending(item, [approval]);
  assert.deepEqual(labels(wizard), ['Apply these changes', 'Review the change plan', 'Reject this response', 'Stop the workflow']);
  await wizard.screen.options[1].action();
  assert.equal(env.entries.at(-1).title, 'Workflow change plan');
  assert.equal(wizard.opened, true, 'review keeps the pending screen available');
  await wizard.screen.options[0].action();
  assert.equal(env.calls.some((call) => call[0] === 'approve' && call[1] === approval.id), true);

  const interrupted = workflowSnapshot({ automationInterrupted: true });
  const interruptedEnv = createRuntime({ workflows: [interrupted] });
  const interruptedWizard = new WorkflowWizardController(interruptedEnv.runtime);
  interruptedWizard.opened = true;
  await interruptedWizard.showPending(interrupted, []);
  assert.deepEqual(labels(interruptedWizard), ['Resume the workflow', 'Discard the interrupted run', 'Stop the workflow']);
  await interruptedWizard.screen.options[1].action();
  assert.equal(interruptedEnv.calls.some((call) => call[0] === 'discardAutomation'), true);
});

test('every attention kind dispatches its primary contextual action without extra commands', async (t) => {
  const cases = [
    ['commit-confirmation', { pendingCommit: { message: 'Commit', paths: ['app.js'] } }, 'approvePendingCommit'],
    ['checks-failed', {}, 'startFixLoopAfterFailedChecks'],
    ['session-exhausted', {}, 'recoverSessionAndRestart'],
    ['invalid-response', {}, 'requestResultRepair'],
    ['paused', {}, 'resumeAutomation'],
    ['error', {}, 'restartAutomation', 1],
  ];
  for (const [kind, extra, method, index = 0] of cases) {
    await t.test(kind, async () => {
      const item = workflowSnapshot({ ...extra, attention: { required: true, kind, title: kind, message: 'Choose' } });
      const env = createRuntime({ workflows: [item] });
      const wizard = new WorkflowWizardController(env.runtime);
      wizard.opened = true;
      await wizard.showPending(item, []);
      await wizard.screen.options[index].action();
      assert.equal(env.calls.some((call) => call[0] === method), true, method);
    });
  }

  await t.test('local conflict refreshes context before restart', async () => {
    const item = workflowSnapshot({ attention: { required: true, kind: 'local-conflict', message: 'Conflict' } });
    const env = createRuntime({ workflows: [item] });
    const wizard = new WorkflowWizardController(env.runtime);
    wizard.opened = true;
    await wizard.showPending(item, []);
    await wizard.screen.options[0].action();
    const methods = env.calls.map((call) => call[0]);
    assert.equal(methods.indexOf('refreshProjectContext') < methods.indexOf('restartAutomation'), true);
  });

  await t.test('no progress requests a materially different approach', async () => {
    const item = workflowSnapshot({ attention: { required: true, kind: 'no-progress', message: 'Same failures' } });
    const env = createRuntime({ workflows: [item] });
    const wizard = new WorkflowWizardController(env.runtime);
    wizard.opened = true;
    await wizard.showPending(item, []);
    await wizard.screen.options[0].action();
    const restart = env.calls.find((call) => call[0] === 'restartAutomation');
    assert.match(restart[2].approachInstruction, /materially different approach/);
  });

  await t.test('completed workflow returns to interactive mode', async () => {
    const item = workflowSnapshot({ attention: { required: false, kind: 'completed', message: 'Done' } });
    const env = createRuntime({ workflows: [item] });
    env.runtime.state.focusedWorkflowId = item.id;
    const wizard = new WorkflowWizardController(env.runtime);
    wizard.opened = true;
    await wizard.showPending(item, []);
    await wizard.screen.options[0].action();
    assert.equal(env.runtime.state.focusedWorkflowId, '');
    assert.equal(env.runtime.saved, 1);
  });
});

test('secondary attention actions review details, continue explicitly, restore state, and stop safely', async () => {
  const checkItem = workflowSnapshot({
    attention: { required: true, kind: 'checks-failed', message: 'Checks failed' },
    pendingCheckFailure: { commands: [{ command: 'npm test', code: 1, stdout: 'out', stderr: 'err' }] },
  });
  const checkEnv = createRuntime({ workflows: [checkItem] });
  const checkWizard = new WorkflowWizardController(checkEnv.runtime);
  checkWizard.opened = true;
  await checkWizard.showPending(checkItem, []);
  await checkWizard.screen.options[3].action();
  assert.equal(checkEnv.entries.at(-1).title, 'Project check output');
  assert.equal(checkWizard.opened, true);

  const localItem = workflowSnapshot({ attention: { required: true, kind: 'local-conflict', message: 'Conflict' } });
  const localEnv = createRuntime({ workflows: [localItem] });
  const localWizard = new WorkflowWizardController(localEnv.runtime);
  localWizard.opened = true;
  await localWizard.showPending(localItem, []);
  await localWizard.screen.options[2].action();
  assert.equal(localEnv.entries.at(-1).title, 'Continuing with stale ChatGPT context');
  assert.equal(localEnv.calls.some((call) => call[0] === 'restartAutomation' && call[2].trigger === 'continue-without-refresh'), true);

  const progressItem = workflowSnapshot({ attention: { required: true, kind: 'no-progress', message: 'No progress' } });
  const progressEnv = createRuntime({ workflows: [progressItem] });
  const progressWizard = new WorkflowWizardController(progressEnv.runtime);
  progressWizard.opened = true;
  await progressWizard.showPending(progressItem, []);
  await progressWizard.screen.options[3].action();
  const methods = progressEnv.calls.map((call) => call[0]);
  assert.equal(methods.includes('stopAutomation'), true);
  assert.equal(methods.includes('restoreStartingState'), true);

  const invalidItem = workflowSnapshot({ attention: { required: true, kind: 'invalid-response', message: 'Invalid' } });
  const invalidEnv = createRuntime({ workflows: [invalidItem] });
  const invalidWizard = new WorkflowWizardController(invalidEnv.runtime);
  invalidWizard.opened = true;
  await invalidWizard.showPending(invalidItem, []);
  await invalidWizard.screen.options[2].action();
  assert.equal(invalidEnv.calls.filter((call) => call[0] === 'acknowledgeAttention').length >= 1, true);
});

test('wizard operation failures remain visible and never leave the UI busy', async () => {
  const env = createRuntime();
  const wizard = new WorkflowWizardController(env.runtime);
  wizard.opened = true;
  const result = await wizard.run(async () => { throw new Error('setup exploded'); });
  assert.equal(result, null);
  assert.equal(wizard.busy, false);
  assert.equal(env.entries.at(-1).title, 'Workflow setup failed');
  assert.equal(env.entries.at(-1).body, 'setup exploded');
});

test('wizard accepts the printable space key and back navigation preserves changed selections', async () => {
  const projectRoot = await createNodeProject('bridge-wizard-back-');
  const env = createRuntime({ projectRoot });
  const wizard = new WorkflowWizardController(env.runtime);
  await wizard.open();
  await wizard.screen.options[0].action();
  await wizard.screen.options[0].action();
  await wizard.screen.options[0].action();
  assert.equal(wizard.screen.id, 'checks');

  const command = wizard.screen.options[0].value;
  assert.equal(wizard.screen.options[0].checked, true);
  await wizard.handleKey({ printable: true, text: ' ', sequence: ' ' });
  assert.equal(wizard.screen.options[0].checked, false);
  assert.equal(wizard.draft.checks.includes(command), false);

  await wizard.handleKey({ name: 'enter' });
  assert.equal(wizard.screen.id, 'summary');
  await wizard.handleKey({ name: 'escape' });
  assert.equal(wizard.screen.id, 'checks');
  assert.equal(wizard.screen.options[0].checked, false);
  assert.equal(wizard.draft.checks.includes(command), false);

  await wizard.handleKey({ name: 'escape' });
  assert.equal(wizard.screen.id, 'project');
  await wizard.screen.options[0].action();
  assert.equal(wizard.screen.id, 'checks');
  assert.equal(wizard.screen.options[0].checked, false);
});

test('workflow setup failures stay in the wizard with retry and edit actions', async () => {
  const projectRoot = await createNodeProject('bridge-wizard-failure-');
  const env = createRuntime({ projectRoot });
  env.runtime.options.workflowManager.load = async () => {
    throw new Error('browser setup conflict');
  };
  const wizard = new WorkflowWizardController(env.runtime);
  await wizard.open();
  await wizard.screen.options[0].action();
  await wizard.screen.options[0].action();
  await wizard.screen.options[0].action();
  await wizard.handleKey({ name: 'enter' });
  assert.equal(wizard.screen.id, 'summary');

  await wizard.startWorkflow();
  assert.equal(wizard.opened, true);
  assert.equal(wizard.screen.id, 'setup-failed');
  assert.match(wizard.screen.message, /browser setup conflict/i);
  assert.deepEqual(labels(wizard), ['Retry starting the workflow', 'Return to the setup summary', 'Close the wizard']);
  await wizard.screen.options[1].action();
  assert.equal(wizard.screen.id, 'summary');
});

test('Apply Changes controls start and pause the passive watcher with explicit guidance', async () => {
  const projectRoot = await createNodeProject('bridge-wizard-apply-controls-');
  const item = workflowSnapshot({
    id: 'apply-1', preset: 'apply-changes', label: 'Apply changes from ChatGPT', projectRoot,
    status: 'stopped', watcher: { status: 'stopped' }, automation: { status: 'idle' }, pipeline: { status: 'idle' },
  });
  const env = createRuntime({ projectRoot, workflows: [item] });
  const wizard = new WorkflowWizardController(env.runtime);
  wizard.global = await loadGlobalWorkflowConfig({ dataDir: isolatedDataDir });
  wizard.opened = true;

  wizard.showWorkflowActions(item);
  assert.equal(wizard.screen.options[0].label, 'Start watching this ChatGPT tab');
  await wizard.screen.options[0].action();
  assert.equal(env.calls.some((call) => call[0] === 'start' && call[1] === 'apply-1'), true);
  assert.equal(env.entries.at(-1).title, 'Watching the ChatGPT tab');
  assert.match(env.entries.at(-1).body, /Continue the conversation in the selected ChatGPT browser tab/);
  assert.equal(wizard.opened, false);

  wizard.opened = true;
  wizard.stopWorkflow(item);
  assert.equal(wizard.screen.options[0].label, 'Pause watching this ChatGPT tab');
  await wizard.screen.options[0].action();
  assert.equal(env.calls.some((call) => call[0] === 'stop' && call[1] === 'apply-1'), true);
  assert.equal(env.calls.some((call) => call[0] === 'pauseAutomation'), false);
  assert.equal(env.entries.at(-1).title, 'Workflow paused');
});

test('failed apply approval remains actionable and explains the failure in transcript', async () => {
  const item = workflowSnapshot();
  const approval = { id: 'approval-retry', workflowId: item.id, status: 'pending', plan: { policyOk: true, changedFiles: 1, counts: { create: 0, update: 1, delete: 0, unchanged: 2 }, writePathsPreview: ['src/app.js'], deletePathsPreview: [] } };
  const env = createRuntime({ workflows: [item], approvals: [approval] });
  env.runtime.options.workflowManager.approve = async () => { throw new Error('Workflow changes overlap existing local edits: src/app.js'); };
  const wizard = new WorkflowWizardController(env.runtime);
  wizard.opened = true;
  await wizard.showPending(item, [approval]);
  await wizard.screen.options[0].action();
  assert.equal(wizard.opened, true);
  assert.equal(wizard.screen.id, 'pending');
  assert.equal(env.entries.at(-1).title, 'Why the changes were not applied');
  assert.match(env.entries.at(-1).body, /overlap existing local edits/);
});

test('workflow change plan is rendered as readable text instead of JSON', async () => {
  const item = workflowSnapshot();
  const approval = { id: 'approval-plan', workflowId: item.id, status: 'pending', plan: { policyOk: false, policyReasons: ['local edits overlap'], requiresConfirmation: true, changedFiles: 2, counts: { create: 1, update: 1, delete: 0, unchanged: 3 }, writePathsPreview: ['src/a.js', 'src/b.js'], deletePathsPreview: [] } };
  const env = createRuntime({ workflows: [item], approvals: [approval] });
  const wizard = new WorkflowWizardController(env.runtime);
  wizard.opened = true;
  await wizard.showPending(item, [approval]);
  await wizard.screen.options[1].action();
  const body = env.entries.at(-1).body;
  assert.match(body, /Policy: requires attention/);
  assert.match(body, /Create: 1 .* Update: 1/);
  assert.match(body, /Files to write:\n- src\/a\.js/);
  assert.doesNotMatch(body, /^\s*\{/);
});
