import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_EXTENSION_INSTALL_DIRECTORY = path.join(os.homedir(), '.local', 'share', 'chatgpt-bridge', 'extension');

async function directoryExists(dir) {
  const stat = await fs.stat(dir).catch(() => null);
  return Boolean(stat?.isDirectory());
}

async function copyTree(source, target) {
  const stat = await fs.stat(source);
  if (!stat.isDirectory()) throw new Error(`Extension source is not a directory: ${source}`);
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Extension source contains a symbolic link: ${src}`);
    if (entry.isDirectory()) await copyTree(src, dst);
    else if (entry.isFile()) await fs.copyFile(src, dst);
    else throw new Error(`Extension source contains an unsupported entry: ${src}`);
  }
}

async function clearDirectoryContents(target) {
  if (!await directoryExists(target)) return;
  for (const entry of await fs.readdir(target)) {
    await fs.rm(path.join(target, entry), { recursive: true, force: true });
  }
}

async function publishTreeInPlace(source, target, token) {
  await fs.mkdir(target, { recursive: true });
  const sourceNames = new Set();
  const sourceEntries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of sourceEntries) {
    sourceNames.add(entry.name);
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Extension source contains a symbolic link: ${src}`);
    if (entry.isDirectory()) {
      const current = await fs.lstat(dst).catch(() => null);
      if (current && !current.isDirectory()) await fs.rm(dst, { recursive: true, force: true });
      await publishTreeInPlace(src, dst, token);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Extension source contains an unsupported entry: ${src}`);
    const current = await fs.lstat(dst).catch(() => null);
    if (current?.isDirectory()) await fs.rm(dst, { recursive: true, force: true });
    const temporary = `${dst}.bridge-update-${token}`;
    await fs.copyFile(src, temporary);
    await fs.rename(temporary, dst);
  }
  for (const existingName of await fs.readdir(target)) {
    if (sourceNames.has(existingName)) continue;
    await fs.rm(path.join(target, existingName), { recursive: true, force: true });
  }
}

export async function treeFingerprint(root) {
  const hash = crypto.createHash('sha256');
  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`Extension directory contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        hash.update(relative);
        hash.update('\0');
        hash.update(await fs.readFile(absolute));
        hash.update('\0');
      }
    }
  };
  await walk(root);
  return hash.digest('hex');
}

export async function deployBundledExtension(sourceDir, targetDir = DEFAULT_EXTENSION_INSTALL_DIRECTORY) {
  const source = path.resolve(sourceDir);
  const target = path.resolve(targetDir);
  const sourceFingerprint = await treeFingerprint(source);
  if (source === target) {
    return { deployed: false, reason: 'source_is_target', sourceDir: source, targetDir: target, fingerprint: sourceFingerprint };
  }

  const targetExists = await directoryExists(target);
  if (targetExists) {
    const targetFingerprint = await treeFingerprint(target);
    if (targetFingerprint === sourceFingerprint) {
      return { deployed: false, reason: 'unchanged', sourceDir: source, targetDir: target, fingerprint: sourceFingerprint };
    }
  }

  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const token = `${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  const stage = path.join(parent, `.${path.basename(target)}.stage-${token}`);
  const backup = path.join(parent, `.${path.basename(target)}.backup-${token}`);
  await fs.rm(stage, { recursive: true, force: true });
  await fs.rm(backup, { recursive: true, force: true });
  await copyTree(source, stage);
  const stagedFingerprint = await treeFingerprint(stage);
  if (stagedFingerprint !== sourceFingerprint) {
    await fs.rm(stage, { recursive: true, force: true });
    throw new Error('Staged extension fingerprint does not match the bundled source');
  }

  if (targetExists) await copyTree(target, backup);
  try {
    // Preserve the stable install-directory identity that Chrome registered for
    // the unpacked extension. Files are atomically replaced within that root.
    await publishTreeInPlace(stage, target, token);
    const publishedFingerprint = await treeFingerprint(target);
    if (publishedFingerprint !== sourceFingerprint) {
      throw new Error('Published extension fingerprint does not match the bundled source');
    }
  } catch (error) {
    await clearDirectoryContents(target).catch(() => {});
    if (targetExists) await copyTree(backup, target).catch(() => {});
    else await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
  }
  return { deployed: true, reason: targetExists ? 'changed' : 'installed', sourceDir: source, targetDir: target, fingerprint: sourceFingerprint };
}
