import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import {
  WorkflowEffectStatus,
  WorkflowEventType,
  WorkflowLocalEffectKind,
  workflowLocalEffectRetryMode,
} from './workflowState.js';

const execFileAsync = promisify(execFile);
const SAFE_LOCAL_EFFECTS = new Set([
  WorkflowLocalEffectKind.PROJECT_SNAPSHOT,
  WorkflowLocalEffectKind.CHECKS,
  WorkflowLocalEffectKind.VERIFY,
  WorkflowLocalEffectKind.PLAN,
]);

export function isSafeLocalEffect(kind) {
  return SAFE_LOCAL_EFFECTS.has(String(kind || ''));
}

export function unresolvedLocalEffects(state = {}) {
  return Object.values(state.localEffects || {}).filter((effect) => effect && ![
    WorkflowEffectStatus.SUCCEEDED,
    WorkflowEffectStatus.FAILED,
    WorkflowEffectStatus.CANCELLED,
  ].includes(effect.status));
}

async function readJson(file = '') {
  if (!file) return null;
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

async function gitValue(root, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    return String(stdout || '').trim();
  } catch { return ''; }
}

async function rollbackManifestRestored(projectRoot, manifest = []) {
  if (!projectRoot || !Array.isArray(manifest) || !manifest.length) return false;
  for (const entry of manifest) {
    const target = path.resolve(projectRoot, String(entry.path || ''));
    if (!target.startsWith(`${path.resolve(projectRoot)}${path.sep}`) && target !== path.resolve(projectRoot)) return false;
    const stat = await fs.lstat(target).catch(() => null);
    if (!entry.exists) {
      if (stat) return false;
      continue;
    }
    if (entry.type !== 'file' || !entry.backupPath || !stat?.isFile()) return false;
    const [current, backup] = await Promise.all([
      fs.readFile(target).catch(() => null),
      fs.readFile(entry.backupPath).catch(() => null),
    ]);
    if (!current || !backup || !current.equals(backup)) return false;
  }
  return true;
}

/**
 * Reconcile one persisted local effect using kind-specific durable evidence.
 * No write is repeated here. The caller may only retry after a proved
 * not-started result or when the operation is read-only/idempotent.
 */
