import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { safeJsonParse } from './protocol.js';
import { log, error as logError } from './logger.js';

function getClientIp(req) {
  return req?.socket?.remoteAddress || '';
}

function isLocalAddress(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1', ''].includes(address) || String(address).endsWith(':127.0.0.1');
}

function tokenFromRequest(req) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    return url.searchParams.get('token') || '';
  } catch {
    return '';
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
  return `tm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class TampermonkeyHub extends EventEmitter {
  #eventBus;
  #wss = null;
  #clients = new Map();
  #heartbeatTimer = null;
  #selectedClientId = config.activeClientId || '';
  #debugEvents = [];

  constructor(eventBus = null) {
    super();
    this.#eventBus = eventBus;
  }

  attach(server) {
    if (this.#wss) return;

    this.#wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const pathname = (() => {
        try { return new URL(req.url, 'http://127.0.0.1').pathname; } catch { return ''; }
      })();

      if (pathname !== '/tm/ws') return;

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

    for (const client of this.#clients.values()) {
      this.#flushPoll(client, [{ type: 'server.shutdown' }]);
      try { client.ws?.close?.(1001, 'Bridge shutting down'); } catch {}
    }

    this.#clients.clear();
    this.#wss?.close();
    this.#wss = null;
  }

  get clients() {
    return Array.from(this.#clients.values()).map((client) => this.#publicClient(client));
  }

  get selectedClientId() { return this.#selectedClientId || ''; }
  get debugEvents() { return this.#debugEvents.slice(); }

  get activeClient() {
    const readyClients = Array.from(this.#clients.values()).filter((client) => client.ready);
    if (this.#selectedClientId) {
      const selected = this.#clients.get(this.#selectedClientId);
      return selected && selected.ready ? selected : null;
    }
    if (readyClients.length === 1) return readyClients[0];
    return null;
  }

  get needsSelection() {
    const readyCount = Array.from(this.#clients.values()).filter((client) => client.ready).length;
    return !this.#selectedClientId && readyCount > 1;
  }

  selectClient(clientId) {
    const client = this.#clients.get(clientId);
    if (!client || !client.ready) throw new Error(`Tampermonkey client not found or not ready: ${clientId}`);
    this.#selectedClientId = clientId;
    this.#recordDebugEvent(clientId, { type: 'server.client_selected', clientId });
    return this.#publicClient(client);
  }

  clearSelectedClient() { this.#selectedClientId = ''; }

  sendToActive(payload) {
    const client = this.activeClient;
    if (!client) {
      if (this.needsSelection) throw new Error('Multiple Tampermonkey clients are connected. Select one with /select <clientId> or POST /tm/select.');
      if (this.#selectedClientId) throw new Error(`Selected Tampermonkey client is not connected: ${this.#selectedClientId}`);
      throw new Error('No Tampermonkey client connected. Open chatgpt.com with the bridge userscript enabled. Run /setup for setup instructions.');
    }
    this.sendToClient(client.id, payload);
    return client;
  }

  sendToClient(clientId, payload) {
    const client = this.#clients.get(clientId);
    if (!client) throw new Error(`Tampermonkey client not found: ${clientId}`);

    if (client.transport === 'websocket') {
      if (client.ws?.readyState !== 1) throw new Error(`Tampermonkey WebSocket client is not open: ${clientId}`);
      client.ws.send(JSON.stringify(payload));
      return client;
    }

    client.queue.push(payload);
    this.#flushPoll(client);
    return client;
  }

  validateToken(token) {
    return !config.bridgeToken || token === config.bridgeToken;
  }

  isLocalRequest(req) {
    return isLocalAddress(getClientIp(req));
  }

  registerPollingClient(hello = {}, req = null) {
    const id = String(hello.clientId || '').trim() || makeFallbackId();
    const existing = this.#clients.get(id);
    const client = existing || {
      id,
      transport: 'polling',
      ready: false,
      origin: req?.headers?.origin || 'tampermonkey-poll',
      ip: getClientIp(req),
      url: '',
      title: '',
      capabilities: {},
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      queue: [],
      poll: null,
    };

    client.transport = 'polling';
    client.ready = true;
    client.lastSeenAt = Date.now();
    client.origin = req?.headers?.origin || client.origin || 'tampermonkey-poll';
    client.ip = getClientIp(req) || client.ip || '';
    client.url = String(hello.url || client.url || '');
    client.title = String(hello.title || client.title || '');
    client.capabilities = hello.capabilities && typeof hello.capabilities === 'object' ? hello.capabilities : client.capabilities || {};
    client.activeRequest = hello.activeRequest || null;
    if (!existing) this.#clients.set(id, client);

    this.#recordDebugEvent(id, { type: 'poll.hello', clientId: id, url: client.url, title: client.title });
    this.emit('client.ready', this.#publicClient(client));
    return this.#publicClient(client);
  }

  receivePollingPayload(clientId, payload = {}) {
    const client = this.#clients.get(clientId) || this.#ensurePollingClient(clientId);
    client.lastSeenAt = Date.now();
    if (payload.type === 'hello') {
      this.registerPollingClient(payload);
      return;
    }
    this.#handleClientMessage(client, payload);
  }

  async poll(clientId, req = null, timeoutMs = config.tmPollTimeoutMs) {
    const client = this.#clients.get(clientId) || this.#ensurePollingClient(clientId, req);
    client.transport = 'polling';
    client.lastSeenAt = Date.now();
    if (client.queue.length) return { commands: client.queue.splice(0), serverTime: Date.now() };

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (client.poll?.resolve === resolve) client.poll = null;
        resolve({ commands: [{ type: 'noop', time: Date.now() }], serverTime: Date.now() });
      }, timeoutMs);
      timer.unref?.();
      client.poll = { resolve, timer };
    });
  }

  #ensurePollingClient(clientId, req = null) {
    const id = String(clientId || '').trim() || makeFallbackId();
    const client = {
      id,
      transport: 'polling',
      ready: false,
      origin: req?.headers?.origin || 'tampermonkey-poll',
      ip: getClientIp(req),
      url: '',
      title: '',
      capabilities: {},
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      queue: [],
      poll: null,
    };
    this.#clients.set(id, client);
    return client;
  }

  #flushPoll(client, explicitCommands = null) {
    if (!client?.poll) return;
    const poll = client.poll;
    client.poll = null;
    clearTimeout(poll.timer);
    const commands = explicitCommands || client.queue.splice(0);
    poll.resolve({ commands: commands.length ? commands : [{ type: 'noop', time: Date.now() }], serverTime: Date.now() });
  }

  #isUpgradeAllowed(req) {
    const ip = getClientIp(req);
    if (!isLocalAddress(ip)) {
      log(`Rejected Tampermonkey WS from non-local address: ${ip}`);
      return false;
    }

    const origin = req.headers.origin || 'null';
    if (!config.allowedOrigins.includes(origin)) {
      log(`Rejected Tampermonkey WS from origin: ${origin}`);
      return false;
    }

    if (!this.validateToken(tokenFromRequest(req))) {
      log('Rejected Tampermonkey WS because BRIDGE_TOKEN did not match');
      return false;
    }

    return true;
  }

  #handleWsConnection(ws, req) {
    const fallbackId = makeFallbackId();
    const client = {
      id: fallbackId,
      transport: 'websocket',
      ws,
      ready: false,
      origin: req.headers.origin || 'null',
      ip: getClientIp(req),
      url: '',
      title: '',
      capabilities: {},
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      queue: [],
      poll: null,
    };

    this.#clients.set(client.id, client);
    log(`Tampermonkey WebSocket client connected from ${client.origin}`);

    ws.on('message', (raw) => {
      const payload = safeJsonParse(String(raw));
      if (!payload || typeof payload !== 'object') return;
      this.#handleClientMessage(client, payload);
    });

    ws.on('close', () => this.#removeClient(client, 'client.closed'));
    ws.on('error', (err) => logError('Tampermonkey WS error:', err));

    this.#sendWs(ws, { type: 'server.hello', protocolVersion: 2, heartbeatIntervalMs: config.heartbeatIntervalMs, transport: 'websocket' });
  }

  #handleClientMessage(client, payload) {
    client.lastSeenAt = Date.now();
    this.#recordDebugEvent(client.id, payload);

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
      client.title = String(payload.title || '');
      client.capabilities = payload.capabilities && typeof payload.capabilities === 'object' ? payload.capabilities : {};
      client.activeRequest = payload.activeRequest || null;
      this.emit('client.ready', this.#publicClient(client));
      log(`Tampermonkey client ready: ${client.id} ${client.url}`);
      return;
    }

    if (payload.type === 'pong' || payload.type === 'page.status') {
      if (payload.url) client.url = String(payload.url);
      if (payload.title) client.title = String(payload.title);
      client.activeRequest = payload.activeRequest || client.activeRequest || null;
      return;
    }

    if (payload.type === 'page.changed') {
      client.url = String(payload.url || client.url || '');
      client.title = String(payload.title || client.title || '');
      this.emit('client.changed', this.#publicClient(client));
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
      if (client.transport === 'websocket') {
        try { this.#sendWs(client.ws, { type: 'ping', time: now }); } catch {}
      } else if (client.ready) {
        client.queue.push({ type: 'ping', time: now });
        this.#flushPoll(client);
      }
    }
  }

  #removeClient(client, type) {
    if (!client) return;
    this.#clients.delete(client.id);
    if (this.#selectedClientId === client.id) this.#selectedClientId = '';
    this.#flushPoll(client, [{ type: 'client.closed' }]);
    try { client.ws?.close?.(1001, type); } catch {}
    this.#recordDebugEvent(client.id, { type });
    this.emit('client.closed', this.#publicClient(client));
    log(`Tampermonkey client disconnected: ${client.id}`);
  }

  #sendWs(ws, payload) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(payload));
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
      ready: client.ready,
      selected: this.#selectedClientId === client.id,
      url: client.url,
      title: client.title,
      origin: client.origin,
      connectedAt: new Date(client.connectedAt).toISOString(),
      lastSeenAt: new Date(client.lastSeenAt).toISOString(),
      capabilities: client.capabilities,
      activeRequest: client.activeRequest || null,
      queuedCommands: client.queue?.length || 0,
    };
  }
}
