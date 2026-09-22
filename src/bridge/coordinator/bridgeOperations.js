import fs from 'node:fs/promises';
import path from 'node:path';
import { isImageArtifact, normalizeImageArtifact } from '../../results/artifactImage.js';
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
  #downloads = new Map();

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
    return await Promise.all(candidates.map((candidate, index) => this.#normalizeRecoveredResponse({
      ...candidate,
      candidateIndex: index + 1,
      session: response.session || candidate.session,
      url: response.url || candidate.url,
      title: response.title || candidate.title,
    }, options)));
  }

  async recoverLatestResponse(options = {}) {
    const index = Math.max(1, Number(options.index) || 1);
    const response = await this.#sendCommand('response.recover.latest', {
      index,
      limit: Math.max(index, Number(options.limit) || 5),
      reconcileConversation: options.reconcileConversation,
    }, { ...options, timeoutMs: options.timeoutMs || 30_000 });
    return this.#normalizeRecoveredResponse(response, { ...options, index });
  }

  async recoverResponseByTurnKey(options = {}) {
    const turnKey = String(options.turnKey || '');
    if (!turnKey) throw new Error('No turnKey provided for response recovery');
    const response = await this.#sendCommand('response.recover.turnKey', { turnKey, reconcileConversation: options.reconcileConversation }, { ...options, timeoutMs: options.timeoutMs || 30_000 });
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

  async submitPassivePrompt({ requestId = '', message, sessionId = '', effort = '', model = '', sourceClientId = '', timeoutMs = 60_000 } = {}) {
    const text = String(message || '').trim();
    if (!text) {
      const error = new Error('Passive prompt message is required');
      error.submissionStatus = 'REJECTED_BEFORE_SUBMIT';
      throw error;
    }
    // Keep the content-side readiness wait inside the server command deadline.
    // Otherwise an invalid/deleted conversation can leave the extension waiting
    // on a missing composer until the server times out, leaving the durable
    // passive-prompt ledger INFLIGHT forever.
    const commandTimeoutMs = Math.max(5_000, Number(timeoutMs) || 60_000);
    // The controller intentionally gives a freshly launched Edge page time to
    // hydrate its composer.  A fixed 30 s cap can expire at the same moment
    // the composer becomes ready (especially on a cold profile), causing a
    // false REJECTED_BEFORE_SUBMIT before the browser write boundary.  Keep
    // readiness inside the command deadline while reserving a small tail for
    // the actual command/response settlement.
    const pageReadyTimeoutMs = Math.max(5_000, commandTimeoutMs - 2_000);
    const result = await this.#sendCommand('passive.prompt.submit', {
      message: text,
      options: {
        sessionId: String(sessionId || ''),
        effort: String(effort || ''),
        model: String(model || ''),
        pageReadyTimeoutMs,
      },
    }, {
      sourceClientId: String(sourceClientId || ''),
      commandId: String(requestId || ''),
      timeoutMs: commandTimeoutMs,
    });
    const actualSession = String(result?.session?.id || result?.sessionId || result?.conversationId || '');
    if (result?.type !== 'passive.prompt.submitted' || !result?.submittedUserTurnKey
        || (sessionId && actualSession !== String(sessionId))
        || (sourceClientId && String(result.sourceClientId || result.commandClientId || '') !== String(sourceClientId))) {
      const error = new Error('Passive prompt returned no matching submission proof');
      error.submissionStatus = 'UNCERTAIN_AFTER_SUBMIT';
      throw error;
    }
    return result;
  }

  async reloadBrowserTab(options = {}) {
    const sourceClientId = String(options.sourceClientId || options.clientId || '');
    return await this.#sendCommand('browser.tab.reload', {
      requestId: String(options.requestId || ''),
      reason: String(options.reason || 'workflow refresh'),
    }, {
      sourceClientId,
      timeoutMs: Math.max(2_000, Number(options.timeoutMs) || 8_000),
      request: options.request || null,
    });
  }

  async capturePageLayout(options = {}) {
    const sourceClientId = String(options.sourceClientId || options.clientId || '');
    const response = await this.#sendCommand('debug.layout.capture', {
      requestId: String(options.requestId || ''),
      options: {
        maxNodes: Math.max(500, Math.min(30_000, Number(options.maxNodes) || 15_000)),
        maxBytes: Math.max(100_000, Math.min(5_000_000, Number(options.maxBytes) || 2_000_000)),
      },
    }, { sourceClientId, timeoutMs: Math.max(2_000, Number(options.timeoutMs) || 15_000) });
    return {
      html: String(response.html || ''),
      metadata: response.metadata && typeof response.metadata === 'object' ? response.metadata : {},
      sourceClientId: String(response.sourceClientId || sourceClientId),
    };
  }

  async fetchArtifact(artifactId, options = {}) {
    if (this.#downloads.has(artifactId)) return await this.#downloads.get(artifactId);
    const pending = this.#fetchArtifact(artifactId, options);
    this.#downloads.set(artifactId, pending);
    try { return await pending; }
    finally { this.#downloads.delete(artifactId); }
  }

  async #fetchArtifact(artifactId, options = {}) {
    const artifact = this.#artifacts.get(artifactId);
    if (!artifact) {
      const stored = await this.#fileStore?.getReadable(artifactId);
      if (stored?.metadata?.kind === 'image') return await this.#verifiedStoredImage(stored, stored.metadata);
      throw new Error(`Unknown artifact: ${artifactId}`);
    }
    if (artifact.materializationError) {
      throw Object.assign(new Error(artifact.materializationError.message), { code: artifact.materializationError.code });
    }

    if ((artifact.storedFileId || isImageArtifact(artifact)) && this.#fileStore && (!options.force || isImageArtifact(artifact))) {
      const existing = await this.#fileStore.getReadable(artifact.storedFileId || artifactId).catch(() => null);
      if (existing?.absolutePath) {
        const stat = await fs.stat(existing.absolutePath).catch(() => null);
        if (stat?.isFile()) return isImageArtifact(artifact)
          ? await this.#verifiedStoredImage(existing, artifact) : existing;
      }
    }

    const sourceClientId = String(options.sourceClientId || options.clientId || artifact.sourceClientId || '');
    this.#eventBus?.emitUser({ type: 'artifact.download.started', data: { artifactId, name: artifact.name || '', kind: artifact.kind || '', sourceClientId } });
    if (artifact.kind === 'image') {
      this.#eventBus?.emitUser({ type: 'image.artifact.download.started', data: {
        artifactId, name: artifact.name || '', mime: artifact.mime || '', sourceClientId, requestId: artifact.requestId || '',
      } });
    }
    const response = await this.#sendCommand(isImageArtifact(artifact) ? 'artifact.image.read' : 'artifact.fetch', {
      artifact: { ...artifact, ...(isImageArtifact(artifact) ? { kind: 'image' } : {}), chunkSize: 256 * 1024 },
    }, { ...options, sourceClientId, timeoutMs: options.timeoutMs || config.artifactChunkTimeoutMs });

    if (response.filePath) return await this.#storeArtifactPath(artifactId, artifact, response, sourceClientId);
    if (!response.contentBase64) throw new Error(`Artifact did not return downloadable content or file path: ${artifactId}`);

    if (!this.#fileStore) {
      const bytes = Buffer.from(response.contentBase64, 'base64');
      const normalized = normalizeImageArtifact(bytes, { ...artifact, name: response.name || artifact.name,
        mime: isImageArtifact(artifact) ? artifact.mime : response.mime || artifact.mime });
      return {
        id: artifactId,
        metadata: { ...artifact, kind: normalized.kind },
        source: { captureSource: response.captureSource || 'direct-fetch' },
        size: bytes.length,
        name: normalized.name || artifactId,
        mime: normalized.mime || 'application/octet-stream',
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
    this.#eventBus?.emitUser({ type: 'artifact.download.done', data: { artifactId, fileId: stored.id, name: stored.name, mime: stored.mime, size: stored.size, kind: artifact.kind || '', source: response.captureSource || 'direct-fetch', sourceClientId, requestId: artifact.requestId || '' } });
    if (artifact.kind === 'image') {
      this.#eventBus?.emitUser({ type: 'image.artifact.download.done', data: {
        artifactId, fileId: stored.id, name: stored.name, mime: stored.mime, size: stored.size,
        source: response.captureSource || 'direct-fetch', sourceClientId, requestId: artifact.requestId || '',
      } });
    }
    return stored;
  }

  async #verifiedStoredImage(stored, artifact) {
    const bytes = await fs.readFile(stored.absolutePath);
    const normalized = normalizeImageArtifact(bytes, { ...artifact, kind: 'image', name: stored.name });
    if (stored.mime === normalized.mime && stored.name === normalized.name) return stored;
    return await this.#fileStore.putArtifact({ artifactId: stored.id, name: normalized.name,
      mime: normalized.mime, contentBase64: bytes.toString('base64'), source: stored.source,
      metadata: { ...stored.metadata, ...artifact, kind: 'image' } });
  }

  async #normalizeRecoveredResponse(response = {}, options = {}) {
    const sourceClientId = String(options.sourceClientId || options.clientId || response.sourceClientId || '');
    let artifacts = Array.isArray(response.artifacts) ? response.artifacts.map((artifact) => ({
      ...artifact,
      requestId: options.requestId || response.requestId || 'recovered',
      sourceClientId: artifact.sourceClientId || sourceClientId,
    })) : [];
    for (const artifact of artifacts) if (artifact.id) this.#artifacts.set(artifact.id, artifact);
    if (this.#artifacts.settled) artifacts = await this.#artifacts.settled(artifacts);
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
      reconciliation: response.reconciliation || null,
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
      userTurnKey: String(response.userTurnKey || ''),
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
      const bytes = await fs.readFile(resolvedFilePath);
      const normalized = normalizeImageArtifact(bytes, { ...artifact, name: resolvedName,
        mime: isImageArtifact(artifact) ? artifact.mime : response.mime || artifact.mime });
      return { id: artifactId, name: normalized.name, mime: normalized.mime || 'application/octet-stream',
        metadata: { ...artifact, kind: normalized.kind }, source: { captureSource: response.captureSource || 'chrome-downloads' },
        filePath: resolvedFilePath, requestedFilePath: response.filePath, size: bytes.length };
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
      data: {
        artifactId,
        fileId: stored.id,
        name: resolvedName,
        path: cleanup.path || resolvedFilePath,
        reason: cleanup.reason || '',
        downloadId: response.downloadId ?? null,
        sourceClientId,
        capturedStatIdentity: resolvedDownload.statIdentity,
        captureIdentity: resolvedDownload.captureIdentity,
      },
    });
    this.#rememberStoredArtifact(artifactId, artifact, stored.id);
    this.#eventBus?.emitUser({ type: 'artifact.download.done', data: { artifactId, fileId: stored.id, name: stored.name, mime: stored.mime, size: stored.size, kind: stored.metadata?.kind || artifact.kind || '', source: response.captureSource || 'chrome-downloads', sourceClientId, requestId: artifact.requestId || '' } });
    return stored;
  }

  #rememberStoredArtifact(artifactId, artifact, storedFileId) {
    artifact.storedFileId = storedFileId;
    this.#artifacts.set(artifactId, { ...artifact, storedFileId });
  }
}
