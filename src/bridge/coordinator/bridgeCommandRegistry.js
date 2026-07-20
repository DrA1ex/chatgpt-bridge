import { makeRequestId } from '../../protocol.js';
import { abortError } from '../requestState.js';


function commandModeForType(type = '') {
  if (type === 'prompt.steer' || type === 'prompt.cancel') return 'effect';
  if (type === 'request.release') return 'release';
  return 'result';
}

function isEffectTerminalPayload(payload = {}) {
  return payload?.type === 'request.effect.succeeded'
    || payload?.type === 'request.effect.failed'
    || payload?.type === 'request.effect.uncertain'
    || payload?.type === 'request.effect.cancelled';
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * Owns server-to-extension command correlation.
 *
 * Request lease identity is supplied by the canonical request state. The Hub
 * does not create, cache, validate, or release leases. Standalone commands are
 * sent without a request envelope and therefore cannot become browser
 * requests accidentally.
 */
export class BridgeCommandRegistry {
  constructor({ hub, eventBus = null }) {
    this.hub = hub;
    this.eventBus = eventBus;
    this.commands = new Map();
    this.releaseBarriers = new Map();
  }

  get size() { return this.commands.size; }
  has(commandId) { return this.commands.has(commandId); }

  handleResponse(clientId, payload) {
    const command = this.commands.get(payload.commandId);
    if (!command || (command.clientId && command.clientId !== clientId)) return false;

    if (command.mode === 'release' && (payload.type === 'lease.released' || payload.type === 'lease.quarantined')) {
      this.#remove(payload.commandId);
      if (payload.type === 'lease.quarantined') {
        const error = new Error(payload.message || payload.reason || 'Browser tab release could not be proven');
        error.code = String(payload.code || 'BROWSER_TAB_QUARANTINED');
        error.retryable = false;
        error.recoverable = true;
        error.quarantined = true;
        command.reject(error);
      } else {
        command.resolve({
          ...payload,
          released: true,
          sourceClientId: payload.sourceClientId || command.sourceClientId || command.clientId,
          commandClientId: command.clientId,
        });
      }
      return true;
    }

    if (command.mode === 'release') return false;

    if (command.mode === 'effect' && isEffectTerminalPayload(payload)) {
      this.#remove(payload.commandId);
      if (payload.type === 'request.effect.succeeded') {
        const physicalResult = payload.result && typeof payload.result === 'object' ? payload.result : {};
        command.resolve({
          ...payload,
          ...physicalResult,
          type: payload.effectType || command.requestType,
          sourceClientId: payload.sourceClientId || command.sourceClientId || command.clientId,
          commandClientId: command.clientId,
        });
        return true;
      }
      const uncertain = payload.type === 'request.effect.uncertain';
      const cancelled = payload.type === 'request.effect.cancelled';
      const error = new Error(payload.message || payload.error?.message || `${command.requestType} browser effect did not succeed`);
      error.code = String(payload.code || payload.error?.code || (uncertain ? 'BROWSER_EFFECT_UNCERTAIN' : cancelled ? 'BROWSER_EFFECT_CANCELLED' : 'BROWSER_EFFECT_FAILED'));
      error.retryable = Boolean(payload.retryable || uncertain);
      error.recoverable = Boolean(payload.recoverable || uncertain);
      error.uncertain = uncertain;
      error.cancelled = cancelled;
      error.evidence = payload.evidence && typeof payload.evidence === 'object' ? payload.evidence : null;
      command.reject(error);
      return true;
    }

    if (command.mode === 'effect' && payload.type !== 'command.error' && payload.type !== 'command.rejected') {
      return false;
    }

    const resultType = payload.type === 'command.result'
      ? String(payload.resultType || '')
      : payload.type === 'command.progress'
        ? String(payload.progressType || '')
        : '';
    const result = resultType ? { ...payload, type: resultType } : payload;

    if (result.type === 'artifact.data.started') {
      command.chunks = [];
      command.chunkMeta = {
        name: result.name,
        mime: result.mime,
        artifactId: result.artifactId,
        totalChunks: result.totalChunks,
        encodedSize: result.encodedSize,
        filePath: result.filePath || result.filename || '',
        size: result.size || 0,
        downloadId: result.downloadId ?? null,
        browserDownloadStartTime: result.browserDownloadStartTime || '',
        browserDownloadEndTime: result.browserDownloadEndTime || '',
        browserCaptureStartedAt: result.browserCaptureStartedAt || 0,
        browserCapturedAt: result.browserCapturedAt || 0,
        browserExpectedNames: Array.isArray(result.browserExpectedNames) ? result.browserExpectedNames : [],
        captureSource: result.captureSource || '',
      };
      this.eventBus?.emitDebug({ type: 'protocol.in.artifact.data.started', data: { commandId: result.commandId, artifactId: result.artifactId, totalChunks: result.totalChunks, encodedSize: result.encodedSize } });
      return true;
    }

    if (result.type === 'artifact.data.chunk') {
      if (!command.chunks) command.chunks = [];
      command.chunks[Number(result.index) || 0] = String(result.contentBase64 || '');
      if ((Number(result.index) || 0) % 10 === 0) {
        this.eventBus?.emitDebug({ type: 'protocol.in.artifact.data.chunk', data: { commandId: result.commandId, index: result.index, totalChunks: result.totalChunks, size: String(result.contentBase64 || '').length } });
      }
      return true;
    }

    if (payload.type === 'command.progress') {
      this.eventBus?.emitDebug({
        type: 'protocol.in.command.progress',
        data: { commandId: result.commandId, requestType: command.requestType, progressType: result.type },
      });
      return true;
    }

    if (result.type === 'artifact.data.done') {
      this.#remove(result.commandId);
      const contentBase64 = (command.chunks && command.chunks.length ? command.chunks.join('') : String(result.contentBase64 || ''));
      command.resolve({
        type: 'artifact.data',
        sourceClientId: result.sourceClientId || command.sourceClientId || command.clientId,
        commandClientId: command.clientId,
        commandId: result.commandId,
        artifactId: result.artifactId || command.chunkMeta?.artifactId,
        name: result.name || command.chunkMeta?.name,
        mime: result.mime || command.chunkMeta?.mime,
        contentBase64,
        encodedSize: contentBase64.length,
        filePath: result.filePath || result.filename || command.chunkMeta?.filePath || '',
        size: result.size || command.chunkMeta?.size || 0,
        captureSource: result.captureSource || command.chunkMeta?.captureSource || '',
        downloadId: result.downloadId ?? command.chunkMeta?.downloadId ?? null,
        browserDownloadStartTime: result.browserDownloadStartTime || command.chunkMeta?.browserDownloadStartTime || '',
        browserDownloadEndTime: result.browserDownloadEndTime || command.chunkMeta?.browserDownloadEndTime || '',
        browserCaptureStartedAt: result.browserCaptureStartedAt || command.chunkMeta?.browserCaptureStartedAt || 0,
        browserCapturedAt: result.browserCapturedAt || command.chunkMeta?.browserCapturedAt || 0,
        browserExpectedNames: Array.isArray(result.browserExpectedNames) ? result.browserExpectedNames : command.chunkMeta?.browserExpectedNames || [],
      });
      return true;
    }

    this.#remove(result.commandId);
    if (result.type === 'command.error' || result.type === 'lease.quarantined' || result.error) {
      const error = new Error(result.message || result.error || 'Browser extension command failed');
      error.code = String(result.code || 'BROWSER_COMMAND_FAILED');
      error.retryable = Boolean(result.retryable || result.uncertain);
      error.recoverable = Boolean(result.recoverable || result.uncertain);
      error.uncertain = Boolean(result.uncertain);
      error.evidence = result.evidence && typeof result.evidence === 'object' ? result.evidence : null;
      command.reject(error);
      return true;
    }
    command.resolve({ ...result, sourceClientId: result.sourceClientId || command.sourceClientId || command.clientId, commandClientId: command.clientId });
    return true;
  }

  async send(type, payload = {}, options = {}) {
    if (options.signal?.aborted) throw abortError(options.signal.reason || 'Command cancelled');

    const commandId = options.commandId || makeRequestId();
    const timeoutMs = Number(options.timeoutMs) || 30_000;
    const sourceClientId = String(options.sourceClientId || options.clientId || payload.sourceClientId || '');
    if (type !== 'request.release' && type !== 'command.cancel') {
      await this.waitForReleaseBarrier(sourceClientId, timeoutMs);
    }

    const dispatch = () => new Promise((resolve, reject) => {
      const command = {
        commandId,
        requestType: type,
        mode: commandModeForType(type),
        clientId: '',
        resolve,
        reject,
        timer: null,
        chunks: null,
        chunkMeta: null,
        sourceClientId,
        request: options.request || null,
      };
      const timer = setTimeout(() => {
        if (!this.commands.has(commandId)) return;
        const error = new Error(`Timed out waiting for ${type} response after ${timeoutMs}ms`);
        void this.#cancelBeforeReject(command, error, 'server_command_timeout');
      }, timeoutMs);
      timer.unref?.();
      command.timer = timer;
      this.commands.set(commandId, command);

      try {
        const commandPayload = { type, commandId, ...payload };
        let sent;
        if (sourceClientId && typeof this.hub.sendToClientWithDelivery === 'function') {
          sent = type === 'extension.reload'
            && options.allowIncompatibleReload === true
            && typeof this.hub.sendReloadControlToClient === 'function'
            ? { client: this.hub.sendReloadControlToClient(sourceClientId, commandPayload, { request: options.request || null }) }
            : this.hub.sendToClientWithDelivery(sourceClientId, commandPayload, { request: options.request || null });
        } else if (typeof this.hub.sendToActiveWithDelivery === 'function') {
          sent = this.hub.sendToActiveWithDelivery(commandPayload, { request: options.request || null });
        } else {
          sent = { client: this.hub.sendToActive(commandPayload) };
        }
        command.clientId = sent.client.id;
        command.sourceClientId = sourceClientId || sent.client.id;
        if (type === 'request.release') this.#beginReleaseBarrier(command.clientId, commandId);
        Promise.resolve(sent.delivered).catch((error) => {
          if (!this.commands.has(commandId)) return;
          this.#remove(commandId);
          reject(error);
        });
      } catch (err) {
        this.#remove(commandId);
        reject(err);
        return;
      }

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          if (!this.commands.has(commandId)) return;
          void this.#cancelBeforeReject(
            command,
            abortError(String(options.signal.reason || 'Command cancelled')),
            'server_command_aborted',
          );
        }, { once: true });
      }
    });

    return await dispatch();
  }

  close(reason = 'Bridge shutting down') {
    for (const command of this.commands.values()) {
      clearTimeout(command.timer);
      command.reject(new Error(reason));
    }
    this.commands.clear();
    for (const barrier of this.releaseBarriers.values()) barrier.resolve();
    this.releaseBarriers.clear();
  }

  isReleasePending(clientId = '') {
    return this.releaseBarriers.has(String(clientId || ''));
  }

  async waitForReleaseBarrier(clientId = '', timeoutMs = 30_000) {
    const id = String(clientId || '');
    if (!id) return;
    const barrier = this.releaseBarriers.get(id);
    if (!barrier) return;
    const limit = Math.max(1_000, Math.min(Number(timeoutMs) || 30_000, 10_500));
    let timer = null;
    try {
      await Promise.race([
        barrier.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out waiting for browser release on ${id} after ${limit}ms`)), limit);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #beginReleaseBarrier(clientId, commandId) {
    const id = String(clientId || '');
    if (!id) return;
    const gate = deferred();
    this.releaseBarriers.set(id, { ...gate, commandId });
  }

  #settleReleaseBarrier(command) {
    if (command?.requestType !== 'request.release') return;
    const id = String(command.clientId || command.sourceClientId || '');
    const barrier = this.releaseBarriers.get(id);
    if (!barrier || barrier.commandId !== command.commandId) return;
    this.releaseBarriers.delete(id);
    barrier.resolve();
  }

  async #cancelBeforeReject(command, error, reason) {
    if (!command || !this.commands.has(command.commandId)) return;
    if (command.requestType !== 'command.cancel') {
      try {
        await this.send('command.cancel', {
          targetCommandId: command.commandId,
          reason,
        }, {
          sourceClientId: String(command.clientId || command.sourceClientId || ''),
          timeoutMs: 5_000,
        });
      } catch {
        // Cancellation is best effort, but the original command is not exposed
        // as timed out until the cancellation attempt itself has settled.
      }
    }
    if (!this.commands.has(command.commandId)) return;
    this.#remove(command.commandId);
    command.reject(error);
  }

  #remove(commandId) {
    const command = this.commands.get(commandId);
    if (command?.timer) clearTimeout(command.timer);
    this.commands.delete(commandId);
    this.#settleReleaseBarrier(command);
  }
}
