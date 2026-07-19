import path from 'node:path';
import fs from 'node:fs/promises';

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function safeFilename(value = '') {
  return String(value || 'artifact.bin').replace(/[\\/\0\r\n"]/g, '_').trim() || 'artifact.bin';
}

function filenameFromDisposition(value = '', fallback = 'artifact.bin') {
  const encoded = String(value).match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return safeFilename(decodeURIComponent(encoded)); } catch {}
  }
  const plain = String(value).match(/filename="?([^";]+)"?/i)?.[1];
  return safeFilename(plain || fallback);
}

function parseSseBlock(block = '') {
  let event = 'message';
  let id = '';
  const data = [];
  for (const line of String(block).split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim() || 'message';
    else if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  const raw = data.join('\n');
  let payload = raw;
  try { payload = JSON.parse(raw); } catch {}
  return { event, id, payload };
}

export class RemoteBrowserBridge {
  constructor({ baseUrl, token = '', fileStore, fetchImpl = fetch, reconnectDelayMs = 500, eventBus = null, cursorPath = '', cursorWriter = null } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    if (!this.baseUrl) throw new Error('RemoteBrowserBridge requires baseUrl');
    this.token = String(token || '');
    this.fileStore = fileStore;
    this.fetchImpl = fetchImpl;
    this.reconnectDelayMs = Math.max(100, Number(reconnectDelayMs) || 500);
    this.eventBus = eventBus;
    this.listeners = new Set();
    this.abortController = null;
    this.streamTask = null;
    this.closed = false;
    this.lastSequence = 0;
    this.streamEpoch = '';
    this.cursorPath = cursorPath ? path.resolve(cursorPath) : '';
    this.cursorWriter = typeof cursorWriter === 'function' ? cursorWriter : null;
    this.cursorReady = this.#loadCursor();
    this.streamGap = null;
    this.blocked = false;
    this.connected = false;
    this.connectionState = 'disconnected';
    this.upstreamServerInstanceId = '';
    this.lastEnqueuedEventId = '';
    this.gapListeners = new Set();
    this.readyWaiters = [];
  }

  onObservedTurn(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    this.#ensureStream();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.#stopStream();
    };
  }

  onStreamGap(listener) {
    if (typeof listener !== 'function') return () => {};
    this.gapListeners.add(listener);
    void this.cursorReady.then(() => { if (this.blocked && this.streamGap && this.gapListeners.has(listener)) return listener({ ...this.streamGap }); }).catch(() => null);
    return () => this.gapListeners.delete(listener);
  }

  registerObservedArtifacts(artifacts = []) {
    return Array.isArray(artifacts) ? artifacts.map((artifact) => ({ ...artifact })) : [];
  }

  async waitUntilConnected(timeoutMs = 15_000) {
    if (this.connected) return true;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((waiter) => waiter.resolve !== resolve);
        reject(new Error(`Timed out connecting workflow worker to upstream bridge after ${timeoutMs}ms`));
      }, Math.max(1, Number(timeoutMs) || 15_000));
      timer.unref?.();
      this.readyWaiters.push({
        resolve: () => { clearTimeout(timer); resolve(true); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  health() {
    return {
      ok: this.connected,
      transport: 'remote-observed-turn-sse',
      upstream: this.baseUrl,
      upstreamServerInstanceId: this.upstreamServerInstanceId,
      streamEpoch: this.streamEpoch,
      lastSequence: this.lastSequence,
      lastEnqueuedEventId: this.lastEnqueuedEventId,
      connectionState: this.connectionState,
      streamGap: this.streamGap,
      blocked: this.blocked,
      listeners: this.listeners.size,
    };
  }

  async fetchArtifact(artifactId, options = {}) {
    if (!this.fileStore) throw new Error('RemoteBrowserBridge requires FileStore to fetch artifacts');
    const response = await this.#fetch(`/artifacts/${encodeURIComponent(artifactId)}/download`, {
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`Upstream artifact download failed (${response.status}): ${await response.text()}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const fallback = `${artifactId}${contentType.includes('zip') ? '.zip' : ''}`;
    const name = filenameFromDisposition(response.headers.get('content-disposition') || '', fallback);
    return await this.fileStore.putArtifact({
      artifactId,
      name,
      mime: contentType,
      contentBase64: buffer.toString('base64'),
      source: { type: 'remote-bridge', upstream: this.baseUrl, sourceClientId: options.sourceClientId || '' },
      metadata: { upstreamArtifactId: artifactId, extension: path.extname(name) },
    });
  }

  async submitPassivePrompt(options = {}) {
    const response = await this.#json('/browser/passive-prompt', {
      method: 'POST',
      body: options,
      timeoutMs: options.timeoutMs,
    });
    return response.result || response;
  }

  async recoverLatestResponse(options = {}) {
    const response = await this.#json('/browser/recover-latest', {
      method: 'POST',
      body: options,
      timeoutMs: options.timeoutMs,
    });
    return response.result || response;
  }

  async reloadExtension(options = {}) {
    return await this.#json('/browser/extension/reload', { method: 'POST', body: options, timeoutMs: options.timeoutMs });
  }

  async close() {
    this.closed = true;
    this.listeners.clear();
    this.#stopStream();
    await this.streamTask?.catch(() => null);
  }

  async resyncFromRetained() {
    if (!this.streamGap) return false;
    await this.#commitCursor({
      streamEpoch: String(this.streamGap.streamEpoch || ''),
      lastSequence: Math.max(0, Number(this.streamGap.retainedFromSequence) - 1 || 0),
      lastEnqueuedEventId: '',
      streamGap: null,
      blocked: false,
      connectionState: 'reconnecting',
    });
    this.#ensureStream();
    return true;
  }

  async #loadCursor() {
    if (!this.cursorPath) return;
    try {
      const parsed = JSON.parse(await fs.readFile(this.cursorPath, 'utf8'));
      this.upstreamServerInstanceId = String(parsed.upstreamServerInstanceId || '');
      this.streamEpoch = String(parsed.streamEpoch || '');
      this.lastSequence = Math.max(0, Number(parsed.lastSequence) || 0);
      this.lastEnqueuedEventId = String(parsed.lastEnqueuedEventId || '');
      this.blocked = Boolean(parsed.blocked);
      this.streamGap = parsed.streamGap && typeof parsed.streamGap === 'object' ? parsed.streamGap : null;
      this.connectionState = String(parsed.connectionState || (this.blocked ? 'blocked' : 'disconnected'));
    } catch (error) {
      if (error?.code !== 'ENOENT') this.eventBus?.emitDebug?.({ type: 'workflow.remote_observer.cursor_load_failed', data: { message: error.message || String(error) } });
    }
  }

  #cursorSnapshot(overrides = {}) {
    return {
      upstreamServerInstanceId: this.upstreamServerInstanceId,
      streamEpoch: this.streamEpoch,
      lastSequence: this.lastSequence,
      lastEnqueuedEventId: this.lastEnqueuedEventId,
      blocked: this.blocked,
      streamGap: this.streamGap,
      connectionState: this.connectionState,
      ...overrides,
    };
  }

  async #persistCursor(snapshot = this.#cursorSnapshot()) {
    if (this.cursorWriter) {
      await this.cursorWriter({ ...snapshot }, { cursorPath: this.cursorPath });
      return;
    }
    if (!this.cursorPath) return;
    await fs.mkdir(path.dirname(this.cursorPath), { recursive: true });
    const temp = `${this.cursorPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temp, `${JSON.stringify(snapshot, null, 2)}
`, 'utf8');
    await fs.rename(temp, this.cursorPath);
  }

  async #commitCursor(patch = {}) {
    const next = this.#cursorSnapshot(patch);
    await this.#persistCursor(next);
    this.upstreamServerInstanceId = String(next.upstreamServerInstanceId || '');
    this.streamEpoch = String(next.streamEpoch || '');
    this.lastSequence = Math.max(0, Number(next.lastSequence) || 0);
    this.lastEnqueuedEventId = String(next.lastEnqueuedEventId || '');
    this.blocked = Boolean(next.blocked);
    this.streamGap = next.streamGap && typeof next.streamGap === 'object' ? next.streamGap : null;
    this.connectionState = String(next.connectionState || (this.blocked ? 'blocked' : 'disconnected'));
  }

  #headers(extra = {}) {
    return {
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  async #fetch(pathname, options = {}) {
    return await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      ...options,
      headers: this.#headers(options.headers || {}),
      cache: 'no-store',
    });
  }

  async #json(pathname, { method = 'GET', body, timeoutMs = 30_000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Upstream request timed out: ${method} ${pathname}`)), Math.max(1, Number(timeoutMs) || 30_000));
    timer.unref?.();
    try {
      const response = await this.#fetch(pathname, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Upstream request failed (${response.status}) ${method} ${pathname}: ${await response.text()}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  #ensureStream() {
    if (this.closed || this.blocked || this.streamTask || !this.listeners.size) return;
    this.abortController = new AbortController();
    this.streamTask = this.cursorReady.then(() => this.#runStream(this.abortController.signal)).finally(() => {
      this.streamTask = null;
      this.abortController = null;
      if (!this.closed && !this.blocked && this.listeners.size) setTimeout(() => this.#ensureStream(), this.reconnectDelayMs).unref?.();
    });
  }

  #stopStream() {
    this.abortController?.abort();
    this.abortController = null;
    this.connected = false;
    this.connectionState = this.blocked ? 'blocked' : 'disconnected';
  }

  #markConnected() {
    this.connected = true;
    this.connectionState = 'connected';
    for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
  }

  async #runStream(signal) {
    while (!this.closed && this.listeners.size && !signal.aborted) {
      try {
        const params = new URLSearchParams({ after: String(this.lastSequence) });
        if (this.streamEpoch) params.set('epoch', this.streamEpoch);
        const response = await this.#fetch(`/browser/observed-turns/stream?${params}`, {
          headers: { Accept: 'text/event-stream', ...(this.streamEpoch ? { 'Last-Event-ID': `${this.streamEpoch}:${this.lastSequence}` } : {}) },
          signal,
        });
        if (!response.ok) throw new Error(`Observed-turn stream failed (${response.status}): ${await response.text()}`);
        if (!response.body) throw new Error('Observed-turn stream returned no body');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          while (true) {
            const separator = buffer.search(/\r?\n\r?\n/);
            if (separator < 0) break;
            const delimiter = buffer.slice(separator).match(/^\r?\n\r?\n/)?.[0] || '\n\n';
            const parsed = parseSseBlock(buffer.slice(0, separator));
            buffer = buffer.slice(separator + delimiter.length);
            if (!parsed) continue;
            if (parsed.event === 'stream.reset') {
              await this.#commitCursor({
                streamEpoch: String(parsed.payload?.streamEpoch || ''),
                lastSequence: 0,
                lastEnqueuedEventId: '',
              });
              continue;
            }
            if (parsed.event === 'stream.gap') {
              const streamGap = parsed.payload || {};
              await this.#commitCursor({
                streamGap,
                blocked: true,
                connectionState: 'blocked',
                upstreamServerInstanceId: String(streamGap.serverInstanceId || this.upstreamServerInstanceId || ''),
              });
              this.connected = false;
              const error = new Error(`Observed-turn stream gap: retained from ${this.streamGap.retainedFromSequence}, cursor ${this.streamGap.afterSequence}`);
              error.code = 'OBSERVED_TURN_STREAM_GAP';
              for (const waiter of this.readyWaiters.splice(0)) waiter.reject(error);
              this.eventBus?.emitUser?.({ type: 'workflow.remote_observer.gap', data: this.streamGap });
              for (const listener of this.gapListeners) await listener({ ...this.streamGap });
              return;
            }
            if (parsed.event === 'ready') {
              const readyEpoch = String(parsed.payload?.streamEpoch || '');
              const serverInstanceId = String(parsed.payload?.serverInstanceId || '');
              const epochChanged = Boolean(readyEpoch && this.streamEpoch && readyEpoch !== this.streamEpoch);
              await this.#commitCursor({
                upstreamServerInstanceId: serverInstanceId || this.upstreamServerInstanceId,
                streamEpoch: readyEpoch || this.streamEpoch,
                lastSequence: epochChanged ? 0 : this.lastSequence,
                lastEnqueuedEventId: epochChanged ? '' : this.lastEnqueuedEventId,
                connectionState: 'connected',
              });
              this.#markConnected();
              continue;
            }
            if (parsed.event !== 'observed_turn') continue;
            const envelope = parsed.payload || {};
            const epoch = String(envelope.streamEpoch || this.streamEpoch || '');
            const sequence = Number(envelope.sequence) || Number(String(parsed.id).split(':').at(-1)) || 0;
            if (this.streamEpoch && epoch !== this.streamEpoch) continue;
            if (sequence <= this.lastSequence) continue;
            const turn = envelope.turn || envelope;
            for (const listener of this.listeners) {
              await listener(turn, { streamEpoch: epoch, sequence, serverInstanceId: this.upstreamServerInstanceId });
            }
            await this.#commitCursor({
              streamEpoch: epoch,
              lastSequence: sequence,
              lastEnqueuedEventId: `${epoch}:${sequence}`,
            });
          }
        }
      } catch (error) {
        if (signal.aborted || this.closed) return;
        this.connected = false;
        this.connectionState = 'disconnected';
        await this.#persistCursor().catch(() => null);
        this.eventBus?.emitDebug?.({ type: 'workflow.remote_observer.disconnected', data: { upstream: this.baseUrl, message: error.message || String(error) } });
        await sleep(this.reconnectDelayMs);
      }
    }
  }
}
