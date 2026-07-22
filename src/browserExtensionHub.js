import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { safeJsonParse } from './protocol.js';
import { BRIDGE_VERSION, EXTENSION_COMPATIBILITY, compatibilityStatusMessage, evaluateExtensionCompatibility } from './extensionCompatibility.js';
import { log, error as logError } from './logger.js';
import { ProtocolV5Adapter } from './bridge/adapters/protocolV5Adapter.js';
import { HubClientMessageRouter } from './bridge/hub/clientMessageRouter.js';
import { HubCommandSender } from './bridge/hub/commandSender.js';
import { getClientIp, isAllowedExtensionOrigin, isClientCompatible, isLocalAddress, makeFallbackId, normalizeDebugPayload, runtimeFromRequest, tokenFromRequest } from './bridge/hub/connectionPolicy.js';
import { publicClientProjection } from './bridge/hub/clientProjection.js';
import {
  EXTENSION_PROTOCOL_VERSION,
  ExtensionMessageType,
  createExtensionEnvelope,
} from './bridge/protocol/v5.js';

export class BrowserExtensionHub extends EventEmitter {
  #eventBus;
  #wss = null;
  #clients = new Map();
  #heartbeatTimer = null;
  #selectedClientId = config.activeClientId || '';
  #debugEvents = [];
  #serverInstanceId;
  #protocol = new ProtocolV5Adapter();
  #serverSequence = 0;
  #messageRouter;
  #canonicalMessageHandler = null;
  #incomingQueues = new Map();
  #commandSender;

