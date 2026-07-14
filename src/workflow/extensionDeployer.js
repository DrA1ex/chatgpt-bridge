import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeZip } from '../zipWriter.js';
import { extractZipFile, validateZipFile } from '../zipUtils.js';

function nowStamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function safeSegment(value) { return String(value || 'extension').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80); }

async function directoryExists(dir) {
  const stat = await fs.stat(dir).catch(() => null);
  return Boolean(stat?.isDirectory());
}

async function readManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!parsed?.version) throw new Error(`Extension manifest has no version: ${file}`);
  return parsed;
}

async function collectTree(root) {
  const entries = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const rel = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`Extension directory contains a symbolic link: ${rel}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) entries.push({ name: rel, path: absolute });
      else throw new Error(`Extension directory contains an unsupported entry: ${rel}`);
    }
  };
  await walk(root);
  return entries;
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

async function atomicReplaceDirectory(targetDir, preparedDir) {
  const parent = path.dirname(targetDir);
  await fs.mkdir(parent, { recursive: true });
  const displacedDir = path.join(parent, `.${path.basename(targetDir)}.previous-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const hadTarget = await directoryExists(targetDir);
  if (hadTarget) await fs.rename(targetDir, displacedDir);
  try {
    await fs.rename(preparedDir, targetDir);
  } catch (error) {
    if (hadTarget) await fs.rename(displacedDir, targetDir).catch(() => {});
    throw error;
  }
  return { hadTarget, displacedDir: hadTarget ? displacedDir : '' };
}

export class ExtensionDeployer {
  constructor({ bridge, event = null, dataDir = '' } = {}) {
    this.bridge = bridge;
    this.event = event;
    this.dataDir = dataDir;
  }

  async prepareBackup(workflow, { pipelineId = 'manual' } = {}) {
    const cfg = workflow.extensionUpdate;
    if (!cfg?.enabled) return { available: false, reason: 'disabled' };
    const targetDir = path.resolve(cfg.targetDir || cfg.sourceDir);
    if (!await directoryExists(targetDir)) return { available: false, reason: 'target-missing', targetDir };
    const manifest = await readManifest(targetDir).catch(() => ({ version: '' }));
    const backupDir = path.join(this.dataDir, 'workflows', workflow.id, 'extension-backups');
    await fs.mkdir(backupDir, { recursive: true });
    const archivePath = path.join(backupDir, `${nowStamp()}-${safeSegment(pipelineId)}-v${safeSegment(manifest.version)}.zip`);
    const entries = await collectTree(targetDir);
    const archive = await writeZip(archivePath, entries);
    await validateZipFile(archivePath, { maxEntries: 20_000, maxUncompressedSize: 512 * 1024 * 1024 });
    await this.#pruneBackups(backupDir, cfg.backupRetention || 5);
    const result = {
      available: true,
      archivePath,
      targetDir,
      manifestVersion: String(manifest.version),
      size: archive.size,
      entries: entries.length,
      createdAt: new Date().toISOString(),
    };
    this.event?.('workflow.extension.backup.created', { pipelineId, ...result });
    return result;
  }

