import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { safeJsonParse } from './protocol.js';
import { BRIDGE_VERSION, EXTENSION_COMPATIBILITY, compatibilityStatusMessage, evaluateExtensionCompatibility } from './extensionCompatibility.js';
import { log, error as logError } from './logger.js';
import { browserLaunchMetadataFromUrl } from './browserLaunch.js';

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

  sendControlToClient(clientId, payload) {
    if (payload?.type !== 'extension.reload') {
      throw new Error(`Unsupported compatibility-bypass command: ${payload?.type || 'unknown'}`);
    }
    return this.sendToClientWithDelivery(clientId, payload, { allowIncompatible: true }).client;
  }

  sendToClientWithDelivery(clientId, payload, options = {}) {
    const client = this.#clients.get(clientId);
    if (!client) throw new Error(`Browser extension client not found: ${clientId}`);
    if (!options.allowIncompatible && !isClientCompatible(client)) throw new Error(`Browser extension client is incompatible: ${client.compatibility?.message || clientId}`);
    if (client.ws?.readyState !== 1) throw new Error(`Browser extension WebSocket client is not open: ${clientId}`);
    client.ws.send(JSON.stringify(payload));
    this.#recordDebugEvent(clientId, {
      type: 'server.command_delivered',
      commandType: payload?.type || 'unknown',
      commandId: payload?.commandId,
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
    };

    this.#clients.set(client.id, client);
    log(`Browser extension WebSocket client connected from ${client.origin}`);

    ws.on('message', (raw) => {
      const payload = safeJsonParse(String(raw));
      if (!payload || typeof payload !== 'object') return;
      this.#handleClientMessage(client, payload);
    });

    ws.on('close', () => this.#removeClient(client, 'client.closed'));
    ws.on('error', (err) => logError('Browser extension WS error:', err));

    this.#sendWs(ws, { type: 'server.hello', protocolVersion: 3, heartbeatIntervalMs: config.heartbeatIntervalMs, transport: 'websocket', serverInstanceId: this.#serverInstanceId, bridgeVersion: BRIDGE_VERSION, extensionCompatibility: EXTENSION_COMPATIBILITY });
  }

  #handleClientMessage(client, payload) {
    client.lastSeenAt = Date.now();
    this.#recordDebugEvent(client.id, payload);

    if (payload?.requestId && (!payload.commandId || payload.type === 'request.progress')) {
      client.activeRequest = activeRequestFromPayload(payload, client.activeRequest);
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
      client.activeRequest = Object.hasOwn(payload, 'activeRequest')
        ? (payload.activeRequest ? activeRequestFromPayload(payload.activeRequest, client.activeRequest) : null)
        : (client.activeRequest || null);
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
      client.activeRequest = Object.hasOwn(payload, 'activeRequest')
        ? (payload.activeRequest ? activeRequestFromPayload(payload.activeRequest, client.activeRequest) : null)
        : (client.activeRequest || null);
      client.session = normalizeClientSession(payload, client.session);
      client.tabObservation = normalizeTabObservation(payload, client.tabObservation);
      client.visibilityState = payload.visibilityState || client.visibilityState || '';
      client.focused = typeof payload.focused === 'boolean' ? payload.focused : Boolean(client.focused);
      client.documentReadyState = String(payload.documentReadyState || client.documentReadyState || '');
      client.chatMainReady = typeof payload.chatMainReady === 'boolean' ? payload.chatMainReady : Boolean(client.chatMainReady);
      client.composerReady = typeof payload.composerReady === 'boolean' ? payload.composerReady : Boolean(client.composerReady);
      client.pageReady = typeof payload.pageReady === 'boolean' ? payload.pageReady : Boolean(client.pageReady);
      const publicClient = this.#publicClient(client);
      this.emit('client.changed', publicClient);
      this.emit('client.activity', { clientId: client.id, client: publicClient, payload });
      return;
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
      try { this.#sendWs(client.ws, { type: 'ping', time: now }); } catch {}
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
    const payload = compatibilityStatusMessage(compatibility);
    if (client.ws?.readyState === 1) this.#sendWs(client.ws, payload);
    this.#recordDebugEvent(client.id, {
      type: 'extension.compatibility.checked',
      compatible: compatibility.compatible,
      status: compatibility.status,
      extensionVersion: compatibility.extensionVersion || '',
      contentVersion: compatibility.contentVersion || '',
      bridgeVersion: compatibility.bridgeVersion || BRIDGE_VERSION,
    });
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
      serverInstanceId: this.#serverInstanceId,
    };
  }
}
