import fs from 'node:fs/promises';
import { extractZipFile } from '../../zipUtils.js';
import { normalizeSelectedSet } from './pathPolicy.js';
import { planZipApply } from './planner.js';

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
