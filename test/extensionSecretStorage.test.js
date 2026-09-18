import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBridgeAuth } from '../tools/chrome-bridge-extension/background/authPreflight.js';

const MARKER = '__chatgpt_bridge_secret_in_extension_storage_v1__';
const STORAGE_KEY = 'chatgptBridge:secret:bridge.token';

test('auth preflight resolves the page-safe marker from extension-private storage', async () => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          assert.equal(key, STORAGE_KEY);
          return { [STORAGE_KEY]: 'private-bridge-token' };
        },
      },
    },
  };

  try {
    const state = { serverUrl: 'http://127.0.0.1:8080', token: MARKER };
    const seen = [];
    const result = await checkBridgeAuth(state, async (url, options) => {
      seen.push({ url: String(url), options });
      return { ok: true, status: 200, async text() { return '{"ok":true}'; } };
    });

    assert.equal(result.ok, true);
    assert.equal(state.token, 'private-bridge-token');
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/extension\/auth\/check\?token=private-bridge-token/);
    assert.equal(seen[0].options.credentials, 'omit');
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test('auth preflight fails closed when the marker has no private secret', async () => {
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local: {
        async get() { return {}; },
      },
    },
  };

  try {
    let fetched = false;
    const state = { serverUrl: 'http://127.0.0.1:8080', token: MARKER };
    const result = await checkBridgeAuth(state, async () => {
      fetched = true;
      throw new Error('fetch must not run');
    });

    assert.equal(result.ok, false);
    assert.equal(result.authError, true);
    assert.equal(result.status, 401);
    assert.equal(fetched, false);
  } finally {
    globalThis.chrome = previousChrome;
  }
});
