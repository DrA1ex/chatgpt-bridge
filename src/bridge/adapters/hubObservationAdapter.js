import { RequestEventType, createRequestEvent } from '../state/requestEvents.js';

export function hubActivityToCanonicalEvent(requestId, clientId, client = {}, payload = {}, at = 0) {
  const executor = client?.activeRequest || payload?.activeRequest || {};
  if (executor.requestId && executor.requestId !== requestId) return null;
  const observation = payload?.observation || client?.tabObservation || null;
  return createRequestEvent(RequestEventType.HEARTBEAT, requestId, {
    clientId,
    url: observation?.url || client?.url || payload?.url || '',
    conversationId: observation?.conversationId || client?.session?.id || payload?.session?.id || '',
    generating: observation?.generation?.state === 'active',
  }, {
    source: 'hub_activity',
    occurredAt: at,
    receivedAt: at,
  });
}
