import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { validateZipFile, sha256File } from './zipUtils.js';
import { writeZip } from './zipWriter.js';


function safeBlockPath(name = '') {
  const raw = String(name || '').trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw.includes('\0')) return '';
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return '';
  if (/^[a-zA-Z]:/.test(parts[0])) return '';
  if (parts[0] === '.git' || parts.includes('node_modules')) return '';
  return parts.join('/');
}

function extractFileBlocks(answer = '') {
  const text = String(answer || '');
  const blocks = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(text))) {
    const info = String(match[1] || '').trim();
    const body = String(match[2] || '').replace(/\n$/, '');
    const fileMatch = info.match(/^(?:file|path)\s*:\s*(.+)$/i) || info.match(/^([^\s`]+\.[A-Za-z0-9._-]{1,12})$/);
    if (!fileMatch) continue;
    const name = safeBlockPath(fileMatch[1]);
    if (!name) continue;
    blocks.push({ name, data: Buffer.from(body, 'utf8') });
  }
  return blocks;
}

function looksLikeZipArtifact(artifact = {}) {
  const name = String(artifact.name || artifact.title || artifact.filename || '').toLowerCase();
  const mime = String(artifact.mime || artifact.type || '').toLowerCase();
  const kind = String(artifact.kind || '').toLowerCase();
  return name.endsWith('.zip') || mime.includes('zip') || (kind === 'file' && /zip/.test(name + mime));
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function artifactMatchesResponseScope(artifact = {}, response = {}) {
  const responseRequestId = String(response.requestId || '');
  const artifactRequestId = String(artifact.requestId || '');
  if (responseRequestId && artifactRequestId && artifactRequestId !== responseRequestId) return false;

  const responseTurnKey = String(response.turnKey || response.sourceTurnKey || response.assistantTurnKey || '');
  const artifactTurnKey = String(artifact.sourceTurnKey || artifact.turnKey || artifact.assistantTurnKey || '');
  if (responseTurnKey && artifactTurnKey && artifactTurnKey !== responseTurnKey) return false;

  const responseCandidateIndex = positiveNumber(response.candidateIndex || response.sourceCandidateIndex);
  const artifactCandidateIndex = positiveNumber(artifact.sourceCandidateIndex || artifact.candidateIndex);
  if (responseCandidateIndex && artifactCandidateIndex && artifactCandidateIndex !== responseCandidateIndex) return false;

  const responseHasScope = Boolean(responseRequestId || responseTurnKey || responseCandidateIndex);
  const artifactHasScope = Boolean(artifactRequestId || artifactTurnKey || artifactCandidateIndex);
  if (responseHasScope && !artifactHasScope) return false;

  return true;
}

function artifactSelectionScore(artifact = {}, response = {}) {
  if (!looksLikeZipArtifact(artifact) || !artifactMatchesResponseScope(artifact, response)) return Number.NEGATIVE_INFINITY;
  let score = 0;
  const responseTurnKey = String(response.turnKey || response.sourceTurnKey || response.assistantTurnKey || '');
  const artifactTurnKey = String(artifact.sourceTurnKey || artifact.turnKey || artifact.assistantTurnKey || '');
  if (responseTurnKey && artifactTurnKey === responseTurnKey) score += 1000;
  const responseRequestId = String(response.requestId || '');
  if (artifact.requestId && responseRequestId && artifact.requestId === responseRequestId) score += 500;
  const responseCandidateIndex = positiveNumber(response.candidateIndex || response.sourceCandidateIndex);
  const artifactCandidateIndex = positiveNumber(artifact.sourceCandidateIndex || artifact.candidateIndex);
  if (responseCandidateIndex && artifactCandidateIndex === responseCandidateIndex) score += 250;
  if (artifact.kind === 'file' || artifact.kind === 'action') score += 10;
  if (String(artifact.name || '').toLowerCase().endsWith('.zip')) score += 5;
  const turnIndex = Number(artifact.sourceTurnIndex);
  if (Number.isFinite(turnIndex)) score += Math.max(0, Math.min(50, turnIndex));
  return score;
}

function selectZipArtifact(artifacts = [], response = {}) {
  return artifacts
    .filter((artifact) => looksLikeZipArtifact(artifact) && artifactMatchesResponseScope(artifact, response))
    .map((artifact, index) => ({ artifact, index, score: artifactSelectionScore(artifact, response) }))
    .sort((a, b) => b.score - a.score || b.index - a.index)[0]?.artifact || null;
}

function sleep(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (!delay) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function resultError(code, message, extra = {}) {
  const err = new Error(message || code);
  err.code = code;
  err.statusCode = extra.statusCode || 422;
  err.extra = extra;
  return err;
}

export class ResultResolver {
  constructor({ bridge, fileStore, metadataStore, eventBus }) {
    this.bridge = bridge;
    this.fileStore = fileStore;
    this.metadataStore = metadataStore;
    this.eventBus = eventBus;
  }

  async resolve(job, response) {
    const output = job.request?.output || {};
    const expected = String(output.expected || output.format || '').toLowerCase();
    if (!expected || expected === 'text') {
      return { type: 'text', text: response.answer || '', artifacts: response.artifacts || [] };
    }
    if (expected !== 'zip') {
      return { type: expected, text: response.answer || '', artifacts: response.artifacts || [], warning: `No resolver for expected output: ${expected}` };
    }
    return await this.resolveZip(job, response);
  }

  async resolveZip(job, response) {
    const output = job.request?.output || {};
    let resolvedResponse = response || {};
    let artifacts = Array.isArray(resolvedResponse.artifacts) ? resolvedResponse.artifacts : [];
    let artifact = selectZipArtifact(artifacts, resolvedResponse);
    await this.#event(job.id, 'result.validating', { expected: 'zip', artifactId: artifact?.id || '', artifactCount: artifacts.length });

    if (!artifact?.id) {
      const refreshed = await this.#retryArtifactResolution(job, resolvedResponse);
      if (refreshed?.artifact?.id) {
        resolvedResponse = refreshed.response;
        artifacts = Array.isArray(resolvedResponse.artifacts) ? resolvedResponse.artifacts : [];
        artifact = refreshed.artifact;
      }
    }

    if (!artifact?.id) {
      const fileBlocks = extractFileBlocks(resolvedResponse.answer || resolvedResponse.response || '');
      if (fileBlocks.length) {
        await this.#event(job.id, 'result.reconstructing_from_file_blocks', { count: fileBlocks.length });
        const generatedDir = path.join(config.dataDir, 'generated-results');
        await fs.mkdir(generatedDir, { recursive: true });
        const zipPath = path.join(generatedDir, `${job.id || 'result'}-${Date.now()}.zip`);
        const zip = await writeZip(zipPath, fileBlocks);
        const imported = await this.fileStore.importArtifactPath({
          artifactId: `reconstructed_${job.id}`,
          filePath: zip.path,
          name: `recovered-${job.id || 'result'}.zip`,
          mime: 'application/zip',
          source: { type: 'file-blocks', jobId: job.id || '' },
          metadata: { reconstructed: true, entries: fileBlocks.map((entry) => entry.name) },
        });
        const readable = await this.fileStore.getReadable(imported.id);
        if (!readable?.absolutePath) throw resultError('RECONSTRUCTED_ZIP_NOT_READABLE', `Reconstructed ZIP is not readable: ${imported.id}`);
        const validated = await validateZipFile(readable.absolutePath, {
          maxEntries: config.zipMaxEntries,
          maxUncompressedSize: config.zipMaxUncompressedSize,
          ...(job.request?.zipValidation || {}),
        });
        const sha256 = validated.sha256 || await sha256File(readable.absolutePath);
        const downloadId = `dl_${job.id}`;
        const download = await this.metadataStore.createDownload({
          id: downloadId,
          jobId: job.id,
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
          downloadUrl: output.downloadUrl || `/jobs/${job.id}/result/download`,
          manifest: validated.files,
          zip: { entries: validated.entries, totalUncompressedSize: validated.totalUncompressedSize },
          reconstructedFrom: 'file-blocks',
        };
        await this.#event(job.id, 'result.ready', result);
        return result;
      }
      throw resultError('EXPECTED_ZIP_ARTIFACT_NOT_FOUND', 'Expected a .zip artifact or fenced ```file:path``` blocks, but ChatGPT did not expose either.', {
        artifacts,
        answerPreview: String(resolvedResponse.answer || '').slice(0, 1000),
      });
    }

    const sourceClientId = String(artifact.sourceClientId || resolvedResponse.sourceClientId || response?.sourceClientId || '');
    await this.#event(job.id, 'artifact.downloading', { artifactId: artifact.id, name: artifact.name || '', sourceTurnKey: artifact.sourceTurnKey || '', sourceTurnIndex: artifact.sourceTurnIndex ?? -1, sourceClientId });
    const stored = await this.bridge.fetchArtifact(artifact.id, { force: Boolean(output.forceArtifactDownload || output.forceDownload), sourceClientId });
    await this.#event(job.id, 'artifact.downloaded', { artifactId: artifact.id, fileId: stored.id || artifact.id, name: stored.name || artifact.name || '', size: stored.size || 0 });
    const readable = await this.fileStore.getReadable(stored.id || artifact.id);
    if (!readable?.absolutePath) throw resultError('ARTIFACT_DOWNLOAD_FAILED', `Downloaded artifact is not readable: ${artifact.id}`);

    const zip = await validateZipFile(readable.absolutePath, {
      maxEntries: config.zipMaxEntries,
      maxUncompressedSize: config.zipMaxUncompressedSize,
      ...(job.request?.zipValidation || {}),
    });
    const sha256 = zip.sha256 || await sha256File(readable.absolutePath);
    const downloadId = `dl_${job.id}`;
    const download = await this.metadataStore.createDownload({
      id: downloadId,
      jobId: job.id,
      artifactId: artifact.id,
      fileId: readable.id,
      name: readable.name || artifact.name || path.basename(readable.absolutePath),
      mime: readable.mime || 'application/zip',
      size: readable.size || zip.size,
      sha256,
      path: readable.absolutePath,
      metadata: { zip, artifact, selectedBy: 'turn-aware-zip-artifact' },
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
      downloadUrl: output.downloadUrl || `/jobs/${job.id}/result/download`,
      manifest: zip.files,
      zip: {
        entries: zip.entries,
        totalUncompressedSize: zip.totalUncompressedSize,
      },
    };
    await this.#event(job.id, 'result.ready', result);
    return result;
  }

  async #retryArtifactResolution(job, response = {}) {
    const output = job.request?.output || {};
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
      await this.#event(job.id, 'result.artifact.retry', {
        attempt,
        maxAttempts: retries,
        turnKey,
        candidateIndex: candidateIndex || 0,
      });

      try {
        const fresh = canReadByTurnKey
          ? await this.bridge.recoverResponseByTurnKey({ requestId: job.id, turnKey, sourceClientId: response.sourceClientId || '', timeoutMs: output.artifactResolveTimeoutMs || 10_000 })
          : await this.bridge.recoverLatestResponse({ requestId: job.id, index: candidateIndex, sourceClientId: response.sourceClientId || '', timeoutMs: output.artifactResolveTimeoutMs || 10_000 });

        if (turnKey && fresh?.turnKey && fresh.turnKey !== turnKey) {
          await this.#event(job.id, 'result.artifact.retry_mismatch', { attempt, expectedTurnKey: turnKey, actualTurnKey: fresh.turnKey });
          continue;
        }

        const merged = {
          ...response,
          ...fresh,
          requestId: response.requestId || fresh?.requestId || job.id,
          id: response.id || fresh?.id || job.id,
          answer: fresh?.answer || response.answer || response.response || '',
          response: fresh?.response || fresh?.answer || response.response || response.answer || '',
          thinking: fresh?.thinking || response.thinking || '',
          turnKey: response.turnKey || fresh?.turnKey || '',
          sourceClientId: response.sourceClientId || fresh?.sourceClientId || '',
          candidateIndex: response.candidateIndex || fresh?.candidateIndex || candidateIndex || 0,
          artifacts: Array.isArray(fresh?.artifacts) ? fresh.artifacts.map((artifact) => ({ ...artifact, sourceClientId: artifact.sourceClientId || response.sourceClientId || fresh?.sourceClientId || '' })) : [],
        };
        const artifact = selectZipArtifact(merged.artifacts, merged);
        if (artifact?.id) {
          await this.#event(job.id, 'result.artifact.retry_found', { attempt, artifactId: artifact.id, name: artifact.name || '', turnKey: merged.turnKey || '' });
          return { response: merged, artifact };
        }
      } catch (err) {
        lastError = err;
        await this.#event(job.id, 'result.artifact.retry_error', { attempt, message: err.message || String(err) });
      }
    }

    if (lastError) await this.#event(job.id, 'result.artifact.retry_exhausted', { message: lastError.message || String(lastError) });
    return null;
  }

  async #event(jobId, type, data = {}) {
    await this.metadataStore.addJobEvent(jobId, { type, data });
    this.eventBus?.emitUser({ type, data: { jobId, ...data } });
  }
}
