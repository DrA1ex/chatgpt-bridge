import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { crc32 } from './zipWriter.js';

function readUInt32LE(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) return 0;
  return buffer.readUInt32LE(offset);
}

function readUInt16LE(buffer, offset) {
  if (offset < 0 || offset + 2 > buffer.length) return 0;
  return buffer.readUInt16LE(offset);
}

function isUnsafeZipPath(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) return true;
  const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  if (!trimmed) return true;
  return trimmed.split('/').some((part) => part === '..' || part === '');
}

export async function sha256File(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function parseZipBuffer(buffer, options = {}) {
  const maxEntries = Number(options.maxEntries) || 5000;
  const maxUncompressedSize = Number(options.maxUncompressedSize) || 500 * 1024 * 1024;
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('ZIP_VALIDATION_FAILED: file does not start with a ZIP local header');
  }

  const minEocd = Math.max(0, buffer.length - 22 - 65535);
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= minEocd; i -= 1) {
    if (readUInt32LE(buffer, i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('ZIP_VALIDATION_FAILED: end of central directory not found');

  const entryCount = readUInt16LE(buffer, eocdOffset + 10);
  const centralDirSize = readUInt32LE(buffer, eocdOffset + 12);
  const centralDirOffset = readUInt32LE(buffer, eocdOffset + 16);
  if (!entryCount || entryCount > maxEntries) throw new Error(`ZIP_VALIDATION_FAILED: invalid entry count ${entryCount}`);
  if (centralDirOffset + centralDirSize > buffer.length) throw new Error('ZIP_VALIDATION_FAILED: central directory is outside the file');

  const files = [];
  let offset = centralDirOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32LE(buffer, offset) !== 0x02014b50) throw new Error('ZIP_VALIDATION_FAILED: invalid central directory header');
    const flags = readUInt16LE(buffer, offset + 8);
    const compressionMethod = readUInt16LE(buffer, offset + 10);
    const crc = readUInt32LE(buffer, offset + 16);
    const compressedSize = readUInt32LE(buffer, offset + 20);
    const uncompressedSize = readUInt32LE(buffer, offset + 24);
    const nameLength = readUInt16LE(buffer, offset + 28);
    const extraLength = readUInt16LE(buffer, offset + 30);
    const commentLength = readUInt16LE(buffer, offset + 32);
    const externalAttrs = readUInt32LE(buffer, offset + 38);
    const localHeaderOffset = readUInt32LE(buffer, offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) throw new Error('ZIP_VALIDATION_FAILED: file name outside archive');
    const name = buffer.slice(nameStart, nameEnd).toString(flags & 0x0800 ? 'utf8' : 'utf8');
    if (isUnsafeZipPath(name)) throw new Error(`ZIP_VALIDATION_FAILED: unsafe path in zip: ${name}`);
    const unixMode = (externalAttrs >>> 16) & 0o170000;
    if (unixMode === 0o120000) throw new Error(`ZIP_VALIDATION_FAILED: symlink entry is not allowed: ${name}`);
    if (compressionMethod !== 0 && compressionMethod !== 8) throw new Error(`ZIP_VALIDATION_FAILED: unsupported compression method ${compressionMethod} for ${name}`);

    const isDir = name.endsWith('/');
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > maxUncompressedSize) throw new Error('ZIP_VALIDATION_FAILED: uncompressed size limit exceeded');
    files.push({
      path: name,
      directory: isDir,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      crc32: crc,
      localHeaderOffset,
    });
    offset = nameEnd + extraLength + commentLength;
  }

  return { files, totalUncompressedSize: totalUncompressed };
}

function isMetadataOnlyTopLevel(name) {
  const top = String(name || '').replace(/\\/g, '/').split('/').filter(Boolean)[0] || '';
  return top === '.bridge' || top === '.git' || top === 'node_modules';
}

function commonTopLevelPrefix(files) {
  const regular = files
    .filter((file) => !file.directory)
    .map((file) => String(file.path || '').replace(/\\/g, '/'))
    .filter(Boolean);
  if (!regular.length) return '';

  const applyRegular = regular.filter((name) => !isMetadataOnlyTopLevel(name));
  if (!applyRegular.length) return '';

  // ChatGPT often mirrors the input snapshot shape and returns project/... plus
  // root .bridge metadata. In that case .bridge should not prevent treating
  // project/ as the output root fallback.
  if (applyRegular.every((name) => name.startsWith('project/') && name.split('/').length >= 2)) return 'project/';

  const firstParts = applyRegular[0].split('/');
  if (firstParts.length < 2) return '';
  const top = firstParts[0];
  if (!top || top.startsWith('.')) return '';
  return applyRegular.every((name) => name.split('/')[0] === top && name.includes('/')) ? `${top}/` : '';
}

function normalizeApplyPath(name, stripPrefix = '') {
  let normalized = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (stripPrefix && normalized.startsWith(stripPrefix)) normalized = normalized.slice(stripPrefix.length);
  normalized = normalized.split('/').filter((part) => part && part !== '.' && part !== '..').join('/');
  return normalized;
}

