import path from 'node:path';
import { config } from './config.js';
import { validateZipFile, sha256File } from './zipUtils.js';

function looksLikeZipArtifact(artifact = {}) {
  const name = String(artifact.name || artifact.title || artifact.filename || '').toLowerCase();
  const mime = String(artifact.mime || artifact.type || '').toLowerCase();
  const kind = String(artifact.kind || '').toLowerCase();
  return name.endsWith('.zip') || mime.includes('zip') || (kind === 'file' && /zip/.test(name + mime));
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
    const artifacts = Array.isArray(response.artifacts) ? response.artifacts : [];
    const artifact = artifacts.find(looksLikeZipArtifact);
    await this.#event(job.id, 'result.validating', { expected: 'zip', artifactId: artifact?.id || '', artifactCount: artifacts.length });

    if (!artifact?.id) {
      throw resultError('EXPECTED_ZIP_ARTIFACT_NOT_FOUND', 'Expected a .zip artifact, but ChatGPT did not expose a downloadable zip file.', {
        artifacts,
        answerPreview: String(response.answer || '').slice(0, 1000),
      });
    }

    await this.#event(job.id, 'artifact.downloading', { artifactId: artifact.id, name: artifact.name || '' });
    const stored = await this.bridge.fetchArtifact(artifact.id);
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
      metadata: { zip, artifact },
    });

    const result = {
      type: 'zip',
      status: 'ready',
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

  async #event(jobId, type, data = {}) {
    await this.metadataStore.addJobEvent(jobId, { type, data });
    this.eventBus?.emitUser({ type, data: { jobId, ...data } });
  }
}
