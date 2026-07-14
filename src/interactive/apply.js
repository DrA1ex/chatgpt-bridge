import fs from 'node:fs/promises';
import path from 'node:path';
import { planZipApply } from '../project/apply/planner.js';
import { applyZipToProject } from '../project/apply/runner.js';
import { bytes } from './format.js';
import {
  autoApplyDecision,
  normalizeSelectedResult,
  sameProjectRoot,
  selectedResultFromTurn,
} from './state.js';

async function getLastTurnResultReadable(fileStore, state) {
  let selected = normalizeSelectedResult(state.selectedResult);
  if (!selected) {
    const fallback = selectedResultFromTurn(state, state.lastTurn || {}, { source: 'previous-turn' });
    if (fallback && (!state.currentTurnId || fallback.turnId === state.currentTurnId)) {
      state.selectedResult = fallback;
      selected = fallback;
    }
  }
  if (!selected) throw new Error('No result selected for the current task. Run a project task or /recover <n> first.');
  if (selected.stale) {
    const current = state.currentTurnId || state.lastTurnId || '(none)';
    throw new Error(`Selected result belongs to an older turn (${selected.turnId || '(unknown)'}); current turn is ${current}. Run /recover or wait for the current task result before applying.`);
  }
  if (selected.turnId && state.currentTurnId && selected.turnId !== state.currentTurnId) {
    throw new Error(`Selected result belongs to an older turn (${selected.turnId}); current turn is ${state.currentTurnId}. Run /recover or wait for the current task result before applying.`);
  }
  if (selected.projectId && state.projectId && selected.projectId !== state.projectId) {
    throw new Error(`Selected result belongs to another project (${selected.projectId}); current project is ${state.projectId}.`);
  }
  if (!sameProjectRoot(selected.projectRoot, state.projectRoot)) {
    throw new Error(`Selected result belongs to another project root (${selected.projectRoot}); current project root is ${state.projectRoot}.`);
  }
  if (selected.sessionId !== String(state.sessionId || '')) {
    throw new Error(`Selected result belongs to another ChatGPT session (${selected.sessionId || '(current-tab scope)'}); current session is ${state.sessionId || '(current-tab scope)'}.`);
  }
  if (!selected.fileId) throw new Error('Selected result has no downloadable ZIP file. Run /recover <n> if the browser shows a newer artifact.');

  let turn = state.lastTurn;
  if (!turn || turn.id !== selected.turnId) {
    turn = { id: selected.turnId, status: 'completed', output: { type: 'zip', status: selected.outputStatus || 'ready', fileId: selected.fileId, artifactId: selected.artifactId, name: selected.name, size: selected.size, sourceClientId: selected.sourceClientId, sourceTurnKey: selected.sourceTurnKey, sourceRequestId: selected.sourceRequestId } };
  }
  const readable = await fileStore.getReadable(selected.fileId);
  if (!readable?.absolutePath) throw new Error(`Selected result file is missing or not readable: ${selected.fileId}`);
  return { turn, file: readable, selectedResult: selected };
}

function printPreview(title, items, prefix, limit = 12) {
  if (!items?.length) return;
  console.log(`${title}:`);
  for (const item of items.slice(0, limit)) console.log(`  ${prefix} ${item.path}${item.size ? ` · ${bytes(item.size)}` : ''}`);
  if (items.length > limit) console.log(`  ... ${items.length - limit} more`);
}

function printApplyPlan(plan) {
  const warnings = plan.safety?.warnings || [];
  if (warnings.length) {
    console.log('Safety warnings:');
    for (const warning of warnings) {
      console.log(`  - ${warning.code}: ${warning.message}`);
      for (const line of warning.preview || []) console.log(`      ${line}`);
    }
  } else {
    console.log('[git] clean worktree detected');
  }
  console.log(`[apply] +${plan.plan.filesToCreate} create, ~${plan.plan.filesToUpdate} update, -${plan.plan.filesToDelete} delete, =${plan.plan.filesUnchanged} unchanged${plan.plan.stripPrefix ? ` · strip ${plan.plan.stripPrefix}` : ''}`);
  if (plan.plan.filesLocallyChanged || plan.plan.filesLocallyChangedDelete) {
    console.log(`[apply] !${plan.plan.filesLocallyChanged} locally changed update conflict(s), !${plan.plan.filesLocallyChangedDelete} locally changed delete conflict(s)`);
  }
  printPreview('Create', plan.plan.create, '+');
  printPreview('Update', plan.plan.update, '~');
  printPreview('Delete', plan.plan.delete, '-');
  printPreview('Locally changed updates', plan.plan.localChanged, '!');
  printPreview('Locally changed deletes', plan.plan.localChangedDelete, '!');
  if (plan.plan.filesSkipped) console.log(`[apply] ${plan.plan.filesSkipped} unsafe/internal file(s) skipped`);
}


