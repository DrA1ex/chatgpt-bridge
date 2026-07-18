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
    get listeners() { return listeners.slice(); },
  };
}

async function loadBackground({ fetchImpl, tabHooks = {}, localInitial = {}, downloadHooks = {} }) {
  const modulePaths = [
    'tools/chrome-bridge-extension/background/stateV4.js',
    'tools/chrome-bridge-extension/background/protocolV4.js',
    'tools/chrome-bridge-extension/background/outboxV4.js',
    'tools/chrome-bridge-extension/background/portRouter.js',
    'tools/chrome-bridge-extension/background.js',
  ];
  const sources = await Promise.all(modulePaths.map((file) => fs.readFile(path.resolve(file), 'utf8')));
  const source = sources.join('\n')
    .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/\bexport\s+(?=(?:const|class|function)\b)/g, '');
  const timeouts = [];
  class FakeWebSocket {
    static OPEN = 1;
    static urls = [];
    static instances = [];
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      this.sent = [];
      FakeWebSocket.urls.push(url);
      FakeWebSocket.instances.push(this);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send(value) { this.sent.push(value); }
    close() { this.closed = true; }
    emit(type, event = {}) {
      for (const fn of this.listeners.get(type) || []) fn(event);
    }
  }

  const storage = new Map();
  const localStorage = new Map(Object.entries(localInitial));
  const tabCalls = [];
  const context = {
    URL,
    URLSearchParams,
    WebSocket: FakeWebSocket,
    fetch: fetchImpl,
    console,
    setTimeout(fn, delay) { const timer = { fn, delay }; timeouts.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    chrome: {
      runtime: { lastError: null, onMessage: makeEvent(), onConnect: makeEvent(), onInstalled: makeEvent(), reload() { tabCalls.push({ type: 'runtime.reload' }); } },
      downloads: {
        onCreated: makeEvent(),
        onChanged: makeEvent(),
        download(options, callback) {
          tabCalls.push({ type: 'downloads.download', options });
          downloadHooks.onDownload?.(options);
          callback(downloadHooks.downloadId ?? 73);
        },
        search(query, callback) {
          tabCalls.push({ type: 'downloads.search', query });
          callback(downloadHooks.searchItems || []);
        },
      },
      storage: {
        session: {
          async set(values) {
            tabCalls.push({ type: 'storage.set', values });
            for (const [key, value] of Object.entries(values || {})) storage.set(key, value);
            await tabHooks.onStorageSet?.(values);
          },
          async get(key) { return { [key]: storage.get(key) }; },
          async remove(key) { storage.delete(key); },
        },
        local: {
          async set(values) {
            tabCalls.push({ type: 'storage.local.set', values });
            for (const [key, value] of Object.entries(values || {})) localStorage.set(key, value);
          },
          async get(key) { return { [key]: localStorage.get(key) }; },
          async remove(key) { localStorage.delete(key); },
        },
      },
      tabs: {
        onRemoved: makeEvent(),
        async query(query) {
          tabCalls.push({ type: 'tabs.query', query });
          return tabHooks.tabs || [];
        },
        async get(tabId) {
          tabCalls.push({ type: 'tabs.get', tabId });
          return (tabHooks.tabs || []).find((tab) => tab.id === tabId) || { id: tabId, url: 'https://chatgpt.com/' };
        },
        create(options, callback) {
          tabCalls.push({ type: 'tabs.create', options });
          const tab = { id: 42, ...options };
          callback?.(tab);
          return Promise.resolve(tab);
        },
        update(tabId, options, callback) {
          tabCalls.push({ type: 'tabs.update', tabId, options });
          const tab = { id: tabId, ...options };
          callback?.(tab);
          return Promise.resolve(tab);
        },
        async reload(tabId) { tabCalls.push({ type: 'tabs.reload', tabId }); },
        remove(tabId, callback) {
          tabCalls.push({ type: 'tabs.remove', tabId });
          callback?.();
          return Promise.resolve();
        },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'background.js' });
  return { context, FakeWebSocket, timeouts, tabCalls, storage, localStorage };
}

function makePort(tabId = 7) {
  return {
    sender: { tab: { id: tabId } },
    name: 'chatgpt-bridge-tab',
    messages: [],
    onMessage: makeEvent(),
    onDisconnect: makeEvent(),
    postMessage(message) { this.messages.push(message); },
  };
}

test('extension background stops reconnecting and reports a clear auth error when BRIDGE_TOKEN is rejected', async () => {
  const fetchCalls = [];
  const { context, FakeWebSocket, timeouts } = await loadBackground({
    async fetchImpl(url) {
      fetchCalls.push(String(url));
      return {
        ok: false,
        status: 403,
        async text() { return JSON.stringify({ detail: 'Invalid BRIDGE_TOKEN' }); },
      };
    },
  });

  const port = makePort();
  context.chrome.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'bridge.connect', serverUrl: 'http://127.0.0.1:8080', token: 'wrong-token', clientId: 'client-1', page: { contentEpoch: 'content-test-1' } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0], /\/extension\/auth\/check\?token=wrong-token/);
  assert.equal(FakeWebSocket.urls.length, 0);
  assert.equal(timeouts.filter((timer) => !timer.cleared && timer.delay === 1500).length, 0);
  assert.equal(port.messages.at(-1).type, 'extension.auth_error');
  assert.equal(port.messages.at(-1).httpStatus, 403);
  assert.match(port.messages.at(-1).detail, /BRIDGE_TOKEN was rejected/i);
});

