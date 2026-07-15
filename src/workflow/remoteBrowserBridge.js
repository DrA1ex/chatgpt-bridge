import path from 'node:path';

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
  constructor({ baseUrl, token = '', fileStore, fetchImpl = fetch, reconnectDelayMs = 500, eventBus = null } = {}) {
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
    this.connected = false;
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
      lastSequence: this.lastSequence,
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
    if (this.closed || this.streamTask || !this.listeners.size) return;
    this.abortController = new AbortController();
    this.streamTask = this.#runStream(this.abortController.signal).finally(() => {
      this.streamTask = null;
      this.abortController = null;
      if (!this.closed && this.listeners.size) setTimeout(() => this.#ensureStream(), this.reconnectDelayMs).unref?.();
    });
  }

  #stopStream() {
    this.abortController?.abort();
    this.abortController = null;
    this.connected = false;
  }

  #markConnected() {
    this.connected = true;
    for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
  }

  async #runStream(signal) {
    while (!this.closed && this.listeners.size && !signal.aborted) {
      try {
        const response = await this.#fetch(`/browser/observed-turns/stream?after=${this.lastSequence}`, {
          headers: { Accept: 'text/event-stream', ...(this.lastSequence ? { 'Last-Event-ID': String(this.lastSequence) } : {}) },
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
            if (parsed.event === 'ready') {
              this.#markConnected();
              continue;
            }
            if (parsed.event !== 'observed_turn') continue;
            const envelope = parsed.payload || {};
            const sequence = Math.max(Number(parsed.id) || 0, Number(envelope.sequence) || 0);
            if (sequence <= this.lastSequence) continue;
            this.lastSequence = sequence;
            const turn = envelope.turn || envelope;
            for (const listener of this.listeners) {
              try { listener(turn); } catch (error) {
                this.eventBus?.emitDebug?.({ type: 'workflow.remote_observer.listener_failed', data: { message: error.message || String(error) } });
              }
            }
          }
        }
      } catch (error) {
        if (signal.aborted || this.closed) return;
        this.connected = false;
        this.eventBus?.emitDebug?.({ type: 'workflow.remote_observer.disconnected', data: { upstream: this.baseUrl, message: error.message || String(error) } });
        await sleep(this.reconnectDelayMs);
      }
    }
  }
}
