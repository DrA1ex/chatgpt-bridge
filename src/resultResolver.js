import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { validateZipFile, sha256File } from './zipUtils.js';
import { writeZip } from './zipWriter.js';
import { extractFileBlocks } from './results/fileBlocks.js';
import { positiveNumber, selectZipArtifact, selectMaterializableZipFallback, summarizeArtifact } from './results/artifacts.js';
import { resultError, sleep } from './results/errors.js';

export class ResultResolver {
  constructor({ bridge, fileStore, metadataStore, eventBus }) {
    this.bridge = bridge;
    this.fileStore = fileStore;
    this.metadataStore = metadataStore;
    this.eventBus = eventBus;
  }

  async resolve(operation, response, options = {}) {
    const output = operation.request?.output || {};
    const expected = String(output.expected || output.format || '').toLowerCase();
    if (!expected || expected === 'text') {
      return { type: 'text', text: response.answer || '', artifacts: response.artifacts || [] };
    }
    if (expected !== 'zip') {
      return { type: expected, text: response.answer || '', artifacts: response.artifacts || [], warning: `No resolver for expected output: ${expected}` };
    }
    return await this.resolveZip(operation, response, options);
  }

  async resolveZip(operation, response, { onEvent = null } = {}) {
    const output = operation.request?.output || {};
    const emit = (type, data = {}) => this.#event(operation.id, type, data, onEvent);
    let resolvedResponse = response || {};
    let artifacts = Array.isArray(resolvedResponse.artifacts) ? resolvedResponse.artifacts.map((artifact) => ({ ...artifact, sourceClientId: artifact.sourceClientId || resolvedResponse.sourceClientId || response?.sourceClientId || '' })) : [];
    resolvedResponse = { ...resolvedResponse, artifacts };
    let artifact = selectZipArtifact(artifacts, resolvedResponse);
    let artifactSelectionReason = artifact?.id ? 'zip_metadata' : '';
    await emit('result.validating', {
      expected: 'zip',
      artifactId: artifact?.id || '',
      artifactCount: artifacts.length,
      sourceClientId: resolvedResponse.sourceClientId || '',
      artifacts: artifacts.map(summarizeArtifact),
    });

    if (!artifact?.id) {
      const refreshed = await this.#retryArtifactResolution(operation, resolvedResponse, emit);
      if (refreshed?.artifact?.id) {
        resolvedResponse = refreshed.response;
        artifacts = Array.isArray(resolvedResponse.artifacts) ? resolvedResponse.artifacts.map((artifact) => ({ ...artifact, sourceClientId: artifact.sourceClientId || resolvedResponse.sourceClientId || response?.sourceClientId || '' })) : [];
        resolvedResponse = { ...resolvedResponse, artifacts };
        artifact = refreshed.artifact;
        artifactSelectionReason = refreshed.selectionReason || 'artifact_retry';
      }
    }

    if (!artifact?.id) {
      const fallback = selectMaterializableZipFallback(artifacts, resolvedResponse);
      if (fallback.artifact?.id) {
        artifact = fallback.artifact;
        artifactSelectionReason = fallback.reason;
        await emit('result.artifact.metadata_fallback_selected', {
          artifactId: artifact.id,
          reason: fallback.reason,
          selected: summarizeArtifact(artifact),
          candidates: fallback.candidates.map((item) => ({ ...summarizeArtifact(item.artifact), score: item.score })),
        });
      } else if (fallback.candidates.length) {
        await emit('result.artifact.metadata_fallback_ambiguous', {
          reason: fallback.reason,
          candidates: fallback.candidates.map((item) => ({ ...summarizeArtifact(item.artifact), score: item.score })),
        });
      }
    }

    if (!artifact?.id) {
      const fileBlocks = extractFileBlocks(resolvedResponse.answer || resolvedResponse.response || '');
      if (fileBlocks.length) {
        await emit('result.reconstructing_from_file_blocks', { count: fileBlocks.length });
        const generatedDir = path.join(config.dataDir, 'generated-results');
        await fs.mkdir(generatedDir, { recursive: true });
        const zipPath = path.join(generatedDir, `${operation.id || 'result'}-${Date.now()}.zip`);
        const zip = await writeZip(zipPath, fileBlocks);
        const imported = await this.fileStore.importArtifactPath({
          artifactId: `reconstructed_${operation.id}`,
          filePath: zip.path,
          name: `recovered-${operation.id || 'result'}.zip`,
          mime: 'application/zip',
          source: { type: 'file-blocks', turnId: operation.id || '' },
          metadata: { reconstructed: true, entries: fileBlocks.map((entry) => entry.name) },
        });
        const readable = await this.fileStore.getReadable(imported.id);
        if (!readable?.absolutePath) throw resultError('RECONSTRUCTED_ZIP_NOT_READABLE', `Reconstructed ZIP is not readable: ${imported.id}`);
        await emit('result.validation.started', { fileId: readable.id || imported.id, name: readable.name || imported.name || '', size: readable.size || 0, reconstructed: true });
        let validated;
        try {
          validated = await validateZipFile(readable.absolutePath, {
            maxEntries: config.zipMaxEntries,
            maxUncompressedSize: config.zipMaxUncompressedSize,
            ...(operation.request?.zipValidation || {}),
          });
        } catch (err) {
          await emit('result.validation_failed', { fileId: readable.id || imported.id, name: readable.name || imported.name || '', code: err.code || '', message: err.message || String(err), reconstructed: true });
          throw err;
        }
        await emit('result.validated', { fileId: readable.id || imported.id, name: readable.name || imported.name || '', size: readable.size || validated.size || 0, entries: validated.entries || 0, totalUncompressedSize: validated.totalUncompressedSize || 0, reconstructed: true });
        const sha256 = validated.sha256 || await sha256File(readable.absolutePath);
        const downloadId = `dl_${operation.id}`;
        const download = await this.metadataStore.createDownload({
          id: downloadId,
          ownerId: operation.id,
          artifactId: imported.id,
          fileId: readable.id,
          name: readable.name || imported.name,
          mime: readable.mime || 'application/zip',
          size: readable.size || validated.size,
          sha256,
          path: readable.absolutePath,
          metadata: { zip: validated, reconstructedFromFileBlocks: true },
        });
        const result = {
          type: 'zip',
          status: 'ready',
          answer: resolvedResponse.answer || resolvedResponse.response || '',
          text: resolvedResponse.answer || resolvedResponse.response || '',
          artifacts,
          artifactId: imported.id,
          downloadId,
          fileId: readable.id,
          name: download.name,
          mime: download.mime,
          size: download.size,
          sha256,
          downloadUrl: output.downloadUrl || `/turns/${operation.id}/result/download`,
          manifest: validated.files,
          zip: { entries: validated.entries, totalUncompressedSize: validated.totalUncompressedSize },
          reconstructedFrom: 'file-blocks',
          sourceRequestId: resolvedResponse.requestId || operation.id,
          sourceClientId: resolvedResponse.sourceClientId || '',
          sourceTurnKey: resolvedResponse.turnKey || resolvedResponse.sourceTurnKey || '',
        };
        await emit('result.ready', result);
        return result;
      }
      throw resultError('EXPECTED_ZIP_ARTIFACT_NOT_FOUND', 'Expected a .zip artifact, but ChatGPT did not expose an unambiguous downloadable ZIP action.', {
        artifacts: artifacts.map(summarizeArtifact),
        answerPreview: String(resolvedResponse.answer || '').slice(0, 1000),
      });
    }

    const sourceClientId = String(artifact.sourceClientId || resolvedResponse.sourceClientId || response?.sourceClientId || '');
    await emit('artifact.downloading', { artifactId: artifact.id, name: artifact.name || '', sourceTurnKey: artifact.sourceTurnKey || '', sourceTurnIndex: artifact.sourceTurnIndex ?? -1, sourceClientId, selectionReason: artifactSelectionReason || 'zip_metadata' });
    const stored = await this.bridge.fetchArtifact(artifact.id, { force: Boolean(output.forceArtifactDownload || output.forceDownload), sourceClientId });
    await emit('artifact.downloaded', { artifactId: artifact.id, fileId: stored.id || artifact.id, name: stored.name || artifact.name || '', size: stored.size || 0, sourceClientId, sourceTurnKey: artifact.sourceTurnKey || '', sourceRequestId: resolvedResponse.requestId || operation.id });
    const readable = await this.fileStore.getReadable(stored.id || artifact.id);
    if (!readable?.absolutePath) throw resultError('ARTIFACT_DOWNLOAD_FAILED', `Downloaded artifact is not readable: ${artifact.id}`);

    await emit('result.validation.started', { artifactId: artifact.id, fileId: readable.id || artifact.id, name: readable.name || artifact.name || '', size: readable.size || stored.size || 0, sourceClientId });
    let zip;
    try {
      zip = await validateZipFile(readable.absolutePath, {
        maxEntries: config.zipMaxEntries,
        maxUncompressedSize: config.zipMaxUncompressedSize,
        ...(operation.request?.zipValidation || {}),
      });
    } catch (err) {
      await emit('result.validation_failed', { artifactId: artifact.id, fileId: readable.id || artifact.id, name: readable.name || artifact.name || '', code: err.code || '', message: err.message || String(err), sourceClientId, selectionReason: artifactSelectionReason || 'zip_metadata' });
      if (artifactSelectionReason && artifactSelectionReason !== 'zip_metadata' && artifactSelectionReason !== 'artifact_retry_zip_metadata') {
        throw resultError('MATERIALIZED_ARTIFACT_NOT_ZIP', `The only scoped artifact action was downloaded, but its bytes are not a valid ZIP: ${readable.name || artifact.name || artifact.id}`, {
          artifact: summarizeArtifact(artifact),
          selectionReason: artifactSelectionReason,
          validationError: err.message || String(err),
        });
      }
      throw err;
    }
    await emit('result.validated', { artifactId: artifact.id, fileId: readable.id || artifact.id, name: readable.name || artifact.name || '', size: readable.size || zip.size || 0, entries: zip.entries || 0, totalUncompressedSize: zip.totalUncompressedSize || 0, sourceClientId });
    const sha256 = zip.sha256 || await sha256File(readable.absolutePath);
    const downloadId = `dl_${operation.id}`;
    const download = await this.metadataStore.createDownload({
      id: downloadId,
      ownerId: operation.id,
      artifactId: artifact.id,
      fileId: readable.id,
      name: readable.name || artifact.name || path.basename(readable.absolutePath),
      mime: readable.mime || 'application/zip',
      size: readable.size || zip.size,
      sha256,
      path: readable.absolutePath,
      metadata: { zip, artifact, selectedBy: artifactSelectionReason || 'turn-aware-zip-artifact', sourceClientId, sourceRequestId: resolvedResponse.requestId || operation.id, sourceTurnKey: artifact.sourceTurnKey || resolvedResponse.turnKey || '' },
    });

    const result = {
      type: 'zip',
      status: 'ready',
      answer: resolvedResponse.answer || resolvedResponse.response || '',
      text: resolvedResponse.answer || resolvedResponse.response || '',
      artifacts,
      artifactId: artifact.id,
      downloadId,
      fileId: readable.id,
      name: download.name,
      mime: download.mime,
      size: download.size,
      sha256,
      downloadUrl: output.downloadUrl || `/turns/${operation.id}/result/download`,
      manifest: zip.files,
      sourceClientId,
      sourceRequestId: resolvedResponse.requestId || operation.id,
      sourceTurnKey: artifact.sourceTurnKey || resolvedResponse.turnKey || resolvedResponse.sourceTurnKey || '',
      sourceTurnIndex: artifact.sourceTurnIndex ?? resolvedResponse.turnIndex ?? -1,
      sourceCandidateIndex: artifact.sourceCandidateIndex ?? resolvedResponse.candidateIndex ?? 0,
      artifactSelectionReason: artifactSelectionReason || 'zip_metadata',
      zip: {
        entries: zip.entries,
        totalUncompressedSize: zip.totalUncompressedSize,
      },
    };
    await emit('result.ready', result);
    return result;
  }