  async deploy(workflow, { sourceClientId = '', pipelineId = 'manual', backup = null } = {}) {
    const cfg = workflow.extensionUpdate;
    if (!cfg.enabled) return { updated: false, reason: 'disabled' };
    const sourceDir = path.resolve(cfg.sourceDir);
    const targetDir = path.resolve(cfg.targetDir || cfg.sourceDir);
    const manifest = await readManifest(sourceDir);
    const preparedBackup = backup || await this.prepareBackup(workflow, { pipelineId });
    let swap = null;
    let deployed = false;
    let stageDir = '';

    if (targetDir !== sourceDir) {
      stageDir = path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.stage-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
      await fs.rm(stageDir, { recursive: true, force: true });
      try {
        await copyTree(sourceDir, stageDir);
        const stagedManifest = await readManifest(stageDir);
        if (String(stagedManifest.version) !== String(manifest.version)) throw new Error('Staged extension manifest version does not match the source');
        swap = await atomicReplaceDirectory(targetDir, stageDir);
        stageDir = '';
        deployed = true;
        this.event?.('workflow.extension.atomic_swap.completed', { pipelineId, sourceDir, targetDir, manifestVersion: manifest.version });
      } catch (error) {
        if (stageDir) await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    }

    try {
      const reload = await this.bridge.reloadExtension({
        sourceClientId,
        reloadTabs: cfg.reloadTabs,
        expectedVersion: manifest.version,
        timeoutMs: cfg.reconnectTimeoutMs,
      });
      if (swap?.displacedDir) await fs.rm(swap.displacedDir, { recursive: true, force: true });
      return {
        updated: true,
        deployed,
        sourceDir,
        targetDir,
        manifestVersion: manifest.version,
        backup: preparedBackup,
        atomic: Boolean(deployed),
        reload,
      };
    } catch (error) {
      let rollback = { attempted: false, ok: false, reason: 'disabled' };
      if (cfg.rollbackOnReloadFailure) {
        rollback = await this.#rollbackDeployment({ workflow, targetDir, swap, backup: preparedBackup, sourceClientId, pipelineId });
      }
      const guidance = deployed
        ? `The previous extension was ${rollback.ok ? 'restored' : 'not restored'} at ${targetDir}.`
        : `The in-place extension directory ${targetDir} was ${rollback.ok ? 'restored from its backup' : 'not restored'}.`;
      const wrapped = new Error(`The unpacked extension did not reconnect as version ${manifest.version}. ${guidance} Cause: ${error.message}`);
      wrapped.cause = error;
      wrapped.extensionRollback = rollback;
      throw wrapped;
    }
  }

  async #rollbackDeployment({ workflow, targetDir, swap, backup, sourceClientId, pipelineId }) {
    const cfg = workflow.extensionUpdate;
    try {
      if (swap?.displacedDir && await directoryExists(swap.displacedDir)) {
        await fs.rm(targetDir, { recursive: true, force: true });
        await fs.rename(swap.displacedDir, targetDir);
      } else if (backup?.available && backup.archivePath) {
        await this.#restoreArchive(backup.archivePath, targetDir);
      } else {
        await fs.rm(targetDir, { recursive: true, force: true });
        return { attempted: true, ok: true, restored: false, reason: 'new-target-removed' };
      }
      let reload = null;
      if (backup?.manifestVersion) {
        reload = await this.bridge.reloadExtension({
          sourceClientId,
          reloadTabs: cfg.reloadTabs,
          expectedVersion: backup.manifestVersion,
          timeoutMs: cfg.reconnectTimeoutMs,
        }).catch((error) => ({ error: error.message || String(error) }));
      }
      const ok = !reload?.error;
      const result = { attempted: true, ok, restored: true, backupArchive: backup?.archivePath || '', manifestVersion: backup?.manifestVersion || '', reload };
      this.event?.(ok ? 'workflow.extension.rollback.completed' : 'workflow.extension.rollback.failed', { pipelineId, ...result });
      return result;
    } catch (error) {
      const result = { attempted: true, ok: false, restored: false, message: error.message || String(error), backupArchive: backup?.archivePath || '' };
      this.event?.('workflow.extension.rollback.failed', { pipelineId, ...result });
      return result;
    }
  }

  async #restoreArchive(archivePath, targetDir) {
    await validateZipFile(archivePath, { maxEntries: 20_000, maxUncompressedSize: 512 * 1024 * 1024 });
    const stageDir = path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.restore-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    await fs.rm(stageDir, { recursive: true, force: true });
    await fs.mkdir(stageDir, { recursive: true });
    await extractZipFile(archivePath, stageDir, { stripCommonRoot: false, conflictPolicy: 'overwrite', maxEntries: 20_000, maxUncompressedSize: 512 * 1024 * 1024 });
    await readManifest(stageDir);
    const swap = await atomicReplaceDirectory(targetDir, stageDir);
    if (swap.displacedDir) await fs.rm(swap.displacedDir, { recursive: true, force: true });
  }

  async #pruneBackups(dir, retention) {
    const files = (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.zip'))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of files.slice(Math.max(1, retention))) await fs.rm(path.join(dir, name), { force: true });
  }
}
