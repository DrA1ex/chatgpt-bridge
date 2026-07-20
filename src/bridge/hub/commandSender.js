import { randomUUID } from 'node:crypto';
import { EXTENSION_PROTOCOL_VERSION } from '../protocol/v4.js';
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
    const commandPayload = {
      ...(payload && typeof payload === 'object' ? payload : {}),
      commandId,
      commandScope: options.request ? 'request' : 'standalone',
    };
    const request = normalizeRequestIdentity(options.request || null);
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
