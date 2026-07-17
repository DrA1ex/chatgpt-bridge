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
  if (manifest.files !== undefined) {
    if (!Array.isArray(manifest.files)) reasons.push('result manifest files must be an array when provided');
    else {
      const seen = new Set();
      for (const [index, value] of manifest.files.entries()) {
        if (typeof value !== 'string' || !isSafeResultPath(value)) reasons.push(`result manifest files[${index}] is not a safe relative path`);
        else if (seen.has(posix(value))) reasons.push(`result manifest contains duplicate file path: ${posix(value)}`);
        else seen.add(posix(value));
      }
    }
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
  if (manifest?.status === 'changed') {
    const payloadFiles = outputFiles.filter((file) => posix(file) !== manifestPath && !posix(file).startsWith('.bridge/'));
    if (!payloadFiles.length) reasons.push('result archive does not contain any project files');
  }
  reasons.push(...await packageLockSafety(stagingRoot));
  return { ok: reasons.length === 0, required: true, manifestPath, manifest, reasons };
}

function actualChangedPaths(plan = {}) {
  if (!plan?.plan) return [];
  return Array.from(new Set([
    ...(plan.plan.create || []),
    ...(plan.plan.update || []),
    ...(plan.plan.localChanged || []),
    ...(plan.plan.delete || []),
    ...(plan.plan.localChangedDelete || []),
  ].map((item) => posix(item?.path)).filter(Boolean))).sort();
}

export function reconcileResultManifestAgainstPlan({ manifest, plan } = {}) {
  const actualFiles = actualChangedPaths(plan);
  const declaredFiles = Array.from(new Set(
    (Array.isArray(manifest?.files) ? manifest.files : []).map(posix).filter(Boolean),
  )).sort();
  const actual = new Set(actualFiles);
  const declared = new Set(declaredFiles);
  return {
    source: 'apply-plan',
    actualFiles,
    declaredFiles,
    matchedDeclaredFiles: declaredFiles.filter((file) => actual.has(file)),
    ignoredUnchangedFiles: declaredFiles.filter((file) => !actual.has(file)),
    undeclaredChangedFiles: actualFiles.filter((file) => !declared.has(file)),
    fileListProvided: Array.isArray(manifest?.files),
  };
}

export function validateResultManifestAgainstPlan({ manifest, plan } = {}) {
  // The transactional apply plan is the source of truth. The optional manifest
  // file list is advisory and is reconciled only for diagnostics.
  reconcileResultManifestAgainstPlan({ manifest, plan });
  return [];
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
    `Include ${manifest} with version, status, summary, and commitMessage.`,
    'The files field is optional. When present, use safe relative paths; Bridge derives the effective changed-file list from the actual project diff and ignores unchanged entries.',
    'Use complete files, not patch or diff files.',
    'Do not include private registry URLs in package-lock.json.',
  ].join('\n');
}
