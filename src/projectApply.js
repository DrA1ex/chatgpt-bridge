import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractZipFile, sha256File, validateZipFile } from './zipUtils.js';

const execFileAsync = promisify(execFile);

function previewLines(text, limit = 20) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function posixPath(value) { return String(value || '').replace(/\\/g, '/'); }

function normalizeRel(value) {
  return posixPath(value)
    .replace(/^\/+/, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

function isProtectedApplyPath(rel) {
  const parts = normalizeRel(rel).split('/').filter(Boolean);
  if (!parts.length) return 'empty-path';
  if (parts[0] === '.git') return 'git-internals';
  if (parts[0] === '.bridge') return 'bridge-metadata';
  if (parts.includes('node_modules')) return 'node_modules';
  return '';
}

function normalizeReferenceFiles(options = {}) {
  const sources = [];
  if (Array.isArray(options.referenceFiles)) sources.push(...options.referenceFiles);
  if (Array.isArray(options.referenceManifest?.files)) sources.push(...options.referenceManifest.files);
  if (Array.isArray(options.referenceSnapshot?.files)) sources.push(...options.referenceSnapshot.files);

  const files = [];
  const seen = new Set();
  for (const item of sources) {
    const rel = normalizeRel(typeof item === 'string' ? item : item?.path || item?.targetPath || '');
    if (!rel || seen.has(rel)) continue;
    const protectedReason = isProtectedApplyPath(rel);
    if (protectedReason) continue;
    seen.add(rel);
    files.push(rel);
  }
  return files.sort();
}

function normalizeSelectedSet(value) {
  if (!value) return null;
  if (value instanceof Set) return new Set(Array.from(value).map(normalizeRel).filter(Boolean));
  if (Array.isArray(value)) return new Set(value.map(normalizeRel).filter(Boolean));
  if (typeof value === 'object') {
    return new Set(Object.entries(value).filter(([, selected]) => selected).map(([rel]) => normalizeRel(rel)).filter(Boolean));
  }
  return null;
}


function referenceFileMap(options = {}) {
  const sources = [];
  if (Array.isArray(options.referenceFiles)) sources.push(...options.referenceFiles);
  if (Array.isArray(options.referenceManifest?.files)) sources.push(...options.referenceManifest.files);
  if (Array.isArray(options.referenceSnapshot?.files)) sources.push(...options.referenceSnapshot.files);

  const map = new Map();
  for (const item of sources) {
    const rel = normalizeRel(typeof item === 'string' ? item : item?.path || item?.targetPath || '');
    if (!rel || isProtectedApplyPath(rel) || map.has(rel)) continue;
    map.set(rel, {
      path: rel,
      sha256: typeof item === 'object' && item?.sha256 ? String(item.sha256) : '',
      size: typeof item === 'object' && Number.isFinite(Number(item?.size)) ? Number(item.size) : undefined,
      mtimeMs: typeof item === 'object' && Number.isFinite(Number(item?.mtimeMs)) ? Number(item.mtimeMs) : undefined,
    });
  }
  return map;
}

async function currentFileSha256(absolute) {
  try { return await sha256File(absolute); }
  catch { return ''; }
}

async function fileExists(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile());
}

async function git(root, args) {
  return await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
}

export async function checkProjectApplySafety(projectRoot) {
  const root = path.resolve(projectRoot || '');
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Project path is not a directory: ${root}`);

  const warnings = [];
  let gitInfo = { available: false, root: '', dirty: false, dirtyCount: 0, dirtyPreview: [] };

  try {
    const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
    if (inside.stdout.trim() !== 'true') throw new Error('not inside work tree');
    const topLevel = await git(root, ['rev-parse', '--show-toplevel']);
    const status = await git(root, ['status', '--porcelain', '--untracked-files=all']);
    const dirtyPreview = previewLines(status.stdout, 25);
    gitInfo = {
      available: true,
      root: topLevel.stdout.trim(),
      dirty: dirtyPreview.length > 0,
      dirtyCount: dirtyPreview.length,
      dirtyPreview,
    };
    if (gitInfo.dirty) {
      warnings.push({
        code: 'DIRTY_WORKTREE',
        message: `Git worktree has uncommitted changes (${gitInfo.dirtyCount} shown). Applying a ZIP result may overwrite local work.`,
        preview: dirtyPreview,
      });
    }
  } catch (err) {
    warnings.push({
      code: 'NO_GIT_OR_GIT_STATUS_FAILED',
      message: `Could not confirm a clean git worktree for this project. ${err.message || err}`,
    });
  }

  return {
    ok: true,
    projectRoot: root,
    safe: warnings.length === 0,
    warnings,
    git: gitInfo,
  };
}

export async function planZipApply({ zipPath, projectRoot, options = {} }) {
  const root = path.resolve(projectRoot || '');
  const zip = await validateZipFile(zipPath, options.zipValidation || {});
  const safety = await checkProjectApplySafety(root);
  const dryRun = await extractZipFile(zipPath, root, {
    ...(options.zipValidation || {}),
    dryRun: true,
    stripCommonRoot: options.stripCommonRoot !== false,
  });

  const referenceMap = referenceFileMap(options);
  const filesToWrite = [];
  const filesToOverwrite = [];
  const filesToCreate = [];
  const filesToUpdate = [];
  const filesUnchanged = [];
  const filesLocallyChanged = [];

  for (const item of dryRun.written) {
    const exists = await fileExists(item.absolutePath);
    const reference = referenceMap.get(item.path) || null;
    const currentSha256 = exists ? await currentFileSha256(item.absolutePath) : '';
    const outputSha256 = item.sha256 || '';
    const outputMatchesCurrent = Boolean(exists && outputSha256 && currentSha256 && outputSha256 === currentSha256);
    const changedSinceSnapshot = Boolean(exists && reference?.sha256 && currentSha256 && currentSha256 !== reference.sha256);
    const enriched = {
      ...item,
      exists,
      conflict: exists,
      reference,
      currentSha256,
      outputSha256,
      outputMatchesCurrent,
      changedSinceSnapshot,
      localChange: changedSinceSnapshot && !outputMatchesCurrent,
    };

    filesToWrite.push(enriched);
    if (!exists) {
      filesToCreate.push(enriched);
    } else {
      filesToOverwrite.push(enriched);
      if (outputMatchesCurrent) filesUnchanged.push(enriched);
      else if (enriched.localChange) filesLocallyChanged.push(enriched);
      else filesToUpdate.push(enriched);
    }
  }

  const sync = Boolean(options.sync || options.deleteMissing);
  const referenceFiles = Array.from(referenceMap.keys()).sort();
  const outputSet = new Set(filesToWrite.map((item) => item.path));
  const filesToDelete = [];
  const filesLocallyChangedDelete = [];
  if (sync && referenceFiles.length) {
    for (const rel of referenceFiles) {
      if (outputSet.has(rel)) continue;
      const protectedReason = isProtectedApplyPath(rel);
      if (protectedReason) continue;
      const absolute = path.resolve(root, rel);
      const relativeToRoot = path.relative(root, absolute);
      if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) continue;
      if (await fileExists(absolute)) {
        const reference = referenceMap.get(rel) || null;
        const currentSha256 = await currentFileSha256(absolute);
        const changedSinceSnapshot = Boolean(reference?.sha256 && currentSha256 && currentSha256 !== reference.sha256);
        const entry = { path: rel, absolutePath: absolute, reference, currentSha256, changedSinceSnapshot, localChange: changedSinceSnapshot };
        if (changedSinceSnapshot) filesLocallyChangedDelete.push(entry);
        else filesToDelete.push(entry);
      }
    }
  }

  const warnings = [...safety.warnings];
  if (sync && !referenceFiles.length) {
    warnings.push({
      code: 'NO_REFERENCE_MANIFEST_FOR_SYNC',
      message: 'Sync delete was requested, but no original project snapshot manifest was provided. Missing files will not be deleted.',
    });
  }
  const totalDeleteCandidates = filesToDelete.length + filesLocallyChangedDelete.length;
  if (totalDeleteCandidates > 0 && filesToWrite.length > 0 && totalDeleteCandidates > Math.max(20, filesToWrite.length * 2)) {
    warnings.push({
      code: 'LARGE_SYNC_DELETE_SET',
      message: `ZIP output is missing many files from the original snapshot (${totalDeleteCandidates} delete candidates, ${filesToWrite.length} write candidates). Confirm carefully before applying.`,
      preview: [...filesToDelete, ...filesLocallyChangedDelete].slice(0, 25).map((item) => item.path),
    });
  }
  if (filesLocallyChanged.length || filesLocallyChangedDelete.length) {
    warnings.push({
      code: 'LOCAL_CHANGES_AFTER_SNAPSHOT',
      message: `Some files changed locally after the project snapshot was sent (${filesLocallyChanged.length} update conflicts, ${filesLocallyChangedDelete.length} delete conflicts).`,
      preview: [...filesLocallyChanged, ...filesLocallyChangedDelete].slice(0, 25).map((item) => item.path),
    });
  }

  return {
    ok: true,
    action: sync ? 'sync_zip' : 'apply_zip',
    projectRoot: root,
    zip,
    safety: { ...safety, safe: warnings.length === 0, warnings },
    requiresConfirmation: warnings.length > 0,
    hasLocalChangesAfterSnapshot: filesLocallyChanged.length > 0 || filesLocallyChangedDelete.length > 0,
    sync,
    referenceFiles: referenceFiles.length,
    plan: {
      filesToWrite: filesToWrite.length,
      filesToCreate: filesToCreate.length,
      filesToOverwrite: filesToOverwrite.length,
      filesToUpdate: filesToUpdate.length,
      filesUnchanged: filesUnchanged.length,
      filesLocallyChanged: filesLocallyChanged.length,
      filesToDelete: filesToDelete.length,
      filesLocallyChangedDelete: filesLocallyChangedDelete.length,
      filesSkipped: dryRun.skipped.length,
      stripPrefix: dryRun.stripPrefix,
      written: filesToWrite,
      create: filesToCreate,
      overwrite: filesToOverwrite,
      update: filesToUpdate,
      unchanged: filesUnchanged,
      localChanged: filesLocallyChanged,
      delete: filesToDelete,
      localChangedDelete: filesLocallyChangedDelete,
      writtenPreview: filesToWrite.slice(0, 30).map(({ path: rel, size, exists, outputMatchesCurrent, localChange }) => ({ path: rel, size, exists, unchanged: outputMatchesCurrent, localChange })),
      createPreview: filesToCreate.slice(0, 30).map(({ path: rel, size }) => ({ path: rel, size })),
      updatePreview: filesToUpdate.slice(0, 30).map(({ path: rel, size }) => ({ path: rel, size })),
      overwritePreview: filesToOverwrite.slice(0, 30).map(({ path: rel, size, outputMatchesCurrent, localChange }) => ({ path: rel, size, unchanged: outputMatchesCurrent, localChange })),
      unchangedPreview: filesUnchanged.slice(0, 30).map(({ path: rel, size }) => ({ path: rel, size })),
      localChangedPreview: filesLocallyChanged.slice(0, 30).map(({ path: rel, size }) => ({ path: rel, size })),
      deletePreview: filesToDelete.slice(0, 30).map(({ path: rel }) => ({ path: rel })),
      localChangedDeletePreview: filesLocallyChangedDelete.slice(0, 30).map(({ path: rel }) => ({ path: rel })),
      skippedPreview: dryRun.skipped.slice(0, 30),
    },
  };
}

export async function applyZipToProject({ zipPath, projectRoot, options = {} }) {
  const plan = await planZipApply({ zipPath, projectRoot, options });
  const selectedWritePaths = normalizeSelectedSet(
    options.selectedWritePaths || options.selectedUpdatePaths || options.selectedConflictPaths || options.selectedPaths,
  );
  const selectedDeletePaths = normalizeSelectedSet(options.selectedDeletePaths || options.selectedRemovePaths);
  const conflictPolicy = options.conflictPolicy || 'overwrite';
  if (!['overwrite', 'skip', 'error'].includes(conflictPolicy)) throw new Error(`Unknown conflictPolicy: ${conflictPolicy}`);
  if (conflictPolicy === 'error' && plan.plan.filesToOverwrite > 0) {
    const first = plan.plan.overwrite[0]?.path || 'unknown';
    const err = new Error(`APPLY_CONFLICT: target file already exists: ${first}`);
    err.code = 'APPLY_CONFLICT';
    throw err;
  }

  const defaultWritable = [
    ...plan.plan.update,
    ...plan.plan.localChanged,
  ].map((item) => item.path);
  const selectedConflictPaths = selectedWritePaths || new Set(defaultWritable);

  const applied = await extractZipFile(zipPath, plan.projectRoot, {
    ...(options.zipValidation || {}),
    dryRun: false,
    stripCommonRoot: options.stripCommonRoot !== false,
    conflictPolicy,
    selectedConflictPaths,
  });

  const deleteCandidates = [...plan.plan.delete, ...plan.plan.localChangedDelete];
  const deleted = [];
  const skippedDeletes = [];
  if (plan.sync) {
    for (const item of deleteCandidates) {
      if (selectedDeletePaths && !selectedDeletePaths.has(item.path)) {
        skippedDeletes.push({ ...item, reason: 'delete-skipped' });
        continue;
      }
      await fs.unlink(item.absolutePath).catch((err) => {
        if (err?.code !== 'ENOENT') throw err;
      });
      deleted.push(item);
    }
  }

  return {
    ...plan,
    applied: true,
    written: applied.written,
    skipped: [...applied.skipped, ...skippedDeletes],
    deleted,
    appliedAt: new Date().toISOString(),
  };
}
