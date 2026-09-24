import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCommand } from '../src/interactive/runtime.js';
import { shellSplit } from '../src/interactive/format.js';
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

test('command parsing preserves Windows paths while retaining escaped spaces', () => {
  assert.deepEqual(
    shellSplit('/apply C:\\Users\\balaj\\AppData\\Local\\Temp\\result.zip --plan'),
    ['/apply', 'C:\\Users\\balaj\\AppData\\Local\\Temp\\result.zip', '--plan'],
  );
  assert.deepEqual(shellSplit('/chat hello\\ world'), ['/chat', 'hello world']);
  assert.deepEqual(shellSplit('/apply "C:\\Users\\balaj\\Project Files\\result.zip" --plan'), [
    '/apply', 'C:\\Users\\balaj\\Project Files\\result.zip', '--plan',
  ]);
  assert.deepEqual(shellSplit('/file add /opt/bridge/result.zip /tmp/plain.txt'), [
    '/file', 'add', '/opt/bridge/result.zip', '/tmp/plain.txt',
  ]);
  assert.deepEqual(shellSplit('/apply /tmp/project\\ with\\ spaces/result.zip --plan'), [
    '/apply', '/tmp/project with spaces/result.zip', '--plan',
  ]);
  assert.deepEqual(shellSplit('/apply "/tmp/project with spaces/result.zip" --plan'), [
    '/apply', '/tmp/project with spaces/result.zip', '--plan',
  ]);
});

test('/tab selection triggers visual identification for the selected browser client', async () => {
  let selected = '';
  let cleared = 0;
  const identified = [];
  const bridge = bridgeWithClients({
    selectClient(id) {
      selected = id;
      return { id, url: `https://chatgpt.com/c/${id}` };
    },
    async identifyBrowserTab(id, options = {}) {
      identified.push({ id, options });
      return { identified: true };
    },
    clearSelectedClient() { cleared += 1; },
  });
  const state = makeDefaultState();

  const first = await captureLogs(() => handleCommand('/tab 2', { bridge, fileStore: {}, state }));
  assert.equal(first.result, true);
  assert.equal(selected, 'client-b');
  assert.ok(first.lines.some((line) => line.includes('Selected client: client-b')));
  assert.equal(identified.length, 1);
  assert.equal(identified[0].id, 'client-b');
  assert.match(identified[0].options.label, /Tab 2/);

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

test('/apply --force is rejected because interactive apply has one server-backed implementation', async () => {
  const state = makeDefaultState();
  state.projectRoot = '/project';
  await assert.rejects(
    handleCommand('/apply --force', {
      bridge: {}, fileStore: {}, state, zipflowWorkflowRuntime: {},
    }),
    (error) => error?.code === 'WORKFLOW_FORCE_UNSUPPORTED',
  );
});


test('bare /workflow opens the server workflow surface directly', async () => {
  const state = makeDefaultState();
  state.projectRoot = '/tmp/project';
  const calls = [];
  const result = await captureLogs(() => handleCommand('/workflow', {
    bridge: {},
    fileStore: {},
    state,
    zipflowWorkflowRuntime: {
      async openProject(projectRoot) { calls.push(['server-open', projectRoot]); return { workflowId: 'server-1' }; },
    },
    async openWorkflowSurface() { calls.push(['surface']); },
  }));
  assert.equal(result.result, true);
  assert.deepEqual(calls, [['server-open', '/tmp/project'], ['surface']]);
});


test('removed workflow compatibility subcommands are rejected by the server workflow command surface', async () => {
  const state = makeDefaultState();
  state.projectRoot = '/tmp/project';
  const context = {
    bridge: {},
    fileStore: {},
    state,
    zipflowWorkflowRuntime: {
      async openProject() { return { workflowId: 'server-1' }; },
    },
  };
  for (const command of ['/workflow legacy', '/workflow migrate old-1', '/workflow wizard', '/workflow run']) {
    await assert.rejects(
      handleCommand(command, context),
      /Usage: \/workflow/,
      command,
    );
  }
});
