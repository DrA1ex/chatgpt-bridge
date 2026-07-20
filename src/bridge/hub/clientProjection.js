export function activeRequestFromPayload(payload = {}, existing = null) {
  const requestId = String(payload.requestId || existing?.requestId || '').trim();
  if (!requestId) return existing || null;
  return Object.freeze({
    requestId,
    leaseId: String(payload.leaseId || existing?.leaseId || ''),
    ownerServerInstanceId: String(payload.ownerServerInstanceId || existing?.ownerServerInstanceId || ''),
    responseEpoch: Math.max(0, Number(payload.responseEpoch ?? existing?.responseEpoch) || 0),
    submittedUserTurnKey: String(payload.submittedUserTurnKey || existing?.submittedUserTurnKey || ''),
    submittedUserTurnIndex: Number.isInteger(payload.submittedUserTurnIndex)
      ? payload.submittedUserTurnIndex
      : Number(existing?.submittedUserTurnIndex ?? -1),
    assistantTurnKey: String(payload.assistantTurnKey || existing?.assistantTurnKey || ''),
    assistantTurnIndex: Number.isInteger(payload.assistantTurnIndex)
      ? payload.assistantTurnIndex
      : Number(existing?.assistantTurnIndex ?? -1),
    updatedAt: Date.now(),
  });
}

export function normalizeTabObservation(payload = {}, fallback = null) {
  const raw = payload.observation && typeof payload.observation === 'object'
    ? payload.observation
    : payload.tabObservation && typeof payload.tabObservation === 'object'
      ? payload.tabObservation
      : null;
  if (!raw) return fallback || null;
  const normalized = {
    ...raw,
    revision: Number(raw.revision ?? payload.revision) || 0,
    observedAt: Number(raw.observedAt ?? payload.observedAt) || 0,
    observerId: String(raw.observerId || ''),
  };
  const previousRevision = Number(fallback?.revision);
  const sameEpoch = String(fallback?.observerId || '') === normalized.observerId;
  if (fallback && sameEpoch && Number.isFinite(previousRevision) && normalized.revision <= previousRevision) return fallback;
  return normalized;
}

export function normalizeClientSession(payload = {}, fallback = null) {
  const raw = payload.session && typeof payload.session === 'object' ? payload.session : null;
  const url = String(raw?.url || payload.url || fallback?.url || '');
  let id = String(raw?.id || '').trim();
  if (!id) {
    try { id = new URL(url, 'https://chatgpt.com').pathname.match(/\/c\/([^/?#]+)/)?.[1] || ''; } catch {}
  }
  if (!id && /chatgpt\.com\/?(?:[?#].*)?$/i.test(url)) id = 'new';
  if (!id && raw?.active) id = 'new';
  if (!id && fallback?.id) id = String(fallback.id || '');
  if (!id && !url && !raw?.title) return fallback || null;
  return {
    id,
    url,
    title: String(raw?.title || payload.title || fallback?.title || id || ''),
    active: raw?.active ?? true,
  };
}

export function publicClientProjection(client, { selectedClientId = '', serverInstanceId = '' } = {}) {
  return {
    id: client.id,
    transport: client.transport || 'unknown',
    runtime: client.runtime || '',
    ready: client.ready,
    selected: selectedClientId === client.id,
    url: client.url,
    title: client.title,
    browserTabId: client.browserTabId ?? null,
    launchToken: client.launchToken || '',
    requestedUrl: client.requestedUrl || '',
    clientVersion: client.clientVersion || '',
    extensionVersion: client.extensionVersion || '',
    extensionProtocolVersion: client.extensionProtocolVersion || 0,
    compatibility: client.compatibility || null,
    compatible: client.compatibility?.compatible !== false,
    origin: client.origin,
    connectedAt: new Date(client.connectedAt).toISOString(),
    lastSeenAt: new Date(client.lastSeenAt).toISOString(),
    capabilities: client.capabilities,
    transportHealth: client.transportHealth || null,
    session: client.session || null,
    tabObservation: client.tabObservation || null,
    visibilityState: client.visibilityState || '',
    focused: Boolean(client.focused),
    documentReadyState: client.documentReadyState || '',
    chatMainReady: Boolean(client.chatMainReady),
    composerReady: Boolean(client.composerReady),
    pageReady: Boolean(client.pageReady),
    activeRequest: client.activeRequest || null,
    quarantined: Boolean(client.quarantined),
    quarantineReason: String(client.quarantineReason || ''),
    serverInstanceId,
  };
}
