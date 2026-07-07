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
      const fileBlocks = extractFileBlocks(response.answer || response.response || '');
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
          answer: response.answer || response.response || '',
          text: response.answer || response.response || '',
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
      answer: response.answer || response.response || '',
      text: response.answer || response.response || '',
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

  async #event(jobId, type, data = {}) {
    await this.metadataStore.addJobEvent(jobId, { type, data });
    this.eventBus?.emitUser({ type, data: { jobId, ...data } });
  }
}
