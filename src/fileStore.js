import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { config } from './config.js';

function safeName(name = 'file') {
  return String(name || 'file')
    .replace(/[\\/\0]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'file';
}

function extensionFromName(name) {
  const ext = path.extname(name || '').replace(/[^.a-zA-Z0-9_-]/g, '');
  return ext.slice(0, 20);
}

function safeStoredId(id = 'file') {
  return String(id || 'file').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 140) || 'file';
}

function decodeContent({ contentBase64, content }) {
  if (typeof contentBase64 === 'string' && contentBase64) return Buffer.from(contentBase64, 'base64');
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  return Buffer.alloc(0);
}

export class FileStore {
  constructor(rootDir = config.dataDir) {
    this.rootDir = rootDir;
    this.filesDir = path.join(rootDir, 'files');
    this.artifactsDir = path.join(rootDir, 'artifacts');
    this.indexPath = path.join(rootDir, 'index.json');
    this.index = { files: {}, artifacts: {} };
    this.ready = this.#init();
  }

  async #init() {
    await fs.mkdir(this.filesDir, { recursive: true });
    await fs.mkdir(this.artifactsDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.index = {
        files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
        artifacts: parsed.artifacts && typeof parsed.artifacts === 'object' ? parsed.artifacts : {},
      };
    } catch {
      await this.#saveIndex();
    }
  }

  async #saveIndex() {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(this.indexPath, JSON.stringify(this.index, null, 2), 'utf8');
  }

  async putUpload({ name, mime = 'application/octet-stream', contentBase64 = '', content = '', source = 'api' }) {
    await this.ready;
    const fileName = safeName(name);
    const buffer = decodeContent({ contentBase64, content });
    const id = `file_${crypto.randomBytes(10).toString('hex')}`;
    const ext = extensionFromName(fileName);
    const storedName = `${safeStoredId(id)}${ext}`;
    const absolutePath = path.join(this.filesDir, storedName);
    await fs.writeFile(absolutePath, buffer);

    const record = {
      id,
      kind: 'upload',
      name: fileName,
      mime: mime || 'application/octet-stream',
      size: buffer.length,
      path: absolutePath,
      createdAt: new Date().toISOString(),
      source,
    };

    this.index.files[id] = record;
    await this.#saveIndex();
    return this.#publicRecord(record);
  }

  async importLocalPath({ filePath, name, mime = 'application/octet-stream' }) {
    await this.ready;
    const absoluteSource = path.resolve(filePath || '');
    const stat = await fs.stat(absoluteSource);
    if (!stat.isFile()) throw new Error(`Not a file: ${absoluteSource}`);
    const fileName = safeName(name || path.basename(absoluteSource));
    const id = `file_${crypto.randomBytes(10).toString('hex')}`;
    const ext = extensionFromName(fileName);
    const storedName = `${safeStoredId(id)}${ext}`;
    const absolutePath = path.join(this.filesDir, storedName);
    await fs.copyFile(absoluteSource, absolutePath);

    const record = {
      id,
      kind: 'upload',
      name: fileName,
      mime: mime || 'application/octet-stream',
      size: stat.size,
      path: absolutePath,
      createdAt: new Date().toISOString(),
      source: 'local-path',
    };

    this.index.files[id] = record;
    await this.#saveIndex();
    return this.#publicRecord(record);
  }


  async importArtifactPath({ artifactId, filePath, name, mime = 'application/octet-stream', source = {}, metadata = {} }) {
    await this.ready;
    const absoluteSource = path.resolve(filePath || '');
    const stat = await fs.stat(absoluteSource);
    if (!stat.isFile()) throw new Error(`Not a file: ${absoluteSource}`);
    const fileName = safeName(name || path.basename(absoluteSource));
    const id = artifactId || `artifact_${crypto.randomBytes(10).toString('hex')}`;
    const ext = extensionFromName(fileName);
    const storedName = `${safeStoredId(id)}${ext}`;
    const absolutePath = path.join(this.artifactsDir, storedName);
    await fs.copyFile(absoluteSource, absolutePath);

    const record = {
      id,
      kind: 'artifact',
      name: fileName,
      mime: mime || 'application/octet-stream',
      size: stat.size,
      path: absolutePath,
      createdAt: new Date().toISOString(),
      source,
      metadata,
    };

    this.index.artifacts[id] = record;
    await this.#saveIndex();
    return this.#publicRecord(record);
  }

  async putArtifact({ artifactId, name, mime = 'application/octet-stream', contentBase64, content, source = {}, metadata = {} }) {
    await this.ready;
    const buffer = decodeContent({ contentBase64, content });
    const fileName = safeName(name || artifactId || 'artifact');
    const id = artifactId || `artifact_${crypto.randomBytes(10).toString('hex')}`;
    const ext = extensionFromName(fileName);
    const storedName = `${safeStoredId(id)}${ext}`;
    const absolutePath = path.join(this.artifactsDir, storedName);
    await fs.writeFile(absolutePath, buffer);

    const record = {
      id,
      kind: 'artifact',
      name: fileName,
      mime: mime || 'application/octet-stream',
      size: buffer.length,
      path: absolutePath,
      createdAt: new Date().toISOString(),
      source,
      metadata,
    };

    this.index.artifacts[id] = record;
    await this.#saveIndex();
    return this.#publicRecord(record);
  }

  async readForTransport(fileId) {
    await this.ready;
    const record = this.index.files[fileId] || this.index.artifacts[fileId];
    if (!record) throw new Error(`File not found: ${fileId}`);
    const buffer = await fs.readFile(record.path);
    return {
      id: record.id,
      name: record.name,
      mime: record.mime || 'application/octet-stream',
      size: record.size,
      contentBase64: buffer.toString('base64'),
    };
  }

  async get(fileId) {
    await this.ready;
    const record = this.index.files[fileId] || this.index.artifacts[fileId];
    if (!record) return null;
    return this.#publicRecord(record);
  }

  async getReadable(fileId) {
    await this.ready;
    const record = this.index.files[fileId] || this.index.artifacts[fileId];
    if (!record) return null;
    return {
      ...this.#publicRecord(record),
      stream: createReadStream(record.path),
      absolutePath: record.path,
    };
  }

  async listFiles() {
    await this.ready;
    return Object.values(this.index.files).map((record) => this.#publicRecord(record));
  }

  async listArtifacts() {
    await this.ready;
    return Object.values(this.index.artifacts).map((record) => this.#publicRecord(record));
  }

  async remove(fileId) {
    await this.ready;
    const record = this.index.files[fileId] || this.index.artifacts[fileId];
    if (!record) return false;
    delete this.index.files[fileId];
    delete this.index.artifacts[fileId];
    try {
      await fs.unlink(record.path);
    } catch {
      // ignore missing files; remove the index entry anyway
    }
    await this.#saveIndex();
    return true;
  }

  #publicRecord(record) {
    return {
      id: record.id,
      kind: record.kind,
      name: record.name,
      mime: record.mime,
      size: record.size,
      createdAt: record.createdAt,
      source: record.source,
      metadata: record.metadata,
    };
  }
}