  constructor(eventBus = null, options = {}) {
    super();
    this.#eventBus = eventBus;
    this.#serverInstanceId = String(options.serverInstanceId || randomUUID());
    this.#commandSender = new HubCommandSender({
      clients: this.#clients,
      protocol: this.#protocol,
      serverInstanceId: this.#serverInstanceId,
      nextSequence: () => ++this.#serverSequence,
      recordDebug: (clientId, payload) => this.#recordDebugEvent(clientId, payload),
    });
    this.#messageRouter = new HubClientMessageRouter({
      clients: this.#clients,
      getSelectedClientId: () => this.#selectedClientId,
      setSelectedClientId: (value) => { this.#selectedClientId = value; },
      serverInstanceId: this.#serverInstanceId,
      recordDebugEvent: (clientId, payload) => this.#recordDebugEvent(clientId, payload),
      publicClient: (client) => this.#publicClient(client),
      emit: (...args) => this.emit(...args),
      removeClient: (client, type) => this.#removeClient(client, type),
      sendCompatibility: (client) => this.#sendCompatibility(client),
    });
  }

  attach(server) {
    if (this.#wss) return;

    this.#wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const pathname = (() => {
        try { return new URL(req.url, 'http://127.0.0.1').pathname; } catch { return ''; }
      })();

      if (pathname !== '/extension/ws') return;

      if (!this.#isUpgradeAllowed(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      this.#wss.handleUpgrade(req, socket, head, (ws) => {
        this.#wss.emit('connection', ws, req);
      });
    });

    this.#wss.on('connection', (ws, req) => this.#handleWsConnection(ws, req));
    this.#heartbeatTimer = setInterval(() => this.#heartbeat(), config.heartbeatIntervalMs);
    this.#heartbeatTimer.unref?.();
  }

  close() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }

    for (const client of Array.from(this.#clients.values())) this.#removeClient(client, 'server.shutdown');
    this.#wss?.close();
    this.#wss = null;
    this.#incomingQueues.clear();
  }

  get clients() {
    return Array.from(this.#clients.values()).map((client) => this.#publicClient(client));
  }

  get selectedClientId() { return this.#selectedClientId || ''; }
  get serverInstanceId() { return this.#serverInstanceId; }
  get debugEvents() { return this.#debugEvents.slice(); }

  setCanonicalMessageHandler(handler) {
    if (handler != null && typeof handler !== 'function') throw new TypeError('Canonical message handler must be a function');
    this.#canonicalMessageHandler = handler || null;
  }

  get activeClient() {
    const readyClients = Array.from(this.#clients.values()).filter((client) => client.ready && isClientCompatible(client));
    if (this.#selectedClientId) {
      const selected = this.#clients.get(this.#selectedClientId);
      return selected && selected.ready && isClientCompatible(selected) ? selected : null;
    }
    if (readyClients.length === 1) return readyClients[0];
    return null;
  }

  get needsSelection() {
    const readyCount = Array.from(this.#clients.values()).filter((client) => client.ready && isClientCompatible(client)).length;
    return !this.#selectedClientId && readyCount > 1;
  }

  selectClient(clientId) {
    const client = this.#clients.get(clientId);
    if (!client || !client.ready) throw new Error(`Browser extension client not found or not ready: ${clientId}`);
    if (!isClientCompatible(client)) throw new Error(`Browser extension client is incompatible: ${client.compatibility?.message || clientId}`);
    this.#selectedClientId = clientId;
    this.#recordDebugEvent(clientId, { type: 'server.client_selected', clientId });
    return this.#publicClient(client);
  }

  clearSelectedClient() { this.#selectedClientId = ''; }

  sendToActive(payload) {
    const client = this.activeClient;
    if (!client) {
      if (this.needsSelection) throw new Error('Multiple browser extension clients are connected. Select one with /tab <clientId> or POST /browser/select.');
      if (this.#selectedClientId) throw new Error(`Selected browser extension client is not connected: ${this.#selectedClientId}`);
      throw new Error('No browser extension client connected. Open chatgpt.com with the ChatGPT Bridge extension enabled. Run /setup for setup instructions.');
    }
    this.sendToClient(client.id, payload);
    return client;
  }

  sendToActiveWithDelivery(payload, options = {}) {
    const client = this.activeClient;
    if (!client) {
      if (this.needsSelection) throw new Error('Multiple browser extension clients are connected. Select one with /tab <clientId> or POST /browser/select.');
      if (this.#selectedClientId) throw new Error(`Selected browser extension client is not connected: ${this.#selectedClientId}`);
      throw new Error('No browser extension client connected. Open chatgpt.com with the ChatGPT Bridge extension enabled. Run /setup for setup instructions.');
    }
    return this.sendToClientWithDelivery(client.id, payload, options);
  }

  sendToClient(clientId, payload) {
    return this.sendToClientWithDelivery(clientId, payload).client;
  }

  sendReloadControlToClient(clientId, payload, options = {}) {
    if (payload?.type !== 'extension.reload') {
      throw new Error(`Unsupported compatibility-bypass command: ${payload?.type || 'unknown'}`);
    }
    return this.sendToClientWithDelivery(clientId, payload, { ...options, allowIncompatibleReload: true }).client;
  }

  sendToClientWithDelivery(clientId, payload, options = {}) { return this.#commandSender.send(clientId, payload, options); }

  dropClient(clientId, reason = 'client.dropped') {
    const client = this.#clients.get(clientId);
    if (!client) throw new Error(`Browser extension client not found: ${clientId}`);
    this.#removeClient(client, reason);
    return this.#publicClient(client);
  }

  setClientQuarantineForE2E(clientId, { quarantined = true, reason = 'e2e_quarantine_isolation' } = {}) {
    if (process.env.BRIDGE_E2E_TEST_HOOKS !== '1') throw new Error('E2E quarantine hooks are disabled');
    const client = this.#clients.get(String(clientId || ''));
    if (!client || !client.ready) throw new Error(`Browser extension client not found or not ready: ${clientId}`);
    client.quarantined = Boolean(quarantined);
    client.quarantineReason = client.quarantined ? String(reason || 'e2e_quarantine_isolation') : '';
    this.#recordDebugEvent(client.id, {
      type: client.quarantined ? 'e2e.client_quarantined' : 'e2e.client_quarantine_cleared',
      clientId: client.id,
      reason: client.quarantineReason,
    });
    return this.#publicClient(client);
  }

  validateToken(token) {
    return !config.bridgeToken || token === config.bridgeToken;
  }

  isLocalRequest(req) {
    return isLocalAddress(getClientIp(req));
  }

  #isUpgradeAllowed(req) {
    const ip = getClientIp(req);
    if (!isLocalAddress(ip)) {
      log(`Rejected browser extension WS from non-local address: ${ip}`);
      return false;
    }

    const origin = req.headers.origin || 'null';
    if (!config.allowedOrigins.includes(origin) && !isAllowedExtensionOrigin(origin)) {
      log(`Rejected browser extension WS from origin: ${origin}`);
      return false;
    }

    if (!this.validateToken(tokenFromRequest(req))) {
      log('Rejected browser extension WS because BRIDGE_TOKEN did not match');
      return false;
    }

    return true;
  }

  #handleWsConnection(ws, req) {
    const fallbackId = makeFallbackId();
    const client = {
      id: fallbackId,
      transport: runtimeFromRequest(req) === 'extension' ? 'extension' : 'websocket',
      runtime: runtimeFromRequest(req),
      ws,
      ready: false,
      origin: req.headers.origin || 'null',
      ip: getClientIp(req),
      url: '',
      title: '',
      browserTabId: null,
      launchToken: '',
      requestedUrl: '',
      clientVersion: '',
      extensionVersion: '',
      extensionProtocolVersion: 0,
      compatibility: null,
      capabilities: {},
      transportHealth: null,
      session: null,
      tabObservation: null,
      visibilityState: '',
      focused: false,
      documentReadyState: '',
      chatMainReady: false,
      composerReady: false,
      pageReady: false,
      quarantined: false,
      quarantineReason: '',
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastHelloDebugAt: 0,
      lastHelloSignature: '',
    };

    this.#clients.set(client.id, client);
    log(`Browser extension WebSocket client connected from ${client.origin}`);

    ws.on('message', (raw) => {
      const message = safeJsonParse(String(raw));
      if (!message || typeof message !== 'object') return;
      const tabId = Number.isInteger(message?.source?.tabId) ? message.source.tabId : client.browserTabId;
      const queueKey = Number.isInteger(tabId) ? `tab:${tabId}` : `connection:${client.id}`;
      void this.#enqueueIncoming(queueKey, async () => {
        if (client.ready && this.#clients.get(client.id) !== client) {
          try { ws.close(1008, 'stale extension instance'); } catch {}
          return;
        }
        const prepared = this.#protocol.prepare(message, client);
        if (!prepared.accepted) {
          this.#recordProtocolRejection(client, prepared);
          if (prepared.envelope) this.#sendProtocolAck(client, prepared.envelope, false, prepared.reason);
          else {
            try { ws.close(1002, 'protocol 5 envelope required'); } catch {}
          }
          return;
        }
        const preflight = this.#messageRouter.preflight(client, prepared.payload, prepared.envelope);
        if (!preflight.accepted) {
          this.#sendProtocolAck(client, prepared.envelope, false, preflight.reason || 'lease_rejected');
          return;
        }
        try {
          const preview = this.#messageRouter.preview(client, prepared.payload, prepared.envelope);
          if (preview && this.#canonicalMessageHandler) await this.#canonicalMessageHandler(preview);
          const applied = this.#handleClientMessage(client, prepared.payload, prepared.envelope);
          if (applied === false) {
            this.#sendProtocolAck(client, prepared.envelope, false, 'lease_rejected');
            return;
          }
          const committed = this.#protocol.commit(prepared);
          if (!committed.accepted) {
            this.#recordProtocolRejection(client, committed);
            this.#sendProtocolAck(client, prepared.envelope, false, committed.reason || 'protocol_commit_rejected');
            return;
          }
          this.#sendProtocolAck(client, prepared.envelope, true, '');
        } catch (error) {
          this.#recordDebugEvent(client.id, {
            type: 'protocol.v5.canonical_commit_failed',
            messageId: prepared.envelope.messageId,
            message: error?.message || String(error),
          });
          this.#sendProtocolAck(client, prepared.envelope, false, 'canonical_commit_failed');
        }
      });
    });

    ws.on('close', () => this.#removeClient(client, 'client.closed'));
    ws.on('error', (err) => logError('Browser extension WS error:', err));

    this.#sendWs(ws, createExtensionEnvelope(ExtensionMessageType.TRANSPORT_HELLO, {
      type: 'server.hello',
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      transport: 'websocket',
      serverInstanceId: this.#serverInstanceId,
      bridgeVersion: BRIDGE_VERSION,
      extensionCompatibility: EXTENSION_COMPATIBILITY,
    }, { source: this.#serverSource() }));
  }

  #enqueueIncoming(key, operation) {
    const previous = this.#incomingQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.#incomingQueues.set(key, current);
    return current.finally(() => {
      if (this.#incomingQueues.get(key) === current) this.#incomingQueues.delete(key);
    });
  }

  #recordProtocolRejection(client, outcome) {
    this.#recordDebugEvent(client.id, {
      type: 'protocol.v5.rejected',
      reason: outcome.reason,
      diagnostics: outcome.diagnostics || [],
      messageId: outcome.envelope?.messageId || '',
    });
  }

  #handleClientMessage(client, payload, envelope) { return this.#messageRouter.handle(client, payload, envelope); }
  #heartbeat() {
    const now = Date.now();
    for (const client of Array.from(this.#clients.values())) {
      if (now - client.lastSeenAt > config.clientStaleMs) {
        this.#removeClient(client, 'client.stale_closed');
        continue;
      }
      try {
        this.#sendWs(client.ws, createExtensionEnvelope(ExtensionMessageType.TRANSPORT_PING, {
          type: 'ping',
          time: now,
        }, { source: this.#serverSource(client) }));
      } catch {}
    }
  }

  #removeClient(client, type) {
    if (!client) return;
    this.#clients.delete(client.id);
    if (this.#selectedClientId === client.id) this.#selectedClientId = '';
    try { client.ws?.close?.(1001, type); } catch {}
    this.#recordDebugEvent(client.id, { type });
    this.emit('client.closed', this.#publicClient(client));
    log(`Browser extension client disconnected: ${client.id}`);
  }

  #sendWs(ws, payload) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(payload));
  }

  #sendCompatibility(client) {
    if (!client) return;
    const compatibility = client.compatibility || evaluateExtensionCompatibility(client);
    const payload = {
      ...compatibilityStatusMessage(compatibility),
      diagnosticType: 'extension.compatibility',
    };
    if (client.ws?.readyState === 1) {
      this.#sendWs(client.ws, createExtensionEnvelope(ExtensionMessageType.TRANSPORT_DIAGNOSTIC, payload, {
        source: this.#serverSource(client),
      }));
    }
    this.#recordDebugEvent(client.id, {
      type: 'extension.compatibility.checked',
      compatible: compatibility.compatible,
      status: compatibility.status,
      extensionVersion: compatibility.extensionVersion || '',
      contentVersion: compatibility.contentVersion || '',
      bridgeVersion: compatibility.bridgeVersion || BRIDGE_VERSION,
    });
  }

  #serverSource(client = null) {
    return {
      clientId: 'bridge-server',
      tabId: client?.browserTabId ?? null,
      backgroundEpoch: this.#serverInstanceId,
      contentEpoch: '',
      sequence: ++this.#serverSequence,
    };
  }

  #sendProtocolAck(client, envelope, accepted, reason = '') {
    if (!client?.ws || client.ws.readyState !== 1) return;
    const ack = createExtensionEnvelope(ExtensionMessageType.TRANSPORT_ACK, {
      ackMessageId: envelope.messageId,
      acceptedSequence: envelope.source.sequence,
      accepted,
      reason,
    }, {
      source: this.#serverSource(client),
      causationId: envelope.messageId,
    });
    this.#sendWs(client.ws, ack);
  }

  #recordDebugEvent(clientId, payload) {
    const event = {
      time: new Date().toISOString(),
      clientId,
      type: String(payload?.type || 'unknown'),
      payload: normalizeDebugPayload(payload || {}),
    };
    this.#debugEvents.push(event);
    while (this.#debugEvents.length > config.debugEventsLimit) this.#debugEvents.shift();
    this.emit('debug.event', event);
    this.#eventBus?.emitDebug({ type: event.type, clientId: event.clientId, data: event.payload });
  }

  #publicClient(client) {
    return publicClientProjection(client, { selectedClientId: this.#selectedClientId, serverInstanceId: this.#serverInstanceId });
  }}
