import { browserLaunchMetadataFromUrl } from '../browserLaunch.js';

export function normalizeConversationId(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, 'https://chatgpt.com');
    const id = parsed.pathname.match(/\/c\/([^/?#]+)/)?.[1] || '';
    if (id) return id;
  } catch {}
  return raw.replace(/^\/+c\//, '').replace(/[/?#].*$/, '');
}

export function sessionIdFromClient(client = {}) {
  const fromSession = normalizeConversationId(client.session?.id || client.session?.url || '');
  if (fromSession) return fromSession;
  return normalizeConversationId(client.url || '');
}

export function clientMatchesSession(client = {}, sessionId = '') {
  const desired = normalizeConversationId(sessionId);
  if (!desired) return false;
  return sessionIdFromClient(client) === desired;
}

export function busyClientLabel(client = {}, localServerInstanceId = '') {
  const releasingRequestId = String(client.releasingRequestId || '');
  const requestId = releasingRequestId || client.activeRequest?.requestId || 'local-pending';
  const owner = String(client.activeRequest?.ownerServerInstanceId || '');
  const ownerSuffix = owner && owner !== String(localServerInstanceId || '') ? `@server:${owner}` : '';
  const phaseSuffix = releasingRequestId ? ':releasing' : '';
  return `${client.id || 'unknown-tab'}:${requestId}${ownerSuffix}${phaseSuffix}`;
}

export function clientDisplayLabel(client = {}) {
  const title = String(client.title || client.session?.title || '').replace(/\s+/g, ' ').trim();
  const url = String(client.url || client.session?.url || '').trim();
  const bits = [client.id || 'unknown-tab'];
  if (title) bits.push(title.length > 72 ? `${title.slice(0, 72)}…` : title);
  const sessionId = sessionIdFromClient(client);
  if (sessionId) bits.push(`session ${sessionId}`);
  else if (url) bits.push(url.length > 72 ? `${url.slice(0, 72)}…` : url);
  if (client.focused) bits.push('focused');
  if (client.visibilityState) bits.push(client.visibilityState);
  return bits.filter(Boolean).join(' · ');
}

export function makeClientSelectionError(message, candidates = []) {
  const err = new Error(message);
  err.code = 'CLIENT_SELECTION_REQUIRED';
  err.candidates = candidates;
  return err;
}

export function normalizeLaunchedClient(client = {}, expectedLaunchToken = '') {
  const metadata = browserLaunchMetadataFromUrl(client.url);
  const launchToken = String(client.launchToken || metadata.launchToken || '');
  if (!launchToken || (expectedLaunchToken && launchToken !== expectedLaunchToken)) return client;
  return {
    ...client,
    launchToken,
    requestedUrl: String(client.requestedUrl || metadata.requestedUrl || ''),
  };
}