function pathSet(items = []) {
  return new Set((Array.isArray(items) ? items : []).map((item) => String(item?.path || item?.targetPath || item || '')).filter(Boolean));
}

function sortedUnique(values = []) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean))).sort();
}

export function summarizeAppliedChanges(result = {}) {
  const written = Array.isArray(result.written) ? result.written : [];
  const deleted = Array.isArray(result.deleted) ? result.deleted : [];
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];
  const createSet = pathSet(result.plan?.create || []);
  const updateSet = pathSet([...(result.plan?.update || []), ...(result.plan?.localChanged || [])]);
  const deleteSet = pathSet([...(result.plan?.delete || []), ...(result.plan?.localChangedDelete || [])]);

  const created = [];
  const updated = [];
  for (const item of written) {
    const rel = String(item?.path || item?.targetPath || '').trim();
    if (!rel) continue;
    if (createSet.has(rel) || item?.conflict === false) created.push(rel);
    else if (updateSet.has(rel) || item?.conflict === true) updated.push(rel);
    else updated.push(rel);
  }

  return {
    created: sortedUnique(created),
    updated: sortedUnique(updated),
    deleted: sortedUnique(deleted.map((item) => item?.path || item?.targetPath || item)),
    skipped: skipped.map((item) => ({
      path: String(item?.targetPath || item?.path || item || '').trim(),
      reason: String(item?.reason || '').trim(),
    })).filter((item) => item.path),
    plannedDeletes: sortedUnique(Array.from(deleteSet)),
  };
}

function printFileList(title, items = [], prefix = '•', limit = 80) {
  if (!items.length) return;
  console.log(`${title}:`);
  for (const item of items.slice(0, limit)) console.log(`  ${prefix} ${item}`);
  if (items.length > limit) console.log(`  ... ${items.length - limit} more`);
}

function printAppliedChanges(result = {}) {
  const summary = summarizeAppliedChanges(result);
  console.log('');
  console.log('Applied changes:');
  if (!summary.created.length && !summary.updated.length && !summary.deleted.length) {
    console.log('  No file changes were written.');
  }
  printFileList('Created', summary.created, '+');
  printFileList('Updated', summary.updated, '~');
  printFileList('Deleted', summary.deleted, '-');
  if (summary.skipped.length) {
    console.log('Skipped:');
    for (const item of summary.skipped.slice(0, 40)) console.log(`  ! ${item.path}${item.reason ? ` · ${item.reason}` : ''}`);
    if (summary.skipped.length > 40) console.log(`  ... ${summary.skipped.length - 40} more`);
  }
  return summary;
}

function applyEventPayload(result = {}) {
  const summary = summarizeAppliedChanges(result);
  return {
    createdFiles: summary.created,
    updatedFiles: summary.updated,
    deletedFiles: summary.deleted,
    skippedFiles: summary.skipped,
    created: summary.created.length,
    updated: summary.updated.length,
    deleted: summary.deleted.length,
    skipped: summary.skipped.length,
  };
}

function printAutoApplySkip(decision = {}, plan = {}) {
  const reason = decision.reason || 'requires confirmation';
  const warning = (plan.safety?.warnings || []).find((item) => item.code === reason) || (plan.safety?.warnings || [])[0] || null;
  console.log('');
  console.log('Apply decision: manual confirmation required');
  console.log(`[apply] auto-apply skipped: ${reason}${warning?.message ? ` · ${warning.message}` : ''}`);
  console.log(`[apply] planned changes: +${plan.plan?.filesToCreate || 0} create, ~${plan.plan?.filesToUpdate || 0} update, -${plan.plan?.filesToDelete || 0} delete, =${plan.plan?.filesUnchanged || 0} unchanged`);
  if (plan.plan?.filesLocallyChanged || plan.plan?.filesLocallyChangedDelete) {
    console.log(`[apply] local conflicts: !${plan.plan?.filesLocallyChanged || 0} changed update(s), !${plan.plan?.filesLocallyChangedDelete || 0} changed delete(s)`);
  }
  if (plan.plan?.filesSkipped) console.log(`[apply] skipped by safety filter: ${plan.plan.filesSkipped} file(s)`);
  console.log('[apply] result remains selected. Run /apply to apply manually, /apply --interactive to choose changes, or /apply --force to apply the whole ZIP.');
}

