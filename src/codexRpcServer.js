import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { safeJsonParse } from './protocol.js';

function getClientIp(req) { return req.socket?.remoteAddress || ''; }
function isLocalAddress(address) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) || address.endsWith(':127.0.0.1'); }
function tokenFromUpgrade(req) {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer;
  try { return new URL(req.url, 'http://127.0.0.1').searchParams.get('token') || ''; } catch { return ''; }
}
function tokenFromPayload(payload = {}) { return String(payload.token || payload.apiToken || payload.api_token || ''); }
function rpcError(id, code, message, data) { return { id, error: { code, message, ...(data ? { data } : {}) } }; }
function rpcResult(id, result) { return { id, result }; }
function wantsAuth() { return Boolean(config.apiToken); }

export class CodexRpcServer extends EventEmitter {
  constructor({ turnManager, bridge, fileStore, metadataStore, eventBus, projectService = null }) {
    super();
    this.turnManager = turnManager;
    this.bridge = bridge;
    this.fileStore = fileStore;
    this.metadataStore = metadataStore;
    this.eventBus = eventBus;
    this.projectService = projectService;
    this.wss = null;
    this.clients = new Set();
    this.turnManager?.on('notification', (note) => this.broadcast(note.method, note.params));
  }

  attach(server) {
    if (this.wss) return;
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const pathname = (() => { try { return new URL(req.url, 'http://127.0.0.1').pathname; } catch { return ''; } })();
      if (pathname !== '/codex/ws') return;
      if (!this.#isUpgradeAllowed(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
    this.wss.on('connection', (ws) => this.#handleConnection(ws));
  }

  close() {
    for (const client of this.clients) {
      try { client.close(1001, 'Server shutting down'); } catch {}
    }
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }

  broadcast(method, params = {}) {
    const payload = JSON.stringify({ method, params });
    for (const client of this.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  }

  async handleMessage(payload = {}, { trusted = false } = {}) {
    const id = payload.id ?? null;
    const method = String(payload.method || '');
    const params = payload.params && typeof payload.params === 'object' ? payload.params : {};
    if (!method) return rpcError(id, -32600, 'Missing method');
    if (!trusted && wantsAuth() && method !== 'initialize' && tokenFromPayload(params) !== config.apiToken) {
      return rpcError(id, 401, 'Unauthorized: missing or invalid API_TOKEN');
    }
    try {
      return rpcResult(id, await this.#dispatch(method, params));
    } catch (err) {
      return rpcError(id, err.code || -32000, err.message || 'Request failed', err.extra);
    }
  }

  async #dispatch(method, params) {
    switch (method) {
      case 'initialize': return this.#initialize();
      case 'thread/list': return { threads: await this.turnManager.listThreads(params) };
      case 'thread/create': return { thread: await this.turnManager.createThread(params) };
      case 'thread/get': return this.#threadGet(params);
      case 'thread/archive': return this.#threadArchive(params, true);
      case 'thread/delete': return this.#threadArchive(params, true);
      case 'turn/start': return this.#turnStart(params);
      case 'turn/get': return this.#turnGet(params);
      case 'turn/list': return { turns: await this.turnManager.listTurns(params) };
      case 'turn/interrupt': return this.#turnInterrupt(params);
      case 'models/list': return await this.bridge.listModels({ timeoutMs: Number(params.timeoutMs) || 10_000 });
      case 'efforts/list': return await this.bridge.listEfforts({ timeoutMs: Number(params.timeoutMs) || 10_000 });
      case 'file/upload': return this.#fileUpload(params);
      case 'artifact/download': return this.#artifactDownload(params);
      case 'project/open': return this.#projectOpen(params);
      case 'project/scan': return this.#projectScan(params);
      case 'project/pack': return this.#projectPack(params);
      default: {
        const err = new Error(`Unknown method: ${method}`);
        err.code = -32601;
        throw err;
      }
    }
  }

  #initialize() {
    return {
      server: { name: 'chatgpt-browser-bridge-node', protocol: 'codex-like', version: 1 },
      capabilities: {
        threads: true,
        turns: true,
        items: true,
        streamingItems: true,
        artifacts: true,
        files: true,
        projectPackaging: Boolean(this.projectService),
        fileEdits: 'zip-artifact',
        shellCommands: false,
        workflowCommands: false,
        worktrees: false,
        sandbox: false,
        transports: { websocket: true, stdio: true, rest: true },
      },
    };
  }

  async #threadGet(params) {
    const id = params.threadId || params.id;
    if (!id) throw new Error('No threadId provided');
    const thread = await this.turnManager.getThread(id);
    if (!thread) throw new Error(`Thread not found: ${id}`);
    const turns = params.includeTurns === false ? undefined : await this.turnManager.listTurns({ threadId: id });
    const items = params.includeItems ? await this.turnManager.getItems({ threadId: id }) : undefined;
    return { thread, ...(turns ? { turns } : {}), ...(items ? { items } : {}) };
  }

  async #threadArchive(params, archived) {
    const id = params.threadId || params.id;
    if (!id) throw new Error('No threadId provided');
    const thread = await this.metadataStore.updateThread(id, { archived });
    if (!thread) throw new Error(`Thread not found: ${id}`);
    this.broadcast('thread/updated', { thread });
    return { thread };
  }

