import {
  EXTENSION_PROTOCOL_VERSION,
  ProtocolMessageDefinition,
  ProtocolMessageType,
  validateProtocolEnvelope,
} from '../shared/protocolV5Manifest.js';

export { EXTENSION_PROTOCOL_VERSION };
export const MessageType = ProtocolMessageType;
export const MessageDefinition = ProtocolMessageDefinition;

export function messageId(prefix = 'msg') { try { return crypto.randomUUID(); } catch {} return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
export function messageDefinition(messageType) { return MessageDefinition[messageType] || null; }
export function makeEnvelope(messageType, body, context, sequence, options = {}) {
  const definition = messageDefinition(messageType);
  if (!definition) throw new Error(`Unsupported extension protocol 5 messageType: ${messageType}`);
  const commandId = String(options.commandId ?? body?.commandId ?? '').trim() || null;
  const effectId = String(options.effectId ?? body?.effectId ?? '').trim() || null;
  if (definition.correlation === 'command' && !commandId) throw new Error(`${messageType} requires commandId`);
  if (definition.correlation === 'effect' && !effectId) throw new Error(`${messageType} requires effectId`);
  const requestId = String(body?.requestId || context.lease?.requestId || '').trim();
  const envelope = {
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    messageId: options.messageId || messageId(),
    messageType,
    sentAt: Number(options.sentAt) || Date.now(),
    source: { clientId: String(context.clientId || ''), tabId: Number.isInteger(context.tabId) ? context.tabId : null, backgroundEpoch: String(context.backgroundEpoch || ''), contentEpoch: String(context.contentEpoch || ''), sequence },
    request: requestId ? { requestId, leaseId: String(context.lease?.leaseId || body?.leaseId || ''), ownerServerInstanceId: String(context.lease?.ownerServerInstanceId || body?.ownerServerInstanceId || ''), responseEpoch: Math.max(0, Number(body?.responseEpoch ?? context.lease?.responseEpoch) || 0) } : null,
    commandId,
    effectId,
    causationId: options.causationId || null,
    body: body && typeof body === 'object' && !Array.isArray(body) ? body : {},
  };
  const validation = validateProtocolEnvelope(envelope);
  if (!validation.valid) throw new Error(`Invalid extension protocol 5 envelope: ${validation.errors.join('; ')}`);
  return envelope;
}
export function validateProtocol5Envelope(value, options = {}) { return validateProtocolEnvelope(value, options); }
export function isProtocol5Envelope(value, options = {}) { return validateProtocolEnvelope(value, options).valid; }
export function isCriticalMessageType(messageType) { return messageDefinition(messageType)?.critical === true; }
export function isTerminalMessageType(messageType) { return messageDefinition(messageType)?.terminal === true; }
