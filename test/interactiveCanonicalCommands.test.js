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
