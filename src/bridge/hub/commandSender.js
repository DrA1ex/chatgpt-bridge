import { randomUUID } from 'node:crypto';
import { EXTENSION_PROTOCOL_VERSION } from '../protocol/v4.js';
import { isClientCompatible } from './connectionPolicy.js';

const REQUEST_START_COMMANDS = new Set(['prompt.send']);
const REQUEST_RESUME_COMMANDS = new Set(['request.resume']);
const REQUEST_RELEASE_COMMANDS = new Set(['request.release']);

function commandScopedIdentity(commandId) {
  return `command_${commandId}`;
}

function missingLeaseError(clientId, requestId, commandType) {
  const error = new Error(`Browser request lease is not available for ${commandType}: ${requestId}`);
  error.code = 'BROWSER_REQUEST_LEASE_MISSING';
  error.clientId = clientId;
  error.requestId = requestId;
  error.commandType = commandType;
  return error;
}

/**
 * The Hub keeps only the immutable routing identity learned when a request is
 * started or restored. It must never resurrect a released request merely
 * because a later diagnostic/read-only command carries a stale requestId.
 */
function resolveCommandLease({ client, payload, commandId, serverInstanceId }) {
  const commandType = String(payload.type || '');
  const explicitRequestId = String(payload.requestId || '');
  const passive = commandType === 'passive.prompt.submit';
  client.requestLeases ||= new Map();

  if (passive) {
    const requestId = `passive_${commandId}`;
    const lease = { requestId, leaseId: randomUUID(), ownerServerInstanceId: serverInstanceId };
    client.requestLeases.set(requestId, lease);
    return { request: lease, payload: { ...payload, requestId, leaseScope: 'command' } };
  }

  if (!explicitRequestId) {
    const requestId = commandScopedIdentity(commandId);
    const lease = { requestId, leaseId: randomUUID(), ownerServerInstanceId: serverInstanceId };
    client.requestLeases.set(requestId, lease);
    return { request: lease, payload: { ...payload, requestId, leaseScope: 'command' } };
  }

  let lease = client.requestLeases.get(explicitRequestId) || null;
  if (lease) {
    if (lease.ownerServerInstanceId !== serverInstanceId) {
      if (!REQUEST_RESUME_COMMANDS.has(commandType)) {
        throw new Error(`Request ${explicitRequestId} is leased to another bridge server instance; explicit request.resume is required`);
      }
      const previousOwnerServerInstanceId = lease.ownerServerInstanceId;
      lease = { requestId: explicitRequestId, leaseId: randomUUID(), ownerServerInstanceId: serverInstanceId };
      client.requestLeases.set(explicitRequestId, lease);
      return { request: lease, payload: { ...payload, previousOwnerServerInstanceId } };
    }
    return { request: lease, payload };
  }

  if (REQUEST_START_COMMANDS.has(commandType) || REQUEST_RESUME_COMMANDS.has(commandType)) {
    lease = { requestId: explicitRequestId, leaseId: randomUUID(), ownerServerInstanceId: serverInstanceId };
    client.requestLeases.set(explicitRequestId, lease);
    return { request: lease, payload };
  }

  if (REQUEST_RELEASE_COMMANDS.has(commandType)) {
    throw missingLeaseError(client.id, explicitRequestId, commandType);
  }

  // A stale requestId on diagnostics, probes, reload controls, or other
  // command-scoped work is correlation metadata only. Replace it with a fresh
  // command lease so the released request cannot be reclaimed.
  const requestId = commandScopedIdentity(commandId);
  lease = { requestId, leaseId: randomUUID(), ownerServerInstanceId: serverInstanceId };
  client.requestLeases.set(requestId, lease);
  return {
    request: lease,
    payload: {
      ...payload,
      requestId,
      correlationRequestId: explicitRequestId,
      leaseScope: 'command',
    },
  };
}

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
    if (client.releasePending?.status === 'pending' && payload?.type !== 'request.release') {
      const error = new Error(`Browser extension client ${clientId} is still releasing ${client.releasePending.requestId}`);
      error.code = 'BROWSER_RELEASE_PENDING';
      error.clientId = clientId;
      error.requestId = client.releasePending.requestId;
      throw error;
    }

    const commandId = String(payload?.commandId || randomUUID());
    const identifiedPayload = { ...(payload && typeof payload === 'object' ? payload : {}), commandId };
    const resolved = resolveCommandLease({
      client,
      payload: identifiedPayload,
      commandId,
      serverInstanceId: this.serverInstanceId,
    });
    const commandPayload = resolved.payload;
    const request = resolved.request;
    const requestId = request?.requestId || '';

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
      if (commandPayload.leaseScope === 'command') client.requestLeases.delete(requestId);
      throw error;
    }
    this.recordDebug(clientId, {
      type: 'server.command_delivered',
      commandType: payload?.type || 'unknown',
      commandId,
      messageId: envelope.messageId,
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      requestId,
      correlationRequestId: String(commandPayload.correlationRequestId || ''),
      leaseScope: String(commandPayload.leaseScope || 'request'),
      transport: 'extension-websocket',
    });
    return {
      client,
      delivered: Promise.resolve({ clientId, transport: 'extension-websocket', deliveredAt: Date.now() }),
    };
  }
}
