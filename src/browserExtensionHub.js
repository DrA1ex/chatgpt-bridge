import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { safeJsonParse } from './protocol.js';
import { BRIDGE_VERSION, EXTENSION_COMPATIBILITY, compatibilityStatusMessage, evaluateExtensionCompatibility } from './extensionCompatibility.js';
import { log, error as logError } from './logger.js';
import { browserLaunchMetadataFromUrl } from './browserLaunch.js';
import { ProtocolV4Adapter } from './bridge/adapters/protocolV4Adapter.js';
import {
  EXTENSION_PROTOCOL_VERSION,
  ExtensionMessageKind,
  createExtensionEnvelope,
} from './bridge/protocol/v4.js';

function getClientIp(req) {
  return req?.socket?.remoteAddress || '';
}

function isLocalAddress(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1', ''].includes(address) || String(address).endsWith(':127.0.0.1');
}

function isAllowedExtensionOrigin(origin) {
  return /^chrome-extension:\/\/[a-p]{32}$/i.test(String(origin || ''));
}

function tokenFromRequest(req) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    return url.searchParams.get('token') || '';
  } catch {
    return '';
  }
}

function runtimeFromRequest(req) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    return url.searchParams.get('runtime') || (isAllowedExtensionOrigin(req.headers.origin || '') ? 'extension' : 'browser');
  } catch {
    return isAllowedExtensionOrigin(req?.headers?.origin || '') ? 'extension' : 'browser';
  }
}

function normalizeDebugPayload(payload) {
  const clone = { ...payload };
  for (const key of ['message', 'text', 'answer', 'contentBase64']) {
    if (typeof clone[key] === 'string' && clone[key].length > 500) clone[key] = `${clone[key].slice(0, 500)}…`;
  }
  return clone;
}

