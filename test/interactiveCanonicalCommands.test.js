import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCommand } from '../src/interactive/runtime.js';
import { makeDefaultState } from '../src/interactive/state.js';

async function captureLogs(run) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return { result: await run(), lines };
  } finally {
    console.log = original;
  }
}

function bridgeWithClients(overrides = {}) {
  const clients = [
    { id: 'client-a', url: 'https://chatgpt.com/c/a', compatible: true },
    { id: 'client-b', url: 'https://chatgpt.com/c/b', compatible: true },
  ];
  return {
    health: () => ({
      transport: 'extension',
      clients,
      activeClient: null,
      selectedClientId: '',
      pendingRequests: 0,
      needsSelection: true,
    }),
    ...overrides,
  };
}

test('/tab commands call only canonical browser selection operations', async () => {
  let selected = '';
  let cleared = 0;
  const bridge = bridgeWithClients({
    selectClient(id) {
      selected = id;
      return { id, url: `https://chatgpt.com/c/${id}` };
    },
    clearSelectedClient() { cleared += 1; },
  });
  const state = makeDefaultState();

  const first = await captureLogs(() => handleCommand('/tab 2', { bridge, fileStore: {}, state }));
  assert.equal(first.result, true);
  assert.equal(selected, 'client-b');
  assert.ok(first.lines.some((line) => line.includes('Selected client: client-b')));

  const second = await captureLogs(() => handleCommand('/tab auto', { bridge, fileStore: {}, state }));
  assert.equal(second.result, true);
  assert.equal(cleared, 1);
  assert.ok(second.lines.some((line) => line.includes('Client selection cleared')));
});

test('/file commands mutate the attachment queue through one canonical command family', async () => {
  const imported = [];
  const fileStore = {
    async importLocalPath({ filePath }) {
      imported.push(filePath);
      return { id: `file-${imported.length}`, name: filePath.split('/').pop(), size: 12 };
    },
  };
  const state = makeDefaultState();

  await captureLogs(() => handleCommand('/file add /tmp/one.txt /tmp/two.txt', { bridge: {}, fileStore, state }));
  assert.deepEqual(imported, ['/tmp/one.txt', '/tmp/two.txt']);
  assert.deepEqual(state.pendingAttachments.map((file) => file.id), ['file-1', 'file-2']);

  await captureLogs(() => handleCommand('/file remove 1', { bridge: {}, fileStore, state }));
  assert.deepEqual(state.pendingAttachments.map((file) => file.id), ['file-2']);

  await captureLogs(() => handleCommand('/file clear', { bridge: {}, fileStore, state }));
  assert.deepEqual(state.pendingAttachments, []);
});

test('/chat sends a direct prompt without translating it to a hidden command', async () => {
  let request = null;
  const bridge = {
    async sendRequest(input) {
      request = input;
      return {
        requestId: 'request-chat-1',
        answer: 'Direct answer',
        artifacts: [],
        session: { id: 'session-chat' },
      };
    },
  };
  const state = makeDefaultState();
  const stream = {
    status() {},
    onThinkingUpdate() {},
    onProgressUpdate() {},
    onAnswerUpdate() {},
    onArtifactUpdate() {},
    finish() {},
  };

  const result = await captureLogs(() => handleCommand('/chat explain this', {
    bridge,
    fileStore: {},
    state,
    projectService: null,
    createConsoleStream: () => stream,
  }));

  assert.equal(result.result, true);
  assert.equal(request.message, 'explain this');
  assert.deepEqual(request.attachments, []);
  assert.equal(state.sessionId, 'session-chat');
  assert.equal(state.responseHistory[0].source, 'chat');
  assert.equal(state.responseHistory[0].text, 'Direct answer');
});

test('/workflow run explains and resumes Apply Changes watcher instead of invoking disabled automation', async () => {
  const workflow = {
    id: 'apply-watch', preset: 'apply-changes', label: 'Apply changes from ChatGPT', projectRoot: '/tmp/project',
    lifecycle: 'stopped', execution: { subscription: { enabled: false } }, binding: { clientId: '', sessionId: 'c/watched' }, run: { id: '', phase: 'none', source: {} },
    sessionPolicy: 'pinned', pinnedSessionId: 'c/watched', restartPolicy: 'ask', contextSyncFingerprint: 'sha',
  };
  let starts = 0;
  let automationRuns = 0;
  const workflowManager = {
    list: () => [workflow],
    get: () => workflow,
    approvals: async () => [],
    async start() {
      starts += 1;
      workflow.lifecycle = 'ready';
      workflow.execution.subscription = { enabled: true };
      return workflow;
    },
    async runAutomation() { automationRuns += 1; throw new Error('must not run automation'); },
  };
  const state = makeDefaultState();
  const output = await captureLogs(() => handleCommand('/workflow run', { bridge: {}, fileStore: {}, state, workflowManager }));
  assert.equal(output.result, true);
  assert.equal(starts, 1);
  assert.equal(automationRuns, 0);
  assert.ok(output.lines.some((line) => /watching the selected ChatGPT tab/i.test(line)));
  assert.ok(output.lines.some((line) => /Continue the conversation in that browser tab/i.test(line)));
  assert.ok(output.lines.some((line) => /Current step:\s+Watching the ChatGPT tab/i.test(line)));
});

test('/workflow wizard is an alias for opening the context-sensitive wizard', async () => {
  const calls = [];
  const state = makeDefaultState();
  const workflowManager = { list: () => [] };
  const result = await captureLogs(() => handleCommand('/workflow wizard', {
    bridge: {}, fileStore: {}, state, workflowManager,
    async openWorkflowWizard(options) { calls.push(options); },
  }));
  assert.equal(result.result, true);
  assert.deepEqual(calls, [{ view: '', pendingOnly: false }]);
});

test('/effort auto remains an explicit project preference for connection synchronization', async () => {
  const state = makeDefaultState();
  await captureLogs(() => handleCommand('/effort auto', { bridge: {}, fileStore: {}, state }));
  assert.equal(state.effort, 'auto');
  await captureLogs(() => handleCommand('/effort default', { bridge: {}, fileStore: {}, state }));
  assert.equal(state.effort, '');
});

test('/model list and /effort list update observed values without overwriting project preferences', async () => {
  const state = makeDefaultState();
  state.model = 'Saved project model';
  state.effort = 'xhigh';
  const bridge = {
    async listModels() { return { models: [{ label: 'Current model', selected: true }], current: { label: 'Current model' } }; },
    async listEfforts() { return { efforts: [{ id: 'high', value: 'high', selected: true }], current: { id: 'high', value: 'high' } }; },
  };
  await captureLogs(() => handleCommand('/model list', { bridge, fileStore: {}, state }));
  await captureLogs(() => handleCommand('/effort list', { bridge, fileStore: {}, state }));
  assert.equal(state.currentModel, 'Current model');
  assert.equal(state.currentEffort, 'high');
  assert.equal(state.model, 'Saved project model');
  assert.equal(state.effort, 'xhigh');
});
