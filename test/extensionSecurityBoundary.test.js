import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {
  EXPECTED_EXTENSION_ORIGIN,
  isAllowedExtensionOrigin,
} from '../src/bridge/hub/connectionPolicy.js';

const TOKEN_MARKER = '__chatgpt_bridge_secret_in_extension_storage_v1__';
const TOKEN_STORAGE_KEY = 'chatgptBridge:secret:bridge.token';

function makePageStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    value(key) { return values.get(key); },
  };
}

async function loadExtensionApi(initial = {}) {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/extensionApi.js'), 'utf8');
  const pageStorage = makePageStorage(initial.pageStorage);
  const privateStorage = new Map(Object.entries(initial.privateStorage || {}));
  const runtimeMessages = [];
  const context = {
    URL,
    Uint8Array,
    JSON,
    console,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    localStorage: pageStorage,
    chrome: {
      storage: {
        local: {
          async set(values) { for (const [key, value] of Object.entries(values || {})) privateStorage.set(key, value); },
          async get(key) { return { [key]: privateStorage.get(key) }; },
          async remove(key) { privateStorage.delete(key); },
        },
      },
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          runtimeMessages.push(message);
          callback?.({ result: { status: 200, ok: true, responseType: 'json', data: { ok: true }, contentType: 'application/json' } });
        },
      },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'extensionApi.js' });
  return { api: context.ChatGptExtensionApi, pageStorage, privateStorage, runtimeMessages };
}

test('legacy plaintext bridge token is migrated out of ChatGPT localStorage', async () => {
  const { api, pageStorage, privateStorage } = await loadExtensionApi({
    pageStorage: { 'chatgptBridge:bridge.token': JSON.stringify('legacy-secret') },
  });

  assert.equal(api.getValue('bridge.token', ''), 'legacy-secret');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pageStorage.value('chatgptBridge:bridge.token'), JSON.stringify(TOKEN_MARKER));
  assert.equal(privateStorage.get(TOKEN_STORAGE_KEY), 'legacy-secret');
});

test('new bridge tokens persist only a marker in page localStorage', async () => {
  const { api, pageStorage, privateStorage } = await loadExtensionApi();

  assert.equal(api.setValue('bridge.token', 'new-private-secret'), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pageStorage.value('chatgptBridge:bridge.token'), JSON.stringify(TOKEN_MARKER));
  assert.equal(privateStorage.get(TOKEN_STORAGE_KEY), 'new-private-secret');
});

test('privileged HTTP rejects a different localhost port', async () => {
  const { api, runtimeMessages } = await loadExtensionApi({
    pageStorage: { 'chatgptBridge:bridge.serverUrl': JSON.stringify('http://127.0.0.1:8080') },
  });

  const error = await new Promise((resolve) => {
    api.httpRequest({
      url: 'http://127.0.0.1:9999/private-service',
      onerror: resolve,
    });
  });

  assert.match(error.error, /refused privileged request/i);
  assert.equal(runtimeMessages.length, 0);
});

test('privileged HTTP permits the configured loopback bridge origin', async () => {
  const { api, runtimeMessages } = await loadExtensionApi({
    pageStorage: { 'chatgptBridge:bridge.serverUrl': JSON.stringify('http://127.0.0.1:18181') },
  });

  await new Promise((resolve, reject) => {
    api.httpRequest({
      url: 'http://127.0.0.1:18181/files/signed-test',
      onload: resolve,
      onerror: reject,
    });
  });

  assert.equal(runtimeMessages.length, 1);
  assert.equal(runtimeMessages[0].request.url, 'http://127.0.0.1:18181/files/signed-test');
});

test('privileged auth check substitutes the private token without exposing it in page storage', async () => {
  const { api, pageStorage, runtimeMessages } = await loadExtensionApi({
    pageStorage: {
      'chatgptBridge:bridge.serverUrl': JSON.stringify('http://127.0.0.1:8080'),
      'chatgptBridge:bridge.token': JSON.stringify(TOKEN_MARKER),
    },
    privateStorage: { [TOKEN_STORAGE_KEY]: 'private-bridge-token' },
  });

  await new Promise((resolve, reject) => {
    api.httpRequest({
      url: `http://127.0.0.1:8080/extension/auth/check?token=${encodeURIComponent(TOKEN_MARKER)}&runtime=extension`,
      onload: resolve,
      onerror: reject,
    });
  });

  assert.equal(runtimeMessages.length, 1);
  const sent = new URL(runtimeMessages[0].request.url);
  assert.equal(sent.searchParams.get('token'), 'private-bridge-token');
  assert.equal(pageStorage.value('chatgptBridge:bridge.token'), JSON.stringify(TOKEN_MARKER));
});

test('extension origin policy is pinned to the manifest-derived extension id', () => {
  assert.equal(EXPECTED_EXTENSION_ORIGIN, 'chrome-extension://dchijcgcljbehhihflegffnhkambmmjb');
  assert.equal(isAllowedExtensionOrigin(EXPECTED_EXTENSION_ORIGIN), true);
  assert.equal(isAllowedExtensionOrigin('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), false);
  assert.equal(isAllowedExtensionOrigin('https://chatgpt.com'), false);
});