function makeFallbackId() {
  return `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function activeRequestFromPayload(payload = {}, existing = null) {
  const requestId = String(payload.requestId || existing?.requestId || '').trim();
  if (!requestId) return existing || null;
  const answerLength = Number(payload.answerLength ?? payload.lastAnswerLength ?? existing?.lastAnswerLength ?? 0) || 0;
  const thinkingLength = Number(payload.thinkingLength ?? payload.lastThinkingLength ?? existing?.lastThinkingLength ?? 0) || 0;
  const artifactCount = Number(payload.artifactCount ?? existing?.artifactCount ?? 0) || 0;
  return {
    ...(existing?.requestId === requestId ? existing : {}),
    requestId,
    phase: String(payload.phase || payload.status || existing?.phase || payload.type || 'active'),
    sawGenerating: Boolean(payload.sawGenerating ?? existing?.sawGenerating ?? false),
    generating: Boolean(payload.generating ?? existing?.generating ?? false),
    stopButtonVisible: Boolean(payload.stopButtonVisible ?? existing?.stopButtonVisible ?? false),
    sawAnswer: Boolean(payload.sawAnswer ?? existing?.sawAnswer ?? answerLength > 0),
    lastAnswerLength: answerLength,
    lastThinkingLength: thinkingLength,
    artifactCount,
    submittedUserTurnKey: payload.submittedUserTurnKey || existing?.submittedUserTurnKey || '',
    submittedUserTurnIndex: payload.submittedUserTurnIndex ?? existing?.submittedUserTurnIndex ?? -1,
    assistantTurnKey: payload.assistantTurnKey || existing?.assistantTurnKey || '',
    assistantTurnIndex: payload.assistantTurnIndex ?? existing?.assistantTurnIndex ?? -1,
    anchorConfidence: payload.anchorConfidence || existing?.anchorConfidence || '',
    anchorReason: payload.anchorReason || existing?.anchorReason || '',
    promptPreview: payload.promptPreview || existing?.promptPreview || '',
    promptHash: payload.promptHash || existing?.promptHash || '',
    ownerServerInstanceId: payload.ownerServerInstanceId || existing?.ownerServerInstanceId || '',
    lastMeaningfulProgressAt: payload.lastMeaningfulProgressAt || existing?.lastMeaningfulProgressAt || 0,
    lastMeaningfulProgressReason: payload.lastMeaningfulProgressReason || existing?.lastMeaningfulProgressReason || '',
    url: payload.url || existing?.url || '',
    title: payload.title || existing?.title || '',
    updatedAt: Date.now(),
  };
}

function normalizeTabObservation(payload = {}, fallback = null) {
  const raw = payload.observation && typeof payload.observation === 'object'
    ? payload.observation
    : payload.tabObservation && typeof payload.tabObservation === 'object'
      ? payload.tabObservation
      : null;
  if (!raw) return fallback || null;
  const normalized = {
    ...raw,
    revision: Number(raw.revision ?? payload.revision) || 0,
    observedAt: Number(raw.observedAt ?? payload.observedAt) || 0,
    observerId: String(raw.observerId || ''),
  };
  const previousRevision = Number(fallback?.revision);
  const sameEpoch = String(fallback?.observerId || '') === normalized.observerId;
  if (fallback && sameEpoch && Number.isFinite(previousRevision) && normalized.revision <= previousRevision) {
    return fallback;
  }
  return normalized;
}

function normalizeClientSession(payload = {}, fallback = null) {
  const raw = payload.session && typeof payload.session === 'object' ? payload.session : null;
  const url = String(raw?.url || payload.url || fallback?.url || '');
  let id = String(raw?.id || '').trim();
  if (!id) {
    try { id = new URL(url, 'https://chatgpt.com').pathname.match(/\/c\/([^/?#]+)/)?.[1] || ''; } catch {}
  }
  if (!id && /chatgpt\.com\/?(?:[?#].*)?$/i.test(url)) id = 'new';
  if (!id && raw?.active) id = 'new';
  if (!id && fallback?.id) id = String(fallback.id || '');
  if (!id && !url && !raw?.title) return fallback || null;
  return {
    id,
    url,
    title: String(raw?.title || payload.title || fallback?.title || id || ''),
    active: raw?.active ?? true,
  };
}

function isClientCompatible(client) {
  return client?.compatibility?.compatible !== false;
}


export class BrowserExtensionHub extends EventEmitter {
  #eventBus;
  #wss = null;
  #clients = new Map();
  #heartbeatTimer = null;
  #selectedClientId = config.activeClientId || '';
  #debugEvents = [];
  #serverInstanceId;
  #protocol = new ProtocolV4Adapter();
  #serverSequence = 0;

  constructor(eventBus = null, options = {}) {
    super();
    this.#eventBus = eventBus;
    this.#serverInstanceId = String(options.serverInstanceId || randomUUID());
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
  }

  get clients() {
    return Array.from(this.#clients.values()).map((client) => this.#publicClient(client));
  }

  get selectedClientId() { return this.#selectedClientId || ''; }
  get serverInstanceId() { return this.#serverInstanceId; }
  get debugEvents() { return this.#debugEvents.slice(); }

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

  beginRequestRelease(clientId, requestId, commandId = '') {
    const client = this.#clients.get(String(clientId || ''));
    if (!client) return null;
    const id = String(requestId || '');
    if (!id) return null;
    const existing = client.releasePending;
    if (existing?.requestId === id && existing.status !== 'failed') {
      if (commandId) existing.commandId = String(commandId);
      return this.#publicClient(client);
    }
    if (existing?.requestId && existing.requestId !== id && existing.status === 'pending') {
      throw new Error(`Browser extension client ${client.id} is still releasing ${existing.requestId}`);
    }
    client.releasePending = {
      requestId: id,
      commandId: String(commandId || ''),
      startedAt: Date.now(),
      status: 'pending',
      error: '',
      waiters: new Set(),
    };
    this.#recordDebugEvent(client.id, { type: 'request.release.pending', requestId: id, commandId: String(commandId || '') });
    this.emit('client.changed', this.#publicClient(client));
    return this.#publicClient(client);
  }

  failRequestRelease(clientId, requestId = '', error = null) {
    const client = this.#clients.get(String(clientId || ''));
    if (!client?.releasePending) return false;
    const expectedRequestId = String(requestId || '');
    if (expectedRequestId && client.releasePending.requestId !== expectedRequestId) return false;
    this.#settleRequestRelease(
      client,
      { requestId: client.releasePending.requestId, commandId: client.releasePending.commandId },
      error instanceof Error ? error : new Error(String(error || `Browser release failed for ${client.releasePending.requestId}`)),
    );
    return true;
  }

  waitForClientRelease(clientId, requestId = '', timeoutMs = 10_500) {
    const client = this.#clients.get(String(clientId || ''));
    if (!client) return Promise.reject(new Error(`Browser extension client not found: ${clientId}`));
    const pending = client.releasePending;
    const expectedRequestId = String(requestId || '');
    if (!pending || (expectedRequestId && pending.requestId !== expectedRequestId)) {
      return Promise.resolve({ released: true, clientId: client.id, requestId: expectedRequestId });
    }
    if (pending.status === 'failed') {
      return Promise.reject(new Error(pending.error || `Browser release failed for ${pending.requestId}`));
    }
    const limitMs = Math.max(100, Number(timeoutMs) || 10_500);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        pending.waiters.delete(waiter);
        reject(new Error(`Timed out waiting for browser release of ${pending.requestId} after ${limitMs}ms`));
      }, limitMs);
      waiter.timer.unref?.();
      pending.waiters.add(waiter);
    });
  }

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

  sendReloadControlToClient(clientId, payload) {
    if (payload?.type !== 'extension.reload') {
      throw new Error(`Unsupported compatibility-bypass command: ${payload?.type || 'unknown'}`);
    }
    return this.sendToClientWithDelivery(clientId, payload, { allowIncompatibleReload: true }).client;
  }

  sendToClientWithDelivery(clientId, payload, options = {}) {
    const client = this.#clients.get(clientId);
    if (!client) throw new Error(`Browser extension client not found: ${clientId}`);
    const reloadControl = options.allowIncompatibleReload === true
      && payload?.type === 'extension.reload'
      && Number(client.extensionProtocolVersion) === EXTENSION_PROTOCOL_VERSION;
    if (!isClientCompatible(client) && !reloadControl) {
      throw new Error(`Browser extension client is incompatible: ${client.compatibility?.message || clientId}`);
    }
    if (client.ws?.readyState !== 1) throw new Error(`Browser extension WebSocket client is not open: ${clientId}`);
    const requestId = String(payload?.requestId
      || (payload?.type === 'passive.prompt.submit' && payload?.commandId ? `passive_${payload.commandId}` : ''));
    let commandPayload = payload;
    let request = null;
    if (requestId) {
      client.requestLeases ||= new Map();
      let lease = client.requestLeases.get(requestId);
      if (lease && lease.ownerServerInstanceId !== this.#serverInstanceId) {
        if (payload?.type !== 'request.resume') {
          throw new Error(`Request ${requestId} is leased to another bridge server instance; explicit request.resume is required`);
        }
        const previousOwnerServerInstanceId = lease.ownerServerInstanceId;
        lease = { requestId, leaseId: randomUUID(), ownerServerInstanceId: this.#serverInstanceId };
        client.requestLeases.set(requestId, lease);
        commandPayload = { ...payload, previousOwnerServerInstanceId };
      }
      if (!lease) {
        lease = {
          requestId,
          leaseId: randomUUID(),
          ownerServerInstanceId: this.#serverInstanceId,
        };
        client.requestLeases.set(requestId, lease);
      }
      request = lease;
    }
    const envelope = this.#protocol.command(commandPayload, {
      source: {
        clientId: 'bridge-server',
        tabId: client.browserTabId,
        backgroundEpoch: this.#serverInstanceId,
        contentEpoch: '',
        sequence: ++this.#serverSequence,
      },
      request,
      commandId: payload?.commandId,
    });
    if (payload?.type === 'request.release') {
      this.beginRequestRelease(client.id, requestId, payload?.commandId);
    }
    try {
      client.ws.send(JSON.stringify(envelope));
    } catch (error) {
      if (payload?.type === 'request.release') this.#settleRequestRelease(client, payload, error);
      throw error;
    }
    this.#recordDebugEvent(clientId, {
      type: 'server.command_delivered',
      commandType: payload?.type || 'unknown',
      commandId: payload?.commandId,
      messageId: envelope.messageId,
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      requestId: payload?.requestId,
      transport: 'extension-websocket',
    });
    return {
      client,
      delivered: Promise.resolve({ clientId, transport: 'extension-websocket', deliveredAt: Date.now() }),
    };
  }

  dropClient(clientId, reason = 'client.dropped') {
    const client = this.#clients.get(clientId);
    if (!client) throw new Error(`Browser extension client not found: ${clientId}`);
    this.#removeClient(client, reason);
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
      session: null,
      tabObservation: null,
      visibilityState: '',
      focused: false,
      documentReadyState: '',
      chatMainReady: false,
      composerReady: false,
      pageReady: false,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastHelloDebugAt: 0,
      lastHelloSignature: '',
      releasePending: null,
    };

    this.#clients.set(client.id, client);
    log(`Browser extension WebSocket client connected from ${client.origin}`);

    ws.on('message', (raw) => {
      if (client.ready && this.#clients.get(client.id) !== client) {
        try { ws.close(1008, 'stale extension instance'); } catch {}
        return;
      }
      const message = safeJsonParse(String(raw));
      if (!message || typeof message !== 'object') return;
      const outcome = this.#protocol.ingest(message, client);
      if (!outcome.accepted) {
        this.#recordDebugEvent(client.id, {
          type: 'protocol.v4.rejected',
          reason: outcome.reason,
          diagnostics: outcome.diagnostics || [],
          messageId: outcome.envelope?.messageId || '',
        });
        if (outcome.envelope) this.#sendProtocolAck(client, outcome.envelope, false, outcome.reason);
        else {
          try { ws.close(1002, 'protocol 4 envelope required'); } catch {}
        }
        return;
      }
      const applied = this.#handleClientMessage(client, outcome.payload, outcome.envelope);
      this.#sendProtocolAck(client, outcome.envelope, applied !== false, applied === false ? 'lease_rejected' : '');
    });

    ws.on('close', () => this.#removeClient(client, 'client.closed'));
    ws.on('error', (err) => logError('Browser extension WS error:', err));

    this.#sendWs(ws, createExtensionEnvelope(ExtensionMessageKind.TRANSPORT_HELLO, {
      type: 'server.hello',
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      transport: 'websocket',
      serverInstanceId: this.#serverInstanceId,
      bridgeVersion: BRIDGE_VERSION,
      extensionCompatibility: EXTENSION_COMPATIBILITY,
    }, { source: this.#serverSource() }));
  }

  #handleClientMessage(client, payload, envelope) {
    client.lastSeenAt = Date.now();
    this.#recordDebugEvent(client.id, { ...payload, protocolMessageId: envelope.messageId, protocolKind: envelope.kind });

    if (envelope.kind === ExtensionMessageKind.TRANSPORT_HELLO && envelope.request) {
      client.requestLeases ||= new Map();
      client.requestLeases.set(envelope.request.requestId, { ...envelope.request });
    } else if (envelope.request) {
      const lease = client.requestLeases?.get(envelope.request.requestId) || null;
      if (!lease
        || lease.leaseId !== envelope.request.leaseId
        || lease.ownerServerInstanceId !== envelope.request.ownerServerInstanceId) {
        this.#recordDebugEvent(client.id, {
          type: 'protocol.v4.lease_rejected',
          requestId: envelope.request.requestId,
          leaseId: envelope.request.leaseId,
        });
        return false;
      }
    }

    if ((payload.type === 'command.result' || payload.type === 'command.error' || payload.error)
      && client.releasePending?.commandId
      && client.releasePending.commandId === String(payload.commandId || '')) {
      const error = payload.type === 'command.error' || payload.error || payload.released === false
        ? new Error(payload.message || payload.error || `Browser did not release request ${client.releasePending.requestId}`)
        : null;
      this.#settleRequestRelease(client, payload, error);
    }

    if (payload.type === 'hello') {
      const oldId = client.id;
      const newId = typeof payload.clientId === 'string' && payload.clientId ? payload.clientId : oldId;

      if (newId !== oldId) {
        this.#clients.delete(oldId);
        client.id = newId;
        const existing = this.#clients.get(newId);
        if (existing && existing !== client) this.#removeClient(existing, 'client.replaced');
        this.#clients.set(newId, client);
        if (this.#selectedClientId === oldId) this.#selectedClientId = newId;
      }

      client.ready = true;
      client.url = String(payload.url || '');
      const launchMetadata = browserLaunchMetadataFromUrl(client.url);
      client.title = String(payload.title || '');
      client.browserTabId = Number.isInteger(payload.browserTabId) ? payload.browserTabId : client.browserTabId;
      client.launchToken = String(payload.launchToken || launchMetadata.launchToken || client.launchToken || '');
      client.requestedUrl = String(payload.requestedUrl || launchMetadata.requestedUrl || client.requestedUrl || '');
      client.clientVersion = String(payload.clientVersion || payload.version || client.clientVersion || '');
      client.extensionVersion = String(payload.extensionVersion || client.extensionVersion || '');
      client.extensionProtocolVersion = Number(payload.extensionProtocolVersion ?? payload.protocolVersion ?? client.extensionProtocolVersion ?? 0) || 0;
      client.compatibility = evaluateExtensionCompatibility(client);
      client.capabilities = payload.capabilities && typeof payload.capabilities === 'object' ? payload.capabilities : {};
      client.activeRequest = payload.activeRequest ? activeRequestFromPayload(payload.activeRequest, client.activeRequest) : null;
      client.session = normalizeClientSession(payload, client.session);
      client.tabObservation = normalizeTabObservation(payload, client.tabObservation);
      client.visibilityState = payload.visibilityState || client.visibilityState || '';
      client.focused = typeof payload.focused === 'boolean' ? payload.focused : Boolean(client.focused);
      client.documentReadyState = String(payload.documentReadyState || client.documentReadyState || '');
      client.chatMainReady = typeof payload.chatMainReady === 'boolean' ? payload.chatMainReady : Boolean(client.chatMainReady);
      client.composerReady = typeof payload.composerReady === 'boolean' ? payload.composerReady : Boolean(client.composerReady);
      client.pageReady = typeof payload.pageReady === 'boolean' ? payload.pageReady : Boolean(client.pageReady);
      this.emit('client.ready', this.#publicClient(client));
      this.#sendCompatibility(client);
      const launchSuffix = client.launchToken ? ` launch=${client.launchToken.slice(-8)}` : '';
      log(`Browser extension client ready: ${client.id} ${client.url}${launchSuffix}${client.compatibility?.compatible === false ? ' (incompatible)' : ''}`);
      return;
    }

    if (payload.type === 'tab.observation') {
      const previousObservation = client.tabObservation;
      client.tabObservation = normalizeTabObservation(payload, previousObservation);
      if (previousObservation && client.tabObservation === previousObservation) {
        this.#recordDebugEvent(client.id, {
          type: 'tab.observation.ignored',
          observerId: String(payload.observation?.observerId || payload.tabObservation?.observerId || ''),
          revision: Number(payload.observation?.revision ?? payload.tabObservation?.revision ?? payload.revision) || 0,
          currentRevision: Number(previousObservation.revision) || 0,
        });
        return;
      }
      const observation = client.tabObservation || {};
      client.url = String(observation.url || payload.url || client.url || '');
      client.title = String(observation.title || payload.title || client.title || '');
      client.activeRequest = Object.hasOwn(observation, 'activeRequest')
        ? (observation.activeRequest ? activeRequestFromPayload(observation.activeRequest, client.activeRequest) : null)
        : (client.activeRequest || null);
      client.session = normalizeClientSession({
        ...payload,
        url: observation.url || payload.url,
        title: observation.title || payload.title,
        session: payload.session || (observation.conversationId ? {
          id: observation.conversationId,
          url: observation.url || payload.url || client.url,
          title: observation.title || payload.title || client.title,
          active: true,
        } : undefined),
      }, client.session);
      client.visibilityState = observation.visibility || payload.visibilityState || client.visibilityState || '';
      client.focused = typeof observation.focused === 'boolean' ? observation.focused : Boolean(client.focused);
      client.documentReadyState = String(observation.document?.readyState || payload.documentReadyState || client.documentReadyState || '');
      client.chatMainReady = typeof observation.document?.chatMainReady === 'boolean' ? observation.document.chatMainReady : Boolean(client.chatMainReady);
      client.composerReady = typeof observation.composer?.ready === 'boolean' ? observation.composer.ready : Boolean(client.composerReady);
      client.pageReady = typeof observation.document?.pageReady === 'boolean' ? observation.document.pageReady : Boolean(client.pageReady);
      this.emit('client.activity', { clientId: client.id, client: this.#publicClient(client), payload });
      return;
    }

    if (payload.type === 'pong' || payload.type === 'page.status') {
      if (payload.url) {
        client.url = String(payload.url);
        const launchMetadata = browserLaunchMetadataFromUrl(client.url);
        if (!client.launchToken && launchMetadata.launchToken) client.launchToken = launchMetadata.launchToken;
        if (!client.requestedUrl && launchMetadata.requestedUrl) client.requestedUrl = launchMetadata.requestedUrl;
      }
      if (payload.title) client.title = String(payload.title);
      client.session = normalizeClientSession(payload, client.session);
      client.tabObservation = normalizeTabObservation(payload, client.tabObservation);
      client.visibilityState = payload.visibilityState || client.visibilityState || '';
      client.focused = typeof payload.focused === 'boolean' ? payload.focused : Boolean(client.focused);
      client.documentReadyState = String(payload.documentReadyState || client.documentReadyState || '');
      client.chatMainReady = typeof payload.chatMainReady === 'boolean' ? payload.chatMainReady : Boolean(client.chatMainReady);
      client.composerReady = typeof payload.composerReady === 'boolean' ? payload.composerReady : Boolean(client.composerReady);
      client.pageReady = typeof payload.pageReady === 'boolean' ? payload.pageReady : Boolean(client.pageReady);
      this.emit('client.activity', { clientId: client.id, client: this.#publicClient(client), payload });
      return;
    }

    if (payload.type === 'page.changed') {
      client.url = String(payload.url || client.url || '');
      client.title = String(payload.title || client.title || '');
      client.session = normalizeClientSession(payload, client.session);
      client.tabObservation = normalizeTabObservation(payload, client.tabObservation);
      client.visibilityState = payload.visibilityState || client.visibilityState || '';
      client.focused = typeof payload.focused === 'boolean' ? payload.focused : Boolean(client.focused);
      client.documentReadyState = String(payload.documentReadyState || client.documentReadyState || '');
      client.chatMainReady = typeof payload.chatMainReady === 'boolean' ? payload.chatMainReady : Boolean(client.chatMainReady);
      client.composerReady = typeof payload.composerReady === 'boolean' ? payload.composerReady : Boolean(client.composerReady);
      client.pageReady = typeof payload.pageReady === 'boolean' ? payload.pageReady : Boolean(client.pageReady);
      if (Object.hasOwn(payload, 'activeRequest')) {
        client.activeRequest = payload.activeRequest ? activeRequestFromPayload(payload.activeRequest, client.activeRequest) : null;
      }
      const publicClient = this.#publicClient(client);
      this.emit('client.changed', publicClient);
      this.emit('client.activity', { clientId: client.id, client: publicClient, payload });
      return;
    }

    if (payload.type === 'command.result' && payload.activeRequest === null) {
      client.activeRequest = null;
      if (payload.requestId) client.requestLeases?.delete(String(payload.requestId));
    }

    this.emit('client.message', { clientId: client.id, payload, client: this.#publicClient(client) });
  }

  #heartbeat() {
    const now = Date.now();
    for (const client of Array.from(this.#clients.values())) {
      if (now - client.lastSeenAt > config.clientStaleMs) {
        this.#removeClient(client, 'client.stale_closed');
        continue;
      }
      try {
        this.#sendWs(client.ws, createExtensionEnvelope(ExtensionMessageKind.TRANSPORT_PING, {
          type: 'ping',
          time: now,
        }, { source: this.#serverSource(client) }));
      } catch {}
    }
  }

  #settleRequestRelease(client, payload = {}, error = null) {
    const pending = client?.releasePending;
    if (!pending) return;
    if (payload.commandId && pending.commandId && String(payload.commandId) !== pending.commandId) return;
    const waiters = Array.from(pending.waiters || []);
    pending.waiters?.clear?.();
    if (error) {
      pending.status = 'failed';
      pending.error = error.message || String(error);
      this.#recordDebugEvent(client.id, {
        type: 'request.release.failed', requestId: pending.requestId, commandId: pending.commandId, message: pending.error,
      });
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    } else {
      client.releasePending = null;
      this.#recordDebugEvent(client.id, {
        type: 'request.release.settled', requestId: pending.requestId, commandId: pending.commandId,
      });
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve({ released: true, clientId: client.id, requestId: pending.requestId });
      }
    }
    this.emit('client.changed', this.#publicClient(client));
  }

  #removeClient(client, type) {
    if (!client) return;
    if (client.releasePending) this.#settleRequestRelease(client, {}, new Error(`Browser extension client disconnected while releasing ${client.releasePending.requestId}`));
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
    const payload = compatibilityStatusMessage(compatibility);
    if (client.ws?.readyState === 1) {
      this.#sendWs(client.ws, createExtensionEnvelope(ExtensionMessageKind.TRANSPORT_DIAGNOSTIC, payload, {
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
    const ack = createExtensionEnvelope(ExtensionMessageKind.TRANSPORT_ACK, {
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
    return {
      id: client.id,
      transport: client.transport || 'unknown',
      runtime: client.runtime || '',
      ready: client.ready,
      selected: this.#selectedClientId === client.id,
      url: client.url,
      title: client.title,
      browserTabId: client.browserTabId ?? null,
      launchToken: client.launchToken || '',
      requestedUrl: client.requestedUrl || '',
      clientVersion: client.clientVersion || '',
      extensionVersion: client.extensionVersion || '',
      extensionProtocolVersion: client.extensionProtocolVersion || 0,
      compatibility: client.compatibility || null,
      compatible: client.compatibility?.compatible !== false,
      origin: client.origin,
      connectedAt: new Date(client.connectedAt).toISOString(),
      lastSeenAt: new Date(client.lastSeenAt).toISOString(),
      capabilities: client.capabilities,
      session: client.session || null,
      tabObservation: client.tabObservation || null,
      visibilityState: client.visibilityState || '',
      focused: Boolean(client.focused),
      documentReadyState: client.documentReadyState || '',
      chatMainReady: Boolean(client.chatMainReady),
      composerReady: Boolean(client.composerReady),
      pageReady: Boolean(client.pageReady),
      activeRequest: client.activeRequest || null,
      releasingRequestId: client.releasePending?.requestId || '',
      releaseStartedAt: client.releasePending?.startedAt || 0,
      releaseStatus: client.releasePending?.status || '',
      releaseError: client.releasePending?.error || '',
      serverInstanceId: this.#serverInstanceId,
    };
  }
}
