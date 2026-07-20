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
  [ProtocolMessageType.TRANSPORT_HELLO]: definition('extension_to_server', 'transport', false, false, 'none'),
  [ProtocolMessageType.TRANSPORT_PING]: definition('server_to_extension', 'transport', false, false, 'none'),
  [ProtocolMessageType.TRANSPORT_PONG]: definition('extension_to_server', 'transport', false, false, 'none'),
  [ProtocolMessageType.TRANSPORT_ACK]: definition('both', 'transport', false, false, 'message'),
  [ProtocolMessageType.TRANSPORT_DIAGNOSTIC]: definition('extension_to_server', 'transport', false, false, 'none'),
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


function protocolText(value) {
  return String(value ?? '').trim();
}

function directionMatches(actual, expected) {
  return actual === 'both' || actual === expected;
}

function validateRequestIdentity(request, label, errors) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    errors.push(`${label} requires request identity`);
    return;
  }
  if (!protocolText(request.requestId)) errors.push(`${label} request.requestId is required`);
  if (!protocolText(request.leaseId)) errors.push(`${label} request.leaseId is required`);
  if (!protocolText(request.ownerServerInstanceId)) errors.push(`${label} request.ownerServerInstanceId is required`);
  if (!Number.isInteger(request.responseEpoch) || request.responseEpoch < 0) errors.push(`${label} request.responseEpoch must be a non-negative integer`);
}

/**
 * Shared Protocol 5 boundary validator. Both the server and the extension use
 * this exact implementation so direction, correlation and immutable request
 * identity cannot drift independently.
 */
export function validateProtocolEnvelope(envelope, options = {}) {
  const errors = [];
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return Object.freeze({ valid: false, errors: Object.freeze(['envelope must be an object']) });
  }
  if (Number(envelope.protocolVersion) !== EXTENSION_PROTOCOL_VERSION) errors.push(`protocolVersion must be ${EXTENSION_PROTOCOL_VERSION}`);
  if (!protocolText(envelope.messageId)) errors.push('messageId is required');
  const messageType = protocolText(envelope.messageType);
  const definition = ProtocolMessageDefinition[messageType] || null;
  if (!definition) errors.push(`unsupported messageType: ${messageType || 'missing'}`);
  const expectedDirection = protocolText(options.direction);
  if (definition && expectedDirection && !directionMatches(definition.direction, expectedDirection)) {
    errors.push(`${messageType} direction ${definition.direction} does not allow ${expectedDirection}`);
  }
  if (!envelope.source || typeof envelope.source !== 'object' || Array.isArray(envelope.source)) errors.push('source is required');
  if (!Number.isInteger(envelope.source?.sequence) || envelope.source.sequence < 0) errors.push('source.sequence must be a non-negative integer');
  if (options.requireClientId === true && !protocolText(envelope.source?.clientId)) errors.push('source.clientId is required');
  if (!protocolText(envelope.source?.backgroundEpoch)) errors.push('source.backgroundEpoch is required');
  if (!envelope.body || typeof envelope.body !== 'object' || Array.isArray(envelope.body)) errors.push('body must be an object');

  const commandId = protocolText(envelope.commandId);
  const effectId = protocolText(envelope.effectId);
  if (definition?.correlation === 'command' && !commandId) errors.push(`${messageType} requires commandId`);
  if (definition?.correlation === 'effect' && !effectId) errors.push(`${messageType} requires effectId`);
  if (protocolText(envelope.body?.commandId) && protocolText(envelope.body.commandId) !== commandId) errors.push(`${messageType} body.commandId must match envelope.commandId`);
  if (protocolText(envelope.body?.effectId) && protocolText(envelope.body.effectId) !== effectId) errors.push(`${messageType} body.effectId must match envelope.effectId`);

  if (definition?.owner === 'effect' || definition?.owner === 'lease') {
    validateRequestIdentity(envelope.request, messageType, errors);
  } else if (envelope.request != null) {
    validateRequestIdentity(envelope.request, messageType, errors);
  }
  if (envelope.request && protocolText(envelope.body?.requestId)
    && protocolText(envelope.body.requestId) !== protocolText(envelope.request.requestId)) {
    errors.push(`${messageType} body.requestId must match envelope.request.requestId`);
  }

  if (messageType === ProtocolMessageType.COMMAND_EXECUTE && !protocolText(envelope.body?.type)) errors.push('command.execute body.type is required');
  if (messageType === ProtocolMessageType.TRANSPORT_ACK && !protocolText(envelope.body?.ackMessageId)) errors.push('transport.ack body.ackMessageId is required');
  if (definition?.owner === 'effect' && !protocolText(envelope.body?.effectType)) errors.push(`${messageType} body.effectType is required`);
  if (definition?.owner === 'lease' && !protocolText(envelope.body?.requestId)) errors.push(`${messageType} body.requestId is required`);

  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}
