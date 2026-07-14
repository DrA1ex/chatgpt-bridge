import { RequestEventType, createRequestEvent } from '../state/requestEvents.js';

export function hubActivityToCanonicalEvent(requestId, clientId, client = {}, payload = {}, at = 0) {
  const activeRequest = client?.activeRequest || payload?.activeRequest || {};
  if (activeRequest.requestId && activeRequest.requestId !== requestId) return null;
  return createRequestEvent(RequestEventType.HEARTBEAT, requestId, {
    clientId,
    url: client?.url || payload?.url || '',
    conversationId: client?.session?.id || payload?.session?.id || '',
    phase: activeRequest.phase || '',
    generating: Boolean(activeRequest.generating || activeRequest.stopButtonVisible || payload.generating || payload.stopButtonVisible),
  }, {
    source: 'hub_activity',
    occurredAt: at,
    receivedAt: at,
  });
}
