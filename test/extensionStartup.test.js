import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  extensionClientMatchesBundle,
  maybeReloadExtensionAtStartup,
  normalizeExtensionReloadPolicy,
  selectReloadableExtensionClient,
} from '../src/extensionStartup.js';

async function extensionDir(version = '9.8.7', contentVersion = '7.6.5') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-extension-startup-'));
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'Fixture Extension', version }));
  await fs.writeFile(path.join(dir, 'content.js'), `const CONTENT_SCRIPT_VERSION = '${contentVersion}';\n`);
  return dir;
}

test('startup extension reload policy normalizes CLI and environment values', () => {
  assert.equal(normalizeExtensionReloadPolicy('yes'), 'always');
  assert.equal(normalizeExtensionReloadPolicy('never'), 'never');
  assert.equal(normalizeExtensionReloadPolicy('unexpected'), 'ask');
});

test('startup extension reload prefers the selected compatible client', () => {
  const client = selectReloadableExtensionClient({
    selectedClientId: 'selected',
    clients: [
      { id: 'other', ready: true, compatible: true },
      { id: 'selected', ready: true, compatible: true },
    ],
  });
  assert.equal(client.id, 'selected');
});

test('startup extension bundle match requires both extension and content versions', () => {
  assert.equal(extensionClientMatchesBundle(
    { extensionVersion: '1.2.3', clientVersion: '4.5.6' },
    { version: '1.2.3', contentVersion: '4.5.6' },
  ), true);
  assert.equal(extensionClientMatchesBundle(
    { extensionVersion: '1.2.3', clientVersion: '4.5.5' },
    { version: '1.2.3', contentVersion: '4.5.6' },
  ), false);
});

