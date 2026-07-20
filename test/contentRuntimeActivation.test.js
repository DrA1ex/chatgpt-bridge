import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

function eventChannel() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(value) { for (const listener of listeners) listener(value); },
  };
}

async function createTransportHarness() {
  const portMessages = [];
  const connectionChanges = [];
  const handledServerMessages = [];
  const onMessage = eventChannel();
  const onDisconnect = eventChannel();
  const port = {
    onMessage,
    onDisconnect,
    postMessage(message) { portMessages.push(message); },
    disconnect() { onDisconnect.emit(); },
  };
  const windowListeners = new Map();
  const window = {
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    postMessage(data) {
      for (const fn of windowListeners.get('message') || []) fn({ source: window, data });
    },
  };
  const timers = [];
  const context = vm.createContext({
    console,
    window,
    Blob,
    URL,
    Date,
    Math,
    setTimeout(fn, delay) { const timer = { fn, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    chrome: {
      runtime: {
        id: 'extension-id',
        connect() { return port; },
        lastError: null,
      },
    },
  });
  context.globalThis = context;
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/transportRuntime.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'transportRuntime.js' });
  const runtime = context.ChatGptContentTransportRuntime.createTransportRuntime({
    CONFIG: { token: 'token', serverUrl: 'http://127.0.0.1:17373', reconnectMs: 1_500 },
    EXTENSION_API: {},
    RECONNECT_RUNTIME: { recoverForHandshake() { return { error: '', requestId: '' }; } },
    RUNTIME_CONFIG: { removeTemporaryConnectionOverride() {} },
    applyCompatibilityStatus() {},
    executionStore: {},
    getClientId() { return 'content-client'; },
    helloPayload() { return { type: 'hello', clientId: 'content-client' }; },
    handleServerMessage(payload) { handledServerMessages.push(payload); },
    onBridgeConnectionChange(connected, reason) { connectionChanges.push({ connected, reason }); },
    recordLocalLog() {},
    safeJsonParse() { return null; },
    safeLaunchBridgeServerUrl(value) { return String(value || ''); },
    safeUrlPath(value) { return String(value || ''); },
    setPanelStatus() {},
    summarizePayload(value) { return value; },
    temporaryConnectionOverride: { applied: false },
  });
  return { runtime, port, onMessage, onDisconnect, portMessages, connectionChanges, handledServerMessages, timers };
}

test('content page runtime remains inactive until the canonical server hello and deactivates on disconnect', async () => {
  const harness = await createTransportHarness();
  harness.runtime.connect();
  assert.equal(harness.runtime.isBridgeConnected(), false);
  assert.equal(harness.connectionChanges.length, 0);
  assert.equal(harness.portMessages[0].type, 'bridge.connect');

  harness.onMessage.emit({ type: 'extension.connected', browserTabId: 44, health: {} });
  assert.equal(harness.runtime.isBridgeConnected(), false, 'Background WebSocket readiness is not the canonical server handshake');
  assert.equal(harness.connectionChanges.length, 0);

  harness.onMessage.emit({ type: 'server.message', payload: { type: 'server.hello', serverInstanceId: 'server-1' } });
  assert.equal(harness.runtime.isBridgeConnected(), true);
  assert.deepEqual(harness.connectionChanges, [{ connected: true, reason: 'server.hello' }]);
  assert.equal(harness.handledServerMessages.length, 1);

  harness.onMessage.emit({ type: 'extension.status', status: 'server unreachable', detail: 'offline' });
  assert.equal(harness.runtime.isBridgeConnected(), false);
  assert.deepEqual(harness.connectionChanges.at(-1), { connected: false, reason: 'server unreachable' });
});

test('content composition starts transport only and never starts DOM observers unconditionally', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /onBridgeConnectionChange:\s*\(connected, reason\)/);
  assert.match(source, /if \(connected\) pageRuntimeController\?\.start/);
  assert.match(source, /else pageRuntimeController\?\.stop/);
  assert.match(source, /\n\s*connect\(\);\n\}\)\(\);\s*$/);
  assert.doesNotMatch(source, /startPageRuntimeObservers\(\)/);
  assert.match(source, /extension\.ui\.open/);
  const background = await fs.readFile(path.resolve('tools/chrome-bridge-extension/background.js'), 'utf8');
  assert.match(background, /chrome\.action\?\.onClicked/);
  assert.match(background, /extension\.ui\.open/);
});