test('extension background validates token before opening the bridge WebSocket', async () => {
  const { context, FakeWebSocket } = await loadBackground({
    async fetchImpl() {
      return { ok: true, status: 200, async text() { return '{"ok":true}'; } };
    },
  });

  const port = makePort();
  context.chrome.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'bridge.connect', serverUrl: 'http://127.0.0.1:8080', token: 'good-token', clientId: 'client-1', page: { contentEpoch: 'content-test-2' } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(FakeWebSocket.urls.length, 1);
  assert.match(FakeWebSocket.urls[0], /^ws:\/\/127\.0\.0\.1:8080\/extension\/ws\?/);
  assert.match(FakeWebSocket.urls[0], /token=good-token/);
});


test('extension persists the E2E launch token before navigating the new ChatGPT tab', async () => {
  const { context, tabCalls } = await loadBackground({
    async fetchImpl() { return { ok: true, status: 200, async text() { return '{"ok":true}'; } }; },
  });

  const port = makePort();
  context.chrome.runtime.onConnect.emit(port);
  port.onMessage.emit({
    type: 'bridge.tab.open',
    requestId: 'open-1',
    url: 'https://chatgpt.com/',
    launchToken: 'token-before-navigation',
    active: true,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(tabCalls.map((call) => call.type), ['tabs.create', 'storage.set', 'tabs.update']);
  assert.equal(tabCalls[0].options.url, 'about:blank');
  assert.equal(tabCalls[1].values['chatgptBridgeLaunchedTab:42'].launchToken, 'token-before-navigation');
  assert.equal(tabCalls[2].options.url, 'https://chatgpt.com/');
  assert.deepEqual(JSON.parse(JSON.stringify(port.messages.at(-1))), {
    type: 'extension.response',
    requestId: 'open-1',
    result: {
      tabId: 42,
      launchToken: 'token-before-navigation',
      requestedUrl: 'https://chatgpt.com/',
      bridgeServerUrl: '',
      active: true,
      openerTabId: 7,
    },
  });
});

test('extension background adopts an OS-opened bridge launch token from the content handshake', async () => {
  const { context, tabCalls } = await loadBackground({
    async fetchImpl() { return { ok: true, status: 200, async text() { return '{"ok":true}'; } }; },
  });

  const port = makePort(91);
  context.chrome.runtime.onConnect.emit(port);
  port.onMessage.emit({
    type: 'bridge.connect',
    serverUrl: 'http://127.0.0.1:8080',
    token: 'good-token',
    clientId: 'os-opened-client',
    page: {
      contentEpoch: 'content-os-opened',
      launchToken: 'bridge-auto-a1b2c3d4e5f6',
      requestedUrl: 'https://chatgpt.com/',
      url: 'https://chatgpt.com/',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const stored = tabCalls.find((call) => call.type === 'storage.set');
  assert.ok(stored);
  assert.equal(stored.values['chatgptBridgeLaunchedTab:91'].launchToken, 'bridge-auto-a1b2c3d4e5f6');
  assert.equal(stored.values['chatgptBridgeLaunchedTab:91'].requestedUrl, 'https://chatgpt.com/');
  assert.equal(stored.values['chatgptBridgeLaunchedTab:91'].serverUrl, '');
});


test('OS-opened E2E tab overrides the stored bridge URL only for that tab', async () => {
  const { context, FakeWebSocket, tabCalls } = await loadBackground({
    async fetchImpl(url) {
      assert.match(String(url), /^http:\/\/127\.0\.0\.1:18181\/extension\/auth\/check/);
      return { ok: true, status: 200, async text() { return '{"ok":true}'; } };
    },
  });

  const port = makePort(92);
  context.chrome.runtime.onConnect.emit(port);
  port.onMessage.emit({
    type: 'bridge.connect',
    serverUrl: 'http://127.0.0.1:8080',
    token: 'good-token',
    clientId: 'isolated-e2e-client',
    page: {
      contentEpoch: 'content-isolated-e2e',
      launchToken: 'bridge-real-e2e-a1b2c3d4e5f6',
      launchServerUrl: 'http://127.0.0.1:18181',
      requestedUrl: 'https://chatgpt.com/',
      url: 'https://chatgpt.com/',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(FakeWebSocket.urls.length, 1);
  assert.match(FakeWebSocket.urls[0], /^ws:\/\/127\.0\.0\.1:18181\/extension\/ws\?/);
  const stored = tabCalls.find((call) => call.type === 'storage.set');
  assert.equal(stored.values['chatgptBridgeLaunchedTab:92'].serverUrl, 'http://127.0.0.1:18181');
});


test('reload compatibility launch metadata is consumed without becoming a persistent tab setting', async () => {
  const { context, storage, tabCalls } = await loadBackground({
    async fetchImpl() { return { ok: true, status: 200, async text() { return '{"ok":true}'; } }; },
  });
  const port = makePort(92);
  const adopted = await context.adoptPageLaunchMetadata(port, {
    launchToken: 'bridge-reload-mtemporary1',
    launchServerUrl: 'http://127.0.0.1:18181',
    requestedUrl: 'https://chatgpt.com/c/e2e-session',
  });

  assert.equal(adopted.serverUrl, 'http://127.0.0.1:18181');
  assert.equal(adopted.launchToken, '');
  assert.equal(storage.has('chatgptBridgeLaunchedTab:92'), false);
  assert.equal(tabCalls.some((call) => call.type === 'storage.set'), false);
});



test('extension reload persists owned-tab identity before restarting the background', async () => {
  const { context, localStorage } = await loadBackground({
    async fetchImpl() { return { ok: true, status: 200, async text() { return '{"ok":true}'; } }; },
    tabHooks: { tabs: [{ id: 92, url: 'https://chatgpt.com/c/e2e-session' }] },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await context.rememberLaunchedTab(92, {
    launchToken: 'bridge-real-e2e-preserved123',
    requestedUrl: 'https://chatgpt.com/',
    createdAt: Date.now(),
    serverUrl: 'http://127.0.0.1:18181',
  });

  const result = await context.scheduleExtensionReload({
    reloadTabs: true,
    expectedVersion: '2.0.0',
    sourceTabId: 92,
    sourceLaunchToken: 'bridge-real-e2e-preserved123',
    temporaryServerUrl: 'http://127.0.0.1:18181',
  });
  const pending = localStorage.get('bridgePendingExtensionReload');
  assert.equal(result.preservedLaunchCount, 1);
  assert.equal(pending.sourceTabId, 92);
  assert.equal(pending.temporaryServerUrl, 'http://127.0.0.1:18181');
  assert.equal(pending.launchRecords['92'].launchToken, 'bridge-real-e2e-preserved123');
});

test('onInstalled recovery reloads existing ChatGPT tabs and preserves cleanup ownership', async () => {
  const { context, tabCalls, localStorage, storage } = await loadBackground({
    async fetchImpl() { return { ok: true, status: 200, async text() { return '{"ok":true}'; } }; },
    tabHooks: { tabs: [{ id: 92, url: 'https://chatgpt.com/c/e2e-session' }] },
  });
  await new Promise((resolve) => setImmediate(resolve));
  localStorage.set('bridgePendingExtensionReload', {
    tabIds: [92],
    expectedVersion: '1.0.14',
    sourceTabId: 92,
    temporaryServerUrl: 'http://127.0.0.1:18181',
    launchRecords: {
      92: {
        launchToken: 'bridge-real-e2e-preserved123',
        requestedUrl: 'https://chatgpt.com/',
        createdAt: Date.now(),
        serverUrl: 'http://127.0.0.1:18181',
      },
    },
    requestedAt: Date.now(),
  });

  context.chrome.runtime.onInstalled.emit({ reason: 'update' });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const sourceUpdate = tabCalls.find((call) => call.type === 'tabs.update' && call.tabId === 92);
  assert.ok(sourceUpdate, 'updated background should reload the existing ChatGPT page automatically');
  const hash = new URLSearchParams(new URL(sourceUpdate.options.url).hash.replace(/^#/, ''));
  assert.equal(hash.get('chatgpt-bridge-launch'), 'bridge-real-e2e-preserved123');
  assert.equal(hash.get('chatgpt-bridge-server'), 'http://127.0.0.1:18181');
  assert.equal(storage.get('chatgptBridgeLaunchedTab:92').launchToken, 'bridge-real-e2e-preserved123');
  assert.equal(localStorage.has('bridgePendingExtensionReload'), false);

  const port = makePort(92);
  context.chrome.runtime.onConnect.emit(port);
  port.onMessage.emit({
    type: 'bridge.connect', serverUrl: 'http://127.0.0.1:8080', token: 'good-token', clientId: 'reloaded',
    page: {
      contentEpoch: 'content-reloaded',
      launchToken: 'bridge-real-e2e-preserved123',
      launchServerUrl: 'http://127.0.0.1:18181',
      requestedUrl: 'https://chatgpt.com/',
      url: 'https://chatgpt.com/',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  port.onMessage.emit({ type: 'bridge.tab.close', requestId: 'close-after-reload', expectedLaunchToken: 'bridge-real-e2e-preserved123' });
  await new Promise((resolve) => setImmediate(resolve));
  const response = port.messages.find((message) => message.requestId === 'close-after-reload');
  assert.equal(response.error, undefined);
  assert.equal(response.result.launchToken, 'bridge-real-e2e-preserved123');
});

test('updated background restores the custom source-tab port from structured v4 reload state', async () => {
  const pending = {
    tabIds: [91, 92],
    expectedVersion: '2.0.0',
    sourceTabId: 92,
    temporaryServerUrl: 'http://127.0.0.1:18181',
    requestedAt: Date.now(),
  };
  const { context, tabCalls, localStorage } = await loadBackground({
    async fetchImpl() { return { ok: true, status: 200, async text() { return '{"ok":true}'; } }; },
    localInitial: { bridgePendingExtensionReload: pending },
    tabHooks: {
      tabs: [
        { id: 91, url: 'https://chatgpt.com/c/ordinary' },
        { id: 92, url: 'https://chatgpt.com/c/e2e-session' },
      ],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const sourceUpdate = tabCalls.find((call) => call.type === 'tabs.update' && call.tabId === 92);
  assert.ok(sourceUpdate);
  const updatedUrl = new URL(sourceUpdate.options.url);
  const hash = new URLSearchParams(updatedUrl.hash.replace(/^#/, ''));
  assert.equal(hash.get('chatgpt-bridge-server'), 'http://127.0.0.1:18181');
  assert.match(hash.get('chatgpt-bridge-launch'), /^bridge-reload-/);
  assert.ok(tabCalls.some((call) => call.type === 'tabs.reload' && call.tabId === 91));
  assert.equal(tabCalls.some((call) => call.type === 'tabs.reload' && call.tabId === 92), false);
  assert.equal(localStorage.has('bridgePendingExtensionReload'), false);
});

test('extension reload preserves the original one-time launch identity while using a temporary server URL', async () => {
  const { context, FakeWebSocket } = await loadBackground({
    async fetchImpl() { return { ok: true, status: 200, async text() { return '{"ok":true}'; } }; },
  });
  const port = makePort(93);
  context.chrome.runtime.onConnect.emit(port);
  port.onMessage.emit({
    type: 'bridge.connect', serverUrl: 'http://127.0.0.1:18181', token: 'good-token', clientId: 'original',
    page: { contentEpoch: 'content-original', launchToken: 'bridge-auto-original123', requestedUrl: 'https://chatgpt.com/', url: 'https://chatgpt.com/' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const first = FakeWebSocket.urls.at(-1);
  assert.match(first, /^ws:\/\/127\.0\.0\.1:18181/);

  const reloaded = makePort(93);
  context.chrome.runtime.onConnect.emit(reloaded);
  reloaded.onMessage.emit({
    type: 'bridge.connect', serverUrl: 'http://127.0.0.1:8080', token: 'good-token', clientId: 'reloaded',
    page: { contentEpoch: 'content-transition', launchToken: 'bridge-reload-transition123', launchServerUrl: 'http://127.0.0.1:18181', requestedUrl: 'https://chatgpt.com/', url: 'https://chatgpt.com/' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const ws = FakeWebSocket.urls.at(-1);
  assert.match(ws, /^ws:\/\/127\.0\.0\.1:18181/);
  const socket = FakeWebSocket.instances.at(-1);
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit('open');
  await new Promise((resolve) => setImmediate(resolve));
  const connected = reloaded.messages.findLast((message) => message.type === 'extension.connected');
  assert.equal(connected.launchToken, 'bridge-auto-original123');
  assert.equal(connected.serverUrl, 'http://127.0.0.1:18181');
  assert.ok(FakeWebSocket.instances.length >= 2);
});

test('a reconnected replacement tab may close the exact stale owned tab by id and launch token', async () => {
  const { context, timeouts, tabCalls } = await loadBackground({
    async fetchImpl() { return { ok: true, status: 200, async text() { return '{"ok":true}'; } }; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await context.rememberLaunchedTab(42, {
    launchToken: 'bridge-real-e2e-staleowned123',
    requestedUrl: 'https://chatgpt.com/',
    createdAt: Date.now(),
    serverUrl: 'http://127.0.0.1:18181',
  });
  const replacement = makePort(77);
  context.chrome.runtime.onConnect.emit(replacement);
  replacement.onMessage.emit({
    type: 'bridge.tab.close-owned', requestId: 'close-stale', tabId: 42,
    expectedLaunchToken: 'bridge-real-e2e-staleowned123',
  });
  await new Promise((resolve) => setImmediate(resolve));

  const response = replacement.messages.find((message) => message.requestId === 'close-stale');
  assert.equal(response.error, undefined);
  assert.equal(response.result.tabId, 42);
  assert.equal(response.result.launchToken, 'bridge-real-e2e-staleowned123');
  const closeTimer = timeouts.find((timer) => timer.delay === 150);
  assert.ok(closeTimer);
  closeTimer.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(tabCalls.some((call) => call.type === 'tabs.remove' && call.tabId === 42));
});

test('closing another tab fails closed when the launch token does not match', async () => {
  const { context } = await loadBackground({
    async fetchImpl() { return { ok: true, status: 200, async text() { return '{"ok":true}'; } }; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await context.rememberLaunchedTab(42, {
    launchToken: 'bridge-real-e2e-ownedcorrect123',
    requestedUrl: 'https://chatgpt.com/',
    createdAt: Date.now(),
    serverUrl: 'http://127.0.0.1:18181',
  });
  const replacement = makePort(77);
  context.chrome.runtime.onConnect.emit(replacement);
  replacement.onMessage.emit({
    type: 'bridge.tab.close-owned', requestId: 'close-stale-wrong', tabId: 42,
    expectedLaunchToken: 'bridge-real-e2e-ownedwrong123',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const response = replacement.messages.find((message) => message.requestId === 'close-stale-wrong');
  assert.match(response.error, /launch token does not match/);
});

test('extension background starts a captured artifact download without navigating the ChatGPT tab', async () => {
  const url = 'https://chatgpt.com/backend-api/estuary/content?id=file-test&fn=project.zip&cd=attachment';
  const { context, tabCalls } = await loadBackground({
    async fetchImpl() { return { ok: true, status: 200, async text() { return '{"ok":true}'; } }; },
    downloadHooks: {
      downloadId: 91,
      searchItems: [{ id: 91, url, finalUrl: url, filename: '/Downloads/project.zip', state: 'in_progress' }],
    },
  });
  const port = makePort(17);
  context.chrome.runtime.onConnect.emit(port);
  port.onMessage.emit({
    type: 'bridge.download.capture.begin',
    requestId: 'capture-begin',
    timeoutMs: 45_000,
    expectedName: 'project.zip',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const capture = port.messages.find((message) => message.requestId === 'capture-begin')?.result;
  assert.ok(capture?.captureId);

  port.onMessage.emit({
    type: 'bridge.download.capture.start',
    requestId: 'capture-start',
    captureId: capture.captureId,
    url,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const started = port.messages.find((message) => message.requestId === 'capture-start');
  assert.deepEqual(JSON.parse(JSON.stringify(started)), {
    type: 'extension.response',
    requestId: 'capture-start',
    result: { captureId: capture.captureId, downloadId: 91, bound: true },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(tabCalls.find((call) => call.type === 'downloads.download')?.options)), { url, saveAs: false });
  assert.equal(tabCalls.some((call) => call.type === 'tabs.update'), false);
});
