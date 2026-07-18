import assert from 'node:assert/strict';
import { compareVersions, EXTENSION_COMPATIBILITY } from '../../src/extensionCompatibility.js';
import { maybeReloadExtensionAtStartup } from '../../src/extensionStartup.js';

export async function maybeReloadE2eExtension(options, { api, testLog, preferredClientId = '' } = {}) {
  return await maybeReloadExtensionAtStartup({
    policy: options.extensionReloadPolicy,
    mode: 'real E2E',
    preferredClientId,
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

function sameBootstrappedTab(candidate, opened, reloadResult) {
  const reconnectedId = String(reloadResult?.result?.reconnected?.id || '');
  if (reconnectedId && candidate.id === reconnectedId) return true;
  const tabId = Number(opened.client?.browserTabId);
  if (Number.isInteger(tabId) && Number(candidate.browserTabId) === tabId) return true;
  return Boolean(opened.launchToken && candidate.launchToken === opened.launchToken);
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
    },
  });
  assert(opened.client?.id, 'Bridge opened a tab but did not return its source client');
  assert.equal(opened.client.launchToken, launchToken, `Opened tab launch token mismatch: expected ${launchToken}, got ${opened.client.launchToken || '(empty)'}`);
  assert(opened.client.compatible !== false && opened.client.compatibility?.compatible !== false,
    opened.client.compatibility?.message || 'The isolated E2E tab uses an incompatible extension. Update it before running E2E.');

  const extensionStartupReload = await maybeReloadE2eExtension(options, {
    api,
    testLog,
    preferredClientId: opened.client.id,
  });

  step(`Waiting for ChatGPT composer in the startup tab`);
  const readyClient = await waitUntil(async () => {
    const snapshot = await api(options, '/browser/clients');
    const candidate = snapshot.clients?.find((item) => sameBootstrappedTab(item, opened, extensionStartupReload));
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