  async #retryArtifactResolution(operation, response = {}, emit) {
    const output = operation.request?.output || {};
    const retries = Math.max(0, Math.min(20, Number(output.artifactResolveRetries ?? config.artifactResolveRetries) || 0));
    if (!retries) return null;

    const turnKey = String(response.turnKey || response.sourceTurnKey || response.assistantTurnKey || '');
    const candidateIndex = positiveNumber(response.candidateIndex || response.sourceCandidateIndex);
    const canReadByTurnKey = turnKey && typeof this.bridge?.recoverResponseByTurnKey === 'function';
    const canReadByCandidate = !turnKey && candidateIndex && typeof this.bridge?.recoverLatestResponse === 'function';
    if (!canReadByTurnKey && !canReadByCandidate) return null;

    const delayMs = Math.max(0, Math.min(10_000, Number(output.artifactResolveRetryDelayMs ?? config.artifactResolveRetryDelayMs) || 0));
    let lastError = null;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      if (delayMs) await sleep(delayMs);
      await emit('result.artifact.retry', {
        attempt,
        maxAttempts: retries,
        turnKey,
        candidateIndex: candidateIndex || 0,
        sourceClientId: response.sourceClientId || '',
      });

      try {
        const fresh = canReadByTurnKey
          ? await this.bridge.recoverResponseByTurnKey({ requestId: operation.id, turnKey, sourceClientId: response.sourceClientId || '', timeoutMs: output.artifactResolveTimeoutMs || 10_000 })
          : await this.bridge.recoverLatestResponse({ requestId: operation.id, index: candidateIndex, sourceClientId: response.sourceClientId || '', timeoutMs: output.artifactResolveTimeoutMs || 10_000 });

        if (turnKey && fresh?.turnKey && fresh.turnKey !== turnKey) {
          await emit('result.artifact.retry_mismatch', { attempt, expectedTurnKey: turnKey, actualTurnKey: fresh.turnKey });
          continue;
        }

        const merged = {
          ...response,
          ...fresh,
          requestId: response.requestId || fresh?.requestId || operation.id,
          id: response.id || fresh?.id || operation.id,
          answer: fresh?.answer || response.answer || response.response || '',
          response: fresh?.response || fresh?.answer || response.response || response.answer || '',
          thinking: fresh?.thinking || response.thinking || '',
          turnKey: response.turnKey || fresh?.turnKey || '',
          sourceClientId: response.sourceClientId || fresh?.sourceClientId || '',
          candidateIndex: response.candidateIndex || fresh?.candidateIndex || candidateIndex || 0,
          artifacts: Array.isArray(fresh?.artifacts) ? fresh.artifacts.map((artifact) => ({ ...artifact, sourceClientId: artifact.sourceClientId || response.sourceClientId || fresh?.sourceClientId || '' })) : [],
        };
        const exactArtifact = selectZipArtifact(merged.artifacts, merged);
        const fallback = exactArtifact?.id ? null : selectMaterializableZipFallback(merged.artifacts, merged);
        const artifact = exactArtifact || fallback?.artifact || null;
        const selectionReason = exactArtifact?.id ? 'artifact_retry_zip_metadata' : fallback?.reason || '';
        if (artifact?.id) {
          await emit('result.artifact.retry_found', { attempt, artifactId: artifact.id, name: artifact.name || '', turnKey: merged.turnKey || '', sourceClientId: merged.sourceClientId || '', selectionReason, artifact: summarizeArtifact(artifact) });
          return { response: merged, artifact, selectionReason };
        }
      } catch (err) {
        lastError = err;
        await emit('result.artifact.retry_error', { attempt, message: err.message || String(err) });
      }
    }

    if (lastError) await emit('result.artifact.retry_exhausted', { message: lastError.message || String(lastError) });
    return null;
  }

  async #event(operationId, type, data = {}, onEvent = null) {
    if (typeof onEvent === 'function') await onEvent(type, data);
    else if (typeof this.metadataStore?.addTurnEvent === 'function') await this.metadataStore.addTurnEvent(operationId, { type, data });
    this.eventBus?.emitUser({ type, requestId: operationId, data: { turnId: operationId, ...data } });
  }
}
