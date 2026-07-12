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

async function loadBackground({ fetchImpl, tabHooks = {} }) {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/background.js'), 'utf8');
  const timeouts = [];
  class FakeWebSocket {
    static OPEN = 1;
    static urls = [];
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      this.sent = [];
      FakeWebSocket.urls.push(url);
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
  const tabCalls = [];
  const context = {
    URL,
    WebSocket: FakeWebSocket,
    fetch: fetchImpl,
    console,
    setTimeout(fn, delay) { const timer = { fn, delay }; timeouts.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    chrome: {
      runtime: { lastError: null, onMessage: makeEvent(), onConnect: makeEvent() },
      downloads: { onCreated: makeEvent(), onChanged: makeEvent(), search(_query, callback) { callback([]); } },
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
      },
      tabs: {
        onRemoved: makeEvent(),
        create(options, callback) {
          tabCalls.push({ type: 'tabs.create', options });
          callback({ id: 42, ...options });
        },
        update(tabId, options, callback) {
          tabCalls.push({ type: 'tabs.update', tabId, options });
          callback({ id: tabId, ...options });
        },
        remove(tabId, callback) {
          tabCalls.push({ type: 'tabs.remove', tabId });
          callback();
        },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'background.js' });
  return { context, FakeWebSocket, timeouts, tabCalls, storage };
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
  port.onMessage.emit({ type: 'bridge.connect', serverUrl: 'http://127.0.0.1:8080', token: 'wrong-token', clientId: 'client-1' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0], /\/tm\/auth\/check\?token=wrong-token/);
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
  port.onMessage.emit({ type: 'bridge.connect', serverUrl: 'http://127.0.0.1:8080', token: 'good-token', clientId: 'client-1' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(FakeWebSocket.urls.length, 1);
  assert.match(FakeWebSocket.urls[0], /^ws:\/\/127\.0\.0\.1:8080\/tm\/ws\?/);
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
      assert.match(String(url), /^http:\/\/127\.0\.0\.1:18181\/tm\/auth\/check/);
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
      launchToken: 'bridge-real-e2e-a1b2c3d4e5f6',
      launchServerUrl: 'http://127.0.0.1:18181',
      requestedUrl: 'https://chatgpt.com/',
      url: 'https://chatgpt.com/',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(FakeWebSocket.urls.length, 1);
  assert.match(FakeWebSocket.urls[0], /^ws:\/\/127\.0\.0\.1:18181\/tm\/ws\?/);
  const stored = tabCalls.find((call) => call.type === 'storage.set');
  assert.equal(stored.values['chatgptBridgeLaunchedTab:92'].serverUrl, 'http://127.0.0.1:18181');
});
