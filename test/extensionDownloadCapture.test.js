import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

function makeEvent() {
  const listeners = [];
  return {
    addListener(fn) { listeners.push(fn); },
    emit(...args) { for (const fn of listeners) fn(...args); },
  };
}

async function loadBackground() {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/background.js'), 'utf8');
  const onCreated = makeEvent();
  const onChanged = makeEvent();
  const onConnect = makeEvent();
  const downloadsById = new Map();
  const timers = [];
  const context = vm.createContext({
    URL,
    WebSocket: class {},
    fetch: async () => ({ ok: true, status: 200, text: async () => '' }),
    console,
    setTimeout(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    chrome: {
      runtime: { lastError: null, onMessage: makeEvent(), onConnect },
      downloads: {
        onCreated,
        onChanged,
        search(query, callback) { callback(query?.id != null && downloadsById.has(query.id) ? [downloadsById.get(query.id)] : []); },
      },
    },
  });
  vm.runInContext(source, context, { filename: 'background.js' });
  return { context, onCreated, onChanged, onConnect, downloadsById, timers };
}

function makePort() {
  return {
    name: 'chatgpt-bridge-tab',
    sender: { tab: { id: 42 } },
    messages: [],
    onMessage: makeEvent(),
    onDisconnect: makeEvent(),
    postMessage(message) { this.messages.push(message); },
  };
}

function responseFor(port, requestId) {
  return port.messages.findLast((message) => message.type === 'extension.response' && message.requestId === requestId);
}

test('chrome download capture ignores an unrelated download and binds the expected artifact filename', async () => {
  const runtime = await loadBackground();
  const port = makePort();
  runtime.onConnect.emit(port);

  port.onMessage.emit({
    type: 'bridge.download.capture.begin',
    requestId: 'begin-1',
    expectedName: 'artifact-table.csv',
    timeoutMs: 30_000,
  });
  const captureId = responseFor(port, 'begin-1').result.captureId;

  runtime.onCreated.emit({ id: 1, filename: '/Downloads/unrelated.png', url: 'https://example.com/unrelated.png', state: 'complete' });
  port.onMessage.emit({ type: 'bridge.download.capture.wait', requestId: 'wait-1', captureId, timeoutMs: 30_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responseFor(port, 'wait-1'), undefined);

  runtime.onCreated.emit({ id: 2, filename: '/Downloads/artifact-table (1).csv', url: 'https://chatgpt.com/backend-api/files/2', state: 'complete', mime: 'text/csv', fileSize: 12 });
  await new Promise((resolve) => setImmediate(resolve));
  const response = responseFor(port, 'wait-1');
  assert.equal(response.error, undefined);
  assert.equal(response.result.id, 2);
  assert.match(response.result.filename, /artifact-table \(1\)\.csv$/);
  assert.equal(response.result.captureId, captureId);
  assert.ok(response.result.captureStartedAt > 0);
  assert.ok(response.result.capturedAt >= response.result.captureStartedAt);
  assert.ok(response.result.expectedNames.includes('artifact-table.csv'));
});

test('unused chrome download capture can be cancelled so it cannot steal a later download', async () => {
  const runtime = await loadBackground();
  const port = makePort();
  runtime.onConnect.emit(port);

  port.onMessage.emit({ type: 'bridge.download.capture.begin', requestId: 'begin-2', expectedName: 'archive.zip', timeoutMs: 30_000 });
  const captureId = responseFor(port, 'begin-2').result.captureId;
  port.onMessage.emit({ type: 'bridge.download.capture.cancel', requestId: 'cancel-2', captureId, reason: 'page blob won' });
  assert.equal(responseFor(port, 'cancel-2').result.cancelled, true);

  runtime.onCreated.emit({ id: 3, filename: '/Downloads/archive.zip', url: 'https://chatgpt.com/backend-api/files/3', state: 'complete' });
  port.onMessage.emit({ type: 'bridge.download.capture.wait', requestId: 'wait-2', captureId, timeoutMs: 30_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(responseFor(port, 'wait-2').error, /Unknown download capture/);
});


test('chrome download capture accepts an exact display-title alias added after preview identification', async () => {
  const runtime = await loadBackground();
  const port = makePort();
  runtime.onConnect.emit(port);

  port.onMessage.emit({
    type: 'bridge.download.capture.begin',
    requestId: 'begin-alias',
    expectedName: 'project-result.zip',
    timeoutMs: 30_000,
  });
  const captureId = responseFor(port, 'begin-alias').result.captureId;
  port.onMessage.emit({
    type: 'bridge.download.capture.add_expected_names',
    requestId: 'alias-1',
    captureId,
    expectedNames: ['Release bundle.zip'],
  });
  assert.equal(responseFor(port, 'alias-1').result.updated, true);

  runtime.onCreated.emit({
    id: 4,
    filename: '/Downloads/Release bundle.zip',
    url: 'https://chatgpt.com/backend-api/files/4',
    state: 'complete',
    mime: 'application/zip',
    fileSize: 9,
  });
  port.onMessage.emit({ type: 'bridge.download.capture.wait', requestId: 'wait-alias', captureId, timeoutMs: 30_000 });
  await new Promise((resolve) => setImmediate(resolve));
  const response = responseFor(port, 'wait-alias');
  assert.equal(response.error, undefined);
  assert.equal(response.result.id, 4);
});
