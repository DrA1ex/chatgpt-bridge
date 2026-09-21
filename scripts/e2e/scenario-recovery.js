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

function clientReleasePending(client = {}) {
  return client.releasePending === true
    || Boolean(client.releasingRequestId);
}

function clientQuarantined(client = {}) {
  return client.quarantined === true || String(client.releaseState || '').toLowerCase() === 'quarantined';
}

function clientBusy(client = {}) {
  const generation = observationState(client.tabObservation?.generation);
  const output = observationState(client.tabObservation?.output);
  return Boolean(client.activeRequest)
    || clientReleasePending(client)
    || ['active', 'starting', 'streaming'].includes(generation)
    || ['active', 'starting', 'streaming'].includes(output);
}

function clientReusableIdle(client = {}) {
  return Boolean(client && clientReady(client) && !clientBusy(client) && !clientQuarantined(client));
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
    if (requireIdle && !clientReusableIdle(candidate)) return null;
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


export async function quiesceBrowserWork({
  options,
  api,
  waitUntil,
  reason = 'E2E browser work cleanup',
  sourceClientId = '',
  clientIdentity = null,
  testLog = () => {},
} = {}) {
  if (typeof api !== 'function') throw new TypeError('Browser quiescence requires api');
  if (typeof waitUntil !== 'function') throw new TypeError('Browser quiescence requires waitUntil');
  const result = { browserCancelled: 0, interruptedTurns: [], errors: [] };
  try {
    const stopped = await api(options, '/browser/stop', {
      method: 'POST',
      timeoutMs: 10_000,
      body: { reason },
    });
    result.browserCancelled = Number(stopped?.cancelled) || 0;
  } catch (error) {
    result.errors.push({ stage: 'browser.stop', message: error.message });
  }

  try {
    const running = await api(options, '/turns?status=running&limit=100', { timeoutMs: 10_000 });
    for (const turn of running?.turns || []) {
      const turnId = String(turn?.id || '');
      if (!turnId) continue;
      try {
        const response = await api(options, `/turns/${encodeURIComponent(turnId)}/interrupt`, {
          method: 'POST',
          timeoutMs: 10_000,
          body: { reason },
        });
        result.interruptedTurns.push({ turnId, status: response?.turn?.status || 'interrupted' });
      } catch (error) {
        if (Number(error?.statusCode || error?.status) === 404) continue;
        result.errors.push({ stage: 'turn.interrupt', turnId, message: error.message });
      }
    }
  } catch (error) {
    result.errors.push({ stage: 'turn.list', message: error.message });
  }

  const identity = clientIdentity && typeof clientIdentity === 'object'
    ? { ...clientIdentity, clientId: String(clientIdentity.clientId || sourceClientId || '') }
    : sourceClientId ? { clientId: String(sourceClientId) } : null;
  const settleWindowOption = Number(options?.quiescenceSettleMs);
  const settleWindowMs = Number.isFinite(settleWindowOption) && settleWindowOption >= 0 ? settleWindowOption : 750;
  let idleSince = 0;
  let idleProjection = null;
  const settled = await waitUntil(async () => {
    const health = await api(options, '/health', { timeoutMs: 3_000 });
    if ((health.activeRequests || []).length) {
      idleSince = 0;
      idleProjection = null;
      return null;
    }
    if (!identity) {
      if (!idleSince) idleSince = Date.now();
      idleProjection = { health, client: null };
      return Date.now() - idleSince >= settleWindowMs ? idleProjection : null;
    }
    const snapshot = await api(options, '/browser/clients', { timeoutMs: 3_000 });
    const client = findOwnedBrowserClient(snapshot.clients, identity);
    if (clientQuarantined(client)) return { health, client, quarantined: true };
    const leaseSettled = Boolean(client && clientReady(client) && !client.activeRequest && !clientReleasePending(client));
    if (!leaseSettled) {
      idleSince = 0;
      idleProjection = null;
      return null;
    }
    if (!idleSince) idleSince = Date.now();
    idleProjection = { health, client };
    return Date.now() - idleSince >= settleWindowMs ? idleProjection : null;
  }, {
    timeoutMs: 15_000,
    intervalMs: 150,
    message: 'canonical browser request and lease settlement',
  });
  if (settled.quarantined || clientQuarantined(settled.client)) {
    testLog('warn', 'browser-quiescence', 'Browser lease reached a quarantined terminal state', {
      cancelled: result.browserCancelled,
      interruptedTurns: result.interruptedTurns.length,
      errors: result.errors.length,
      reason: settled.client?.quarantineReason || settled.client?.releaseState || 'quarantined',
    });
    return { ...result, settled: true, reusable: false, quarantined: true, health: settled.health, client: settled.client || null };
  }
  testLog('state', 'browser-quiescence', 'Canonical browser work and physical lease release settled', {
    cancelled: result.browserCancelled,
    interruptedTurns: result.interruptedTurns.length,
    errors: result.errors.length,
  });
  return { ...result, settled: true, reusable: true, health: settled.health, client: settled.client || null };
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

  if (clientQuarantined(client)) {
    return { recovered: false, reason: 'lease-quarantined', client };
  }
  if (clientReusableIdle(client)) {
    return { recovered: true, reason: client.id === identity.clientId ? 'already-idle' : 'client-reconnected', client };
  }

  testLog('warn', scenarioId, 'Scenario left canonical browser work active; stopping it before any tab reload', {
    activeRequest: client.activeRequest?.requestId || '',
    generation: observationState(client.tabObservation?.generation) || '(unknown)',
  });
  const recoveryIdentity = { ...identity, clientId: client.id, browserTabId: client.browserTabId ?? identity.browserTabId };
  const quiescence = await quiesceBrowserWork({
    options,
    api,
    waitUntil,
    reason: `recover after failed E2E scenario ${scenarioId}`,
    sourceClientId: client.id,
    clientIdentity: recoveryIdentity,
    testLog,
  });

  snapshot = await api(options, '/browser/clients');
  client = findOwnedBrowserClient(snapshot.clients, recoveryIdentity) || quiescence.client || client;
  if (quiescence.quarantined || clientQuarantined(client)) {
    testLog('error', scenarioId, 'The owned ChatGPT tab was quarantined during physical lease release; later scenarios are blocked', {
      reason: client?.quarantineReason || 'lease-quarantined',
    });
    return { recovered: false, reason: 'lease-quarantined', client, quiescence };
  }
  if (clientReusableIdle(client)) {
    testLog('ok', scenarioId, 'Canonical request and physical browser lease settled; the ChatGPT tab is reusable', { url: client.url || '' });
    return { recovered: true, reason: 'canonical-work-stopped', url: client.url || '', client, quiescence };
  }

  testLog('warn', scenarioId, 'Canonical work settled but the tab projection is still busy; reloading the idle-owned tab', {
    activeRequest: client.activeRequest?.requestId || '',
    generation: observationState(client.tabObservation?.generation) || '(unknown)',
  });
  await api(options, '/browser/tabs/reload', {
    method: 'POST',
    timeoutMs: 15_000,
    body: {
      sourceClientId: client.id,
      reason: `recover idle tab after failed E2E scenario ${scenarioId}`,
      timeoutMs: 10_000,
    },
  });
  const ready = await waitForOwnedBrowserClient({
    options,
    identity: recoveryIdentity,
    api,
    waitUntil,
    message: `browser recovery after ${scenarioId}`,
    requireIdle: true,
  });
  testLog('ok', scenarioId, 'ChatGPT tab recovered before the next scenario', { url: ready.url || '' });
  return { recovered: true, reason: 'canonical-work-stopped-and-tab-reloaded', url: ready.url || '', client: ready, quiescence };
}
