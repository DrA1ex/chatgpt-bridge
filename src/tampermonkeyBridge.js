import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncMutex } from './mutex.js';
import { config } from './config.js';
import { makeRequestId, appendOnlyDelta } from './protocol.js';
import { log } from './logger.js';

function noopCallbacks(callbacks = {}) {
  return {
    onThinkingUpdate: typeof callbacks.onThinkingUpdate === 'function' ? callbacks.onThinkingUpdate : null,
    onAnswerUpdate: typeof callbacks.onAnswerUpdate === 'function' ? callbacks.onAnswerUpdate : null,
    onArtifactUpdate: typeof callbacks.onArtifactUpdate === 'function' ? callbacks.onArtifactUpdate : null,
    onEvent: typeof callbacks.onEvent === 'function' ? callbacks.onEvent : null,
    onStatus: typeof callbacks.onStatus === 'function' ? callbacks.onStatus : null,
  };
}

function abortError(message = 'Request cancelled') {
  const err = new Error(message);
  err.name = 'AbortError';
  err.statusCode = 499;
  return err;
}

function makeEvent(type, payload = {}) {
  return {
    type,
    time: new Date().toISOString(),
    ...payload,
  };
}

function normalizeOptions(options = {}) {
  return {
    sessionId: typeof options.sessionId === 'string' ? options.sessionId : '',
    newSession: Boolean(options.newSession),
    model: typeof options.model === 'string' ? options.model : '',
    effort: typeof options.effort === 'string' ? options.effort : '',
    attachments: Array.isArray(options.attachments) ? options.attachments : [],
    answerSettleMs: config.answerSettleMs,
    answerDoneSettleMs: config.answerDoneSettleMs,
    ...(options.chatOptions && typeof options.chatOptions === 'object' ? options.chatOptions : {}),
  };
}

async function statFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat?.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function downloadConflictCandidates(filePath = '', preferredName = '') {
  const absolute = path.resolve(String(filePath || ''));
  const dir = path.dirname(absolute);
  const baseName = path.basename(absolute);
  const names = new Set([baseName]);
  if (preferredName) names.add(path.basename(String(preferredName)));
  const patterns = [];
  for (const name of names) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    if (!stem) continue;
    patterns.push({ stem, ext });
  }
  return { dir, patterns };
}