export async function reconcileLocalEffect({ effect, runtime } = {}) {
  if (!effect) return { outcome: 'uncertain', reason: 'effect_missing' };
  if (effect.status === WorkflowEffectStatus.PLANNED) return { outcome: 'not_started', reason: 'intent_not_dispatched' };
  if (isSafeLocalEffect(effect.kind)) return { outcome: 'safe_retry', reason: 'read_only_effect' };
  const refs = effect.references || {};

  if (effect.kind === WorkflowLocalEffectKind.APPLY) {
    const receipt = await readJson(refs.receiptPath);
    if (receipt) return { outcome: 'succeeded', reason: 'apply_receipt', result: receipt };
    const manifest = await readJson(refs.manifestPath);
    if (!manifest) return { outcome: 'not_started', reason: 'rollback_manifest_absent' };
    return { outcome: 'uncertain', reason: 'apply_started_without_completion_receipt', evidence: { manifestPath: refs.manifestPath } };
  }

  if (effect.kind === WorkflowLocalEffectKind.ROLLBACK) {
    const receipt = await readJson(refs.receiptPath);
    if (receipt) return { outcome: 'succeeded', reason: refs.mode === 'git_restore' ? 'git_restore_receipt' : 'rollback_receipt', result: receipt };
    if (refs.mode === 'git_restore') {
      const root = runtime?.config?.projectRoot || '';
      const baseSha = String(refs.baseSha || '');
      const paths = Array.isArray(refs.paths) ? refs.paths.map(String).filter(Boolean) : [];
      const preCommitHead = String(refs.preCommitHead || '');
      const checkpoints = Array.isArray(refs.checkpointShas) ? refs.checkpointShas.map(String).filter(Boolean) : [];
      if (!root || !baseSha || !paths.length || !preCommitHead) {
        return { outcome: 'uncertain', reason: 'git_restore_evidence_missing' };
      }
      const head = await gitValue(root, ['rev-parse', 'HEAD']);
      const pathDiff = await gitValue(root, ['diff', '--name-only', baseSha, '--', ...paths]);
      const pathsMatchBase = pathDiff === '';
      let expectedHead = preCommitHead;
      let backupRef = '';
      if (checkpoints.length && preCommitHead === checkpoints.at(-1)) {
        const graph = (await gitValue(root, ['rev-list', '--reverse', `${baseSha}..${preCommitHead}`])).split('\n').filter(Boolean);
        const exactCheckpointGraph = graph.length === checkpoints.length && graph.every((sha, index) => sha === checkpoints[index]);
        if (exactCheckpointGraph) {
          expectedHead = baseSha;
          const safeRef = String(refs.refName || 'workflow').replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/^[-/]+|[-/]+$/g, '') || 'workflow';
          backupRef = `refs/bridge/workflows/${safeRef}-before-restore`;
          const backupHead = await gitValue(root, ['rev-parse', backupRef]);
          if (backupHead !== checkpoints.at(-1)) {
            return { outcome: 'uncertain', reason: 'git_restore_backup_not_proved', evidence: { head, backupRef, backupHead } };
          }
        }
      }
      if (pathsMatchBase && head === expectedHead) {
        return { outcome: 'succeeded', reason: 'git_restore_verified', result: { restored: true, reconciled: true, baseSha, paths, head, backupRef } };
      }
      return { outcome: 'uncertain', reason: 'git_restore_state_not_proved', evidence: { head, expectedHead, pathsMatchBase } };
    }
    const manifest = await readJson(refs.manifestPath);
    if (!manifest) return { outcome: 'not_started', reason: 'rollback_manifest_absent' };
    if (await rollbackManifestRestored(runtime?.config?.projectRoot || '', manifest)) {
      return { outcome: 'succeeded', reason: 'rollback_state_verified', result: { ok: true, reconciled: true, paths: manifest.map((item) => item.path) } };
    }
    return { outcome: 'uncertain', reason: 'rollback_state_not_proved' };
  }

  if ([WorkflowLocalEffectKind.COMMIT, WorkflowLocalEffectKind.SQUASH].includes(effect.kind)) {
    const receipt = await readJson(refs.receiptPath);
    if (receipt) return { outcome: 'succeeded', reason: effect.kind === WorkflowLocalEffectKind.SQUASH ? 'squash_receipt' : 'commit_receipt', result: receipt };
    const root = runtime?.config?.projectRoot || '';
    const expectedMessage = String(refs.expectedMessage || '');
    const preCommitHead = String(refs.preCommitHead || refs.baseSha || '');
    if (!root || !expectedMessage || !preCommitHead) return { outcome: 'uncertain', reason: 'git_reconciliation_evidence_missing' };
    const head = await gitValue(root, ['rev-parse', 'HEAD']);
    if (!head) return { outcome: 'uncertain', reason: 'git_head_unavailable' };
    if (head === preCommitHead) return { outcome: 'not_started', reason: 'git_head_unchanged' };
    const message = await gitValue(root, ['log', '-1', '--format=%B']);
    if (message !== expectedMessage.trim()) return { outcome: 'uncertain', reason: 'git_head_changed_without_expected_commit', evidence: { head } };
    if (effect.kind === WorkflowLocalEffectKind.SQUASH) {
      const baseSha = String(refs.baseSha || '');
      const checkpointShas = Array.isArray(refs.checkpointShas) ? refs.checkpointShas.map(String).filter(Boolean) : [];
      const backupRef = String(refs.backupRef || '');
      if (!baseSha || checkpointShas.length < 2 || !backupRef) return { outcome: 'uncertain', reason: 'squash_graph_evidence_missing' };
      const parent = await gitValue(root, ['rev-parse', 'HEAD^']);
      const backupHead = await gitValue(root, ['rev-parse', backupRef]);
      const checkpointGraph = (await gitValue(root, ['rev-list', '--reverse', `${baseSha}..${backupRef}`])).split('\n').filter(Boolean);
      const graphMatches = parent === baseSha
        && backupHead === checkpointShas.at(-1)
        && checkpointGraph.length === checkpointShas.length
        && checkpointGraph.every((sha, index) => sha === checkpointShas[index]);
      if (!graphMatches) return { outcome: 'uncertain', reason: 'squash_graph_not_proved', evidence: { head, parent, backupHead, checkpointGraph } };
      return { outcome: 'succeeded', reason: 'git_squash_verified', result: { sha: head, message, baseSha, checkpointShas, backupRef } };
    }
    return { outcome: 'succeeded', reason: 'git_commit_verified', result: { sha: head, message } };
  }

  return { outcome: 'uncertain', reason: `no_reconciler_for_${effect.kind}` };
}