test('startup extension reload does not ask when the connected bundle is already current', async () => {
  const dir = await extensionDir();
  let confirmed = false;
  let reloaded = false;
  const result = await maybeReloadExtensionAtStartup({
    policy: 'ask',
    mode: 'test',
    extensionDir: dir,
    getHealth: async () => ({
      selectedClientId: 'ext-1',
      clients: [{ id: 'ext-1', ready: true, extensionVersion: '9.8.7', clientVersion: '7.6.5', extensionProtocolVersion: 4 }],
    }),
    confirm: async () => { confirmed = true; return true; },
    reload: async () => { reloaded = true; },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'already-current');
  assert.equal(confirmed, false);
  assert.equal(reloaded, false);
});

test('startup extension reload asks for confirmation and verifies reconnect version', async () => {
  const dir = await extensionDir();
  const calls = [];
  const result = await maybeReloadExtensionAtStartup({
    policy: 'ask',
    mode: 'test',
    extensionDir: dir,
    getHealth: async () => ({ selectedClientId: 'ext-1', clients: [{ id: 'ext-1', ready: true, compatible: false, extensionVersion: '9.8.6', clientVersion: '7.6.4', extensionProtocolVersion: 4 }] }),
    confirm: async (question) => { calls.push({ question }); return true; },
    reload: async (options) => { calls.push(options); return { reconnected: { extensionVersion: '9.8.7', clientVersion: '7.6.5' } }; },
  });
  assert.equal(result.status, 'reloaded');
  assert.equal(result.reconnectedVersion, '9.8.7');
  assert.equal(result.reconnectedContentVersion, '7.6.5');
  assert.match(calls[0].question, /Reload the connected unpacked extension/);
  assert.deepEqual(calls[1], {
    sourceClientId: 'ext-1',
    expectedVersion: '9.8.7',
    reloadTabs: true,
    timeoutMs: 30_000,
  });
});

test('startup extension reload skips ask mode without an interactive confirmation channel', async () => {
  const dir = await extensionDir();
  let reloaded = false;
  const result = await maybeReloadExtensionAtStartup({
    policy: 'ask',
    extensionDir: dir,
    getHealth: async () => ({ clients: [{ id: 'ext-1', ready: true, compatible: true, extensionProtocolVersion: 4 }] }),
    confirm: async () => null,
    reload: async () => { reloaded = true; },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'non-interactive');
  assert.equal(reloaded, false);
});

test('forced startup extension reload fails on a mismatched reconnected version', async () => {
  const dir = await extensionDir('3.2.1');
  await assert.rejects(() => maybeReloadExtensionAtStartup({
    policy: 'always',
    extensionDir: dir,
    getHealth: async () => ({ clients: [{ id: 'ext-1', ready: true, compatible: true, extensionProtocolVersion: 4 }] }),
    reload: async () => ({ reconnected: { extensionVersion: '3.2.0' } }),
  }), /reconnected as 3\.2\.0, expected 3\.2\.1/);
});

test('startup reload can select a ready extension that is currently version-incompatible', () => {
  const client = selectReloadableExtensionClient({
    selectedClientId: 'outdated',
    clients: [
      { id: 'outdated', ready: true, compatible: false, extensionVersion: '1.0.3' },
    ],
  });
  assert.equal(client?.id, 'outdated');
});

test('startup reload blocks clients that cannot understand protocol 4 reload envelopes', async () => {
  const dir = await extensionDir();
  let reloaded = false;
  const result = await maybeReloadExtensionAtStartup({
    policy: 'always',
    extensionDir: dir,
    getHealth: async () => ({ clients: [{ id: 'legacy', ready: true, compatible: false, extensionProtocolVersion: 3 }] }),
    reload: async () => { reloaded = true; },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'protocol-incompatible');
  assert.equal(reloaded, false);
});

test('real E2E startup reload discovers clients through the full browser-client endpoint', async () => {
  const { maybeReloadE2eExtension } = await import('../scripts/e2e/startup-extension.js');
  const calls = [];
  const result = await maybeReloadE2eExtension({
    extensionReloadPolicy: 'always',
    tabReadyTimeoutMs: 5_000,
  }, {
    api: async (_options, route, request = {}) => {
      calls.push({ route, request });
      if (route === '/browser/clients') {
        return { clients: [{ id: 'ext-e2e', ready: true, compatible: true, extensionVersion: '2.0.3', extensionProtocolVersion: 4 }], selectedClientId: 'ext-e2e' };
      }
      if (route === '/browser/extension/reload') {
        return { reconnected: { extensionVersion: '2.0.3' } };
      }
      throw new Error(`Unexpected route: ${route}`);
    },
    testLog: () => {},
  });
  assert.equal(result.status, 'reloaded');
  assert.equal(calls[0].route, '/browser/clients');
  assert.equal(calls[1].route, '/browser/extension/reload');
});


test('real E2E bootstraps an outdated protocol-4 tab, reloads it, and selects the compatible reconnect', async () => {
  const { prepareIsolatedE2eTab } = await import('../scripts/e2e/startup-extension.js');
  const calls = [];
  let reloaded = false;
  const launchToken = 'bridge-real-e2e-fixture-run';
  const api = async (_options, route, request = {}) => {
    calls.push({ route, request });
    if (route === '/browser/tabs/open') {
      assert.equal(request.body.allowIncompatibleClient, true);
      assert.equal(request.body.select, false);
      assert.equal(request.body.launchToken, launchToken);
      return {
        client: {
          id: 'outdated-tab', ready: true, compatible: false,
          extensionVersion: '2.0.1', clientVersion: '4.0.1', extensionProtocolVersion: 4,
          browserTabId: 42, launchToken,
        },
        launchToken,
        openedBy: 'system',
      };
    }
    if (route === '/browser/clients') {
      return {
        clients: [reloaded
          ? {
              id: 'updated-tab', ready: true, compatible: true,
              extensionVersion: '2.0.3', clientVersion: '4.0.3', extensionProtocolVersion: 4,
              browserTabId: 42, launchToken, pageReady: true, composerReady: true, chatMainReady: true,
              capabilities: { browserTabs: true, sessionDeletion: true, promptSteering: true },
            }
          : {
              id: 'outdated-tab', ready: true, compatible: false,
              extensionVersion: '2.0.1', clientVersion: '4.0.1', extensionProtocolVersion: 4,
              browserTabId: 42, launchToken,
            }],
        selectedClientId: '',
      };
    }
    if (route === '/browser/extension/reload') {
      reloaded = true;
      assert.equal(request.body.sourceClientId, 'outdated-tab');
      return { reconnected: { id: 'updated-tab', extensionVersion: '2.0.3', clientVersion: '4.0.3' } };
    }
    if (route === '/browser/select') {
      assert.equal(request.body.clientId, 'updated-tab');
      return { selectedClient: { id: 'updated-tab' } };
    }
    throw new Error(`Unexpected route: ${route}`);
  };
  const result = await prepareIsolatedE2eTab({
    extensionReloadPolicy: 'always',
    tabReadyTimeoutMs: 2_000,
    tabSettleMs: 0,
    bootstrapWaitMs: 0,
    autoOpenBrowser: true,
    baseUrl: 'http://127.0.0.1:18181',
  }, {
    api,
    waitUntil: async (check) => await check(),
    testLog: () => {},
    step: () => {},
    runId: 'fixture-run',
  });
  assert.equal(result.client.id, 'updated-tab');
  assert.equal(result.extensionStartupReload.status, 'reloaded');
  assert.equal(reloaded, true);
  assert.deepEqual(calls.map((call) => call.route), [
    '/browser/tabs/open',
    '/browser/clients',
    '/browser/extension/reload',
    '/browser/clients',
    '/browser/select',
  ]);
});
