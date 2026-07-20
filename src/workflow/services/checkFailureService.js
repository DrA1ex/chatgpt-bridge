import path from 'node:path';
import { createHash } from 'node:crypto';
import { captureGitPathStates } from '../gitCommit.js';
import { WorkflowActionKind, WorkflowEffectKind, WorkflowLocalEffectKind, WorkflowEventType, WorkflowPhase, WorkflowRunKind } from '../state/workflowState.js';
import { executeWorkflowEffect } from '../state/workflowEffects.js';
import { executeLocalEffect } from '../state/localEffects.js';
import { mergeWorkflowGitState, replaceWorkflowGitState, workflowGitState } from '../state/workflowGitState.js';
import { nowIso, workflowId as createWorkflowId } from '../support/workflowValues.js';

function commandSummary(commands = []) {
  return commands.map((item) => ({
    command: item.command || '',
    ok: Boolean(item.ok),
    code: item.code ?? null,
    stdout: String(item.stdout || '').slice(-8_000),
    stderr: String(item.stderr || '').slice(-8_000),
  }));
}

export class WorkflowCheckFailureService {
  constructor({ applier, store, commitService, applyCompletionService, transition, persistRuntime, persistConfig, publish, runAutomation, stopWatcher } = {}) {
    this.applier = applier;
    this.store = store;
    this.commitService = commitService;
    this.applyCompletionService = applyCompletionService;
    this.transition = transition;
    this.persistRuntime = persistRuntime;
    this.persistConfig = persistConfig;
    this.publish = publish;
    this.runAutomation = runAutomation;
    this.stopWatcher = stopWatcher;
  }

  async capture(runtime, state, error, { workflowPaths, preApplyGit, appliedSummary } = {}) {
    const applyState = error.workflowApply || {};
    const pathStates = await captureGitPathStates(runtime.config.projectRoot, workflowPaths);
    const previousGit = workflowGitState(runtime);
    const previousWorkflowPaths = [...previousGit.ownedPaths];
    const previousPathStates = { ...previousGit.pathStates };
    await mergeWorkflowGitState(this.transition, runtime, {
      baseSha: String(preApplyGit?.head || ''),
      ownedPaths: workflowPaths,
      pathStates,
    }, 'failed-check workflow ownership recorded');
    const decision = {
      id: createWorkflowId('checks-failed'),
      kind: WorkflowActionKind.FAILED_CHECKS,
      workflowId: runtime.id,
      pipelineId: state.pipelineId,
      artifactKey: state.artifactKey,
      workflowPaths,
      pathStates,
      previousWorkflowPaths,
      previousPathStates,
      previousGit,
      preApplyGit,
      verification: state.verification,
      response: state.response,
      applied: appliedSummary,
      rollbackManifest: applyState.manifest || [],
      commands: commandSummary(error.commandResults || applyState.commands?.results || []),
      message: error.message || 'Project checks failed after applying changes.',
      createdAt: nowIso(),
    };
    const artifact = {
      ...(await this.store.getArtifact(state.artifactKey)),
      status: 'awaiting-check-decision',
      appliedAt: nowIso(),
      applied: appliedSummary,
      checkFailure: {
        message: decision.message,
        commands: decision.commands,
      },
    };
    await this.transition(runtime, WorkflowEventType.ACTION_REQUIRED, {
      runId: runtime.workflowState.run.id,
      actionId: decision.id,
      kind: WorkflowActionKind.FAILED_CHECKS,
      reason: decision.message,
      choices: [
        { id: 'fix', label: 'Start fix loop', transition: 'continue', phase: WorkflowPhase.REMEDIATING },
        { id: 'keep', label: 'Keep changes and stop', transition: 'continue', phase: WorkflowPhase.COMMITTING },
        { id: 'revert', label: 'Revert workflow changes', transition: 'continue', phase: WorkflowPhase.ROLLING_BACK },
        { id: 'stop', label: 'Stop workflow', transition: 'stop' },
      ],
      references: { payloadRef: decision.id, paths: workflowPaths },
    }, 'workflow.checks.failed.after-apply', {
      pipelineId: state.pipelineId,
      actionId: decision.id,
      message: decision.message,
      commands: decision.commands,
    }, {
      actionPayloads: { [decision.id]: decision },
      artifacts: { [state.artifactKey]: artifact },
    });
    return { status: 'waiting_action', actionId: decision.id };
  }

  async startFixLoop(runtime, value) {
    const pending = await this.#pending(runtime, value);
    await this.#resolve(pending, 'fix');
    runtime.config.automation.enabled = true;
    await this.persistConfig?.(runtime);
    await this.persistRuntime(runtime);
    await this.applyCompletionService.complete(runtime, pending, {
      commit: { committed: false, reason: 'checks-failed-fix-loop' },
      warnings: ['Project checks failed. The workflow was converted into a fix loop.'],
    });
    if (runtime.workflowState.run.kind === WorkflowRunKind.AUTOMATION) return { status: 'fix-loop-continued' };
    return await this.runAutomation(runtime, { trigger: 'checks-failed-fix-loop' });
  }

