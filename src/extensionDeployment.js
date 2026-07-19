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

async function treeFingerprint(root) {
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
    return { deployed: false, sourceDir: source, targetDir: target, fingerprint: sourceFingerprint };
  }

  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const token = `${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  const stage = path.join(parent, `.${path.basename(target)}.stage-${token}`);
  const previous = path.join(parent, `.${path.basename(target)}.previous-${token}`);
  await fs.rm(stage, { recursive: true, force: true });
  await copyTree(source, stage);
  const stagedFingerprint = await treeFingerprint(stage);
  if (stagedFingerprint !== sourceFingerprint) {
    await fs.rm(stage, { recursive: true, force: true });
    throw new Error('Staged extension fingerprint does not match the bundled source');
  }

  const hadTarget = await directoryExists(target);
  if (hadTarget) await fs.rename(target, previous);
  try {
    await fs.rename(stage, target);
  } catch (error) {
    if (hadTarget) await fs.rename(previous, target).catch(() => {});
    throw error;
  }
  await fs.rm(previous, { recursive: true, force: true }).catch(() => {});
  return { deployed: true, sourceDir: source, targetDir: target, fingerprint: sourceFingerprint };
}
