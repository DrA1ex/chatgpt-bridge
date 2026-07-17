import { captureGitPathStates } from '../gitCommit.js';
import { WorkflowPipelineStatus, WorkflowStateEventType } from '../state/workflowState.js';
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
    const previousWorkflowPaths = [...(runtime.workflowCommitPaths || [])];
    const previousPathStates = { ...(runtime.workflowCommitPathStates || {}) };
    runtime.workflowCommitBaseSha ||= String(preApplyGit?.head || '');
    runtime.workflowCommitPaths = Array.from(new Set([...previousWorkflowPaths, ...workflowPaths]));
    runtime.workflowCommitPathStates = { ...previousPathStates, ...pathStates };
    runtime.pendingCheckFailure = {
      id: createWorkflowId('checks-failed'),
      pipelineId: state.pipelineId,
      artifactKey: state.artifactKey,
      workflowPaths,
      pathStates,
      previousWorkflowPaths,
      previousPathStates,
      preApplyGit,
      verification: state.verification,
      response: state.response,
      applied: appliedSummary,
      rollbackManifest: applyState.manifest || [],
      commands: commandSummary(error.commandResults || applyState.commands?.results || []),
      message: error.message || 'Project checks failed after applying changes.',
      createdAt: nowIso(),
    };
    await this.store.setArtifact(state.artifactKey, {
      ...(await this.store.getArtifact(state.artifactKey)),
      status: 'awaiting-check-decision',
      appliedAt: nowIso(),
      applied: appliedSummary,
      checkFailure: {
        message: runtime.pendingCheckFailure.message,
        commands: runtime.pendingCheckFailure.commands,
      },
    });
    await this.persistRuntime(runtime);
    await this.transition(runtime, WorkflowStateEventType.PIPELINE_STAGE_CHANGED, {
      pipelineId: state.pipelineId,
      status: WorkflowPipelineStatus.AWAITING_APPROVAL,
      approvalId: runtime.pendingCheckFailure.id,
      evidence: { approvalType: 'failed-checks', paths: workflowPaths },
    }, 'workflow.checks.failed.after-apply', {
      pipelineId: state.pipelineId,
      approvalId: runtime.pendingCheckFailure.id,
      message: runtime.pendingCheckFailure.message,
      commands: runtime.pendingCheckFailure.commands,
    });
    return { status: 'checks-failed', attention: true };
  }

  async startFixLoop(runtime) {
    const pending = this.#pending(runtime);
    runtime.pendingCheckFailure = null;
    runtime.config.automation.enabled = true;
    await this.persistConfig?.(runtime);
    await this.persistRuntime(runtime);
    await this.applyCompletionService.complete(runtime, pending, {
      commit: { committed: false, reason: 'checks-failed-fix-loop' },
      warnings: ['Project checks failed. The workflow was converted into a fix loop.'],
    });
    return await this.runAutomation(runtime, { trigger: 'checks-failed-fix-loop' });
  }

  async keepAndStop(runtime) {
    const pending = this.#pending(runtime);
    let commit = await this.commitService.maybeCommit(runtime, pending.response || {}, pending.pipelineId, {
      preApplyGit: pending.preApplyGit,
      verification: pending.verification,
      workflowPaths: pending.workflowPaths,
    });
    runtime.pendingCheckFailure = null;
    if (commit.reason === 'approval-required') {
      const approvalId = createWorkflowId('commit-approval');
      runtime.pendingCommit = {
        id: approvalId,
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
      await this.persistRuntime(runtime);
      await this.transition(runtime, WorkflowStateEventType.PIPELINE_STAGE_CHANGED, {
        pipelineId: pending.pipelineId,
        status: WorkflowPipelineStatus.AWAITING_APPROVAL,
        approvalId,
        evidence: { approvalType: 'commit', message: commit.message, paths: pending.workflowPaths },
      }, 'workflow.commit.approval.required', {
        pipelineId: pending.pipelineId,
        approvalId,
        message: commit.message,
        paths: pending.workflowPaths,
      });
      return { status: 'pending-approval', approvalType: 'commit', approvalId };
    }
    const result = await this.applyCompletionService.complete(runtime, pending, {
      commit,
      warnings: ['Project checks failed; the user chose to keep the applied changes.'],
    });
    await this.stopWatcher(runtime);
    return result;
  }

  async revert(runtime) {
    const pending = this.#pending(runtime);
    const rollback = await this.applier.rollback({ workflow: runtime.config, manifest: pending.rollbackManifest || [] });
    if (!rollback.ok) throw new Error(`The workflow update could not be fully reverted: ${rollback.errors.map((item) => `${item.path}: ${item.message}`).join('; ')}`);
    runtime.pendingCheckFailure = null;
    runtime.workflowCommitPaths = [...(pending.previousWorkflowPaths || [])];
    runtime.workflowCommitPathStates = { ...(pending.previousPathStates || {}) };
    await this.store.setArtifact(pending.artifactKey, {
      ...(await this.store.getArtifact(pending.artifactKey)),
      status: 'reverted',
      revertedAt: nowIso(),
      rollback,
    });
    await this.persistRuntime(runtime);
    await this.transition(runtime, WorkflowStateEventType.PIPELINE_REJECTED, {
      pipelineId: pending.pipelineId,
      approvalId: pending.id,
      code: 'failed_checks_reverted',
      message: 'The applied workflow update was reverted after project checks failed.',
    }, 'workflow.checks.failed.reverted', { pipelineId: pending.pipelineId, rollback });
    return rollback;
  }

  #pending(runtime) {
    if (!runtime.pendingCheckFailure) throw new Error(`Workflow ${runtime.id} has no failed-check decision`);
    return runtime.pendingCheckFailure;
  }
}