function shouldSkipApplyPath(rel, options = {}) {
  const parts = String(rel || '').split('/').filter(Boolean);
  if (!parts.length) return 'empty-path';
  if (parts[0] === '.git') return 'git-internals';
  if (parts[0] === '.bridge') return 'bridge-metadata';
  if (parts.includes('node_modules')) return 'node_modules';
  if (Array.isArray(options.skipTopLevel) && options.skipTopLevel.includes(parts[0])) return `skip:${parts[0]}`;
  return '';
}

function entryData(buffer, entry) {
  const localOffset = entry.localHeaderOffset;
  if (readUInt32LE(buffer, localOffset) !== 0x04034b50) throw new Error(`ZIP_EXTRACTION_FAILED: invalid local header for ${entry.path}`);
  const nameLength = readUInt16LE(buffer, localOffset + 26);
  const extraLength = readUInt16LE(buffer, localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) throw new Error(`ZIP_EXTRACTION_FAILED: data outside archive for ${entry.path}`);
  const compressed = buffer.slice(dataStart, dataEnd);
  let data;
  if (entry.compressionMethod === 0) data = compressed;
  else if (entry.compressionMethod === 8) data = zlib.inflateRawSync(compressed);
  else throw new Error(`ZIP_EXTRACTION_FAILED: unsupported compression method ${entry.compressionMethod} for ${entry.path}`);
  if (data.length !== entry.uncompressedSize) throw new Error(`ZIP_EXTRACTION_FAILED: size mismatch for ${entry.path}`);
  if (crc32(data) !== entry.crc32) throw new Error(`ZIP_EXTRACTION_FAILED: CRC mismatch for ${entry.path}`);
  return data;
}

export async function validateZipFile(filePath, options = {}) {
  const buffer = await fs.readFile(filePath);
  const parsed = parseZipBuffer(buffer, options);
  return {
    ok: true,
    size: buffer.length,
    entries: parsed.files.length,
    totalUncompressedSize: parsed.totalUncompressedSize,
    files: parsed.files.map(({ path: name, directory, compressedSize, uncompressedSize }) => ({ path: name, directory, compressedSize, uncompressedSize })),
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    name: path.basename(filePath),
  };
}

function normalizeSelectedPaths(value) {
  if (!value) return null;
  if (value instanceof Set) return new Set(Array.from(value).map((item) => normalizeApplyPath(item)).filter(Boolean));
  if (Array.isArray(value)) return new Set(value.map((item) => normalizeApplyPath(item)).filter(Boolean));
  if (typeof value === 'object') {
    return new Set(Object.entries(value).filter(([, enabled]) => enabled).map(([key]) => normalizeApplyPath(key)).filter(Boolean));
  }
  return null;
}

export async function extractZipFile(filePath, targetDir, options = {}) {
  const buffer = await fs.readFile(filePath);
  const parsed = parseZipBuffer(buffer, options);
  const root = path.resolve(targetDir);
  const stripPrefix = options.stripCommonRoot === false ? '' : commonTopLevelPrefix(parsed.files);
  const dryRun = Boolean(options.dryRun);
  const conflictPolicy = options.conflictPolicy || 'overwrite';
  const selectedConflictPaths = normalizeSelectedPaths(options.selectedConflictPaths || options.selectedPaths);
  const written = [];
  const skipped = [];

  for (const entry of parsed.files) {
    if (entry.directory) continue;
    const rel = normalizeApplyPath(entry.path, stripPrefix);
    const skipReason = shouldSkipApplyPath(rel, options);
    if (skipReason) {
      skipped.push({ path: entry.path, targetPath: rel, reason: skipReason });
      continue;
    }
    const absolute = path.resolve(root, rel);
    const relativeToRoot = path.relative(root, absolute);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      throw new Error(`ZIP_EXTRACTION_FAILED: unsafe target path: ${entry.path}`);
    }
    const stat = await fs.stat(absolute).catch(() => null);
    const conflict = Boolean(stat?.isFile() || stat?.isDirectory());
    let data = null;
    let sha256 = '';
    if (dryRun) {
      data = entryData(buffer, entry);
      sha256 = crypto.createHash('sha256').update(data).digest('hex');
    }
    if (!dryRun && conflict) {
      if (conflictPolicy === 'error') throw new Error(`ZIP_EXTRACTION_FAILED: target already exists: ${rel}`);
      if (conflictPolicy === 'skip' || (selectedConflictPaths && !selectedConflictPaths.has(rel))) {
        skipped.push({ path: entry.path, targetPath: rel, reason: 'conflict-skipped' });
        continue;
      }
      if (stat?.isDirectory()) throw new Error(`ZIP_EXTRACTION_FAILED: target path is a directory: ${rel}`);
    }
    written.push({ path: rel, sourcePath: entry.path, absolutePath: absolute, size: entry.uncompressedSize, conflict, ...(sha256 ? { sha256 } : {}) });
    if (!dryRun) {
      data = entryData(buffer, entry);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, data);
    }
  }

  return {
    ok: true,
    dryRun,
    targetDir: root,
    stripPrefix,
    written,
    skipped,
    zip: {
      entries: parsed.files.length,
      totalUncompressedSize: parsed.totalUncompressedSize,
      size: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      name: path.basename(filePath),
    },
  };
}
