import { randomUUID } from 'node:crypto';
import { EXTENSION_PROTOCOL_VERSION } from '../protocol/v4.js';
import { isClientCompatible } from './connectionPolicy.js';

export class HubCommandSender {
  constructor({ clients, protocol, serverInstanceId, nextSequence, beginRelease, settleRelease, recordDebug } = {}) {
    this.clients = clients;
    this.protocol = protocol;
    this.serverInstanceId = serverInstanceId;
    this.nextSequence = nextSequence;
    this.beginRelease = beginRelease;
    this.settleRelease = settleRelease;
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
    const identifiedPayload = { ...(payload && typeof payload === 'object' ? payload : {}), commandId };
    const explicitRequestId = String(identifiedPayload.requestId || '');
    const passiveRequestId = identifiedPayload.type === 'passive.prompt.submit' ? `passive_${commandId}` : '';
    const commandRequestId = !explicitRequestId && !passiveRequestId && commandId ? `command_${commandId}` : '';
    const requestId = explicitRequestId || passiveRequestId || commandRequestId;
    let commandPayload = commandRequestId || passiveRequestId
      ? { ...identifiedPayload, requestId, leaseScope: 'command' }
      : identifiedPayload;
    let request = null;

    if (requestId) {
      client.requestLeases ||= new Map();
      let lease = client.requestLeases.get(requestId);
      if (lease && lease.ownerServerInstanceId !== this.serverInstanceId) {
        if (identifiedPayload.type !== 'request.resume') {
          throw new Error(`Request ${requestId} is leased to another bridge server instance; explicit request.resume is required`);
        }
        const previousOwnerServerInstanceId = lease.ownerServerInstanceId;
        lease = { requestId, leaseId: randomUUID(), ownerServerInstanceId: this.serverInstanceId };
        client.requestLeases.set(requestId, lease);
        commandPayload = { ...commandPayload, previousOwnerServerInstanceId };
      }
      if (!lease) {
        lease = { requestId, leaseId: randomUUID(), ownerServerInstanceId: this.serverInstanceId };
        client.requestLeases.set(requestId, lease);
      }
      request = lease;
    }

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
    if (identifiedPayload.type === 'request.release') this.beginRelease(client.id, requestId, commandId);
    try {
      client.ws.send(JSON.stringify(envelope));
    } catch (error) {
      if (identifiedPayload.type === 'request.release') this.settleRelease(client, commandPayload, error);
      throw error;
    }
    this.recordDebug(clientId, {
      type: 'server.command_delivered',
      commandType: payload?.type || 'unknown',
      commandId,
      messageId: envelope.messageId,
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      requestId,
      transport: 'extension-websocket',
    });
    return {
      client,
      delivered: Promise.resolve({ clientId, transport: 'extension-websocket', deliveredAt: Date.now() }),
    };
  }
}
