function observationState(value) {
  if (value && typeof value === 'object') return String(value.state || value.phase || '').toLowerCase();
  return String(value || '').toLowerCase();
}

function numericTabId(value) {
  const tabId = Number(value);
  return Number.isInteger(tabId) ? tabId : null;
}

export function browserOwnershipIdentity(client = {}, launchToken = '') {
  return Object.freeze({
    clientId: String(client.id || ''),
    browserTabId: numericTabId(client.browserTabId),
    launchToken: String(launchToken || client.launchToken || ''),
  });
}

export function findOwnedBrowserClient(clients = [], identity = {}) {
  const list = Array.isArray(clients) ? clients : [];
  const clientId = String(identity.clientId || '');
  if (clientId) {
    const exact = list.find((client) => client?.id === clientId);
    if (exact) return exact;
  }
  const browserTabId = numericTabId(identity.browserTabId);
  const launchToken = String(identity.launchToken || '');
  if (browserTabId != null && launchToken) {
    const sameOwnedTab = list.find((client) => numericTabId(client?.browserTabId) === browserTabId
      && String(client?.launchToken || '') === launchToken);
    if (sameOwnedTab) return sameOwnedTab;
  } else if (browserTabId != null) {
    const sameTab = list.find((client) => numericTabId(client?.browserTabId) === browserTabId);
    if (sameTab) return sameTab;
  } else if (launchToken) {
    return list.find((client) => String(client?.launchToken || '') === launchToken) || null;
  }
  return null;
}

function clientReady(client = {}) {
  return Boolean(client.ready && client.pageReady && client.composerReady && client.chatMainReady !== false);
}

function clientBusy(client = {}) {
  const generation = observationState(client.tabObservation?.generation);
  const output = observationState(client.tabObservation?.output);
  return Boolean(client.activeRequest)
    || ['active', 'starting', 'streaming'].includes(generation)
    || ['active', 'starting', 'streaming'].includes(output);
}

export async function waitForOwnedBrowserClient({
  options,
  identity,
  api,
  waitUntil,
  message = 'owned browser client reconnect',
  requireIdle = false,
} = {}) {
  return await waitUntil(async () => {
    const snapshot = await api(options, '/browser/clients');
    const candidate = findOwnedBrowserClient(snapshot.clients, identity);
    if (!candidate || !clientReady(candidate)) return null;
    if (requireIdle && clientBusy(candidate)) return null;
    return candidate;
  }, {
    timeoutMs: Math.max(15_000, Number(options?.tabReadyTimeoutMs) || 60_000),
    intervalMs: 300,
    message,
  });
}

export function turnFailureDetail(snapshot = {}, label = 'Turn') {
  const status = String(snapshot?.turn?.status || 'unknown');
  const error = snapshot?.turn?.error || {};
  const code = String(error.code || '').trim();
  const message = String(error.message || '').trim();
  const suffix = [code, message].filter(Boolean).join(': ');
  return `${label}: ${status}${suffix ? ` (${suffix})` : ''}`;
}

export async function recoverBrowserAfterScenarioFailure({
  options,
  sourceClientId,
  clientIdentity = {},
  scenarioId,
  api,
  waitUntil,
  testLog,
} = {}) {
  const identity = {
    ...clientIdentity,
    clientId: String(clientIdentity.clientId || sourceClientId || ''),
  };
  if (!identity.clientId && identity.browserTabId == null && !identity.launchToken) {
    return { recovered: false, reason: 'no-client-identity' };
  }

  let snapshot = await api(options, '/browser/clients');
  let client = findOwnedBrowserClient(snapshot.clients, identity);
  if (!client || !clientReady(client)) {
    testLog('warn', scenarioId, 'Owned ChatGPT tab disconnected; waiting for its protocol handshake before continuing', {
      clientId: identity.clientId || '',
      browserTabId: identity.browserTabId ?? '',
    });
    client = await waitForOwnedBrowserClient({
      options,
      identity,
      api,
      waitUntil,
      message: `owned browser reconnect after ${scenarioId}`,
    });
  }

  if (!clientBusy(client)) {
    return { recovered: true, reason: client.id === identity.clientId ? 'already-idle' : 'client-reconnected', client };
  }

  testLog('warn', scenarioId, 'Scenario left the ChatGPT tab busy; reloading it before the next scenario', {
    activeRequest: client.activeRequest?.requestId || '',
    generation: observationState(client.tabObservation?.generation) || '(unknown)',
  });
  await api(options, '/browser/tabs/reload', {
    method: 'POST',
    timeoutMs: 15_000,
    body: {
      sourceClientId: client.id,
      reason: `recover after failed E2E scenario ${scenarioId}`,
      timeoutMs: 10_000,
    },
  });
  const ready = await waitForOwnedBrowserClient({
    options,
    identity: { ...identity, clientId: client.id, browserTabId: client.browserTabId ?? identity.browserTabId },
    api,
    waitUntil,
    message: `browser recovery after ${scenarioId}`,
    requireIdle: true,
  });
  testLog('ok', scenarioId, 'ChatGPT tab recovered before the next scenario', { url: ready.url || '' });
  return { recovered: true, reason: 'tab-reloaded', url: ready.url || '', client: ready };
}
