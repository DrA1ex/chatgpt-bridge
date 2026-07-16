import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    dump() { return Object.fromEntries(values); },
  };
}

async function loadRuntimeConfig({ saved = {}, session = memoryStorage() } = {}) {
  const local = memoryStorage(Object.fromEntries(Object.entries(saved).map(([key, value]) => [
    `chatgptBridge:${key}`,
    JSON.stringify(value),
  ])));
  const api = {
    getValue(key, fallback) {
      const raw = local.getItem(`chatgptBridge:${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    },
    setValue(key, value) {
      local.setItem(`chatgptBridge:${key}`, JSON.stringify(value));
      return true;
    },
  };
  const context = {
    URL,
    URLSearchParams,
    location: new URL('https://chatgpt.com/'),
    history: { state: null, replaceState() {} },
    sessionStorage: session,
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/runtimeConfig.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'runtimeConfig.js' });
  return { runtime: context.ChatGptContentRuntimeConfig, api, local, session };
}

test('extension reload temporarily restores a custom active bridge port without changing saved settings', async () => {
  const session = memoryStorage();
  const first = await loadRuntimeConfig({
    saved: { 'bridge.serverUrl': 'http://127.0.0.1:8080', 'bridge.token': 'saved-token' },
    session,
  });
  const active = first.runtime.loadConfig(first.api);
  active.serverUrl = 'http://127.0.0.1:18181';

  const staged = first.runtime.stageTemporaryConnectionOverride(first.api, active, active, session, 1_000);
  assert.deepEqual(JSON.parse(JSON.stringify(staged)), {
    staged: true,
    reason: 'differs_from_saved',
    serverUrl: 'http://127.0.0.1:18181',
    tokenChanged: false,
  });

  const restarted = await loadRuntimeConfig({
    saved: { 'bridge.serverUrl': 'http://127.0.0.1:8080', 'bridge.token': 'saved-token' },
    session,
  });
  const config = restarted.runtime.loadConfig(restarted.api);
  const applied = restarted.runtime.applyTemporaryConnectionOverride(restarted.api, config, session, 1_100);

  assert.equal(applied.applied, true);
  assert.equal(config.serverUrl, 'http://127.0.0.1:18181');
  assert.equal(config.token, 'saved-token');
  assert.equal(restarted.api.getValue('bridge.serverUrl', ''), 'http://127.0.0.1:8080');
  restarted.runtime.removeTemporaryConnectionOverride(session);
  assert.deepEqual(session.dump(), {});
});

test('temporary reload connection is discarded when persisted settings changed before restart', async () => {
  const session = memoryStorage();
  const first = await loadRuntimeConfig({
    saved: { 'bridge.serverUrl': 'http://127.0.0.1:8080', 'bridge.token': 'old-token' },
    session,
  });
  const active = first.runtime.loadConfig(first.api);
  active.serverUrl = 'http://127.0.0.1:18181';
  first.runtime.stageTemporaryConnectionOverride(first.api, active, active, session, 2_000);

  const restarted = await loadRuntimeConfig({
    saved: { 'bridge.serverUrl': 'http://127.0.0.1:19090', 'bridge.token': 'new-token' },
    session,
  });
  const config = restarted.runtime.loadConfig(restarted.api);
  const applied = restarted.runtime.applyTemporaryConnectionOverride(restarted.api, config, session, 2_100);

  assert.equal(applied.applied, false);
  assert.equal(applied.reason, 'saved_connection_changed');
  assert.equal(config.serverUrl, 'http://127.0.0.1:19090');
  assert.equal(config.token, 'new-token');
  assert.deepEqual(session.dump(), {});
});

test('matching active and saved settings do not create a temporary reload override', async () => {
  const loaded = await loadRuntimeConfig({
    saved: { 'bridge.serverUrl': 'http://127.0.0.1:8080', 'bridge.token': 'same-token' },
  });
  const config = loaded.runtime.loadConfig(loaded.api);
  const staged = loaded.runtime.stageTemporaryConnectionOverride(loaded.api, config, config, loaded.session, 3_000);

  assert.equal(staged.staged, false);
  assert.equal(staged.reason, 'matches_saved');
  assert.deepEqual(loaded.session.dump(), {});
});

test('extension reload command stages the active runtime connection before restarting Chrome', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/sessionCommands.js'), 'utf8');
  const timers = [];
  const context = {
    URL,
    location: new URL('https://chatgpt.com/c/reload-test'),
    document: { title: 'Reload test', querySelectorAll: () => [] },
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'sessionCommands.js' });

  const staged = [];
  const sent = [];
  const requests = [];
  const commands = context.ChatGptSessionCommands.createSessionCommands({
    CONFIG: { serverUrl: 'http://127.0.0.1:8080', token: 'runtime-token' },
    CONTENT_SCRIPT_VERSION: '3.0.14',
    DOM_PARSER: {},
    EXTENSION_VERSION: '1.0.14',
    diagnostic() {},
    extensionRequest(type, payload) { requests.push({ type, payload }); return Promise.resolve({}); },
    safeLaunchBridgeServerUrl(value) { return String(value || ''); },
    send(payload) { sent.push(payload); },
    stageTemporaryConnectionOverride(connection) {
      staged.push(connection);
      return { staged: true, reason: 'differs_from_saved', serverUrl: connection.serverUrl, tokenChanged: false };
    },
    visibleText() { return ''; },
  });

  const wireVersion = 'bridge-reload-v1|1.0.14|77|http%3A%2F%2F127.0.0.1%3A18181';
  commands.handleExtensionReload({
    commandId: 'reload-custom-port',
    reloadTabs: true,
    expectedVersion: wireVersion,
    connection: { serverUrl: 'http://127.0.0.1:18181' },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(staged)), [{
    serverUrl: 'http://127.0.0.1:18181',
    token: 'runtime-token',
  }]);
  assert.equal(sent[0].type, 'extension.reload.accepted');
  assert.equal(sent[0].temporaryConnection.staged, true);
  assert.equal(timers[0].delay, 120);
  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{
    type: 'bridge.extension.reload',
    payload: { reloadTabs: true, expectedVersion: wireVersion },
  }]);
});
