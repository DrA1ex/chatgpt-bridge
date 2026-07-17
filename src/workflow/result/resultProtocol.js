import fs from 'node:fs/promises';
import path from 'node:path';
import { readZipJsonEntry } from '../../zipUtils.js';

const RESULT_STATUSES = new Set(['changed', 'unchanged', 'completed']);
const INTERNAL_REGISTRY_PATTERNS = [
  /openai[^\s"']*(?:cache|registry)/i,
  /(?:artifactory|registry|npm)[^\s"']*\.openai\./i,
  /https?:\/\/[^\s"']*(?:openai-internal|openai\.org)/i,
];

function posix(value) {
  return String(value || '').replace(/\\/g, '/');
}

export function isSafeResultPath(value) {
  const rel = posix(value).trim();
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:\//.test(rel)) return false;
  const normalized = path.posix.normalize(rel);
  return normalized === rel && normalized !== '..' && !normalized.startsWith('../') && !normalized.includes('/../');
}

function validateManifestShape(manifest, workflow) {
  const reasons = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['result manifest is not a JSON object'];
  if (manifest.version !== 1) reasons.push(`result manifest version must be 1, got ${String(manifest.version)}`);
  if (!RESULT_STATUSES.has(String(manifest.status || ''))) reasons.push('result manifest status must be changed, unchanged, or completed');
  if (typeof manifest.summary !== 'string' || !manifest.summary.trim()) reasons.push('result manifest summary is required');
  if (workflow.resultProtocol.requireCommitMessage && (typeof manifest.commitMessage !== 'string' || !manifest.commitMessage.trim())) {
    reasons.push('result manifest commitMessage is required by the workflow commit policy');
  }
  if (!Array.isArray(manifest.files)) reasons.push('result manifest files must be an array');
  else {
    const seen = new Set();
    for (const [index, value] of manifest.files.entries()) {
      if (typeof value !== 'string' || !isSafeResultPath(value)) reasons.push(`result manifest files[${index}] is not a safe relative path`);
      else if (seen.has(posix(value))) reasons.push(`result manifest contains duplicate file path: ${posix(value)}`);
      else seen.add(posix(value));
    }
    if (manifest.status === 'changed' && manifest.files.length === 0) reasons.push('result manifest status=changed requires at least one file');
    if (manifest.status !== 'changed' && manifest.files.length > 0) reasons.push(`result manifest status=${manifest.status} must not list changed files`);
  }
  if (manifest.projectId && workflow.projectId && String(manifest.projectId) !== String(workflow.projectId)) {
    reasons.push(`result manifest projectId mismatch: expected ${workflow.projectId}, got ${manifest.projectId}`);
  }
  if (manifest.workflowId && String(manifest.workflowId) !== String(workflow.id)) {
    reasons.push(`result manifest workflowId mismatch: expected ${workflow.id}, got ${manifest.workflowId}`);
  }
  return reasons;
}

async function packageLockSafety(stagingRoot) {
  const lockPath = path.join(stagingRoot, 'package-lock.json');
  const text = await fs.readFile(lockPath, 'utf8').catch(() => '');
  if (!text) return [];
  for (const pattern of INTERNAL_REGISTRY_PATTERNS) {
    if (pattern.test(text)) return ['package-lock.json contains a private or internal registry URL'];
  }
  return [];
}

export async function validateWorkflowResultProtocol({ workflow, zipPath, stagingRoot, outputFiles = [] } = {}) {
  const protocol = workflow.resultProtocol || {};
  if (!protocol.required) return { ok: true, required: false, manifest: null, reasons: [] };
  const manifestPath = posix(protocol.manifest || 'bridge-result.json');
  const manifest = await readZipJsonEntry(zipPath, manifestPath, {
    maxEntries: workflow.artifact.maxEntries,
    maxUncompressedSize: workflow.artifact.maxExtractedBytes,
  });
  const reasons = [];
  if (!manifest) reasons.push(`result archive is missing ${manifestPath}`);
  else reasons.push(...validateManifestShape(manifest, workflow));

  for (const file of outputFiles.map(posix)) {
    if (/\.(?:patch|diff)$/i.test(file)) reasons.push(`unsupported patch file returned instead of a complete file: ${file}`);
  }
  if (manifest?.status === 'changed' && Array.isArray(manifest.files)) {
    const payloadFiles = outputFiles.filter((file) => posix(file) !== manifestPath && !posix(file).startsWith('.bridge/'));
    if (!payloadFiles.length) reasons.push('result archive does not contain any project files');
  }
  reasons.push(...await packageLockSafety(stagingRoot));
  return { ok: reasons.length === 0, required: true, manifestPath, manifest, reasons };
}

export function validateResultManifestAgainstPlan({ manifest, plan } = {}) {
  if (!manifest || !plan?.plan) return [];
  const actual = new Set([
    ...(plan.plan.create || []),
    ...(plan.plan.update || []),
    ...(plan.plan.localChanged || []),
    ...(plan.plan.delete || []),
    ...(plan.plan.localChangedDelete || []),
  ].map((item) => posix(item?.path)).filter(Boolean));
  const declared = new Set(Array.isArray(manifest.files) ? manifest.files.map(posix).filter(Boolean) : []);
  const reasons = [];
  if (manifest.status === 'changed') {
    for (const file of declared) {
      if (!actual.has(file)) reasons.push(`result manifest lists a file that is not changed by the package: ${file}`);
    }
    for (const file of actual) {
      if (!declared.has(file)) reasons.push(`result package changes a file that is missing from the manifest: ${file}`);
    }
    if (!actual.size) reasons.push('result manifest status=changed but the package does not change the project');
  } else if (actual.size) {
    reasons.push(`result manifest status=${manifest.status} but the package changes ${actual.size} project file(s)`);
  }
  return reasons;
}

export function buildResultRepairPrompt({ workflow, reasons = [], attempt, maxAttempts } = {}) {
  const manifest = workflow.resultProtocol?.manifest || 'bridge-result.json';
  return [
    'Bridge could not apply the returned result package.',
    `Correction attempt ${attempt} of ${maxAttempts}.`,
    '',
    'Problems:',
    ...reasons.map((reason) => `- ${reason}`),
    '',
    'Return exactly one corrected complete project ZIP.',
    `Include ${manifest} with version, status, summary, commitMessage, and the exact changed file list.`,
    'Use safe relative paths and complete files, not patch or diff files.',
    'Do not include private registry URLs in package-lock.json.',
  ].join('\n');
}
