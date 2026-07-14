import fs from 'node:fs/promises';
import path from 'node:path';
import { extractZipFile, validateZipFile, readZipJsonEntry } from '../zipUtils.js';
import { runWorkflowCommands } from './commandRunner.js';
import { ensureProjectIdentity, buildProjectFingerprint, PROJECT_IDENTITY_RELATIVE_PATH, PROJECT_FINGERPRINT_RELATIVE_PATH } from '../projectIdentity.js';

async function readJson(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return null; }
}


async function sha256File(filePath) {
  const crypto = await import('node:crypto');
  const data = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

async function identityFileDigest(filePath, relativePath) {
  if (/\.json$/i.test(relativePath)) {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const crypto = await import('node:crypto');
      const identityPayload = /(^|\/)package\.json$/i.test(relativePath)
        ? {
            name: typeof parsed?.name === 'string' ? parsed.name : '',
            repository: typeof parsed?.repository === 'string' ? parsed.repository : parsed?.repository?.url || '',
          }
        : canonicalJson(parsed);
      return crypto.createHash('sha256').update(JSON.stringify(canonicalJson(identityPayload))).digest('hex');
    } catch {}
  }
  return await sha256File(filePath);
}

async function compareIdentityFallbackFiles(projectRoot, stagingRoot, files = []) {
  const compared = [];
  for (const rel of Array.from(new Set(files.map(String).filter(Boolean)))) {
    const local = path.resolve(projectRoot, rel);
    const output = path.resolve(stagingRoot, rel);
    if (!local.startsWith(`${path.resolve(projectRoot)}${path.sep}`) || !output.startsWith(`${path.resolve(stagingRoot)}${path.sep}`)) continue;
    const [localStat, outputStat] = await Promise.all([fs.stat(local).catch(() => null), fs.stat(output).catch(() => null)]);
    if (!localStat?.isFile() || !outputStat?.isFile()) continue;
    const [localSha256, outputSha256] = await Promise.all([
      identityFileDigest(local, rel),
      identityFileDigest(output, rel),
    ]);
    compared.push({ path: rel.replace(/\\/g, '/'), match: localSha256 === outputSha256, localSha256, outputSha256 });
  }
  return compared;
}

async function listProjectFiles(root, limit = 5000) {
  const result = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (result.length >= limit) return;
      if (['.git', 'node_modules', '.bridge-data'].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const rel = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) result.push(rel);
    }
  };
  await walk(root);
  return result;
}

function overlapScore(currentFiles, outputFiles) {
  const current = new Set(currentFiles);
  const output = new Set(outputFiles);
  let overlap = 0;
  for (const file of output) if (current.has(file)) overlap += 1;
  const denominator = Math.max(1, Math.min(current.size || 1, output.size || 1));
  return overlap / denominator;
}

export class ArtifactVerifier {
  constructor({ dataDir, event = null } = {}) {
    this.dataDir = dataDir;
    this.event = event;
  }

