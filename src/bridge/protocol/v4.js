import { randomUUID } from 'node:crypto';

export const EXTENSION_PROTOCOL_VERSION = 4;

export const ExtensionMessageKind = Object.freeze({
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
  TAB_OBSERVATION: 'tab.observation',
  EFFECT_RECONCILE: 'effect.reconcile',
  EFFECT_RESULT: 'effect.result',
  EFFECT_UNCERTAIN: 'effect.uncertain',
});

const KINDS = new Set(Object.values(ExtensionMessageKind));

function text(value) {
  return String(value || '').trim();
}

function optionalText(value) {
  const normalized = text(value);
  return normalized || null;
}

function normalizeSource(source = {}) {
  return Object.freeze({
    clientId: text(source.clientId),
    tabId: Number.isInteger(source.tabId) ? source.tabId : null,
    backgroundEpoch: text(source.backgroundEpoch),
    contentEpoch: text(source.contentEpoch),
    sequence: Number.isInteger(source.sequence) && source.sequence >= 0 ? source.sequence : 0,
  });
}

function normalizeRequest(request = null) {
  if (!request || typeof request !== 'object') return null;
  const requestId = text(request.requestId);
  if (!requestId) return null;
  return Object.freeze({
    requestId,
    leaseId: text(request.leaseId),
    ownerServerInstanceId: text(request.ownerServerInstanceId),
    responseEpoch: Number.isInteger(request.responseEpoch) && request.responseEpoch >= 0 ? request.responseEpoch : 0,
  });
}

export function createExtensionEnvelope(kind, payload = {}, options = {}) {
  if (!KINDS.has(kind)) throw new Error(`Unsupported extension protocol 4 message kind: ${kind}`);
  return Object.freeze({
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    messageId: text(options.messageId) || randomUUID(),
    kind,
    sentAt: Number(options.sentAt) || Date.now(),
    source: normalizeSource(options.source),
    request: normalizeRequest(options.request),
    commandId: optionalText(options.commandId ?? payload?.commandId),
    effectId: optionalText(options.effectId ?? payload?.effectId),
    causationId: optionalText(options.causationId),
    payload: payload && typeof payload === 'object' ? payload : {},
  });
}

export function validateExtensionEnvelope(value, options = {}) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('envelope must be an object');
  if (Number(value?.protocolVersion) !== EXTENSION_PROTOCOL_VERSION) errors.push('protocolVersion must be 4');
  if (!text(value?.messageId)) errors.push('messageId is required');
  if (!KINDS.has(value?.kind)) errors.push(`unsupported kind: ${value?.kind || 'missing'}`);
  if (!value?.source || typeof value.source !== 'object') errors.push('source is required');
  if (!Number.isInteger(value?.source?.sequence) || value.source.sequence < 0) errors.push('source.sequence must be a non-negative integer');
  if (options.requireClientId && !text(value?.source?.clientId)) errors.push('source.clientId is required');
  if (!value?.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) errors.push('payload must be an object');
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function extensionKindForPayload(payload = {}) {
  const type = text(payload.type);
  if (type === 'hello') return ExtensionMessageKind.TRANSPORT_HELLO;
  if (type === 'pong') return ExtensionMessageKind.TRANSPORT_PONG;
  if (type === 'diagnostic' || type === 'page.status' || type === 'page.changed') return ExtensionMessageKind.TRANSPORT_DIAGNOSTIC;
  if (type === 'tab.observation') return ExtensionMessageKind.TAB_OBSERVATION;
  if (type === 'command.error' || payload.error) return ExtensionMessageKind.COMMAND_REJECTED;
  if (payload.commandId && !type.startsWith('request.') && type !== 'status' && type !== 'chat.event') return ExtensionMessageKind.COMMAND_RESULT;
  if (type === 'request.effect.uncertain') return ExtensionMessageKind.EFFECT_UNCERTAIN;
  if (type.startsWith('request.effect.')) return ExtensionMessageKind.EFFECT_RESULT;
  throw new Error(`Unsupported extension protocol 4 payload type: ${type || 'missing'}`);
}

export function unwrapExtensionEnvelope(envelope) {
  const validation = validateExtensionEnvelope(envelope);
  if (!validation.valid) return { valid: false, errors: validation.errors, payload: null };
  return { valid: true, errors: [], payload: envelope.payload, envelope };
}

export function isCriticalExtensionKind(kind) {
  return kind === ExtensionMessageKind.COMMAND_ACCEPTED
    || kind === ExtensionMessageKind.COMMAND_REJECTED
    || kind === ExtensionMessageKind.COMMAND_RESULT
    || kind === ExtensionMessageKind.EFFECT_RESULT
    || kind === ExtensionMessageKind.EFFECT_UNCERTAIN;
}
