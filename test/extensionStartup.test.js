import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  extensionClientMatchesBundle,
  maybeReloadExtensionAtStartup,
  normalizeExtensionReloadPolicy,
  readBundledExtensionInfo,
  selectReloadableExtensionClient,
} from '../src/extensionStartup.js';
import { deployBundledExtension } from '../src/extensionDeployment.js';

const BUNDLED_EXTENSION = await readBundledExtensionInfo();


async function extensionInstallDir() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-extension-install-target-'));
  return path.join(parent, 'extension');
}

async function extensionDir(version = '9.8.7', contentVersion = '7.6.5') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-extension-startup-'));
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'Fixture Extension', version }));
  await fs.writeFile(path.join(dir, 'content.js'), `const CONTENT_SCRIPT_VERSION = '${contentVersion}';\n`);
  return dir;
}

test('startup extension reload policy normalizes CLI and environment values', () => {
  assert.equal(normalizeExtensionReloadPolicy('yes'), 'if-needed');
  assert.equal(normalizeExtensionReloadPolicy('force'), 'always');
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

test('startup extension bundle match rejects a same-version client from another bundle', () => {
  assert.equal(extensionClientMatchesBundle(
    { extensionVersion: '1.2.3', extensionBundleId: 'old-build', clientVersion: '4.5.6' },
    { version: '1.2.3', bundleId: 'current-build', contentVersion: '4.5.6' },
  ), false);
  assert.equal(extensionClientMatchesBundle(
    { extensionVersion: '1.2.3', extensionBundleId: 'current-build', clientVersion: '4.5.6' },
    { version: '1.2.3', bundleId: 'current-build', contentVersion: '4.5.6' },
  ), true);
});

test('startup extension reload does not ask when the connected bundle is already current', async () => {
  const dir = await extensionDir();
  const installDir = await extensionInstallDir();
  await deployBundledExtension(dir, installDir);
  let confirmed = false;
  let reloaded = false;
  const result = await maybeReloadExtensionAtStartup({
    policy: 'ask',
    mode: 'test',
    extensionDir: dir,
    installDir,
    getHealth: async () => ({
      selectedClientId: 'ext-1',
      clients: [{ id: 'ext-1', ready: true, extensionVersion: '9.8.7', clientVersion: '7.6.5', extensionProtocolVersion: 5 }],
    }),
    confirm: async () => { confirmed = true; return true; },
    reload: async () => { reloaded = true; },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'already-current');
  assert.equal(confirmed, false);
  assert.equal(reloaded, false);
});

test('if-needed startup extension reload skips an already current connected bundle', async () => {
  const dir = await extensionDir();
  const installDir = await extensionInstallDir();
  await deployBundledExtension(dir, installDir);
  let reloaded = false;
  const result = await maybeReloadExtensionAtStartup({
    policy: 'if-needed',
    extensionDir: dir,
    installDir,
    getHealth: async () => ({
      selectedClientId: 'ext-1',
      clients: [{ id: 'ext-1', ready: true, extensionVersion: '9.8.7', clientVersion: '7.6.5', extensionProtocolVersion: 5 }],
    }),
    reload: async () => { reloaded = true; },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'already-current');
  assert.equal(reloaded, false);
});

test('startup extension reloads automatically when deployed files changed under the same version', async () => {
  const dir = await extensionDir('9.8.7', '7.6.5');
  const installDir = await extensionInstallDir();
  await fs.mkdir(installDir, { recursive: true });
  await fs.writeFile(path.join(installDir, 'manifest.json'), JSON.stringify({ name: 'Fixture Extension', version: '9.8.7' }));
  await fs.writeFile(path.join(installDir, 'content.js'), "const CONTENT_SCRIPT_VERSION = '7.6.5';\n// stale same-version bytes\n");
  let confirmed = false;
  let reloaded = false;
  const result = await maybeReloadExtensionAtStartup({
    policy: 'ask',
    mode: 'test',
    extensionDir: dir,
    installDir,
    getHealth: async () => ({
      selectedClientId: 'ext-1',
      clients: [{ id: 'ext-1', ready: true, extensionVersion: '9.8.7', clientVersion: '7.6.5', extensionProtocolVersion: 5 }],
    }),
    confirm: async () => { confirmed = true; return false; },
    reload: async () => { reloaded = true; return { reconnected: { extensionVersion: '9.8.7', clientVersion: '7.6.5' } }; },
  });
  assert.equal(result.status, 'reloaded');
  assert.equal(result.deployment.deployed, true);
  assert.equal(confirmed, false, 'Changed deployed bytes must not be skipped because the version string stayed the same');
  assert.equal(reloaded, true);
});

test('startup extension reload asks for confirmation and verifies reconnect version', async () => {
  const dir = await extensionDir();
  const installDir = await extensionInstallDir();
  await deployBundledExtension(dir, installDir);
  const calls = [];
  const result = await maybeReloadExtensionAtStartup({
    policy: 'ask',
    mode: 'test',
    extensionDir: dir,
    installDir,
    getHealth: async () => ({ selectedClientId: 'ext-1', clients: [{ id: 'ext-1', ready: true, compatible: false, extensionVersion: '9.8.6', clientVersion: '7.6.4', extensionProtocolVersion: 5 }] }),
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
    expectedBundleId: '',
    reloadTabs: true,
    allowMaintenancePageBootstrap: true,
    timeoutMs: 30_000,
  });
});

test('startup extension reload skips ask mode without an interactive confirmation channel', async () => {
  const dir = await extensionDir();
  const installDir = await extensionInstallDir();
  await deployBundledExtension(dir, installDir);
  let reloaded = false;
  const result = await maybeReloadExtensionAtStartup({
    policy: 'ask',
    extensionDir: dir,
    installDir,
    getHealth: async () => ({ clients: [{ id: 'ext-1', ready: true, compatible: true, extensionProtocolVersion: 5 }] }),
    confirm: async () => null,
    reload: async () => { reloaded = true; },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'non-interactive');
  assert.equal(reloaded, false);
});

test('forced startup extension reload fails on a mismatched reconnected version', async () => {
  const dir = await extensionDir('3.2.1');
  const installDir = await extensionInstallDir();
  await assert.rejects(() => maybeReloadExtensionAtStartup({
    policy: 'always',
    extensionDir: dir,
    installDir,
    getHealth: async () => ({ clients: [{ id: 'ext-1', ready: true, compatible: true, extensionProtocolVersion: 5 }] }),
    reload: async () => ({ reconnected: { extensionVersion: '3.2.0' } }),
  }), (error) => {
    assert.equal(error.code, 'EXTENSION_LOADED_PATH_MISMATCH');
    assert.match(error.message, /reconnected as 3\.2\.0, expected 3\.2\.1/);
    assert.match(error.message, new RegExp(installDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
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

test('startup reload blocks clients that cannot understand protocol 5 reload envelopes', async () => {
  const dir = await extensionDir();
  let reloaded = false;
  const result = await maybeReloadExtensionAtStartup({
    policy: 'always',
    extensionDir: dir,
    installDir: await extensionInstallDir(),
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
        return { clients: [{ id: 'ext-e2e', ready: true, compatible: true, extensionVersion: BUNDLED_EXTENSION.version, extensionBundleId: BUNDLED_EXTENSION.bundleId, extensionProtocolVersion: 5 }], selectedClientId: 'ext-e2e' };
      }
      if (route === '/browser/extension/reload') {
        assert.equal(request.body.allowMaintenancePageBootstrap, true);
        return { reconnected: { extensionVersion: BUNDLED_EXTENSION.version, extensionBundleId: BUNDLED_EXTENSION.bundleId } };
      }
      throw new Error(`Unexpected route: ${route}`);
    },
    testLog: () => {},
  });
  assert.equal(result.status, 'reloaded');
  assert.equal(calls[0].route, '/browser/clients');
  assert.equal(calls[1].route, '/browser/extension/reload');
});


test('real E2E bootstraps an outdated protocol-5 tab, reloads it, and selects the compatible reconnect', async () => {
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
          extensionVersion: '2.0.1', clientVersion: '4.0.1', extensionProtocolVersion: 5,
          backgroundEpoch: 'background-old', contentEpoch: 'content-old',
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
              extensionVersion: BUNDLED_EXTENSION.version, extensionBundleId: BUNDLED_EXTENSION.bundleId, clientVersion: '4.3.11', extensionProtocolVersion: 5,
              backgroundEpoch: 'background-new', contentEpoch: 'content-new',
              browserTabId: 42, launchToken, pageReady: true, composerReady: true, chatMainReady: true,
              capabilities: { browserTabs: true, sessionDeletion: true, promptSteering: true },
            }
          : {
              id: 'outdated-tab', ready: true, compatible: false,
              extensionVersion: '2.0.1', clientVersion: '4.0.1', extensionProtocolVersion: 5,
              backgroundEpoch: 'background-old', contentEpoch: 'content-old',
              browserTabId: 42, launchToken,
            }],
        selectedClientId: '',
      };
    }
    if (route === '/browser/extension/reload') {
      reloaded = true;
      assert.equal(request.body.sourceClientId, 'outdated-tab');
      assert.equal(request.body.allowMaintenancePageBootstrap, true);
      return { reconnected: { id: 'updated-tab', extensionVersion: BUNDLED_EXTENSION.version, extensionBundleId: BUNDLED_EXTENSION.bundleId, clientVersion: '4.3.11', backgroundEpoch: 'background-new', contentEpoch: 'content-new' } };
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

test('ask-mode startup update opens a bootstrap ChatGPT tab when no extension client is connected', async () => {
  const dir = await extensionDir('9.8.7', '7.6.5');
  const installDir = await extensionInstallDir();
  await deployBundledExtension(dir, installDir);
  let clients = [];
  const calls = [];
  const result = await maybeReloadExtensionAtStartup({
    policy: 'ask',
    mode: 'interactive fixture',
    extensionDir: dir,
    installDir,
    waitTimeoutMs: 50,
    confirm: async (question) => { calls.push(['confirm', question]); return true; },
    getHealth: async () => ({ clients, selectedClientId: clients[0]?.id || '' }),
    bootstrapClient: async () => {
      calls.push(['bootstrap']);
      const client = {
        id: 'bootstrap-tab', ready: true, compatible: false, browserTabId: 42,
        extensionVersion: '9.8.6', clientVersion: '7.6.4', extensionProtocolVersion: 5,
      };
      clients = [client];
      return { client };
    },
    reload: async (options) => {
      calls.push(['reload', options.sourceClientId]);
      return { reconnected: { id: 'bootstrap-tab', browserTabId: 42, extensionVersion: '9.8.7', clientVersion: '7.6.5' } };
    },
  });
  assert.equal(result.status, 'reloaded');
  assert.deepEqual(calls.map((item) => item[0]), ['confirm', 'bootstrap', 'reload']);
  assert.match(calls[0][1], /Open a temporary ChatGPT tab/);
  assert.equal(calls[2][1], 'bootstrap-tab');
});

test('forced startup update fails instead of silently skipping when no client or bootstrap path exists', async () => {
  const dir = await extensionDir('9.8.7', '7.6.5');
  const installDir = await extensionInstallDir();
  await assert.rejects(() => maybeReloadExtensionAtStartup({
    policy: 'always',
    extensionDir: dir,
    installDir,
    waitTimeoutMs: 5,
    getHealth: async () => ({ clients: [] }),
    reload: async () => { throw new Error('must not run'); },
  }), (error) => {
    assert.equal(error.code, 'EXTENSION_UPDATE_CLIENT_UNAVAILABLE');
    return true;
  });
});

test('interactive startup opens a dedicated update tab and reloads from that tab before entering the UI', async () => {
  const { runInteractiveStartupExtensionUpdate } = await import('../src/interactive/startupExtensionUpdate.js');
  const info = await readBundledExtensionInfo();
  let clients = [{
    id: 'old-user-tab', ready: true, compatible: false, browserTabId: 11,
    extensionVersion: '2.3.10', extensionBundleId: 'old-bundle', clientVersion: info.contentVersion,
    extensionProtocolVersion: 5,
  }];
  const calls = [];
  const result = await runInteractiveStartupExtensionUpdate({
    policy: 'ask',
    publicBaseUrl: 'http://127.0.0.1:18181',
    waitTimeoutMs: 100,
    confirm: async () => { calls.push('confirm'); return true; },
    bridge: {
      health: async () => ({ clients, selectedClientId: 'old-user-tab' }),
      openBrowserTab: async (options) => {
        calls.push('open');
        assert.equal(options.allowSystemFallback, true);
        assert.equal(options.allowIncompatibleClient, true);
        assert.match(options.launchToken, /^bridge-extension-update-/);
        const client = {
          id: 'update-tab', ready: true, compatible: false, browserTabId: 77,
          extensionVersion: '2.3.10', extensionBundleId: 'old-bundle', clientVersion: info.contentVersion,
          extensionProtocolVersion: 5, launchToken: options.launchToken,
        };
        clients = [clients[0], client];
        return { client, launchToken: options.launchToken, openedBy: 'system' };
      },
      reloadExtension: async (options) => {
        calls.push('reload');
        assert.equal(options.sourceClientId, 'update-tab');
        const updated = {
          id: 'update-tab:tab:77', ready: true, compatible: true, browserTabId: 77,
          extensionVersion: info.version, extensionBundleId: info.bundleId, clientVersion: info.contentVersion,
          extensionProtocolVersion: 5,
        };
        clients = [clients[0], updated];
        return { reconnected: updated };
      },
    },
  });
  assert.equal(result.status, 'reloaded');
  assert.deepEqual(calls, ['confirm', 'open', 'reload']);
  assert.equal(result.result.reconnected.browserTabId, 77);
});

test('interactive entrypoint blocks the UI when an accepted startup update fails', async () => {
  const source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /await shutdown\('interactive-extension-update-failed', 1\);\s*return;/);
});

test('interactive startup treats a protocol-incompatible reload result as fatal before the UI starts', async () => {
  const { runInteractiveStartupExtensionUpdate } = await import('../src/interactive/startupExtensionUpdate.js');
  await assert.rejects(() => runInteractiveStartupExtensionUpdate({
    policy: 'always',
    waitTimeoutMs: 25,
    bridge: {
      health: async () => ({
        clients: [{
          id: 'legacy-extension', ready: true, compatible: false,
          extensionVersion: '1.0.0', clientVersion: '1.0.0', extensionProtocolVersion: 3,
        }],
        selectedClientId: 'legacy-extension',
      }),
      openBrowserTab: async () => { throw new Error('must not open after legacy client selection'); },
      reloadExtension: async () => { throw new Error('must not reload unsupported protocol'); },
    },
  }), (error) => {
    assert.equal(error.code, 'INTERACTIVE_EXTENSION_UPDATE_BLOCKED');
    assert.match(error.message, /Protocol 5 reload command/);
    assert.equal(error.result?.reason, 'protocol-incompatible');
    return true;
  });
});

test('interactive Yes with no connected client opens a bootstrap tab and completes the verified update', async () => {
  const { runInteractiveStartupExtensionUpdate } = await import('../src/interactive/startupExtensionUpdate.js');
  const info = await readBundledExtensionInfo();
  let clients = [];
  const calls = [];
  const result = await runInteractiveStartupExtensionUpdate({
    policy: 'ask',
    publicBaseUrl: 'http://127.0.0.1:18181',
    waitTimeoutMs: 100,
    confirm: async (question) => {
      calls.push('confirm');
      assert.match(question, /Open a temporary ChatGPT tab/);
      return true;
    },
    bridge: {
      health: async () => ({ clients, selectedClientId: '' }),
      openBrowserTab: async (options) => {
        calls.push('open');
        const client = {
          id: 'bootstrap-update-tab', ready: true, compatible: false, browserTabId: 88,
          extensionVersion: '2.3.10', extensionBundleId: 'old-bundle', clientVersion: info.contentVersion,
          extensionProtocolVersion: 5, launchToken: options.launchToken,
        };
        clients = [client];
        return { client, launchToken: options.launchToken, openedBy: 'system' };
      },
      reloadExtension: async (options) => {
        calls.push('reload');
        assert.equal(options.sourceClientId, 'bootstrap-update-tab');
        const updated = {
          id: 'bootstrap-update-tab:tab:88', ready: true, compatible: true, browserTabId: 88,
          extensionVersion: info.version, extensionBundleId: info.bundleId, clientVersion: info.contentVersion,
          extensionProtocolVersion: 5,
        };
        clients = [updated];
        return { reconnected: updated };
      },
    },
  });
  assert.equal(result.status, 'reloaded');
  assert.deepEqual(calls, ['confirm', 'open', 'reload']);
  assert.equal(result.result.reconnected.browserTabId, 88);
});
