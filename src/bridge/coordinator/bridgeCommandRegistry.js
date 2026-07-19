import { makeRequestId } from '../../protocol.js';
import { abortError } from '../requestState.js';

/**
 * Owns server-to-extension command correlation. Progress is telemetry; only a
 * typed result, rejection, or error may settle a registered command.
 */
export class BridgeCommandRegistry {
  constructor({ hub, eventBus = null }) {
    this.hub = hub;
    this.eventBus = eventBus;
    this.commands = new Map();
  }

  get size() { return this.commands.size; }

  has(commandId) { return this.commands.has(commandId); }

  handleResponse(clientId, payload) {
    const command = this.commands.get(payload.commandId);
    if (!command || (command.clientId && command.clientId !== clientId)) return;
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
      return;
    }

    if (result.type === 'artifact.data.chunk') {
      if (!command.chunks) command.chunks = [];
      command.chunks[Number(result.index) || 0] = String(result.contentBase64 || '');
      if ((Number(result.index) || 0) % 10 === 0) {
        this.eventBus?.emitDebug({ type: 'protocol.in.artifact.data.chunk', data: { commandId: result.commandId, index: result.index, totalChunks: result.totalChunks, size: String(result.contentBase64 || '').length } });
      }
      return;
    }

    if (payload.type === 'command.progress') {
      this.eventBus?.emitDebug({
        type: 'protocol.in.command.progress',
        data: { commandId: result.commandId, requestType: command.requestType, progressType: result.type },
      });
      return;
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
      return;
    }

    this.#remove(result.commandId);
    if (result.type === 'command.error' || result.error) {
      command.reject(new Error(result.message || result.error || 'Browser extension command failed'));
      return;
    }
    command.resolve({ ...result, sourceClientId: result.sourceClientId || command.sourceClientId || command.clientId, commandClientId: command.clientId });
  }

  async send(type, payload = {}, options = {}) {
    if (options.signal?.aborted) throw abortError(options.signal.reason || 'Command cancelled');

    const commandId = options.commandId || makeRequestId();
    const timeoutMs = Number(options.timeoutMs) || 30_000;
    const sourceClientId = String(options.sourceClientId || options.clientId || payload.sourceClientId || '');
    const dispatch = () => new Promise((resolve, reject) => {
      const command = { commandId, requestType: type, clientId: '', resolve, reject, timer: null, chunks: null, chunkMeta: null, sourceClientId };
      const timer = setTimeout(() => {
        this.commands.delete(commandId);
        const error = new Error(`Timed out waiting for ${type} response after ${timeoutMs}ms`);
        if (type === 'request.release') {
          this.hub.failRequestRelease?.(command.clientId || sourceClientId, payload.requestId, error);
        }
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      command.timer = timer;
      this.commands.set(commandId, command);

      try {
        let client;
        if (sourceClientId && typeof this.hub.sendToClient === 'function') {
          const commandPayload = { type, commandId, ...payload };
          client = type === 'extension.reload'
            && options.allowIncompatibleReload === true
            && typeof this.hub.sendReloadControlToClient === 'function'
            ? this.hub.sendReloadControlToClient(sourceClientId, commandPayload)
            : this.hub.sendToClient(sourceClientId, commandPayload);
        } else {
          client = this.hub.sendToActive({ type, commandId, ...payload });
        }
        command.clientId = client.id;
        command.sourceClientId = sourceClientId || client.id;
      } catch (err) {
        this.#remove(commandId);
        reject(err);
        return;
      }

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          if (!this.commands.has(commandId)) return;
          this.#remove(commandId);
          reject(abortError(String(options.signal.reason || 'Command cancelled')));
        }, { once: true });
      }
    });

    if (type !== 'request.release') {
      await this.#waitForReleaseBarrier(sourceClientId, timeoutMs);
    }
    try {
      return await dispatch();
    } catch (error) {
      if (error?.code !== 'BROWSER_RELEASE_PENDING' || type === 'request.release') throw error;
      await this.hub.waitForClientRelease?.(String(error.clientId || sourceClientId || ''), String(error.requestId || ''), Math.max(1_000, Math.min(timeoutMs, 10_500)));
      return await dispatch();
    }
  }

  async #waitForReleaseBarrier(sourceClientId = '', timeoutMs = 30_000) {
    if (typeof this.hub.waitForClientRelease !== 'function') return;
    const client = sourceClientId
      ? (this.hub.clients || []).find((candidate) => candidate.id === sourceClientId)
      : this.hub.activeClient;
    const requestId = String(client?.releasingRequestId || '');
    if (!client?.id || !requestId) return;
    await this.hub.waitForClientRelease(client.id, requestId, Math.max(1_000, Math.min(timeoutMs, 10_500)));
  }

  close(reason = 'Bridge shutting down') {
    for (const command of this.commands.values()) {
      clearTimeout(command.timer);
      command.reject(new Error(reason));
    }
    this.commands.clear();
  }

  #remove(commandId) {
    const command = this.commands.get(commandId);
    if (command?.timer) clearTimeout(command.timer);
    this.commands.delete(commandId);
  }
}
