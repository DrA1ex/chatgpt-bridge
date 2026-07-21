import './commandManifest.js';

export const EXTENSION_PROTOCOL_VERSION = 5;

export const ProtocolMessageType = Object.freeze({
  TRANSPORT_HELLO: 'transport.hello',
  TRANSPORT_PING: 'transport.ping',
  TRANSPORT_PONG: 'transport.pong',
  TRANSPORT_ACK: 'transport.ack',
  TRANSPORT_DIAGNOSTIC: 'transport.diagnostic',
  COMMAND_EXECUTE: 'command.execute',
  COMMAND_ACCEPTED: 'command.accepted',
  COMMAND_PROGRESS: 'command.progress',
  COMMAND_REJECTED: 'command.rejected',
  COMMAND_RESULT: 'command.result',
  TAB_OBSERVATION: 'tab.observation',
  EFFECT_STARTED: 'effect.started',
  EFFECT_SUCCEEDED: 'effect.succeeded',
  EFFECT_FAILED: 'effect.failed',
  EFFECT_UNCERTAIN: 'effect.uncertain',
  EFFECT_CANCELLED: 'effect.cancelled',
  LEASE_RELEASED: 'lease.released',
  LEASE_QUARANTINED: 'lease.quarantined',
});

const definition = (direction, owner, critical, terminal, correlation) => Object.freeze({ direction, owner, critical, terminal, correlation });

export const ProtocolMessageDefinition = Object.freeze({
  [ProtocolMessageType.TRANSPORT_HELLO]: definition('both', 'transport', false, false, 'none'),
  [ProtocolMessageType.TRANSPORT_PING]: definition('server_to_extension', 'transport', false, false, 'none'),
  [ProtocolMessageType.TRANSPORT_PONG]: definition('extension_to_server', 'transport', false, false, 'none'),
  [ProtocolMessageType.TRANSPORT_ACK]: definition('both', 'transport', false, false, 'message'),
  [ProtocolMessageType.TRANSPORT_DIAGNOSTIC]: definition('both', 'transport', false, false, 'none'),
  [ProtocolMessageType.COMMAND_EXECUTE]: definition('server_to_extension', 'command', true, false, 'command'),
  [ProtocolMessageType.COMMAND_ACCEPTED]: definition('extension_to_server', 'command', true, false, 'command'),
  [ProtocolMessageType.COMMAND_PROGRESS]: definition('extension_to_server', 'command', false, false, 'command'),
  [ProtocolMessageType.COMMAND_REJECTED]: definition('extension_to_server', 'command', true, true, 'command'),
  [ProtocolMessageType.COMMAND_RESULT]: definition('extension_to_server', 'command', true, true, 'command'),
  [ProtocolMessageType.TAB_OBSERVATION]: definition('extension_to_server', 'observation', false, false, 'none'),
  [ProtocolMessageType.EFFECT_STARTED]: definition('extension_to_server', 'effect', false, false, 'effect'),
  [ProtocolMessageType.EFFECT_SUCCEEDED]: definition('extension_to_server', 'effect', true, true, 'effect'),
  [ProtocolMessageType.EFFECT_FAILED]: definition('extension_to_server', 'effect', true, true, 'effect'),
  [ProtocolMessageType.EFFECT_UNCERTAIN]: definition('extension_to_server', 'effect', true, true, 'effect'),
  [ProtocolMessageType.EFFECT_CANCELLED]: definition('extension_to_server', 'effect', true, true, 'effect'),
  [ProtocolMessageType.LEASE_RELEASED]: definition('extension_to_server', 'lease', true, true, 'command'),
  [ProtocolMessageType.LEASE_QUARANTINED]: definition('extension_to_server', 'lease', true, true, 'command'),
});

function protocolText(value) { return String(value ?? '').trim(); }
function protocolObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function directionMatches(actual, expected) { return actual === 'both' || actual === expected; }
function requireText(body, key, label, errors) { if (!protocolText(body?.[key])) errors.push(`${label} body.${key} is required`); }
function requireBoolean(body, key, label, errors) { if (typeof body?.[key] !== 'boolean') errors.push(`${label} body.${key} must be boolean`); }

