import assert from 'node:assert/strict';
import { compareVersions, EXTENSION_COMPATIBILITY } from '../../src/extensionCompatibility.js';
import { maybeReloadExtensionAtStartup } from '../../src/extensionStartup.js';

export async function maybeReloadE2eExtension(options, { api, testLog, preferredClientId = '', bootstrapClient = null } = {}) {
  return await maybeReloadExtensionAtStartup({
    policy: options.extensionReloadPolicy,
    mode: 'real E2E',
    // The real-browser matrix owns one launch-token-bound tab. Reload only
    // that source tab: unrelated user ChatGPT tabs may legitimately hold
    // active leases and must neither block nor be refreshed by an E2E update.
    reloadTabs: false,
    preferredClientId,
    bootstrapClient,
    waitTimeoutMs: 5_000,
    reloadTimeoutMs: Math.max(20_000, Number(options.tabReadyTimeoutMs) || 30_000),
    getHealth: async () => await api(options, '/browser/clients'),
    reload: async (payload) => await api(options, '/browser/extension/reload', {
      method: 'POST',
      timeoutMs: payload.timeoutMs,
      body: payload,
    }),
    log: (level, message) => testLog(level === 'action' ? 'action' : level === 'warn' ? 'warn' : 'ok', 'extension-reload', message),
  });
}

function sameBootstrappedTab(candidate, opened) {
  const tabId = Number(opened.client?.browserTabId);
  if (Number.isInteger(tabId)) return Number(candidate.browserTabId) === tabId;
  return Boolean(opened.client?.id && candidate.id === opened.client.id);
}

export async function prepareIsolatedE2eTab(options, { api, waitUntil, testLog, step, runId } = {}) {
  const launchToken = `bridge-real-e2e-${runId}`;
  const opened = await api(options, '/browser/tabs/open', {
    method: 'POST',
    timeoutMs: 55_000,
    body: {
      url: 'https://chatgpt.com/',
      active: true,
      launchToken,
      bridgeServerUrl: options.baseUrl,
      select: false,
      timeoutMs: 45_000,
      bootstrapWaitMs: options.bootstrapWaitMs,
      allowSystemFallback: options.autoOpenBrowser,
      allowIncompatibleClient: true,
    },
  });
  assert(opened.client?.id, 'Bridge opened a tab but did not return its source client');
  assert.equal(opened.client.launchToken, launchToken, `Opened tab launch token mismatch: expected ${launchToken}, got ${opened.client.launchToken || '(empty)'}`);

  const extensionStartupReload = await maybeReloadE2eExtension(options, {
    api,
    testLog,
    preferredClientId: opened.client.id,
    bootstrapClient: async () => opened,
  });
  if (extensionStartupReload?.status === 'blocked') {
    throw new Error(extensionStartupReload.compatibility?.message || `Extension startup update was blocked: ${extensionStartupReload.reason || 'unknown reason'}`);
  }
  if (['always', 'if-needed'].includes(String(options.extensionReloadPolicy || ''))
    && !['reloaded', 'skipped'].includes(String(extensionStartupReload?.status || ''))) {
    throw new Error(`Extension startup update did not complete: ${extensionStartupReload?.status || 'missing result'}`);
  }

  step(`Waiting for ChatGPT composer in the startup tab`);
  const readyClient = await waitUntil(async () => {
    const snapshot = await api(options, '/browser/clients');
    const candidate = snapshot.clients?.find((item) => sameBootstrappedTab(item, opened));
    if (!candidate?.ready || !candidate.pageReady || !candidate.composerReady || !candidate.chatMainReady) return null;
    return candidate;
  }, {
    timeoutMs: options.tabReadyTimeoutMs,
    intervalMs: 250,
    message: 'ChatGPT page readiness after startup extension reload',
  });

  assert(readyClient.compatible !== false && readyClient.compatibility?.compatible !== false,
    readyClient.compatibility?.message || `Extension ${readyClient.extensionVersion || 'unknown'} is incompatible with this bridge`);
  const readinessVersion = compareVersions(readyClient.clientVersion || '', EXTENSION_COMPATIBILITY.minContentVersion);
  assert(readinessVersion !== null && readinessVersion >= 0,
    `Real E2E requires content runtime ${EXTENSION_COMPATIBILITY.minContentVersion}+ from extension ${EXTENSION_COMPATIBILITY.minExtensionVersion}+; got ${readyClient.clientVersion || 'unknown'}. Reload the unpacked extension and reload ChatGPT tabs.`);

  if (extensionStartupReload?.status === 'reloaded') {
    assert.equal(Number(readyClient.browserTabId), Number(opened.client.browserTabId),
      'Extension reload replaced the startup browser tab instead of automatically refreshing the original page');
    assert.equal(extensionStartupReload?.result?.recovery?.used === true, false,
      `Extension reload required replacement recovery: ${extensionStartupReload?.result?.recovery?.reason || 'unknown'}`);
    assert(readyClient.backgroundEpoch, 'Extension reload reconnected without a background runtime epoch');
    assert(readyClient.contentEpoch, 'Extension reload reconnected without a content runtime epoch');
    assert.notEqual(readyClient.backgroundEpoch, opened.client.backgroundEpoch,
      'Extension reload did not replace the background service worker epoch');
    assert.notEqual(readyClient.contentEpoch, opened.client.contentEpoch,
      'Extension reload did not replace the page content runtime; automatic page refresh did not complete');
    if (readyClient.mock?.enabled) {
      assert(Number(readyClient.mock.trampolineReloadCount || 0) > 0,
        'Mock extension reload did not pass through the independent Bridge reload trampoline');
    }
    testLog('ok', 'extension-reload', 'Automatic page refresh replaced both extension runtime epochs', {
      backgroundEpoch: readyClient.backgroundEpoch,
      contentEpoch: readyClient.contentEpoch,
    });
  }

  await api(options, '/browser/select', { method: 'POST', body: { clientId: readyClient.id } });
  if (options.tabSettleMs) {
    step(`ChatGPT composer is ready; settling for ${options.tabSettleMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, options.tabSettleMs));
  }

  return {
    client: readyClient,
    launchToken: String(readyClient.launchToken || extensionStartupReload?.result?.recovery?.launchToken || launchToken),
    openedBy: opened.openedBy || 'extension',
    bootstrapClientId: opened.sourceClientId || '',
    targetUrl: opened.targetUrl || opened.requestedUrl || '',
    extensionStartupReload,
  };
}
