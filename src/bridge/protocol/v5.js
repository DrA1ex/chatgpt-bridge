import { randomUUID } from 'node:crypto';
import {
  EXTENSION_PROTOCOL_VERSION,
  ProtocolMessageDefinition,
  ProtocolMessageType,
  validateProtocolEnvelope,
} from '../../../tools/chrome-bridge-extension/shared/protocolV5Manifest.js';

export { EXTENSION_PROTOCOL_VERSION };
export const ExtensionMessageType = ProtocolMessageType;
export const ExtensionMessageDefinition = ProtocolMessageDefinition;
const MESSAGE_TYPES = new Set(Object.values(ExtensionMessageType));

function text(value) { return String(value || '').trim(); }
function optionalText(value) { const normalized = text(value); return normalized || null; }
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

export function messageDefinition(messageType) {
  return ExtensionMessageDefinition[messageType] || null;
}

export function createExtensionEnvelope(messageType, body = {}, options = {}) {
  if (!MESSAGE_TYPES.has(messageType)) throw new Error(`Unsupported extension protocol 5 messageType: ${messageType}`);
  const commandId = optionalText(options.commandId ?? body?.commandId);
  const effectId = optionalText(options.effectId ?? body?.effectId);
  const definition = messageDefinition(messageType);
  if (definition.correlation === 'command' && !commandId) throw new Error(`${messageType} requires commandId`);
  if (definition.correlation === 'effect' && !effectId) throw new Error(`${messageType} requires effectId`);
  const envelope = Object.freeze({
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    messageId: text(options.messageId) || randomUUID(),
    messageType,
    sentAt: Number(options.sentAt) || Date.now(),
    source: normalizeSource(options.source),
    request: normalizeRequest(options.request),
    commandId,
    effectId,
    causationId: optionalText(options.causationId),
    body: body && typeof body === 'object' && !Array.isArray(body) ? body : {},
  });
  const validation = validateProtocolEnvelope(envelope);
  if (!validation.valid) throw new Error(`Invalid extension protocol 5 envelope: ${validation.errors.join('; ')}`);
  return envelope;
}

export function validateExtensionEnvelope(value, options = {}) {
  return validateProtocolEnvelope(value, options);
}

export function unwrapExtensionEnvelope(envelope, options = {}) {
  const validation = validateExtensionEnvelope(envelope, options);
  if (!validation.valid) return { valid: false, errors: validation.errors, body: null };
  return { valid: true, errors: [], body: envelope.body, envelope };
}

export function isCriticalExtensionMessageType(messageType) {
  return messageDefinition(messageType)?.critical === true;
}

export function isTerminalExtensionMessageType(messageType) {
  return messageDefinition(messageType)?.terminal === true;
}