  async keepAndStop(runtime, value) {
    const pending = await this.#pending(runtime, value);
    let commit = await this.commitService.maybeCommit(runtime, pending.response || {}, pending.pipelineId, {
      preApplyGit: pending.preApplyGit,
      verification: pending.verification,
      workflowPaths: pending.workflowPaths,
    });
    await this.#resolve(pending, 'keep');
    if (commit.reason === 'approval-required') {
      const approvalId = createWorkflowId('commit-approval');
      const decision = {
        id: approvalId,
        kind: WorkflowActionKind.COMMIT,
        workflowId: runtime.id,
          pipelineId: pending.pipelineId,
        artifactKey: pending.artifactKey,
        message: commit.message,
        paths: pending.workflowPaths,
        pathStates: commit.pathStates || pending.pathStates || {},
        preApplyHead: String(pending.preApplyGit?.head || ''),
        applied: pending.applied,
        extensionUpdate: { updated: false },
        warnings: ['Project checks failed; the user chose to keep the applied changes.'],
        response: pending.response || {},
        stopAfterCommit: true,
        createdAt: nowIso(),
      };
      await this.transition(runtime, WorkflowEventType.ACTION_REQUIRED, {
        runId: runtime.workflowState.run.id,
        actionId: approvalId,
        kind: WorkflowActionKind.COMMIT,
        reason: commit.message,
        choices: [
          { id: 'commit', label: 'Create commit', transition: 'continue', phase: WorkflowPhase.COMMITTING },
          { id: 'continue_without_commit', label: 'Continue without commit', transition: 'continue', phase: WorkflowPhase.CHECKING },
          { id: 'stop', label: 'Stop workflow', transition: 'stop' },
        ],
        references: { payloadRef: approvalId, paths: pending.workflowPaths },
      }, 'workflow.commit.approval.required', {
        pipelineId: pending.pipelineId,
        approvalId,
        message: commit.message,
        paths: pending.workflowPaths,
      }, { actionPayloads: { [approvalId]: decision } });
      return { status: 'pending-approval', approvalType: 'commit', approvalId };
    }
    const result = await this.applyCompletionService.complete(runtime, pending, {
      commit,
      warnings: ['Project checks failed; the user chose to keep the applied changes.'],
    });
    await this.stopWatcher(runtime);
    return result;
  }

  async revert(runtime, value) {
    const pending = await this.#pending(runtime, value);
    const manifest = pending.rollbackManifest || [];
    const preconditionsHash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    const effectId = `${runtime.workflowState.run.id}:rollback:failed-checks`;
    const backupRoot = path.join(this.applier.dataDir, 'workflows', runtime.config.id, 'pipelines', pending.pipelineId, 'rollback');
    const rollback = await executeLocalEffect({
      transition: this.transition,
      runtime,
      effect: { id: effectId, kind: WorkflowLocalEffectKind.ROLLBACK, safe: false, idempotencyKey: effectId, preconditionsHash, references: { manifestPath: path.join(backupRoot, 'manifest.json'), receiptPath: path.join(backupRoot, 'rollback-completed.json'), pipelineId: pending.pipelineId } },
      execute: () => this.applier.rollback({ workflow: runtime.config, manifest, backupRoot }),
    });
    if (!rollback.ok) throw new Error(`The workflow update could not be fully reverted: ${rollback.errors.map((item) => `${item.path}: ${item.message}`).join('; ')}`);
    await this.#resolve(pending, 'revert');
    await replaceWorkflowGitState(this.transition, runtime, pending.previousGit || {
      ...workflowGitState(runtime),
      ownedPaths: pending.previousWorkflowPaths || [],
      pathStates: pending.previousPathStates || {},
    }, 'failed-check apply reverted');
    await this.store.setArtifact(pending.artifactKey, {
      ...(await this.store.getArtifact(pending.artifactKey)),
      status: 'reverted',
      revertedAt: nowIso(),
      rollback,
    });
    await this.transition(runtime, WorkflowEventType.RUN_CANCELLED, {
      runId: runtime.workflowState.run.id,
      code: 'failed_checks_reverted',
      message: 'The applied workflow update was reverted after project checks failed.',
    }, 'workflow.checks.failed.reverted', { pipelineId: pending.pipelineId, rollback });
    return rollback;
  }

  async #pending(runtime, value) {
    const pending = typeof value === 'string' ? await this.store.getActionPayload(value) : value;
    if (!pending || pending.workflowId !== runtime.id || pending.kind !== WorkflowActionKind.FAILED_CHECKS) throw new Error(`Workflow ${runtime.id} has no matching failed-check decision`);
    return pending;
  }

  async #resolve(_payload, _choice) {
    // ACTION_RESOLVED is the only durable decision lifecycle transition.
  }
}
