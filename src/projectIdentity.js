import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const PROJECT_IDENTITY_RELATIVE_PATH = '.bridge/PROJECT_ID.json';
export const PROJECT_FINGERPRINT_RELATIVE_PATH = '.bridge/PROJECT_FINGERPRINT.json';

function nowIso() { return new Date().toISOString(); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function posix(value) { return String(value || '').split(path.sep).join('/'); }

async function readJson(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return null; }
}

async function packageNameFor(root) {
  const pkg = await readJson(path.join(root, 'package.json'));
  return typeof pkg?.name === 'string' ? pkg.name : '';
}

export async function ensureProjectIdentity(projectRoot, { projectName = '', packageName = '' } = {}) {
  const root = path.resolve(projectRoot || '');
  if (!root) throw new Error('projectRoot is required to create a project identity');
  const identityPath = path.join(root, PROJECT_IDENTITY_RELATIVE_PATH);
  const existing = await readJson(identityPath);
  if (typeof existing?.projectId === 'string' && existing.projectId.trim()) {
    return { ...existing, path: identityPath, relativePath: PROJECT_IDENTITY_RELATIVE_PATH };
  }
  const identity = {
    version: 1,
    projectId: `bridge-project-${crypto.randomUUID()}`,
    projectName: projectName || path.basename(root) || 'project',
    packageName: packageName || await packageNameFor(root),
    createdAt: nowIso(),
  };
  await fs.mkdir(path.dirname(identityPath), { recursive: true });
  const tempPath = `${identityPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fs.writeFile(tempPath, `${JSON.stringify(identity, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.rename(tempPath, identityPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    const raced = await readJson(identityPath);
    if (typeof raced?.projectId === 'string' && raced.projectId.trim()) {
      return { ...raced, path: identityPath, relativePath: PROJECT_IDENTITY_RELATIVE_PATH };
    }
    throw error;
  }
  return { ...identity, path: identityPath, relativePath: PROJECT_IDENTITY_RELATIVE_PATH };
}

export async function readProjectIdentity(projectRoot) {
  const root = path.resolve(projectRoot || '');
  const identityPath = path.join(root, PROJECT_IDENTITY_RELATIVE_PATH);
  const identity = await readJson(identityPath);
  return typeof identity?.projectId === 'string' && identity.projectId.trim()
    ? { ...identity, path: identityPath, relativePath: PROJECT_IDENTITY_RELATIVE_PATH }
    : null;
}

export async function buildProjectFingerprint(projectRoot, {
  identity = null,
  files = ['package.json', 'AGENT.MD', 'AGENTS.md', 'README.md'],
  maxFileBytes = 512 * 1024,
} = {}) {
  const root = path.resolve(projectRoot || '');
  const projectIdentity = identity || await ensureProjectIdentity(root);
  const entries = [];
  for (const requested of Array.from(new Set(files.map(posix).filter(Boolean)))) {
    if (requested === PROJECT_IDENTITY_RELATIVE_PATH || requested === PROJECT_FINGERPRINT_RELATIVE_PATH) continue;
    const absolute = path.resolve(root, requested);
    if (!(absolute === root || absolute.startsWith(`${root}${path.sep}`))) continue;
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile() || stat.size > maxFileBytes) continue;
    const data = await fs.readFile(absolute);
    entries.push({ path: posix(path.relative(root, absolute)), size: stat.size, sha256: sha256(data) });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const payload = {
    version: 1,
    projectId: projectIdentity.projectId,
    projectName: projectIdentity.projectName || path.basename(root),
    packageName: projectIdentity.packageName || await packageNameFor(root),
    files: entries,
  };
  return { ...payload, fingerprintSha256: sha256(JSON.stringify(payload)) };
}

export async function writeProjectFingerprint(projectRoot, options = {}) {
  const root = path.resolve(projectRoot || '');
  const fingerprint = await buildProjectFingerprint(root, options);
  const target = path.join(root, PROJECT_FINGERPRINT_RELATIVE_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const next = `${JSON.stringify(fingerprint, null, 2)}\n`;
  const previous = await fs.readFile(target, 'utf8').catch(() => '');
  if (previous !== next) await fs.writeFile(target, next, 'utf8');
  return { ...fingerprint, path: target, relativePath: PROJECT_FINGERPRINT_RELATIVE_PATH };
}

export async function readArtifactProjectIdentity(stagingRoot) {
  return await readJson(path.join(path.resolve(stagingRoot), PROJECT_IDENTITY_RELATIVE_PATH));
}

export async function readArtifactProjectFingerprint(stagingRoot) {
  return await readJson(path.join(path.resolve(stagingRoot), PROJECT_FINGERPRINT_RELATIVE_PATH));
}