function validateRequestIdentity(request, label, errors) {
  if (!protocolObject(request)) {
    errors.push(`${label} requires request identity`);
    return;
  }
  if (!protocolText(request.requestId)) errors.push(`${label} request.requestId is required`);
  if (!protocolText(request.leaseId)) errors.push(`${label} request.leaseId is required`);
  if (!protocolText(request.ownerServerInstanceId)) errors.push(`${label} request.ownerServerInstanceId is required`);
  if (!Number.isInteger(request.responseEpoch) || request.responseEpoch < 0) errors.push(`${label} request.responseEpoch must be a non-negative integer`);
}

function validateCommandExecuteBody(envelope, errors) {
  const body = envelope.body || {};
  const commandType = protocolText(body.type);
  requireText(body, 'type', ProtocolMessageType.COMMAND_EXECUTE, errors);
  const manifest = globalThis.ChatGptBridgeCommandManifest;
  if (!manifest || typeof manifest.validateCommandPayload !== 'function') {
    errors.push('command manifest is unavailable');
    return;
  }
  const validation = manifest.validateCommandPayload(commandType, body, { requestScoped: Boolean(envelope.request) });
  for (const error of validation.errors) errors.push(`command.execute ${error}`);
  if (protocolText(body.commandScope)) {
    const expectedScope = envelope.request ? 'request' : 'standalone';
    if (protocolText(body.commandScope) !== expectedScope) errors.push(`command.execute body.commandScope must be ${expectedScope}`);
  }
  if (validation.definition && protocolText(body.retryPolicy)
    && protocolText(body.retryPolicy) !== protocolText(validation.definition.retryPolicy)) {
    errors.push(`command.execute body.retryPolicy must be ${validation.definition.retryPolicy}`);
  }
}

function validateMessageBody(envelope, errors) {
  const body = envelope.body || {};
  const type = protocolText(envelope.messageType);
  if (type === ProtocolMessageType.COMMAND_EXECUTE) validateCommandExecuteBody(envelope, errors);
  if (type === ProtocolMessageType.TRANSPORT_ACK) requireText(body, 'ackMessageId', type, errors);
  if (type === ProtocolMessageType.TRANSPORT_DIAGNOSTIC) requireText(body, 'diagnosticType', type, errors);
  if (type === ProtocolMessageType.COMMAND_ACCEPTED) {
    requireText(body, 'commandId', type, errors);
    if (!['result', 'effect', 'release'].includes(protocolText(body.commandMode))) errors.push(`${type} body.commandMode is invalid`);
    if (protocolText(body.commandScope) && !['standalone', 'request'].includes(protocolText(body.commandScope))) errors.push(`${type} body.commandScope is invalid`);
  }
  if (type === ProtocolMessageType.COMMAND_PROGRESS) requireText(body, 'progressType', type, errors);
  if (type === ProtocolMessageType.COMMAND_REJECTED) {
    requireText(body, 'code', type, errors);
    requireText(body, 'message', type, errors);
  }
  if (type === ProtocolMessageType.COMMAND_RESULT) requireText(body, 'resultType', type, errors);
  if (type === ProtocolMessageType.TAB_OBSERVATION) {
    const observation = protocolObject(body.observation);
    if (!observation) errors.push(`${type} body.observation is required`);
    const revision = Number(observation?.revision ?? body.revision);
    if (!Number.isInteger(revision) || revision < 0) errors.push(`${type} observation revision must be a non-negative integer`);
  }
  if (ProtocolMessageDefinition[type]?.owner === 'effect') {
    requireText(body, 'effectType', type, errors);
    requireText(body, 'effectId', type, errors);
    requireText(body, 'requestId', type, errors);
  }
  if (type === ProtocolMessageType.EFFECT_FAILED || type === ProtocolMessageType.EFFECT_UNCERTAIN) {
    requireText(body, 'code', type, errors);
    requireText(body, 'message', type, errors);
  }
  if (type === ProtocolMessageType.EFFECT_CANCELLED) {
    requireBoolean(body, 'provenNotExecuted', type, errors);
    if (body.provenNotExecuted !== true) errors.push(`${type} body.provenNotExecuted must be true`);
  }
  if (type === ProtocolMessageType.LEASE_RELEASED) {
    requireText(body, 'requestId', type, errors);
    requireBoolean(body, 'released', type, errors);
    if (body.released !== true) errors.push(`${type} body.released must be true`);
  }
  if (type === ProtocolMessageType.LEASE_QUARANTINED) {
    requireText(body, 'requestId', type, errors);
    requireText(body, 'code', type, errors);
    if (!protocolText(body.reason) && !protocolText(body.message)) errors.push(`${type} body.reason or body.message is required`);
  }
}

