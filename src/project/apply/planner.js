import fs from 'node:fs/promises';
import path from 'node:path';
import { extractZipFile, sha256File, validateZipFile } from '../../zipUtils.js';
import { isProtectedApplyPath } from './pathPolicy.js';
import { referenceFileMap } from './reference.js';
import { checkProjectApplySafety } from './safety.js';
import { resolveSafeDescendant } from '../../pathSafety.js';

async function currentFileSha256(absolute) {
  try { return await sha256File(absolute); }
  catch { return ''; }
}

async function fileExists(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile());
}

function previewEntry({ path: rel, size, exists, outputMatchesCurrent, localChange }) {
  return { path: rel, size, exists, unchanged: outputMatchesCurrent, localChange };
}

async function classifyWrites({ dryRun, root, referenceMap }) {
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
      continue;
    }
    filesToOverwrite.push(enriched);
    if (outputMatchesCurrent) filesUnchanged.push(enriched);
    else if (enriched.localChange) filesLocallyChanged.push(enriched);
    else filesToUpdate.push(enriched);
  }

  return { filesToWrite, filesToOverwrite, filesToCreate, filesToUpdate, filesUnchanged, filesLocallyChanged };
}

async function classifyDeletes({ root, sync, referenceMap, outputSet }) {
  const filesToDelete = [];
  const filesLocallyChangedDelete = [];
  const referenceFiles = Array.from(referenceMap.keys()).sort();
  if (!sync || !referenceFiles.length) return { referenceFiles, filesToDelete, filesLocallyChangedDelete };

  for (const rel of referenceFiles) {
    if (outputSet.has(rel) || isProtectedApplyPath(rel)) continue;
    const absolute = await resolveSafeDescendant(root, rel, {
      code: 'APPLY_UNSAFE_DELETE_PATH',
      symlinkCode: 'APPLY_SYMLINK_DELETE_PATH',
    });
    if (!await fileExists(absolute)) continue;

    const reference = referenceMap.get(rel) || null;
    const currentSha256 = await currentFileSha256(absolute);
    const changedSinceSnapshot = Boolean(reference?.sha256 && currentSha256 && currentSha256 !== reference.sha256);
    const entry = { path: rel, absolutePath: absolute, reference, currentSha256, changedSinceSnapshot, localChange: changedSinceSnapshot };
    if (changedSinceSnapshot) filesLocallyChangedDelete.push(entry);
    else filesToDelete.push(entry);
  }

  return { referenceFiles, filesToDelete, filesLocallyChangedDelete };
}

function buildWarnings({ safety, sync, referenceFiles, filesToWrite, filesToDelete, filesLocallyChanged, filesLocallyChangedDelete }) {
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
  return warnings;
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
  const excludedPaths = new Set((options.excludedWritePaths || []).map((item) => String(item || '').replace(/\\/g, '/')).filter(Boolean));
  const excludedPrefixes = (options.excludedWritePrefixes || []).map((item) => String(item || '').replace(/\\/g, '/')).filter(Boolean);
  const excludedWrites = dryRun.written.filter((item) => excludedPaths.has(item.path) || excludedPrefixes.some((prefix) => item.path.startsWith(prefix)));
  const effectiveDryRun = {
    ...dryRun,
    written: dryRun.written.filter((item) => !excludedWrites.includes(item)),
    skipped: [...dryRun.skipped, ...excludedWrites.map((item) => ({ path: item.path, reason: 'excluded-control-file' }))],
  };

  const referenceMap = referenceFileMap(options);
  const writeGroups = await classifyWrites({ dryRun: effectiveDryRun, root, referenceMap });
  const sync = Boolean(options.sync || options.deleteMissing);
  const outputSet = new Set(writeGroups.filesToWrite.map((item) => item.path));
  const deleteGroups = await classifyDeletes({ root, sync, referenceMap, outputSet });
  const warnings = buildWarnings({ safety, sync, ...writeGroups, ...deleteGroups });

  return {
    ok: true,
    action: sync ? 'sync_zip' : 'apply_zip',
    projectRoot: root,
    zip,
    safety: { ...safety, safe: warnings.length === 0, warnings },
    requiresConfirmation: warnings.length > 0,
    hasLocalChangesAfterSnapshot: writeGroups.filesLocallyChanged.length > 0 || deleteGroups.filesLocallyChangedDelete.length > 0,
    sync,
    referenceFiles: deleteGroups.referenceFiles.length,
    plan: {
      filesToWrite: writeGroups.filesToWrite.length,
      filesToCreate: writeGroups.filesToCreate.length,
      filesToOverwrite: writeGroups.filesToOverwrite.length,
      filesToUpdate: writeGroups.filesToUpdate.length,
      filesUnchanged: writeGroups.filesUnchanged.length,
      filesLocallyChanged: writeGroups.filesLocallyChanged.length,
      filesToDelete: deleteGroups.filesToDelete.length,
      filesLocallyChangedDelete: deleteGroups.filesLocallyChangedDelete.length,
      filesSkipped: effectiveDryRun.skipped.length,
      stripPrefix: effectiveDryRun.stripPrefix,
      written: writeGroups.filesToWrite,
      create: writeGroups.filesToCreate,
      overwrite: writeGroups.filesToOverwrite,
      update: writeGroups.filesToUpdate,
      unchanged: writeGroups.filesUnchanged,
      localChanged: writeGroups.filesLocallyChanged,
      delete: deleteGroups.filesToDelete,
      localChangedDelete: deleteGroups.filesLocallyChangedDelete,
      writtenPreview: writeGroups.filesToWrite.slice(0, 30).map(previewEntry),
      createPreview: writeGroups.filesToCreate.slice(0, 30).map(({ path: rel, size }) => ({ path: rel, size })),
      updatePreview: writeGroups.filesToUpdate.slice(0, 30).map(({ path: rel, size }) => ({ path: rel, size })),
      overwritePreview: writeGroups.filesToOverwrite.slice(0, 30).map(previewEntry),
      unchangedPreview: writeGroups.filesUnchanged.slice(0, 30).map(({ path: rel, size }) => ({ path: rel, size })),
      localChangedPreview: writeGroups.filesLocallyChanged.slice(0, 30).map(({ path: rel, size }) => ({ path: rel, size })),
      deletePreview: deleteGroups.filesToDelete.slice(0, 30).map(({ path: rel }) => ({ path: rel })),
      localChangedDeletePreview: deleteGroups.filesLocallyChangedDelete.slice(0, 30).map(({ path: rel }) => ({ path: rel })),
      skippedPreview: effectiveDryRun.skipped.slice(0, 30),
    },
  };
}
