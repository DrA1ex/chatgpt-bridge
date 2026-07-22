import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { resolveBridgeRuntime } from '../scripts/e2e/runtime.js';

test('mock E2E auto-start uses fresh isolated API and extension tokens', async () => {
  const inheritedApiToken = 'inherited-api-token';
  const inheritedBridgeToken = 'inherited-bridge-token';
  const first = await resolveBridgeRuntime({
    baseUrl: '',
    port: 0,
    autoStartServer: true,
    mockChatGpt: true,
    apiToken: inheritedApiToken,
    bridgeToken: inheritedBridgeToken,
  }, 'isolation-a', { publicBaseUrl: 'http://127.0.0.1:8080', dataDir: os.tmpdir() });
  const second = await resolveBridgeRuntime({
    baseUrl: '',
    port: 0,
    autoStartServer: true,
    mockChatGpt: true,
    apiToken: inheritedApiToken,
    bridgeToken: inheritedBridgeToken,
  }, 'isolation-b', { publicBaseUrl: 'http://127.0.0.1:8080', dataDir: os.tmpdir() });

  assert.notEqual(first.apiToken, inheritedApiToken);
  assert.notEqual(first.bridgeToken, inheritedBridgeToken);
  assert.notEqual(first.apiToken, second.apiToken);
  assert.notEqual(first.bridgeToken, second.bridgeToken);
  assert.match(first.apiToken, /^[A-Za-z0-9_-]{64}$/);
  assert.match(first.bridgeToken, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(first.serverDataDir, path.join(os.tmpdir(), 'e2e', 'runtime', 'isolation-a'));
});

test('live or externally managed E2E keeps explicitly supplied credentials', async () => {
  const options = await resolveBridgeRuntime({
    baseUrl: 'http://127.0.0.1:9123',
    port: 9123,
    autoStartServer: false,
    mockChatGpt: false,
    apiToken: 'live-api',
    bridgeToken: 'live-bridge',
  }, 'live', { publicBaseUrl: 'http://127.0.0.1:9123', dataDir: os.tmpdir() });

  assert.equal(options.apiToken, 'live-api');
  assert.equal(options.bridgeToken, 'live-bridge');
});