/**
 * Shared Protocol 5 boundary validator. Both the server and the extension use
 * this exact implementation so direction, correlation, body shape and
 * immutable request identity cannot drift independently.
 */
export function validateProtocolEnvelope(envelope, options = {}) {
  const errors = [];
  if (!protocolObject(envelope)) {
    return Object.freeze({ valid: false, errors: Object.freeze(['envelope must be an object']) });
  }
  if (Number(envelope.protocolVersion) !== EXTENSION_PROTOCOL_VERSION) errors.push(`protocolVersion must be ${EXTENSION_PROTOCOL_VERSION}`);
  if (!protocolText(envelope.messageId)) errors.push('messageId is required');
  const messageType = protocolText(envelope.messageType);
  const messageDefinition = ProtocolMessageDefinition[messageType] || null;
  if (!messageDefinition) errors.push(`unsupported messageType: ${messageType || 'missing'}`);
  const expectedDirection = protocolText(options.direction);
  if (messageDefinition && expectedDirection && !directionMatches(messageDefinition.direction, expectedDirection)) {
    errors.push(`${messageType} direction ${messageDefinition.direction} does not allow ${expectedDirection}`);
  }
  if (!protocolObject(envelope.source)) errors.push('source is required');
  if (!Number.isInteger(envelope.source?.sequence) || envelope.source.sequence < 0) errors.push('source.sequence must be a non-negative integer');
  if (options.requireClientId === true && !protocolText(envelope.source?.clientId)) errors.push('source.clientId is required');
  if (!protocolText(envelope.source?.backgroundEpoch)) errors.push('source.backgroundEpoch is required');
  if (!protocolObject(envelope.body)) errors.push('body must be an object');

  const commandId = protocolText(envelope.commandId);
  const effectId = protocolText(envelope.effectId);
  if (messageDefinition?.correlation === 'command' && !commandId) errors.push(`${messageType} requires commandId`);
  if (messageDefinition?.correlation === 'effect' && !effectId) errors.push(`${messageType} requires effectId`);
  if (protocolText(envelope.body?.commandId) && protocolText(envelope.body.commandId) !== commandId) errors.push(`${messageType} body.commandId must match envelope.commandId`);
  if (protocolText(envelope.body?.effectId) && protocolText(envelope.body.effectId) !== effectId) errors.push(`${messageType} body.effectId must match envelope.effectId`);

  if (messageDefinition?.owner === 'effect' || messageDefinition?.owner === 'lease') {
    validateRequestIdentity(envelope.request, messageType, errors);
  } else if (envelope.request != null) {
    validateRequestIdentity(envelope.request, messageType, errors);
  }
  if (envelope.request && protocolText(envelope.body?.requestId)
    && protocolText(envelope.body.requestId) !== protocolText(envelope.request.requestId)) {
    errors.push(`${messageType} body.requestId must match envelope.request.requestId`);
  }

  if (messageDefinition && protocolObject(envelope.body)) validateMessageBody(envelope, errors);
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}
