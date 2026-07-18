import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  WorkflowEffectKind,
  WorkflowEventType,
  WorkflowLifecycle,
  WorkflowPhase,
} from '../state/workflowState.js';
import { executeWorkflowEffect } from '../state/workflowEffects.js';

function pathWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function manifestIsSafe({ manifest, projectRoot, rollbackRoot }) {
  return manifest.every((entry) => {
    const relativePath = String(entry?.path || '').replace(/\\/g, '/');
    if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').includes('..')) return false;
    if (!pathWithin(projectRoot, path.resolve(projectRoot, relativePath))) return false;
    if (entry.exists && entry.type === 'file') {
      const backupPath = path.resolve(String(entry.backupPath || ''));
      if (!pathWithin(rollbackRoot, backupPath)) return false;
    }
    return true;
  });
}

export async function recoverInterruptedPipeline({
  runtime,
  dataDir,
  applier,
  persistRuntime,
  transition,
  publish,
  syncRefreshTimer,
}) {
  const pipelineId = String(runtime.workflowState?.run?.id || runtime.lastPipelineId || '');
  if (!pipelineId || !/^[a-zA-Z0-9._-]+$/.test(pipelineId)) {
    runtime.lastError = pipelineId
      ? 'Interrupted pipeline id is invalid; no automatic rollback was attempted'
      : '';
    await persistRuntime(runtime);
    await publish(runtime.id, 'workflow.interrupted.detected', {
      pipelineId,
      rollbackAvailable: false,
      workflowStateRevision: runtime.workflowState?.revision || 0,
    });
    return;
  }

  const rollbackRoot = path.resolve(dataDir, 'workflows', runtime.id, 'pipelines', pipelineId, 'rollback');
  const manifestPath = path.join(rollbackRoot, 'manifest.json');
  const manifest = await fs.readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => null);
  if (!Array.isArray(manifest)) {
    runtime.lastError = '';
    if (runtime.workflowState?.run?.id === pipelineId) {
      await transition(runtime, WorkflowEventType.RUN_FAILED, {
        runId: pipelineId,
        code: 'interrupted_without_rollback',
        message: 'Interrupted pipeline had no rollback manifest',
        evidence: { rollbackAvailable: false },
      }, 'workflow.interrupted.detected', { pipelineId, rollbackAvailable: false });
    } else {
      await persistRuntime(runtime);
      await publish(runtime.id, 'workflow.interrupted.detected', { pipelineId, rollbackAvailable: false });
    }
    syncRefreshTimer(runtime);
    return;
  }

  const projectRoot = path.resolve(runtime.config.projectRoot);
  if (!manifestIsSafe({ manifest, projectRoot, rollbackRoot })) {
    runtime.lastError = `Interrupted pipeline ${pipelineId} has an unsafe rollback manifest`;
    if (runtime.workflowState?.run?.id === pipelineId) {
      await transition(runtime, WorkflowEventType.RUN_FAILED, {
        runId: pipelineId,
        code: 'unsafe_rollback_manifest',
        message: runtime.lastError,
      });
    }
    if (runtime.workflowState.lifecycle !== WorkflowLifecycle.STOPPED) await transition(runtime, WorkflowEventType.STOPPED, { runId: pipelineId }, 'workflow.interrupted.rollback.failed', {
      pipelineId,
      message: runtime.lastError,
    });
    return;
  }

  if (runtime.workflowState?.run?.id === pipelineId) {
    if (runtime.workflowState.lifecycle === WorkflowLifecycle.RECOVERING) await transition(runtime, WorkflowEventType.RECOVERY_RESUMED, { runId: pipelineId });
    await transition(runtime, WorkflowEventType.PHASE_CHANGED, { runId: pipelineId, phase: WorkflowPhase.ROLLING_BACK });
  }

  const preconditionsHash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const rollback = await executeWorkflowEffect({
    transition,
    runtime,
    effect: { id: `${pipelineId}:rollback`, kind: WorkflowEffectKind.ROLLBACK, safe: false, idempotencyKey: `${pipelineId}:rollback`, preconditionsHash },
    execute: () => applier.rollback({ workflow: runtime.config, manifest }),
  });
  runtime.lastError = rollback.ok ? '' : `Interrupted pipeline rollback failed for ${rollback.errors.length} path(s)`;
  if (rollback.ok) {
    await transition(runtime, WorkflowEventType.RUN_CANCELLED, {
      runId: pipelineId,
      code: 'interrupted_rollback_completed',
      evidence: { rollback },
    }, 'workflow.interrupted.rollback.completed', { pipelineId, rollback });
    syncRefreshTimer(runtime);
    return;
  }

  await transition(runtime, WorkflowEventType.RUN_FAILED, {
    runId: pipelineId,
    code: 'interrupted_rollback_failed',
    message: runtime.lastError,
    evidence: { rollback },
  });
  if (runtime.workflowState.lifecycle !== WorkflowLifecycle.STOPPED) await transition(runtime, WorkflowEventType.STOPPED, { runId: pipelineId }, 'workflow.interrupted.rollback.failed', {
    pipelineId,
    rollback,
  });
}