export function localEffectRecoveryDecision(state = {}) {
  const unresolved = unresolvedLocalEffects(state);
  const blocked = unresolved.find((effect) => {
    if (effect.status === WorkflowEffectStatus.PLANNED) return false;
    if (effect.safe) return effect.attempt >= Number(state.retryPolicy?.safeLimit || 0);
    const policy = workflowLocalEffectRetryMode(state, effect.kind);
    return policy !== 'always';
  });
  if (!blocked) return { automatic: true, effectIds: unresolved.map((effect) => effect.id) };
  return {
    automatic: false,
    effect: blocked,
    reason: `Cannot safely determine whether local ${blocked.kind} (${blocked.id}) completed before restart.`,
  };
}

export async function executeLocalEffect({ transition, runtime, effect, execute, afterDispatch = null }) {
  if (typeof transition !== 'function' || typeof execute !== 'function') throw new TypeError('Local effect execution requires transition and execute');
  const localEffectId = String(effect?.id || effect?.localEffectId || '');
  const kind = String(effect?.kind || '');
  if (!localEffectId || !Object.values(WorkflowLocalEffectKind).includes(kind)) throw new TypeError('Local effect requires a known id and kind');
  if (runtime.workflowState.control?.stopRequested || runtime.workflowState.control?.pauseRequested) {
    throw Object.assign(new Error('Workflow effects are blocked while pause or stop is pending'), { code: 'WORKFLOW_EFFECT_CONTROL_BARRIER' });
  }
  const existing = runtime.workflowState.localEffects?.[localEffectId];
  if (existing?.status === WorkflowEffectStatus.SUCCEEDED) return existing.result;
  if (existing && existing.status !== WorkflowEffectStatus.PLANNED) {
    throw Object.assign(new Error(`Local effect ${localEffectId} must be reconciled before dispatch; current status is ${existing.status}`), { code: 'WORKFLOW_LOCAL_EFFECT_NOT_RECOVERED' });
  }
  if (!existing) {
    await transition(runtime, WorkflowEventType.LOCAL_EFFECT_PLANNED, {
      localEffectId,
      runId: runtime.workflowState.run.id,
      kind,
      safe: effect.safe ?? isSafeLocalEffect(kind),
      idempotencyKey: effect.idempotencyKey || localEffectId,
      preconditionsHash: effect.preconditionsHash,
      policy: effect.policy || workflowLocalEffectRetryMode(runtime.workflowState, kind),
      references: effect.references || {},
      processIdentity: effect.processIdentity || '',
      transactionIdentity: effect.transactionIdentity || '',
    });
  } else if (existing.idempotencyKey !== (effect.idempotencyKey || localEffectId) || existing.preconditionsHash !== effect.preconditionsHash) {
    throw Object.assign(new Error(`Local effect ${localEffectId} recovery guards changed`), { code: 'WORKFLOW_LOCAL_EFFECT_GUARD_MISMATCH' });
  }
  await transition(runtime, WorkflowEventType.LOCAL_EFFECT_DISPATCHED, {
    localEffectId,
    processIdentity: effect.processIdentity || '',
    transactionIdentity: effect.transactionIdentity || '',
  });
  const attempt = runtime.workflowState.localEffects[localEffectId].attempt;
  let result;
  try {
    if (typeof afterDispatch === 'function') await afterDispatch({ localEffectId, attempt });
    result = await execute();
  } catch (error) {
    const uncertain = Boolean(error?.uncertain || error?.code === 'EFFECT_OUTCOME_UNKNOWN' || error?.code === 'LOCAL_EFFECT_OUTCOME_UNKNOWN');
    try {
      await transition(runtime, uncertain ? WorkflowEventType.LOCAL_EFFECT_UNCERTAIN : WorkflowEventType.LOCAL_EFFECT_FAILED, {
        localEffectId,
        attempt,
        error: error?.message || String(error),
      });
    } catch (commitError) {
      throw Object.assign(new Error(`Local workflow effect ${localEffectId} outcome could not be persisted`), {
        code: 'WORKFLOW_LOCAL_EFFECT_RESULT_COMMIT_FAILED',
        uncertain: true,
        cause: commitError,
        executionError: error,
      });
    }
    throw error;
  }
  try {
    await transition(runtime, WorkflowEventType.LOCAL_EFFECT_SUCCEEDED, { localEffectId, attempt, result: result || {} });
  } catch (commitError) {
    throw Object.assign(new Error(`Local workflow effect ${localEffectId} success could not be persisted`), {
      code: 'WORKFLOW_LOCAL_EFFECT_RESULT_COMMIT_FAILED',
      uncertain: true,
      cause: commitError,
      result,
    });
  }
  return result;
}
