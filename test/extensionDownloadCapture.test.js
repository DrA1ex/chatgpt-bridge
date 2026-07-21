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
  const modulePaths = [
    'tools/chrome-bridge-extension/shared/commandManifest.js',
    'tools/chrome-bridge-extension/shared/protocolV5Manifest.js',
    'tools/chrome-bridge-extension/background/stateV6.js',
    'tools/chrome-bridge-extension/background/protocolV5.js',
    'tools/chrome-bridge-extension/background/outboxV5.js',
    'tools/chrome-bridge-extension/background/tabOperationQueue.js',
    'tools/chrome-bridge-extension/background/operationPriorityPolicy.js',
    'tools/chrome-bridge-extension/background/serverEnvelopeRouter.js',
    'tools/chrome-bridge-extension/background/downloadCoordinator.js',
    'tools/chrome-bridge-extension/background/maintenanceOperations.js',
    'tools/chrome-bridge-extension/background/extensionReloadCoordinator.js',
    'tools/chrome-bridge-extension/background/authPreflight.js',
    'tools/chrome-bridge-extension/background/tabController.js',
    'tools/chrome-bridge-extension/background/portRouter.js',
    'tools/chrome-bridge-extension/background.js',
  ];
  const source = (await Promise.all(modulePaths.map((file) => fs.readFile(path.resolve(file), 'utf8')))).join('\n')
    .replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/\bexport\s+(?=(?:async\s+)?(?:const|class|function)\b)/g, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  const onCreated = makeEvent();
  const onChanged = makeEvent();
  const onConnect = makeEvent();
  const downloadsById = new Map();
  const sessionStorage = new Map();
  const localStorage = new Map();
  const timers = [];
  const context = vm.createContext({
    URL,
    AbortController,
    structuredClone,
    WebSocket: class {},
    fetch: async () => ({ ok: true, status: 200, text: async () => '' }),
    console,
    setTimeout(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    chrome: {
      runtime: { lastError: null, onMessage: makeEvent(), onConnect, onInstalled: makeEvent(), reload() {} },
      downloads: {
        onCreated,
        onChanged,
        search(query, callback) { callback(query?.id != null && downloadsById.has(query.id) ? [downloadsById.get(query.id)] : []); },
      },
      storage: {
        session: {
          async get(key) { return { [key]: sessionStorage.get(key) }; },
          async set(values) { for (const [key, value] of Object.entries(values || {})) sessionStorage.set(key, value); },
          async remove(key) { sessionStorage.delete(key); },
        },
        local: {
          async get(key) { return { [key]: localStorage.get(key) }; },
          async set(values) { for (const [key, value] of Object.entries(values || {})) localStorage.set(key, value); },
          async remove(key) { localStorage.delete(key); },
        },
      },
      tabs: { async query() { return []; }, async reload() {}, async get() { return null; }, async update() {}, async remove() {} },
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

async function flushBackgroundQueue(cycles = 8) {
  for (let index = 0; index < cycles; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('chrome download capture ignores an unrelated download and binds the expected artifact filename', async () => {
  const runtime = await loadBackground();
  const port = makePort();
  runtime.onConnect.emit(port);

  port.onMessage.emit({
    type: 'bridge.download.capture.begin',
    requestId: 'begin-1',
    expectedName: 'artifact-table.csv',
    artifact: { id: 'artifact-table-candidate', name: 'artifact-table.csv', sourceTurnKey: 'assistant-turn-table', kind: 'file' },
    timeoutMs: 30_000,
  });
  await flushBackgroundQueue();
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
  await flushBackgroundQueue();
  const captureId = responseFor(port, 'begin-2').result.captureId;
  port.onMessage.emit({ type: 'bridge.download.capture.cancel', requestId: 'cancel-2', captureId, reason: 'page blob won' });
  await flushBackgroundQueue();
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
    artifact: { id: 'artifact-alias-candidate', name: 'project-result.zip', sourceTurnKey: 'assistant-turn-alias', kind: 'file' },
    timeoutMs: 30_000,
  });
  await flushBackgroundQueue();
  const captureId = responseFor(port, 'begin-alias').result.captureId;
  port.onMessage.emit({
    type: 'bridge.download.capture.add_expected_names',
    requestId: 'alias-1',
    captureId,
    expectedNames: ['Release bundle.zip'],
  });
  await flushBackgroundQueue();
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

test('bound chrome download capture is retained, completed, and remains identifiable after a direct page result wins', async () => {
  const runtime = await loadBackground();
  const port = makePort();
  runtime.onConnect.emit(port);

  port.onMessage.emit({ type: 'bridge.download.capture.begin', requestId: 'begin-bound', expectedName: 'project.zip', artifact: { id: 'artifact-bound-candidate', name: 'project.zip', sourceTurnKey: 'assistant-turn-bound', kind: 'file' }, timeoutMs: 30_000 });
  await flushBackgroundQueue();
  const captureId = responseFor(port, 'begin-bound').result.captureId;
  const item = { id: 8, filename: '/Downloads/project.zip', url: 'https://chatgpt.com/backend-api/files/8', state: 'in_progress', mime: 'application/zip', fileSize: 0 };
  runtime.downloadsById.set(8, item);
  runtime.onCreated.emit(item);

  port.onMessage.emit({ type: 'bridge.download.capture.release', requestId: 'release-bound', captureId, reason: 'page-url-won', graceMs: 10 });
  await new Promise((resolve) => setImmediate(resolve));
  const release = responseFor(port, 'release-bound');
  assert.equal(release.error, undefined);
  assert.equal(release.result.bound, true);
  assert.equal(release.result.retained, true);
  assert.equal(release.result.cancelled, false);
  assert.equal(release.result.item.id, 8);

  port.onMessage.emit({ type: 'bridge.download.capture.cancel', requestId: 'cancel-bound', captureId, reason: 'late-cleanup' });
  await flushBackgroundQueue();
  assert.equal(responseFor(port, 'cancel-bound').result.cancelled, false);
  assert.equal(responseFor(port, 'cancel-bound').result.bound, true);

  port.onMessage.emit({ type: 'bridge.download.capture.wait', requestId: 'wait-bound', captureId, timeoutMs: 30_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(responseFor(port, 'wait-bound'), undefined);

  Object.assign(item, { state: 'complete', fileSize: 732, endTime: new Date().toISOString() });
  runtime.onChanged.emit({ id: 8, state: { current: 'complete' } });
  await flushBackgroundQueue();
  const completed = responseFor(port, 'wait-bound');
  assert.equal(completed.error, undefined);
  assert.equal(completed.result.id, 8);
  assert.equal(completed.result.captureId, captureId);
  assert.equal(completed.result.fileSize, 732);
});

test('indirect download binding fails closed when two armed captures have the same filename', async () => {
  const runtime = await loadBackground();
  const port = makePort();
  runtime.onConnect.emit(port);

  for (const [requestId, candidateId, turnKey] of [
    ['begin-ambiguous-a', 'artifact-candidate-a', 'assistant-turn-a'],
    ['begin-ambiguous-b', 'artifact-candidate-b', 'assistant-turn-b'],
  ]) {
    port.onMessage.emit({
      type: 'bridge.download.capture.begin', requestId,
      expectedName: 'same-project.zip',
      artifact: { id: candidateId, name: 'same-project.zip', sourceTurnKey: turnKey, kind: 'file' },
      timeoutMs: 30_000,
    });
    await flushBackgroundQueue();
  }
  const captureA = responseFor(port, 'begin-ambiguous-a').result.captureId;
  const captureB = responseFor(port, 'begin-ambiguous-b').result.captureId;
  runtime.onCreated.emit({
    id: 31,
    filename: '/Downloads/same-project.zip',
    url: 'https://chatgpt.com/backend-api/files/31',
    state: 'complete',
    startTime: new Date().toISOString(),
  });
  port.onMessage.emit({ type: 'bridge.download.capture.wait_bound', requestId: 'wait-ambiguous-a', captureId: captureA, timeoutMs: 30_000 });
  port.onMessage.emit({ type: 'bridge.download.capture.wait_bound', requestId: 'wait-ambiguous-b', captureId: captureB, timeoutMs: 30_000 });
  await flushBackgroundQueue();
  assert.equal(responseFor(port, 'wait-ambiguous-a'), undefined);
  assert.equal(responseFor(port, 'wait-ambiguous-b'), undefined);
});

test('indirect download binding requires candidate and source-turn identity even when the filename is exact', async () => {
  const runtime = await loadBackground();
  const port = makePort();
  runtime.onConnect.emit(port);
  port.onMessage.emit({
    type: 'bridge.download.capture.begin', requestId: 'begin-name-only',
    expectedName: 'name-only.zip', timeoutMs: 30_000,
  });
  await flushBackgroundQueue();
  const captureId = responseFor(port, 'begin-name-only').result.captureId;
  runtime.onCreated.emit({
    id: 32,
    filename: '/Downloads/name-only.zip',
    url: 'https://chatgpt.com/backend-api/files/32',
    state: 'complete',
    startTime: new Date().toISOString(),
  });
  port.onMessage.emit({ type: 'bridge.download.capture.wait_bound', requestId: 'wait-name-only', captureId, timeoutMs: 30_000 });
  await flushBackgroundQueue();
  assert.equal(responseFor(port, 'wait-name-only'), undefined);
});

test('indirect download binding rejects an exact artifact outside the capture time window', async () => {
  const runtime = await loadBackground();
  const port = makePort();
  runtime.onConnect.emit(port);
  port.onMessage.emit({
    type: 'bridge.download.capture.begin', requestId: 'begin-old-download',
    expectedName: 'old-project.zip',
    artifact: { id: 'artifact-old-candidate', name: 'old-project.zip', sourceTurnKey: 'assistant-turn-old', kind: 'file' },
    timeoutMs: 30_000,
  });
  await flushBackgroundQueue();
  const captureId = responseFor(port, 'begin-old-download').result.captureId;
  runtime.onCreated.emit({
    id: 33,
    filename: '/Downloads/old-project.zip',
    url: 'https://chatgpt.com/backend-api/files/33',
    state: 'complete',
    startTime: new Date(Date.now() - 60_000).toISOString(),
  });
  port.onMessage.emit({ type: 'bridge.download.capture.wait_bound', requestId: 'wait-old-download', captureId, timeoutMs: 30_000 });
  await flushBackgroundQueue();
  assert.equal(responseFor(port, 'wait-old-download'), undefined);
});
