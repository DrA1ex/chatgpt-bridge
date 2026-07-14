import fs from 'node:fs/promises';
import path from 'node:path';
import { extractZipFile, validateZipFile } from '../zipUtils.js';
import { runWorkflowCommands } from './commandRunner.js';

async function readJson(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return null; }
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
    const reasons = [];
    for (const required of workflow.verification.requiredFiles) {
      if (!outputFiles.includes(required)) reasons.push(`required file is missing: ${required}`);
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
      currentFiles,
      overlapScore: score,
      expectedPackageName,
      outputPackageName: outputPackage?.name || '',
      commands,
      verifiedAt: new Date().toISOString(),
    };
  }
}
