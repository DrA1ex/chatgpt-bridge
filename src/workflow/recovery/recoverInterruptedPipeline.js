import fs from 'node:fs/promises';
import path from 'node:path';
import {
  WorkflowPipelineStatus,
  WorkflowStateEventType,
  isWorkflowPipelineTerminal,
} from '../state/workflowState.js';

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
  const pipelineId = String(runtime.lastPipelineId || runtime.workflowState?.pipeline?.id || '');
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
    if (runtime.workflowState?.pipeline?.id === pipelineId && !isWorkflowPipelineTerminal(runtime.workflowState)) {
      await transition(runtime, WorkflowStateEventType.PIPELINE_FAILED, {
        pipelineId,
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
    if (runtime.workflowState?.pipeline?.id === pipelineId && !isWorkflowPipelineTerminal(runtime.workflowState)) {
      await transition(runtime, WorkflowStateEventType.PIPELINE_FAILED, {
        pipelineId,
        code: 'unsafe_rollback_manifest',
        message: runtime.lastError,
      });
    }
    await transition(runtime, WorkflowStateEventType.WATCHER_STOPPED, {}, 'workflow.interrupted.rollback.failed', {
      pipelineId,
      message: runtime.lastError,
    });
    return;
  }

  if (runtime.workflowState?.pipeline?.id === pipelineId && !isWorkflowPipelineTerminal(runtime.workflowState)) {
    await transition(runtime, WorkflowStateEventType.PIPELINE_STAGE_CHANGED, {
      pipelineId,
      status: WorkflowPipelineStatus.ROLLING_BACK,
    });
  }

  const rollback = await applier.rollback({ workflow: runtime.config, manifest });
  runtime.lastError = rollback.ok ? '' : `Interrupted pipeline rollback failed for ${rollback.errors.length} path(s)`;
  if (rollback.ok) {
    await transition(runtime, WorkflowStateEventType.PIPELINE_COMPLETED, {
      pipelineId,
      code: 'interrupted_rollback_completed',
      evidence: { rollback },
    }, 'workflow.interrupted.rollback.completed', { pipelineId, rollback });
    syncRefreshTimer(runtime);
    return;
  }

  await transition(runtime, WorkflowStateEventType.PIPELINE_FAILED, {
    pipelineId,
    code: 'interrupted_rollback_failed',
    message: runtime.lastError,
    evidence: { rollback },
  });
  await transition(runtime, WorkflowStateEventType.WATCHER_STOPPED, {}, 'workflow.interrupted.rollback.failed', {
    pipelineId,
    rollback,
  });
}
