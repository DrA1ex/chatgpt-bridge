export const EXTENSION_PROTOCOL_VERSION = 4;

export const MessageKind = Object.freeze({
  TRANSPORT_HELLO: 'transport.hello',
  TRANSPORT_PING: 'transport.ping',
  TRANSPORT_PONG: 'transport.pong',
  TRANSPORT_ACK: 'transport.ack',
  TRANSPORT_DIAGNOSTIC: 'transport.diagnostic',
  COMMAND_EXECUTE: 'command.execute',
  COMMAND_ACCEPTED: 'command.accepted',
  COMMAND_REJECTED: 'command.rejected',
  COMMAND_RESULT: 'command.result',
  LEASE_CLAIM: 'lease.claim',
  LEASE_RELEASE: 'lease.release',
  REQUEST_OBSERVATION: 'request.observation',
  EFFECT_RECONCILE: 'effect.reconcile',
  EFFECT_RESULT: 'effect.result',
  EFFECT_UNCERTAIN: 'effect.uncertain',
});

export function messageId(prefix = 'msg') {
  try { return crypto.randomUUID(); } catch {}
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function kindForPayload(payload = {}) {
  const type = String(payload.type || '');
  if (type === 'hello') return MessageKind.TRANSPORT_HELLO;
  if (type === 'pong') return MessageKind.TRANSPORT_PONG;
  if (type === 'diagnostic' || type === 'page.status' || type === 'page.changed' || type === 'command.progress') return MessageKind.TRANSPORT_DIAGNOSTIC;
  if (type === 'tab.observation' || type === 'request.observation') return MessageKind.REQUEST_OBSERVATION;
  if (type === 'command.error' || payload.error) return MessageKind.COMMAND_REJECTED;
  if (payload.commandId && !type.startsWith('request.') && type !== 'status' && type !== 'chat.event') return MessageKind.COMMAND_RESULT;
  if (type === 'request.effect.uncertain') return MessageKind.EFFECT_UNCERTAIN;
  if (type.startsWith('request.effect.')) return MessageKind.EFFECT_RESULT;
  return MessageKind.REQUEST_OBSERVATION;
}

export function makeEnvelope(payload, context, sequence, options = {}) {
  const kind = options.kind || kindForPayload(payload);
  const requestId = String(payload?.requestId || context.lease?.requestId || '');
  return {
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    messageId: options.messageId || messageId(),
    kind,
    sentAt: Date.now(),
    source: {
      clientId: String(context.clientId || ''),
      tabId: Number.isInteger(context.tabId) ? context.tabId : null,
      backgroundEpoch: String(context.backgroundEpoch || ''),
      contentEpoch: String(context.contentEpoch || ''),
      sequence,
    },
    request: requestId ? {
      requestId,
      leaseId: String(context.lease?.leaseId || payload?.leaseId || ''),
      ownerServerInstanceId: String(context.lease?.ownerServerInstanceId || payload?.ownerServerInstanceId || ''),
      responseEpoch: Math.max(0, Number(payload?.responseEpoch ?? context.lease?.responseEpoch) || 0),
    } : null,
    commandId: payload?.commandId ? String(payload.commandId) : null,
    effectId: payload?.effectId ? String(payload.effectId) : null,
    causationId: options.causationId || null,
    payload: payload && typeof payload === 'object' ? payload : {},
  };
}

export function isProtocol4Envelope(value) {
  return Boolean(value && typeof value === 'object'
    && value.protocolVersion === EXTENSION_PROTOCOL_VERSION
    && typeof value.messageId === 'string' && value.messageId
    && typeof value.kind === 'string' && value.kind
    && value.source && Number.isInteger(value.source.sequence)
    && value.payload && typeof value.payload === 'object');
}

export function isCriticalKind(kind) {
  return kind === MessageKind.COMMAND_ACCEPTED
    || kind === MessageKind.COMMAND_RESULT
    || kind === MessageKind.COMMAND_REJECTED
    || kind === MessageKind.EFFECT_RESULT
    || kind === MessageKind.EFFECT_UNCERTAIN
    || kind === MessageKind.REQUEST_OBSERVATION;
}