async function buildApplyReference(projectService, state) {
  if (state.lastProjectScan?.manifest?.files?.length) return state.lastProjectScan.manifest;
  if (projectService && state.projectRoot) {
    const manifest = await projectService.getLatestSnapshotManifest(state.projectRoot).catch(() => null);
    if (manifest?.files?.length) return manifest;
  }
  return null;
}

async function askInteractiveApplySelection(plan, confirm) {
  const selectedWritePaths = [];
  const selectedDeletePaths = [];
  if (!confirm) {
    console.log('[apply] interactive prompts are unavailable here; use --force to apply all changes or --plan to preview.');
    return { selectedWritePaths: [], selectedDeletePaths: [] };
  }
  const updateCandidates = [...(plan.plan.update || []), ...(plan.plan.localChanged || [])];
  const deleteCandidates = [...(plan.plan.delete || []), ...(plan.plan.localChangedDelete || [])];
  if (updateCandidates.length) console.log('Changed files:');
  for (const item of updateCandidates) {
    const local = item.localChange ? ' Local changes after snapshot will be overwritten.' : '';
    const ok = await confirm(`Apply update to ${item.path}?${local} [y/N] `);
    if (ok) selectedWritePaths.push(item.path);
  }
  if (deleteCandidates.length) console.log('Deleted files:');
  for (const item of deleteCandidates) {
    const local = item.localChange ? ' Local changes after snapshot will be deleted.' : '';
    const ok = await confirm(`Delete ${item.path}?${local} [y/N] `);
    if (ok) selectedDeletePaths.push(item.path);
  }
  return { selectedWritePaths, selectedDeletePaths };
}

export async function applyZipPathResult(zipPathArg, state, { force = false, planOnly = false, interactive = false, confirm = null, projectService = null } = {}) {
  if (!state.projectRoot) throw new Error('No project opened. Use --project <path> or /project open <path>.');
  const zipPath = path.resolve(zipPathArg || '');
  const stat = await fs.stat(zipPath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`ZIP file not found: ${zipPath}`);
  console.log(`[apply] planning ${path.basename(zipPath)} against ${state.projectRoot}...`);
  const referenceManifest = await buildApplyReference(projectService, state);
  const options = { sync: true, referenceManifest };
  const plan = await planZipApply({ zipPath, projectRoot: state.projectRoot, options });
  printApplyPlan(plan);
  if (planOnly) return plan;

  if (!force && !interactive) {
    const question = plan.safety.safe
      ? 'Apply this ZIP to the project? [y/N] '
      : 'Apply this ZIP despite warnings/local changes? [y/N] ';
    const ok = confirm ? await confirm(question) : false;
    if (!ok) {
      console.log('[apply] cancelled');
      return null;
    }
    if (!plan.safety?.safe || plan.requiresConfirmation) {
      console.log('[apply] applying despite warnings because /apply was explicitly confirmed.');
    }
  }

  let selectedWritePaths = null;
  let selectedDeletePaths = null;
  if (interactive && !force) {
    const selection = await askInteractiveApplySelection(plan, confirm);
    selectedWritePaths = selection.selectedWritePaths;
    selectedDeletePaths = selection.selectedDeletePaths;
    const ok = confirm ? await confirm('Apply selected changes now? [y/N] ') : false;
    if (!ok) {
      console.log('[apply] cancelled');
      return null;
    }
  }

  console.log('[apply] writing selected changes...');
  const result = await applyZipToProject({
    zipPath,
    projectRoot: state.projectRoot,
    options: {
      ...options,
      conflictPolicy: 'overwrite',
      ...(selectedWritePaths ? { selectedWritePaths } : {}),
      ...(selectedDeletePaths ? { selectedDeletePaths } : {}),
    },
  });
  state.lastAppliedResult = result;
  state.lastApplySummary = { ...applyEventPayload(result), projectRoot: result.projectRoot || state.projectRoot || '', appliedAt: result.appliedAt || new Date().toISOString() };
  printAppliedChanges(result);
  console.log(`[apply] applied ${path.basename(zipPath)} · wrote ${result.written.length} file(s), deleted ${result.deleted.length} file(s) in ${result.projectRoot}`);
  if (result.skipped.length) console.log(`[apply] skipped ${result.skipped.length} file(s)`);
  return result;
}