async function resolveBrowserDownloadedPath(filePath = '', preferredName = '') {
  const absolute = path.resolve(String(filePath || ''));
  if (await statFile(absolute)) return absolute;

  const { dir, patterns } = downloadConflictCandidates(absolute, preferredName);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return absolute;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const matched = patterns.some(({ stem, ext }) => {
      if (name === `${stem}${ext}`) return true;
      const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedExt = ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^${escapedStem} \\([0-9]+\\)${escapedExt}$`).test(name);
    });
    if (!matched) continue;
    const candidate = path.join(dir, name);
    const stat = await statFile(candidate);
    if (stat) candidates.push({ path: candidate, mtimeMs: stat.mtimeMs, size: stat.size });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
  return candidates[0]?.path || absolute;
}

export class TampermonkeyBridge {
  #hub;
  #fileStore;
  #eventBus;
  #mutex = new AsyncMutex();
  #pending = new Map();
  #commands = new Map();
  #artifacts = new Map();

  constructor(hub, fileStore = null, eventBus = null) {
    this.#hub = hub;
    this.#fileStore = fileStore;
    this.#eventBus = eventBus;
    this.#hub.on('client.message', ({ clientId, payload }) => this.#handleClientMessage(clientId, payload));
    this.#hub.on?.('client.activity', ({ clientId, client, payload }) => this.#handleClientActivity(clientId, client, payload));
  }

  get pageUrl() {
    return this.#hub.activeClient?.url || null;
  }

  async connectBrowser() {
    if (!this.#hub.activeClient) {
      throw new Error('No browser extension client connected. Open ChatGPT with the ChatGPT Bridge extension enabled.');
    }
  }

  health() {
    const active = this.#hub.activeClient;
    return {
      ok: Boolean(active),
      transport: active ? `${active.runtime === 'extension' || active.transport === 'extension' ? 'extension' : 'browser'}:${active.transport || 'unknown'}` : 'extension:disconnected',
      clients: this.#hub.clients,
      activeClient: active ? this.#hub.clients.find((client) => client.id === active.id) : null,
      selectedClientId: this.#hub.selectedClientId,
      needsSelection: this.#hub.needsSelection,
      pendingRequests: this.#pending.size,
      pendingCommands: this.#commands.size,
      artifacts: this.#artifacts.size,
    };
  }

  selectClient(clientId) {
    return this.#hub.selectClient(clientId);
  }

  clearSelectedClient() {
    this.#hub.clearSelectedClient();
  }

  dropClient(clientId) {
    return this.#hub.dropClient(clientId);
  }

  debugEvents() {
    return this.#hub.debugEvents;
  }

  onClientLifecycle(handler) {
    if (typeof handler !== 'function') return () => {};
    const events = ['client.ready', 'client.changed', 'client.closed'];
    for (const event of events) this.#hub.on(event, handler);
    return () => {
      for (const event of events) this.#hub.off(event, handler);
    };
  }


  validateBridgeToken(token) {
    return this.#hub.validateToken(token);
  }

  isLocalRequest(req) {
    return this.#hub.isLocalRequest(req);
  }

  registerPollingClient(hello, req = null) {
    return this.#hub.registerPollingClient(hello, req);
  }

  receivePollingPayload(clientId, payload = {}) {
    return this.#hub.receivePollingPayload(clientId, payload);
  }

  async pollClient(clientId, req = null, timeoutMs = undefined) {
    return await this.#hub.poll(clientId, req, timeoutMs);
  }

  listKnownArtifacts() {
    return Array.from(this.#artifacts.values());
  }

  cancelActive(reason = 'Cancelled by user') {
    const pending = Array.from(this.#pending.values());
    for (const state of pending) {
      this.#cancelState(state, reason);
    }
    return pending.length;
  }

  async sendToChatGPT(message, callbacks = {}, options = {}) {
    const response = await this.sendRequest({ message, ...options, fullResponse: true }, callbacks, options);
    return options.fullResponse ? response : response.answer;
  }

  async sendRequest(request, callbacks = {}, options = {}) {
    return this.#mutex.runExclusive(async () => {
      if (options.signal?.aborted) throw abortError(options.signal.reason || 'Request cancelled');

      const requestId = request.requestId || makeRequestId();
      const normalizedCallbacks = noopCallbacks(callbacks);
      const started = Date.now();
      const message = String(request.message || '');
      const safePreview = message.slice(0, 120).replaceAll('\n', '\\n');
      const attachments = await this.#resolveAttachments(request.attachments || request.fileIds || []);
      const chatOptions = normalizeOptions({ ...request, attachments });
      log(`Incoming prompt ${requestId}: ${JSON.stringify(safePreview)} attachments=${attachments.length}`);

      return await new Promise((resolve, reject) => {
        const state = {
          requestId,
          clientId: null,
          resolve,
          reject,
          callbacks: normalizedCallbacks,
          answer: '',
          thinking: '',
          artifacts: [],
          session: null,
          model: chatOptions.model,
          effort: chatOptions.effort,
          events: [],
          timer: null,
          accepted: false,
          delivered: false,
          done: false,
          lastActivityAt: started,
          lastActivityReason: 'request.started',
          abortSignal: options.signal || null,
          abortHandler: null,
        };

        const startedEvent = makeEvent('request.started', {
          requestId,
          model: chatOptions.model || undefined,
          effort: chatOptions.effort || undefined,
          sessionId: chatOptions.sessionId || undefined,
          newSession: chatOptions.newSession || undefined,
          attachments: attachments.map(({ contentBase64, ...attachment }) => attachment),
        });
        this.#emitRequestEvent(state, startedEvent);

        this.#touchState(state, 'request.started');

        if (state.abortSignal) {
          state.abortHandler = () => {
            this.#cancelState(state, String(state.abortSignal.reason || 'Request cancelled'));
          };
          state.abortSignal.addEventListener('abort', state.abortHandler, { once: true });
        }

        try {
          this.#pending.set(requestId, state);
          this.#eventBus?.emitDebug({ type: 'protocol.out.prompt.send', requestId, data: { requestId, messageLength: message.length, attachments: attachments.map(({ contentBase64, ...rest }) => rest), model: chatOptions.model, effort: chatOptions.effort, sessionId: chatOptions.sessionId } });
          const promptPayload = {
            type: 'prompt.send',
            requestId,
            message,
            options: chatOptions,
            attachments,
          };
          const { client, delivered } = typeof this.#hub.sendToActiveWithDelivery === 'function'
            ? this.#hub.sendToActiveWithDelivery(promptPayload, { timeoutMs: config.promptDeliveryTimeoutMs })
            : { client: this.#hub.sendToActive(promptPayload), delivered: Promise.resolve() };
          state.clientId = client.id;
          delivered.then(() => {
            if (state.done) return;
            state.delivered = true;
            this.#emitRequestEvent(state, makeEvent('prompt.delivered', { requestId, clientId: client.id }));
          }).catch((err) => {
            if (state.done) return;
            this.#finish(state, new Error(err.message || `Timed out delivering prompt to ${client.id}`));
          });
        } catch (err) {
          this.#cleanupState(state);
          this.#pending.delete(requestId);
          reject(err);
        }
      }).then((response) => {
        const elapsedSec = (Date.now() - started) / 1000;
        const answerPreview = response.answer.slice(0, 120).replaceAll('\n', '\\n');
        log(`Answer ${requestId} received in ${elapsedSec.toFixed(2)}s: ${JSON.stringify(answerPreview)}`);
        return response;
      });
    });
  }

  async listSessions(options = {}) {
    const response = await this.#sendCommand('sessions.list', {}, options);
    return response.sessions || [];
  }

  async newSession(options = {}) {
    return await this.#sendCommand('sessions.new', {}, options);
  }

  async selectSession(sessionId, options = {}) {
    if (!sessionId) throw new Error('No sessionId provided');
    return await this.#sendCommand('sessions.select', { sessionId }, options);
  }

  async listModels(options = {}) {
    const response = await this.#sendCommand('models.list', {}, options);
    return { models: response.models || [], current: response.current || null };
  }

  async listEfforts(options = {}) {
    const response = await this.#sendCommand('efforts.list', {}, options);
    return { efforts: response.efforts || [], current: response.current || null };
  }

  async clearComposerAttachments(options = {}) {
    return await this.#sendCommand('composer.attachments.clear', {}, options);
  }

  #normalizeRecoveredResponse(response = {}, options = {}) {
    const artifacts = Array.isArray(response.artifacts) ? response.artifacts.map((artifact) => ({ ...artifact, requestId: options.requestId || response.requestId || 'recovered' })) : [];
    for (const artifact of artifacts) {
      if (artifact.id) this.#artifacts.set(artifact.id, artifact);
    }
    return {
      id: options.requestId || response.requestId || makeRequestId(),
      requestId: options.requestId || response.requestId || '',
      answer: String(response.answer || ''),
      response: String(response.answer || ''),
      thinking: String(response.thinking || ''),
      artifacts,
      session: response.session || null,
      url: response.url || '',
      title: response.title || '',
      finishReason: 'recovered',
      recovered: true,
      recoveredAt: response.recoveredAt || new Date().toISOString(),
      source: response.source || 'latest-assistant-turn',
      format: response.format || '',
      reason: response.reason || '',
      turnKey: response.turnKey || '',
      turnIndex: response.turnIndex ?? -1,
      candidateIndex: response.candidateIndex ?? options.index ?? 1,
      events: [],
      createdAt: new Date().toISOString(),
    };
  }

  async recoverResponses(options = {}) {
    const limit = Math.max(1, Math.min(10, Number(options.limit) || 5));
    const response = await this.#sendCommand('response.recover.list', { limit }, { ...options, timeoutMs: options.timeoutMs || 30_000 });
    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    return candidates.map((candidate, index) => this.#normalizeRecoveredResponse({ ...candidate, candidateIndex: index + 1, session: response.session || candidate.session, url: response.url || candidate.url, title: response.title || candidate.title }, options));
  }

  async recoverLatestResponse(options = {}) {
    const index = Math.max(1, Number(options.index) || 1);
    const response = await this.#sendCommand('response.recover.latest', { index, limit: Math.max(index, Number(options.limit) || 5) }, { ...options, timeoutMs: options.timeoutMs || 30_000 });
    return this.#normalizeRecoveredResponse(response, { ...options, index });
  }

  async fetchArtifact(artifactId, options = {}) {
    const artifact = this.#artifacts.get(artifactId);
    if (!artifact) throw new Error(`Unknown artifact: ${artifactId}`);

    if (artifact.storedFileId && this.#fileStore && !options.force) {
      const existing = await this.#fileStore.getReadable(artifact.storedFileId).catch(() => null);
      if (existing?.absolutePath) {
        const stat = await fs.stat(existing.absolutePath).catch(() => null);
        if (stat?.isFile()) return existing;
      }
    }

    this.#eventBus?.emitUser({ type: 'artifact.download.started', data: { artifactId, name: artifact.name || '', kind: artifact.kind || '' } });
    const response = await this.#sendCommand('artifact.fetch', { artifact: { ...artifact, chunkSize: 256 * 1024 } }, { ...options, timeoutMs: options.timeoutMs || config.artifactChunkTimeoutMs });

    if (response.filePath) {
      const resolvedFilePath = await resolveBrowserDownloadedPath(response.filePath, response.name || artifact.name || artifactId);
      const resolvedName = path.basename(resolvedFilePath) || response.name || artifact.name || artifactId;
      if (resolvedFilePath !== path.resolve(response.filePath)) {
        this.#eventBus?.emitUser({ type: 'artifact.download.renamed', data: { artifactId, requestedPath: response.filePath, resolvedPath: resolvedFilePath } });
      }
      if (!this.#fileStore) {
        return {
          id: artifactId,
          name: resolvedName,
          mime: response.mime || artifact.mime || 'application/octet-stream',
          filePath: resolvedFilePath,
          requestedFilePath: response.filePath,
          size: response.size || 0,
        };
      }
      const storedFromPath = await this.#fileStore.importArtifactPath({
        artifactId,
        filePath: resolvedFilePath,
        name: resolvedName,
        mime: response.mime || artifact.mime || 'application/octet-stream',
        source: { url: artifact.url || artifact.src || artifact.downloadUrl || '', requestId: artifact.requestId || '', browserDownloadPath: resolvedFilePath, requestedBrowserDownloadPath: response.filePath },
        metadata: artifact,
        removeSource: true,
      });
      artifact.storedFileId = storedFromPath.id;
      this.#artifacts.set(artifactId, { ...artifact, storedFileId: storedFromPath.id });
      this.#eventBus?.emitUser({ type: 'artifact.download.done', data: { artifactId, fileId: storedFromPath.id, name: storedFromPath.name, size: storedFromPath.size, source: 'browser-download' } });
      return storedFromPath;
    }

    if (!response.contentBase64) throw new Error(`Artifact did not return downloadable content or file path: ${artifactId}`);

    if (!this.#fileStore) {
      return {
        id: artifactId,
        name: response.name || artifact.name || artifactId,
        mime: response.mime || artifact.mime || 'application/octet-stream',
        contentBase64: response.contentBase64,
      };
    }

    const stored = await this.#fileStore.putArtifact({
      artifactId,
      name: response.name || artifact.name || artifactId,
      mime: response.mime || artifact.mime || 'application/octet-stream',
      contentBase64: response.contentBase64,
      source: { url: artifact.url || artifact.src || artifact.downloadUrl || '', requestId: artifact.requestId || '' },
      metadata: artifact,
    });
    artifact.storedFileId = stored.id;
    this.#artifacts.set(artifactId, { ...artifact, storedFileId: stored.id });
    this.#eventBus?.emitUser({ type: 'artifact.download.done', data: { artifactId, fileId: stored.id, name: stored.name, size: stored.size } });
    return stored;
  }

  async close() {
    for (const state of this.#pending.values()) {
      this.#cancelState(state, 'Bridge shutting down');
    }
    this.#pending.clear();

    for (const command of this.#commands.values()) {
      clearTimeout(command.timer);
      command.reject(new Error('Bridge shutting down'));
    }
    this.#commands.clear();
  }

  async #resolveAttachments(rawAttachments) {
    const result = [];
    for (const raw of rawAttachments) {
      if (!raw) continue;
      if (typeof raw === 'string') {
        if (!this.#fileStore) throw new Error('FileStore is not configured');
        result.push(await this.#readAttachmentForTransport(raw));
        continue;
      }

      if (typeof raw === 'object') {
        const fileId = raw.fileId || raw.id;
        if (fileId && !raw.contentBase64 && !raw.content && this.#fileStore) {
          result.push(await this.#readAttachmentForTransport(fileId));
          continue;
        }
        if (raw.url && !raw.contentBase64 && !raw.content) {
          result.push({
            id: raw.id || raw.fileId || `url_${makeRequestId()}`,
            name: raw.name || 'attachment',
            mime: raw.mime || raw.type || 'application/octet-stream',
            size: raw.size || 0,
            url: raw.url,
          });
          continue;
        }
        if (raw.contentBase64 || raw.content) {
          result.push({
            id: raw.id || raw.fileId || `inline_${makeRequestId()}`,
            name: raw.name || 'attachment',
            mime: raw.mime || raw.type || 'application/octet-stream',
            contentBase64: raw.contentBase64 || Buffer.from(String(raw.content || ''), 'utf8').toString('base64'),
          });
        }
      }
    }
    return result;
  }

  async #readAttachmentForTransport(fileId) {
    const record = await this.#fileStore.get(fileId);
    if (!record) throw new Error(`File not found: ${fileId}`);
    if (config.attachmentTransport === 'base64') return await this.#fileStore.readForTransport(fileId);
    const url = new URL(`/tm/files/${encodeURIComponent(fileId)}/download`, config.publicBaseUrl);
    url.searchParams.set('token', config.bridgeToken);
    return {
      id: record.id,
      name: record.name,
      mime: record.mime || 'application/octet-stream',
      size: record.size,
      url: url.toString(),
    };
  }

  #handleClientMessage(clientId, payload) {
    const commandId = payload?.commandId;
    if (commandId && this.#commands.has(commandId)) {
      this.#handleCommandResponse(clientId, payload);
      return;
    }

    const requestId = payload?.requestId;
    if (!requestId) return;

    const state = this.#pending.get(requestId);
    if (!state || (state.clientId && state.clientId !== clientId)) return;

    this.#touchState(state, payload.type || 'client.message');

    if (payload.type === 'prompt.accepted') {
      this.#markPromptAccepted(state, payload);
      return;
    }

    if (!state.accepted) this.#markPromptAccepted(state, payload, { implicit: true });

    if (payload.type === 'chat.event') {
      this.#emitRequestEvent(state, payload.event || makeEvent('event', { requestId, payload }));
      return;
    }

    if (payload.type === 'status') {
      state.callbacks.onStatus?.(payload.status || 'status', payload);
      this.#emitRequestEvent(state, makeEvent(`status.${payload.status || 'unknown'}`, { requestId, payload }));
      return;
    }

    if (payload.type === 'thinking.delta') {
      const delta = String(payload.delta || '');
      if (!delta) return;
      state.thinking += delta;
      state.callbacks.onThinkingUpdate?.(state.thinking, payload);
      this.#emitRequestEvent(state, makeEvent('thinking.delta', { requestId, delta, thinking: state.thinking }));
      return;
    }

    if (payload.type === 'thinking.snapshot') {
      const text = String(payload.text || '');
      if (!text || text === state.thinking) return;
      const delta = appendOnlyDelta(state.thinking, text);
      state.thinking = text;
      if (delta) state.callbacks.onThinkingUpdate?.(state.thinking, payload);
      this.#emitRequestEvent(state, makeEvent('thinking.snapshot', { requestId, text: state.thinking, delta }));
      return;
    }

    if (payload.type === 'answer.delta') {
      const delta = String(payload.delta || '');
      if (!delta) return;
      state.answer += delta;
      state.callbacks.onAnswerUpdate?.(state.answer, payload);
      this.#emitRequestEvent(state, makeEvent('answer.delta', { requestId, delta, answer: state.answer }));
      return;
    }

    if (payload.type === 'answer.snapshot') {
      const text = String(payload.text || '');
      if (!text || text === state.answer) return;

      const delta = appendOnlyDelta(state.answer, text);
      state.answer = text;
      if (delta) state.callbacks.onAnswerUpdate?.(state.answer, payload);
      this.#emitRequestEvent(state, makeEvent('answer.snapshot', { requestId, text: state.answer, delta }));
      return;
    }

    if (payload.type === 'artifact.snapshot') {
      const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
      const normalized = artifacts.map((artifact) => ({ ...artifact, requestId }));
      state.artifacts = normalized;
      for (const artifact of normalized) {
        if (artifact.id) this.#artifacts.set(artifact.id, artifact);
      }
      state.callbacks.onArtifactUpdate?.(normalized, payload);
      this.#emitRequestEvent(state, makeEvent('artifact.snapshot', { requestId, artifacts: normalized }));
      return;
    }

    if (payload.type === 'session.snapshot') {
      state.session = payload.session || null;
      this.#emitRequestEvent(state, makeEvent('session.snapshot', { requestId, session: state.session }));
      return;
    }

    if (payload.type === 'done') {
      const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts.map((artifact) => ({ ...artifact, requestId })) : state.artifacts;
      for (const artifact of artifacts) {
        if (artifact.id) this.#artifacts.set(artifact.id, artifact);
      }
      state.artifacts = artifacts;
      state.session = payload.session || state.session;
      this.#finish(state, null, String(payload.answer || state.answer || ''), {
        thinking: String(payload.thinking || state.thinking || ''),
        artifacts,
        session: state.session,
        url: payload.url,
        title: payload.title,
        finishReason: payload.finishReason || 'stop',
        turnKey: payload.turnKey || '',
        turnIndex: payload.turnIndex ?? -1,
        format: payload.format || '',
        reason: payload.reason || '',
      });
      return;
    }

    if (payload.type === 'error') {
      this.#finish(state, new Error(payload.message || 'Browser extension client error'));
    }
  }

  #handleClientActivity(clientId, client = null, payload = {}) {
    for (const state of this.#pending.values()) {
      if (state.done) continue;
      if (state.clientId && state.clientId !== clientId) continue;
      const activeRequest = client?.activeRequest || payload?.activeRequest || null;
      if (activeRequest?.requestId === state.requestId) {
        this.#touchState(state, 'client.activeRequest');
      }
    }
  }

  #handleCommandResponse(clientId, payload) {
    const command = this.#commands.get(payload.commandId);
    if (!command || (command.clientId && command.clientId !== clientId)) return;

    if (payload.type === 'artifact.data.started') {
      command.chunks = [];
      command.chunkMeta = {
        name: payload.name,
        mime: payload.mime,
        artifactId: payload.artifactId,
        totalChunks: payload.totalChunks,
        encodedSize: payload.encodedSize,
        filePath: payload.filePath || payload.filename || '',
        size: payload.size || 0,
      };
      this.#eventBus?.emitDebug({ type: 'protocol.in.artifact.data.started', data: { commandId: payload.commandId, artifactId: payload.artifactId, totalChunks: payload.totalChunks, encodedSize: payload.encodedSize } });
      return;
    }

    if (payload.type === 'artifact.data.chunk') {
      if (!command.chunks) command.chunks = [];
      command.chunks[Number(payload.index) || 0] = String(payload.contentBase64 || '');
      if ((Number(payload.index) || 0) % 10 === 0) {
        this.#eventBus?.emitDebug({ type: 'protocol.in.artifact.data.chunk', data: { commandId: payload.commandId, index: payload.index, totalChunks: payload.totalChunks, size: String(payload.contentBase64 || '').length } });
      }
      return;
    }

    if (payload.type === 'artifact.data.done') {
      clearTimeout(command.timer);
      this.#commands.delete(payload.commandId);
      const contentBase64 = (command.chunks || []).join('');
      command.resolve({
        type: 'artifact.data',
        commandId: payload.commandId,
        artifactId: payload.artifactId || command.chunkMeta?.artifactId,
        name: payload.name || command.chunkMeta?.name,
        mime: payload.mime || command.chunkMeta?.mime,
        contentBase64,
        encodedSize: contentBase64.length,
        filePath: payload.filePath || payload.filename || command.chunkMeta?.filePath || '',
        size: payload.size || command.chunkMeta?.size || 0,
      });
      return;
    }

    clearTimeout(command.timer);
    this.#commands.delete(payload.commandId);

    if (payload.type === 'command.error' || payload.error) {
      command.reject(new Error(payload.message || payload.error || 'Browser extension command failed'));
      return;
    }

    command.resolve(payload);
  }

  #sendCommand(type, payload = {}, options = {}) {
    if (options.signal?.aborted) throw abortError(options.signal.reason || 'Command cancelled');

    const commandId = options.commandId || makeRequestId();
    const timeoutMs = Number(options.timeoutMs) || 30_000;

    return new Promise((resolve, reject) => {
      let client;
      try {
        client = this.#hub.sendToActive({ type, commandId, ...payload });
      } catch (err) {
        reject(err);
        return;
      }

      const timer = setTimeout(() => {
        this.#commands.delete(commandId);
        reject(new Error(`Timed out waiting for ${type} response after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      const command = { commandId, clientId: client.id, resolve, reject, timer, chunks: null, chunkMeta: null };
      this.#commands.set(commandId, command);

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          if (!this.#commands.has(commandId)) return;
          clearTimeout(timer);
          this.#commands.delete(commandId);
          reject(abortError(String(options.signal.reason || 'Command cancelled')));
        }, { once: true });
      }
    });
  }

  #emitRequestEvent(state, event) {
    const normalized = event.time ? event : makeEvent(event.type || 'event', event);
    state.events.push(normalized);
    state.callbacks.onEvent?.(normalized);
    this.#eventBus?.emitUser({
      type: normalized.type || 'event',
      requestId: state.requestId,
      sessionId: normalized.sessionId || state.session?.id || '',
      data: normalized,
    });
  }

  #markPromptAccepted(state, payload = {}, options = {}) {
    if (!state || state.done || state.accepted) return false;
    state.accepted = true;
    state.callbacks.onStatus?.('accepted', payload);
    const event = { requestId: state.requestId };
    if (options.implicit) {
      event.implicit = true;
      event.via = payload.type || 'unknown';
    }
    this.#emitRequestEvent(state, makeEvent('prompt.accepted', event));
    return true;
  }


  #touchState(state, reason = 'activity') {
    if (!state || state.done) return;
    state.lastActivityAt = Date.now();
    state.lastActivityReason = reason || 'activity';
    this.#scheduleStateIdleTimer(state);
  }

  #scheduleStateIdleTimer(state) {
    if (!state || state.done) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (!state || state.done) return;
      const idleForMs = Date.now() - (state.lastActivityAt || 0);
      if (idleForMs < config.answerTimeoutMs) {
        this.#scheduleStateIdleTimer(state);
        return;
      }
      const reason = state.lastActivityReason ? `; last activity: ${state.lastActivityReason}` : '';
      this.#cancelState(state, `Timed out waiting for ChatGPT activity after ${config.answerTimeoutMs}ms${reason}`);
    }, config.answerTimeoutMs);
    state.timer.unref?.();
  }

  #cancelState(state, reason = 'Cancelled') {
    if (!state || state.done) return;

    try {
      if (state.clientId) {
        this.#hub.sendToClient(state.clientId, {
          type: 'prompt.cancel',
          requestId: state.requestId,
          reason,
        });
      }
    } catch {
      // The tab may already be gone. The local request still needs to finish.
    }

    this.#finish(state, abortError(reason), '', { finishReason: 'cancelled' });
  }

  #finish(state, err, answer = '', metadata = {}) {
    if (state.done) return;
    state.done = true;
    this.#cleanupState(state);
    this.#pending.delete(state.requestId);

    if (err) {
      this.#emitRequestEvent(state, makeEvent('request.error', { requestId: state.requestId, message: err.message }));
      state.reject(err);
      return;
    }

    const finalAnswer = answer || state.answer;
    state.answer = finalAnswer;
    state.thinking = metadata.thinking || state.thinking;
    const response = {
      id: state.requestId,
      requestId: state.requestId,
      answer: finalAnswer,
      response: finalAnswer,
      thinking: state.thinking,
      artifacts: metadata.artifacts || state.artifacts,
      session: metadata.session || state.session,
      model: state.model || undefined,
      effort: state.effort || undefined,
      url: metadata.url,
      title: metadata.title,
      finishReason: metadata.finishReason || 'stop',
      turnKey: metadata.turnKey || '',
      turnIndex: metadata.turnIndex ?? -1,
      format: metadata.format || '',
      reason: metadata.reason || '',
      events: state.events,
      createdAt: new Date().toISOString(),
    };
    this.#emitRequestEvent(state, makeEvent('request.done', {
      requestId: state.requestId,
      answerLength: finalAnswer.length,
      thinkingLength: state.thinking.length,
      artifacts: response.artifacts,
      session: response.session,
      finishReason: response.finishReason,
    }));
    response.events = state.events;
    state.resolve(response);
  }

  #cleanupState(state) {
    clearTimeout(state.timer);
    state.timer = null;

    if (state.abortSignal && state.abortHandler) {
      state.abortSignal.removeEventListener('abort', state.abortHandler);
      state.abortHandler = null;
    }
  }
}
