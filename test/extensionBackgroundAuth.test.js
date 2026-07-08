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

async function loadBackground({ fetchImpl }) {
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
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'background.js' });
  return { context, FakeWebSocket, timeouts };
}

function makePort() {
  return {
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