async function cleanupAppliedResultArchives(fileStore, state, keepFileId = '') {
  if (!fileStore) return;
  const removed = [];
  const previousFileId = state.lastAppliedFileId || '';
  if (previousFileId && previousFileId !== keepFileId) {
    const didRemove = await fileStore.remove(previousFileId).catch(() => false);
    if (didRemove) removed.push(previousFileId);
  }
  const pruned = typeof fileStore.pruneArtifacts === 'function'
    ? await fileStore.pruneArtifacts({ keepIds: [keepFileId].filter(Boolean) }).catch(() => [])
    : [];
  if (pruned.length) removed.push(...pruned.map((item) => item.id || item.name).filter(Boolean));
  if (removed.length) console.log(`[artifact] cleaned ${removed.length} old archive(s) from bridge storage`);
}

export async function applyLastTurnResult(fileStore, state, { force = false, planOnly = false, interactive = false, auto = false, confirm = null, projectService = null, turnManager = null } = {}) {
  const selectedTurnId = state.lastTurn?.id || state.lastTurnId || state.currentTurnId || '';
  const emitApplyEvent = async (turnId, type, data = {}) => {
    if (!turnManager?.recordTurnEvent || !turnId) return;
    await turnManager.recordTurnEvent(turnId, type, {
      auto: Boolean(auto),
      force: Boolean(force),
      interactive: Boolean(interactive),
      planOnly: Boolean(planOnly),
      projectRoot: state.projectRoot || '',
      ...data,
    }).catch(() => null);
  };

  try {
    if (!state.projectRoot) throw new Error('No project opened. Use --project <path> or /project open <path>.');
    if (!normalizeSelectedResult(state.selectedResult) && !state.lastTurn && state.lastTurnId) throw new Error('Last turn is not loaded. Use /result first after running a task.');
    const { turn, file, selectedResult } = await getLastTurnResultReadable(fileStore, state);
    if (auto && !force && !selectedResult.sourceClientId) {
      console.log('[apply] auto-apply skipped: selected result has no source client identity. Result remains selected; run /apply manually to review and confirm.');
      await emitApplyEvent(turn.id, 'apply/skipped', { reason: 'missing_source_identity', fileId: file.id || selectedResult.fileId || '' });
      return { skipped: true, reason: 'missing_source_identity' };
    }
    const lowConfidenceResult = ['low', 'manual', 'uncertain'].includes(String(selectedResult.confidence || '').toLowerCase());
    if (lowConfidenceResult && auto && !force) {
      console.log(`[apply] auto-apply skipped: selected result confidence is ${selectedResult.confidence}. Result remains selected for manual review.`);
      await emitApplyEvent(turn.id, 'apply/skipped', { reason: 'low_confidence_selected_result', confidence: selectedResult.confidence });
      return { skipped: true, reason: 'low_confidence_selected_result' };
    }
    if (lowConfidenceResult && !force && !interactive) {
      const ok = confirm ? await confirm(`[apply] selected result confidence is ${selectedResult.confidence}; apply anyway? [y/N] `) : false;
      if (!ok) {
        console.log('[apply] cancelled because selected result confidence is low');
        await emitApplyEvent(turn.id, 'apply/skipped', { reason: 'low_confidence_selected_result', confidence: selectedResult.confidence });
        return null;
      }
    }
    const sameAppliedResult = state.lastAppliedTurnId === turn.id && state.lastAppliedFileId === file.id;
    if (sameAppliedResult && !force && !planOnly) {
      console.log(`[apply] this result was marked applied before; re-planning anyway to verify the current project state.`);
    }

    console.log(`[apply] selected artifact: ${file.name || file.id} · ${file.id} · ${bytes(file.size)}${file.absolutePath ? ` · ${file.absolutePath}` : ''}`);
    console.log(`[apply] planning last result ${file.name || file.id} against ${state.projectRoot}...`);
    await emitApplyEvent(turn.id, 'apply/planning', { fileId: file.id || '', name: file.name || '', size: file.size || 0 });
    const referenceManifest = await buildApplyReference(projectService, state);
    const options = { sync: true, referenceManifest };
    const plan = await planZipApply({ zipPath: file.absolutePath, projectRoot: state.projectRoot, options });
    printApplyPlan(plan);
    await emitApplyEvent(turn.id, 'apply/plan.ready', {
      safe: Boolean(plan.safety?.safe),
      warnings: plan.safety?.warnings || [],
      requiresConfirmation: Boolean(plan.requiresConfirmation),
      filesToCreate: plan.plan?.filesToCreate || 0,
      filesToUpdate: plan.plan?.filesToUpdate || 0,
      filesToDelete: plan.plan?.filesToDelete || 0,
      filesUnchanged: plan.plan?.filesUnchanged || 0,
      filesSkipped: plan.plan?.filesSkipped || 0,
      filesLocallyChanged: plan.plan?.filesLocallyChanged || 0,
      filesLocallyChangedDelete: plan.plan?.filesLocallyChangedDelete || 0,
    });
    if (planOnly) return plan;

  if (auto && !force && !interactive) {
    const decision = autoApplyDecision(plan);
    if (!decision.ok) {
      printAutoApplySkip(decision, plan);
      await emitApplyEvent(turn.id, 'apply/skipped', {
        reason: decision.reason,
        safe: Boolean(plan.safety?.safe),
        warnings: plan.safety?.warnings || [],
        requiresConfirmation: Boolean(plan.requiresConfirmation),
        filesToCreate: plan.plan?.filesToCreate || 0,
        filesToUpdate: plan.plan?.filesToUpdate || 0,
        filesToDelete: plan.plan?.filesToDelete || 0,
        filesUnchanged: plan.plan?.filesUnchanged || 0,
        filesSkipped: plan.plan?.filesSkipped || 0,
        filesLocallyChanged: plan.plan?.filesLocallyChanged || 0,
        filesLocallyChangedDelete: plan.plan?.filesLocallyChangedDelete || 0,
      });
      return { skipped: true, reason: decision.reason, plan };
    }
    console.log('[apply] safe plan detected; applying automatically.');
    await emitApplyEvent(turn.id, 'apply/auto.started', { reason: decision.reason });
  } else if (!force && !interactive) {
    const question = plan.safety.safe
      ? 'Apply this sync plan to the project? [y/N] '
      : 'Apply this sync plan despite warnings/local changes? [y/N] ';
    const ok = confirm ? await confirm(question) : false;
    if (!ok) {
      console.log('[apply] cancelled');
      await emitApplyEvent(turn.id, 'apply/skipped', { reason: 'cancelled' });
      return null;
    }
    if (!plan.safety?.safe || plan.requiresConfirmation) {
      console.log('[apply] applying despite warnings because /apply was explicitly confirmed.');
    }
  }

  let selectedWritePaths = null;
  let selectedDeletePaths = null;
  if (interactive && !force) {
    const selection = await askInteractiveApplySelection(plan, confirm);
    selectedWritePaths = selection.selectedWritePaths;
    selectedDeletePaths = selection.selectedDeletePaths;
    const ok = confirm ? await confirm('Apply selected changes now? [y/N] ') : false;
    if (!ok) {
      console.log('[apply] cancelled');
      await emitApplyEvent(turn.id, 'apply/skipped', { reason: 'cancelled' });
      return null;
    }
  }

  console.log('[apply] writing selected changes...');
  const result = await applyZipToProject({
    zipPath: file.absolutePath,
    projectRoot: state.projectRoot,
    options: {
      ...options,
      conflictPolicy: 'overwrite',
      ...(selectedWritePaths ? { selectedWritePaths } : {}),
      ...(selectedDeletePaths ? { selectedDeletePaths } : {}),
    },
  });
  const previousAppliedFileId = state.lastAppliedFileId || '';
  state.lastAppliedTurnId = turn.id;
  state.lastAppliedFileId = file.id || '';
  state.lastAppliedResult = result;
  state.lastApplySummary = { ...applyEventPayload(result), projectRoot: result.projectRoot || state.projectRoot || '', appliedAt: result.appliedAt || new Date().toISOString(), turnId: turn.id, fileId: file.id || '' };
  printAppliedChanges(result);
  console.log(`[apply] wrote ${result.written.length} file(s), deleted ${result.deleted.length} file(s) in ${result.projectRoot}`);
  if (previousAppliedFileId && previousAppliedFileId !== state.lastAppliedFileId) {
    await cleanupAppliedResultArchives(fileStore, { ...state, lastAppliedFileId: previousAppliedFileId }, state.lastAppliedFileId);
  } else {
    await cleanupAppliedResultArchives(fileStore, state, state.lastAppliedFileId);
  }
  if (result.skipped.length) console.log(`[apply] skipped ${result.skipped.length} file(s)`);
  await emitApplyEvent(turn.id, 'apply/done', {
    fileId: file.id || '',
    written: result.written.length,
    deleted: result.deleted.length,
    skipped: result.skipped.length,
    projectRoot: result.projectRoot || state.projectRoot || '',
    ...applyEventPayload(result),
  });
  return result;
  } catch (err) {
    await emitApplyEvent(selectedTurnId, 'apply/failed', { message: err.message || String(err), code: err.code || '' });
    throw err;
  }
}