  async #turnStart(params) {
    const { turn, reused } = await this.turnManager.startTurn(params, { idempotencyKey: params.idempotencyKey || params.idempotency_key || '' });
    return { turn, reused };
  }

  async #turnGet(params) {
    const id = params.turnId || params.id;
    if (!id) throw new Error('No turnId provided');
    const turn = await this.turnManager.getTurn(id);
    if (!turn) throw new Error(`Turn not found: ${id}`);
    const items = await this.turnManager.getItems({ turnId: id });
    return { turn, items };
  }

  async #turnInterrupt(params) {
    const id = params.turnId || params.id;
    if (!id) throw new Error('No turnId provided');
    const turn = await this.turnManager.cancelTurn(id, params.reason || 'Interrupted by client');
    if (!turn) throw new Error(`Turn not found: ${id}`);
    return { turn };
  }

  async #fileUpload(params) {
    const file = params.path
      ? await this.fileStore.importLocalPath({ filePath: params.path, name: params.name, mime: params.mime || params.type })
      : await this.fileStore.putUpload({ name: params.name, mime: params.mime || params.type, contentBase64: params.contentBase64 || params.content_base64, content: params.content });
    return { file };
  }

  async #artifactDownload(params) {
    const artifactId = params.artifactId || params.id;
    if (!artifactId) throw new Error('No artifactId provided');
    const file = await this.bridge.fetchArtifact(artifactId);
    return { file };
  }

  async #projectOpen(params) {
    if (!this.projectService) throw new Error('Project service is not available');
    const cwd = params.cwd || params.path || '';
    if (!cwd) throw new Error('No cwd provided');
    const thread = params.createThread === false ? null : await this.turnManager.createThread({ title: params.title || (cwd ? cwd.split(/[\/]/).pop() : 'Project'), cwd, metadata: { project: true } });
    const project = await this.projectService.open(cwd, { threadId: thread?.id || params.threadId || '', title: params.title || '' });
    return { project, ...(thread ? { thread } : {}) };
  }

  async #projectScan(params) {
    if (!this.projectService) throw new Error('Project service is not available');
    const cwd = params.cwd || params.path || '';
    if (!cwd) throw new Error('No cwd provided');
    return { scan: await this.projectService.scan(cwd, params) };
  }

  async #projectPack(params) {
    if (!this.projectService) throw new Error('Project service is not available');
    const cwd = params.cwd || params.path || '';
    if (!cwd) throw new Error('No cwd provided');
    return { pack: await this.projectService.pack(cwd, params) };
  }

  #handleConnection(ws) {
    this.clients.add(ws);
    ws.on('message', async (raw) => {
      const payload = safeJsonParse(String(raw));
      if (!payload || typeof payload !== 'object') return;
      const response = await this.handleMessage(payload);
      if (response && payload.id !== undefined && ws.readyState === 1) ws.send(JSON.stringify(response));
    });
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  #isUpgradeAllowed(req) {
    if (!isLocalAddress(getClientIp(req))) return false;
    if (!wantsAuth()) return true;
    return tokenFromUpgrade(req) === config.apiToken;
  }
}

export async function runCodexStdio(rpcServer, { input = process.stdin, output = process.stdout } = {}) {
  input.setEncoding('utf8');
  let buffer = '';
  for await (const chunk of input) {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const payload = safeJsonParse(line);
      const response = payload && typeof payload === 'object'
        ? await rpcServer.handleMessage(payload, { trusted: true })
        : rpcError(null, -32700, 'Parse error');
      if (response && payload?.id !== undefined) output.write(`${JSON.stringify(response)}\n`);
    }
  }
}
