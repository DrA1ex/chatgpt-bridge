import fs from 'node:fs/promises';
import path from 'node:path';

async function copyTree(source, target) {
  const stat = await fs.stat(source);
  if (!stat.isDirectory()) throw new Error(`Extension source is not a directory: ${source}`);
  await fs.mkdir(target, { recursive: true });
  const sourceNames = new Set();
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    sourceNames.add(entry.name);
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) await copyTree(src, dst);
    else if (entry.isFile()) await fs.copyFile(src, dst);
  }
  for (const entry of await fs.readdir(target, { withFileTypes: true }).catch(() => [])) {
    if (!sourceNames.has(entry.name)) await fs.rm(path.join(target, entry.name), { recursive: true, force: true });
  }
}

export class ExtensionDeployer {
  constructor({ bridge, event = null } = {}) {
    this.bridge = bridge;
    this.event = event;
  }

  async deploy(workflow, { sourceClientId = '' } = {}) {
    const cfg = workflow.extensionUpdate;
    if (!cfg.enabled) return { updated: false, reason: 'disabled' };
    const manifestPath = path.join(cfg.sourceDir, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    let targetDir = cfg.targetDir;
    let deployed = false;
    if (targetDir && path.resolve(targetDir) !== path.resolve(cfg.sourceDir)) {
      await fs.mkdir(path.dirname(targetDir), { recursive: true });
      await copyTree(cfg.sourceDir, targetDir);
      deployed = true;
    } else {
      targetDir = cfg.sourceDir;
    }
    let reload;
    try {
      reload = await this.bridge.reloadExtension({
        sourceClientId,
        reloadTabs: cfg.reloadTabs,
        expectedVersion: manifest.version,
        timeoutMs: cfg.reconnectTimeoutMs,
      });
    } catch (error) {
      const guidance = deployed
        ? `Load ${targetDir} once from chrome://extensions, then future updates can reload automatically.`
        : `Confirm that Chrome loaded the unpacked extension from ${targetDir}; the source files were updated, but another extension directory may still be active.`;
      const wrapped = new Error(`The unpacked extension did not reconnect as version ${manifest.version}. ${guidance} Cause: ${error.message}`);
      wrapped.cause = error;
      throw wrapped;
    }
    return { updated: true, deployed, sourceDir: cfg.sourceDir, targetDir, manifestVersion: manifest.version, reload };
  }
}
