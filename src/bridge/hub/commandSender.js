import '../../../tools/chrome-bridge-extension/shared/commandManifest.js';
import { randomUUID } from 'node:crypto';
import { EXTENSION_PROTOCOL_VERSION } from '../protocol/v5.js';
import { isClientCompatible } from './connectionPolicy.js';

function normalizeRequestIdentity(request = null) {
  if (!request || typeof request !== 'object') return null;
  const requestId = String(request.requestId || '').trim();
  const leaseId = String(request.leaseId || '').trim();
  const ownerServerInstanceId = String(request.ownerServerInstanceId || '').trim();
  if (!requestId || !leaseId || !ownerServerInstanceId) {
    const error = new Error('Request-scoped browser command requires immutable requestId, leaseId, and ownerServerInstanceId');
    error.code = 'BROWSER_REQUEST_IDENTITY_MISSING';
    throw error;
  }
  return Object.freeze({
    requestId,
    leaseId,
    ownerServerInstanceId,
    responseEpoch: Math.max(0, Number(request.responseEpoch) || 0),
  });
}


function inferredCommandPreconditions(commandType = '', payload = {}, commandId = '') {
  const base = { commandType: String(commandType || ''), protocolCommandId: String(commandId || '') };
  if (commandType === 'passive.prompt.submit') {
    return { ...base, message: String(payload.message || ''), sessionId: String(payload.options?.sessionId || '') };
  }
  if (commandType === 'artifact.fetch') {
    const artifact = payload.artifact && typeof payload.artifact === 'object' ? payload.artifact : {};
    return {
      ...base,
      artifactId: String(artifact.id || ''),
      artifactCandidateId: String(artifact.candidateId || artifact.id || ''),
      sourceTurnKey: String(artifact.sourceTurnKey || artifact.turnKey || ''),
      expectedName: String(artifact.name || ''),
    };
  }
  if (commandType.startsWith('sessions.')) return { ...base, conversationId: String(payload.sessionId || '') };
  return base;
}

/**
 * Transport-only command sender.
 *
 * The Hub deliberately owns no request lease registry and no release barrier.
 * Request identity is supplied by the canonical request coordinator. Commands
 * without that identity are standalone tab operations and never acquire a
 * request lease merely because their payload happens to contain a requestId.
 */
export class HubCommandSender {
  constructor({ clients, protocol, serverInstanceId, nextSequence, recordDebug } = {}) {
    this.clients = clients;
    this.protocol = protocol;
    this.serverInstanceId = serverInstanceId;
    this.nextSequence = nextSequence;
    this.recordDebug = recordDebug;
  }

  send(clientId, payload, options = {}) {
    const client = this.clients.get(clientId);
    if (!client) throw new Error(`Browser extension client not found: ${clientId}`);
    const reloadControl = options.allowIncompatibleReload === true
      && payload?.type === 'extension.reload'
      && Number(client.extensionProtocolVersion) === EXTENSION_PROTOCOL_VERSION;
    if (!isClientCompatible(client) && !reloadControl) {
      throw new Error(`Browser extension client is incompatible: ${client.compatibility?.message || clientId}`);
    }
    if (client.ws?.readyState !== 1) throw new Error(`Browser extension WebSocket client is not open: ${clientId}`);

    const commandId = String(payload?.commandId || randomUUID());
    const request = normalizeRequestIdentity(options.request || null);
    const commandType = String(payload?.type || '');
    const validation = globalThis.ChatGptBridgeCommandManifest?.validateCommandPayload?.(commandType, payload, {
      requestScoped: Boolean(request),
    });
    if (!validation?.valid) {
      const error = new Error(validation?.errors?.join('; ') || `Unsupported browser command type: ${commandType || 'missing'}`);
      error.code = 'BROWSER_COMMAND_INVALID';
      throw error;
    }
    const definition = validation.definition;
    const commandPayload = {
      ...(payload && typeof payload === 'object' ? payload : {}),
      commandId,
      commandScope: request ? 'request' : 'standalone',
      commandMode: definition.mode,
      commandOperation: definition.operation,
      retryPolicy: definition.retryPolicy,
      reconcilePolicy: definition.reconcile,
      idempotencyKey: String(payload?.idempotencyKey || commandId),
      preconditions: payload?.preconditions && typeof payload.preconditions === 'object'
        ? payload.preconditions
        : inferredCommandPreconditions(commandType, payload, commandId),
    };
    const envelope = this.protocol.command(commandPayload, {
      source: {
        clientId: 'bridge-server',
        tabId: client.browserTabId,
        backgroundEpoch: this.serverInstanceId,
        contentEpoch: '',
        sequence: this.nextSequence(),
      },
      request,
      commandId,
    });
    client.ws.send(JSON.stringify(envelope));
    this.recordDebug(clientId, {
      type: 'server.command_delivered',
      commandType: commandPayload.type || 'unknown',
      commandId,
      messageId: envelope.messageId,
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      requestId: request?.requestId || '',
      commandScope: request ? 'request' : 'standalone',
      transport: 'extension-websocket',
    });
    return {
      client,
      delivered: Promise.resolve({ clientId, transport: 'extension-websocket', deliveredAt: Date.now() }),
    };
  }
}
