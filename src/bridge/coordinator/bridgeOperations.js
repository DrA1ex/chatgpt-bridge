import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { makeRequestId } from '../../protocol.js';
import { normalizeConversationId } from '../clientSelection.js';
import {
  completedReasoningRecords,
  mergeProgressRecords,
} from '../requestState.js';
import {
  removeCapturedBrowserDownload,
  resolveBrowserDownloadedPath,
} from '../browserDownloads.js';

export class BridgeOperations {
  #sendCommand;
  #fileStore;
  #eventBus;
  #artifacts;

  constructor(options = {}) {
    if (typeof options.sendCommand !== 'function') throw new TypeError('BridgeOperations requires sendCommand');
    this.#sendCommand = options.sendCommand;
    this.#fileStore = options.fileStore || null;
    this.#eventBus = options.eventBus || null;
    this.#artifacts = options.artifacts || new Map();
  }

  async deleteSession(sessionId, expectedUrl, options = {}) {
    const normalizedSessionId = normalizeConversationId(sessionId);
    if (!normalizedSessionId) throw new Error('A concrete ChatGPT sessionId is required for deletion');
    if (!String(expectedUrl || '').trim()) throw new Error('expectedUrl is required for safe ChatGPT session deletion');
    return await this.#sendCommand('sessions.delete', {
      sessionId: normalizedSessionId,
      expectedUrl: String(expectedUrl),
    }, { ...options, timeoutMs: Number(options.timeoutMs) || 30_000 });
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
    return { models: response.models || [], current: response.current || null, intelligence: response.intelligence || null };
  }

  async listEfforts(options = {}) {
    const response = await this.#sendCommand('efforts.list', {}, options);
    return { efforts: response.efforts || [], current: response.current || null, intelligence: response.intelligence || null };
  }

  async applyIntelligence({ model = '', effort = '' } = {}, options = {}) {
    const response = await this.#sendCommand('intelligence.apply', {
      options: { model: String(model || ''), effort: String(effort || '') },
    }, { ...options, timeoutMs: Math.max(5_000, Number(options.timeoutMs) || 15_000) });
    return {
      model: String(response.model || model || ''),
      effort: String(response.effort || effort || ''),
      modelApplied: Boolean(response.modelApplied),
      effortApplied: Boolean(response.effortApplied),
      warnings: Array.isArray(response.warnings) ? response.warnings : [],
      intelligence: response.intelligence || null,
    };
  }

  async clearComposerAttachments(options = {}) {
    return await this.#sendCommand('composer.attachments.clear', {}, options);
  }

  async recoverResponses(options = {}) {
    const limit = Math.max(1, Math.min(10, Number(options.limit) || 5));
    const response = await this.#sendCommand('response.recover.list', { limit }, { ...options, timeoutMs: options.timeoutMs || 30_000 });
    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    return candidates.map((candidate, index) => this.#normalizeRecoveredResponse({
      ...candidate,
      candidateIndex: index + 1,
      session: response.session || candidate.session,
      url: response.url || candidate.url,
      title: response.title || candidate.title,
    }, options));
  }

  async recoverLatestResponse(options = {}) {
    const index = Math.max(1, Number(options.index) || 1);
    const response = await this.#sendCommand('response.recover.latest', {
      index,
      limit: Math.max(index, Number(options.limit) || 5),
    }, { ...options, timeoutMs: options.timeoutMs || 30_000 });
    return this.#normalizeRecoveredResponse(response, { ...options, index });
  }

  async recoverResponseByTurnKey(options = {}) {
    const turnKey = String(options.turnKey || '');
    if (!turnKey) throw new Error('No turnKey provided for response recovery');
    const response = await this.#sendCommand('response.recover.turnKey', { turnKey }, { ...options, timeoutMs: options.timeoutMs || 30_000 });
    return this.#normalizeRecoveredResponse(response, { ...options, turnKey });
  }

  registerObservedArtifacts(artifacts = [], metadata = {}) {
    const normalized = Array.isArray(artifacts) ? artifacts.map((artifact) => ({
      ...artifact,
      observed: true,
      requestId: artifact.requestId || '',
      sourceClientId: artifact.sourceClientId || metadata.sourceClientId || '',
      sourceTurnKey: artifact.sourceTurnKey || metadata.turnKey || '',
      sessionId: artifact.sessionId || metadata.sessionId || '',
    })) : [];
    for (const artifact of normalized) if (artifact.id) this.#artifacts.set(artifact.id, artifact);
    return normalized;
  }

  async submitPassivePrompt({ message, sessionId = '', effort = '', model = '', sourceClientId = '', timeoutMs = 60_000 } = {}) {
    const text = String(message || '').trim();
    if (!text) throw new Error('Passive prompt message is required');
    return await this.#sendCommand('passive.prompt.submit', {
      message: text,
      options: { sessionId: String(sessionId || ''), effort: String(effort || ''), model: String(model || '') },
    }, { sourceClientId: String(sourceClientId || ''), timeoutMs: Math.max(5_000, Number(timeoutMs) || 60_000) });
  }

  async reloadBrowserTab(options = {}) {
    const sourceClientId = String(options.sourceClientId || options.clientId || '');
    return await this.#sendCommand('browser.tab.reload', {
      reason: String(options.reason || 'workflow refresh'),
    }, { sourceClientId, timeoutMs: Math.max(2_000, Number(options.timeoutMs) || 8_000) });
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

    const sourceClientId = String(options.sourceClientId || options.clientId || artifact.sourceClientId || '');
    this.#eventBus?.emitUser({ type: 'artifact.download.started', data: { artifactId, name: artifact.name || '', kind: artifact.kind || '', sourceClientId } });
    const response = await this.#sendCommand('artifact.fetch', {
      artifact: { ...artifact, chunkSize: 256 * 1024 },
    }, { ...options, sourceClientId, timeoutMs: options.timeoutMs || config.artifactChunkTimeoutMs });

    if (response.filePath) return await this.#storeArtifactPath(artifactId, artifact, response, sourceClientId);
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
      source: { url: artifact.url || artifact.src || artifact.downloadUrl || '', requestId: artifact.requestId || '', captureSource: response.captureSource || 'direct-fetch' },
      metadata: artifact,
    });
    this.#rememberStoredArtifact(artifactId, artifact, stored.id);
    this.#eventBus?.emitUser({ type: 'artifact.download.done', data: { artifactId, fileId: stored.id, name: stored.name, size: stored.size, source: response.captureSource || 'direct-fetch', sourceClientId, requestId: artifact.requestId || '' } });
    return stored;
  }

  #normalizeRecoveredResponse(response = {}, options = {}) {
    const sourceClientId = String(options.sourceClientId || options.clientId || response.sourceClientId || '');
    const artifacts = Array.isArray(response.artifacts) ? response.artifacts.map((artifact) => ({
      ...artifact,
      requestId: options.requestId || response.requestId || 'recovered',
      sourceClientId: artifact.sourceClientId || sourceClientId,
    })) : [];
    for (const artifact of artifacts) if (artifact.id) this.#artifacts.set(artifact.id, artifact);
    return {
      id: options.requestId || response.requestId || makeRequestId(),
      requestId: options.requestId || response.requestId || '',
      answer: String(response.answer || ''),
      response: String(response.answer || ''),
      thinking: String(response.thinking || ''),
      reasoningHistory: mergeProgressRecords(response.reasoningHistory, completedReasoningRecords(response.progressItems)),
      progressItems: Array.isArray(response.progressItems) ? response.progressItems : [],
      responseBlocks: Array.isArray(response.responseBlocks) ? response.responseBlocks : [],
      codeBlocks: Array.isArray(response.codeBlocks) ? response.codeBlocks : [],
      codeBlockDiagnostics: Array.isArray(response.codeBlockDiagnostics) ? response.codeBlockDiagnostics : [],
      parserAudit: response.parserAudit && typeof response.parserAudit === 'object' ? response.parserAudit : null,
      artifacts,
      session: response.session || null,
      url: response.url || '',
      title: response.title || '',
      sourceClientId,
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

  async #storeArtifactPath(artifactId, artifact, response, sourceClientId) {
    const resolvedDownload = await resolveBrowserDownloadedPath(response.filePath, response.name || artifact.name || artifactId, {
      size: response.size || 0,
      browserDownloadStartTime: response.browserDownloadStartTime || '',
      browserDownloadEndTime: response.browserDownloadEndTime || '',
      browserCaptureStartedAt: response.browserCaptureStartedAt || 0,
      browserCapturedAt: response.browserCapturedAt || 0,
      browserActualName: response.name || '',
      browserExpectedNames: Array.isArray(response.browserExpectedNames) ? response.browserExpectedNames : [],
      captureSource: response.captureSource || '',
      downloadId: response.downloadId ?? null,
    });
    const resolvedFilePath = resolvedDownload.path;
    const resolvedName = path.basename(resolvedFilePath) || response.name || artifact.name || artifactId;
    if (resolvedFilePath !== path.resolve(response.filePath)) {
      this.#eventBus?.emitUser({ type: 'artifact.download.renamed', data: { artifactId, requestedPath: response.filePath, resolvedPath: resolvedFilePath, resolution: resolvedDownload.resolution } });
    }
    if (!this.#fileStore) {
      return { id: artifactId, name: resolvedName, mime: response.mime || artifact.mime || 'application/octet-stream', filePath: resolvedFilePath, requestedFilePath: response.filePath, size: response.size || 0 };
    }
    const stored = await this.#fileStore.importArtifactPath({
      artifactId,
      filePath: resolvedFilePath,
      name: resolvedName,
      mime: response.mime || artifact.mime || 'application/octet-stream',
      source: { url: artifact.url || artifact.src || artifact.downloadUrl || '', requestId: artifact.requestId || '', browserDownloadPath: resolvedFilePath, requestedBrowserDownloadPath: response.filePath, captureSource: response.captureSource || 'chrome-downloads' },
      metadata: artifact,
      removeSource: false,
    });
    const cleanup = await removeCapturedBrowserDownload(resolvedDownload).catch((error) => ({ removed: false, reason: error.message || String(error), path: resolvedFilePath }));
    this.#eventBus?.emitUser({
      type: cleanup.removed ? 'artifact.download.source_removed' : 'artifact.download.source_cleanup_skipped',
      data: { artifactId, fileId: stored.id, path: cleanup.path || resolvedFilePath, reason: cleanup.reason || '', downloadId: response.downloadId ?? null, sourceClientId },
    });
    this.#rememberStoredArtifact(artifactId, artifact, stored.id);
    this.#eventBus?.emitUser({ type: 'artifact.download.done', data: { artifactId, fileId: stored.id, name: stored.name, size: stored.size, source: response.captureSource || 'chrome-downloads', sourceClientId, requestId: artifact.requestId || '' } });
    return stored;
  }

  #rememberStoredArtifact(artifactId, artifact, storedFileId) {
    artifact.storedFileId = storedFileId;
    this.#artifacts.set(artifactId, { ...artifact, storedFileId });
  }
}