  async verify({ workflow, artifactFile, pipelineId }) {
    const zipPath = artifactFile.absolutePath || artifactFile.path;
    if (!zipPath) throw new Error('Downloaded artifact does not expose an absolute path');
    const stat = await fs.stat(zipPath);
    if (!stat.isFile()) throw new Error(`Downloaded artifact is not a file: ${zipPath}`);
    if (stat.size > workflow.artifact.maxBytes) throw new Error(`Artifact exceeds maxBytes (${stat.size} > ${workflow.artifact.maxBytes})`);

    const zip = await validateZipFile(zipPath, {
      maxEntries: workflow.artifact.maxEntries,
      maxUncompressedSize: workflow.artifact.maxExtractedBytes,
    });
    const stagingRoot = path.join(this.dataDir, 'workflows', workflow.id, 'pipelines', pipelineId, 'staging');
    await fs.rm(stagingRoot, { recursive: true, force: true });
    await fs.mkdir(stagingRoot, { recursive: true });
    const extracted = await extractZipFile(zipPath, stagingRoot, {
      maxEntries: workflow.artifact.maxEntries,
      maxUncompressedSize: workflow.artifact.maxExtractedBytes,
      stripCommonRoot: true,
      conflictPolicy: 'overwrite',
    });
    const outputFiles = extracted.written.map((item) => item.path).sort();
    const archiveFiles = zip.files.filter((item) => !item.directory).map((item) => item.path).sort();
    const reasons = [];

    const projectIdentity = await ensureProjectIdentity(workflow.projectRoot, { packageName: workflow.verification.packageName });
    const projectFingerprint = await buildProjectFingerprint(workflow.projectRoot, { identity: projectIdentity, files: workflow.verification.identityFallbackFiles });
    const artifactIdentity = await readZipJsonEntry(zipPath, PROJECT_IDENTITY_RELATIVE_PATH, { maxEntries: workflow.artifact.maxEntries, maxUncompressedSize: workflow.artifact.maxExtractedBytes });
    const artifactFingerprint = await readZipJsonEntry(zipPath, PROJECT_FINGERPRINT_RELATIVE_PATH, { maxEntries: workflow.artifact.maxEntries, maxUncompressedSize: workflow.artifact.maxExtractedBytes });
    let identityStatus = 'matched';
    let identityFallback = [];
    if (artifactIdentity?.projectId) {
      if (String(artifactIdentity.projectId) !== String(projectIdentity.projectId)) {
        identityStatus = 'mismatch';
        reasons.push(`project identity mismatch: expected ${projectIdentity.projectId}, got ${artifactIdentity.projectId}`);
      }
    } else if (artifactFingerprint?.projectId) {
      if (String(artifactFingerprint.projectId) !== String(projectIdentity.projectId)) {
        identityStatus = 'mismatch';
        reasons.push(`project fingerprint identity mismatch: expected ${projectIdentity.projectId}, got ${artifactFingerprint.projectId}`);
      }
    } else {
      identityStatus = 'fallback';
      identityFallback = await compareIdentityFallbackFiles(workflow.projectRoot, stagingRoot, workflow.verification.identityFallbackFiles);
      const matchedFallback = identityFallback.filter((item) => item.match);
      if (workflow.verification.requireProjectIdentity) reasons.push('artifact is missing .bridge/PROJECT_ID.json');
      else if (identityFallback.length === 0) reasons.push('artifact has no project identity and no configured fallback identity file could be compared');
      else if (matchedFallback.length === 0) reasons.push('artifact has no project identity and none of the fallback identity files match the local project');
    }
    for (const required of workflow.verification.requiredFiles) {
      const source = String(required).startsWith('.bridge/') ? archiveFiles : outputFiles;
      if (!source.includes(required)) reasons.push(`required file is missing: ${required}`);
    }

    const projectPackage = await readJson(path.join(workflow.projectRoot, 'package.json'));
    const outputPackage = await readJson(path.join(stagingRoot, 'package.json'));
    const expectedPackageName = workflow.verification.packageName || projectPackage?.name || '';
    if (expectedPackageName) {
      if (!outputPackage?.name) reasons.push('output package.json does not contain name');
      else if (outputPackage.name !== expectedPackageName) reasons.push(`package name mismatch: expected ${expectedPackageName}, got ${outputPackage.name}`);
    }

    const currentFiles = await listProjectFiles(workflow.projectRoot);
    const score = overlapScore(currentFiles, outputFiles);
    if (score < workflow.verification.minProjectFileOverlap) {
      reasons.push(`project file overlap is too low: ${score.toFixed(3)} < ${workflow.verification.minProjectFileOverlap}`);
    }

    const commands = await runWorkflowCommands(workflow.verification.commands, {
      cwd: stagingRoot,
      timeoutMs: workflow.verification.timeoutMs,
      onOutput: (stream, text) => this.event?.('workflow.verify.command.output', { pipelineId, stream, text }),
    });
    if (!commands.ok) reasons.push('one or more staging verification commands failed');

    return {
      ok: reasons.length === 0,
      reasons,
      zip,
      zipPath,
      stagingRoot,
      stripPrefix: extracted.stripPrefix,
      outputFiles,
      archiveFiles,
      currentFiles,
      overlapScore: score,
      expectedPackageName,
      outputPackageName: outputPackage?.name || '',
      projectIdentity: { projectId: projectIdentity.projectId, projectName: projectIdentity.projectName || '', packageName: projectIdentity.packageName || '' },
      projectFingerprintSha256: projectFingerprint.fingerprintSha256,
      artifactProjectId: artifactIdentity?.projectId || artifactFingerprint?.projectId || '',
      identityStatus,
      identityFallback,
      commands,
      verifiedAt: new Date().toISOString(),
    };
  }
}
