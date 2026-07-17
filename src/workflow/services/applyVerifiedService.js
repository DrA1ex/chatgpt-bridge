import { inspectGitRepository, verifyGitPathStates } from '../gitCommit.js';
import { applicationSummary } from '../support/workflowSummaries.js';
import { nowIso, workflowId as createWorkflowId } from '../support/workflowValues.js';
import { WorkflowPipelineStatus, WorkflowStateEventType } from '../state/workflowState.js';

function workflowPathsFromPlan(plan = {}) {
  return Array.from(new Set([
    ...(plan.plan?.written || []).map((item) => item.path),
    ...(plan.plan?.delete || []).map((item) => item.path),
    ...(plan.plan?.localChangedDelete || []).map((item) => item.path),
  ].map((item) => String(item || '').replace(/\\/g, '/')).filter(Boolean)));
}

export class WorkflowApplyVerifiedService {
  constructor({ applier, extensionDeployer, commitService, checkFailureService, applyCompletionService, resultRepairService, store, transition, publish, refresh } = {}) {
    this.applier = applier;
    this.extensionDeployer = extensionDeployer;
    this.commitService = commitService;
    this.checkFailureService = checkFailureService;
    this.applyCompletionService = applyCompletionService;
    this.resultRepairService = resultRepairService;
    this.store = store;
    this.transition = transition;
    this.publish = publish;
    this.refresh = refresh;
  }

  async apply(runtime, state) {
    const workflow = runtime.config;
    await this.transition(runtime, WorkflowStateEventType.PIPELINE_STAGE_CHANGED, {
      pipelineId: state.pipelineId,
      status: WorkflowPipelineStatus.APPLYING,
    }, 'workflow.apply.started', { pipelineId: state.pipelineId });
    const workflowPaths = workflowPathsFromPlan(state.plan);
    const preApplyGit = workflow.commit.mode === 'none' ? null : await inspectGitRepository(workflow.projectRoot);
    await this.#assertNoUserOverlap(runtime, state.pipelineId, workflowPaths, preApplyGit);

    let extensionBackup = { available: false, reason: 'disabled' };
    if (workflow.extensionUpdate.enabled) {
      extensionBackup = await this.extensionDeployer.prepareBackup(workflow, { pipelineId: state.pipelineId });
    }
    let applied;
    try {
      applied = await this.applier.apply({ workflow, verification: state.verification, plan: state.plan, pipelineId: state.pipelineId });
      await this.publish(runtime.id, 'workflow.apply.completed', {
        pipelineId: state.pipelineId,
        written: applied.applied.written.length,
        deleted: applied.applied.deleted.length,
        commands: applied.commands.results.map((item) => ({ command: item.command, ok: item.ok, code: item.code, durationMs: item.durationMs })),
      });
    } catch (error) {
      return await this.#handleApplyFailure(runtime, state, error, { workflowPaths, preApplyGit });
    }

    const appliedSummary = applicationSummary(applied);
    const extensionUpdate = await this.extensionDeployer.deploy(workflow, {
      sourceClientId: state.response.sourceClientId || workflow.watch.clientId,
      pipelineId: state.pipelineId,
      backup: extensionBackup,
    }).catch((error) => ({ updated: false, error: error.message, rollback: error.extensionRollback || null, backup: extensionBackup }));
    if (extensionUpdate.updated || extensionUpdate.error) {
      await this.publish(runtime.id, extensionUpdate.error ? 'workflow.extension.update.failed' : 'workflow.extension.update.completed', {
        pipelineId: state.pipelineId,
        ...extensionUpdate,
      });
    }
    return await this.#commitOrComplete(runtime, state, { workflowPaths, preApplyGit, appliedSummary, extensionUpdate });
  }

  async #assertNoUserOverlap(runtime, pipelineId, workflowPaths, preApplyGit) {
    if (!preApplyGit?.available) return;
    const dirtyPaths = new Set(preApplyGit.paths || []);
    const overlap = workflowPaths.filter((item) => dirtyPaths.has(item));
    const expected = Object.fromEntries(overlap
      .filter((item) => runtime.workflowCommitPathStates?.[item])
      .map((item) => [item, runtime.workflowCommitPathStates[item]]));
    const owned = await verifyGitPathStates(runtime.config.projectRoot, expected);
    const changedOwnedPaths = new Set(owned.conflicts.map((item) => item.path));
    const conflicts = overlap.filter((item) => !expected[item] || changedOwnedPaths.has(item));
    if (!conflicts.length) return;
    const message = `Workflow changes overlap existing local edits: ${conflicts.slice(0, 12).join(', ')}`;
    await this.publish(runtime.id, 'workflow.local-change.conflict', { pipelineId, message, paths: conflicts });
    const error = new Error(message);
    error.code = 'WORKFLOW_LOCAL_CHANGE_CONFLICT';
    throw error;
  }

  async #handleApplyFailure(runtime, state, error, { workflowPaths, preApplyGit }) {
    const workflow = runtime.config;
    const commandResults = error.commandResults || error.workflowApply?.commands?.results || [];
    const failureEvent = {
      pipelineId: state.pipelineId,
      message: error.message,
      rollback: error.workflowApply?.rollback || null,
      commands: commandResults.map((item) => ({ command: item.command, ok: item.ok, code: item.code })),
    };
    const attempt = Number(state.remediationAttempt || 0);
    if (workflow.preset === 'apply-changes'
      && error.code === 'WORKFLOW_VALIDATION_FAILED'
      && error.workflowApply?.rollback?.skipped) {
      return await this.checkFailureService.capture(runtime, state, error, {
        workflowPaths,
        preApplyGit,
        appliedSummary: applicationSummary(error.workflowApply),
      });
    }
    if (workflow.remediation.enabled && attempt < workflow.remediation.maxAttempts) {
      await this.transition(runtime, WorkflowStateEventType.PIPELINE_STAGE_CHANGED, {
        pipelineId: state.pipelineId,
        status: WorkflowPipelineStatus.REMEDIATING,
        evidence: { attempt: attempt + 1, failure: error.message },
      }, 'workflow.apply.failed', failureEvent);
      return await this.resultRepairService.remediate(runtime, state, error, attempt + 1);
    }
    runtime.lastError = error.message;
    await this.transition(runtime, WorkflowStateEventType.PIPELINE_FAILED, {
      pipelineId: state.pipelineId,
      code: 'apply_failed',
      message: error.message,
      evidence: failureEvent,
    }, 'workflow.apply.failed', failureEvent);
    this.refresh(runtime);
    throw error;
  }

  async #commitOrComplete(runtime, state, { workflowPaths, preApplyGit, appliedSummary, extensionUpdate }) {
    let commit = { committed: false, reason: 'disabled' };
    let commitError = null;
    try {
      commit = await this.commitService.maybeCommit(runtime, state.response, state.pipelineId, {
        preApplyGit,
        verification: state.verification,
        workflowPaths,
      });
    } catch (error) {
      commitError = error;
      commit = { committed: false, reason: 'commit-failed', error: error.message || String(error) };
      await this.publish(runtime.id, 'workflow.commit.failed', {
        pipelineId: state.pipelineId,
        message: commit.error,
        code: error.code || '',
      });
    }
    const warnings = [commitError?.message, extensionUpdate.error].filter(Boolean);
    if (commit.reason === 'approval-required') {
      return await this.#waitForCommitApproval(runtime, state, { workflowPaths, preApplyGit, appliedSummary, extensionUpdate, warnings, commit });
    }
    return await this.applyCompletionService.complete(runtime, {
      pipelineId: state.pipelineId,
      artifactKey: state.artifactKey,
      applied: appliedSummary,
      extensionUpdate,
      response: state.response,
    }, { commit, warnings });
  }

  async #waitForCommitApproval(runtime, state, { workflowPaths, preApplyGit, appliedSummary, extensionUpdate, warnings, commit }) {
    const approvalId = createWorkflowId('commit-approval');
    runtime.pendingCommit = {
      id: approvalId,
      pipelineId: state.pipelineId,
      artifactKey: state.artifactKey,
      message: commit.message,
      paths: workflowPaths,
      pathStates: commit.pathStates || {},
      preApplyHead: String(preApplyGit?.head || ''),
      applied: appliedSummary,
      extensionUpdate,
      warnings,
      response: {
        sessionId: state.response.session?.id || state.response.sessionId || '',
        sourceClientId: state.response.sourceClientId || '',
      },
      createdAt: nowIso(),
    };
    await this.store.setArtifact(state.artifactKey, {
      ...(await this.store.getArtifact(state.artifactKey)),
      status: 'awaiting-commit',
      appliedAt: nowIso(),
      applied: appliedSummary,
      extensionUpdate,
      warnings,
    });
    await this.transition(runtime, WorkflowStateEventType.PIPELINE_STAGE_CHANGED, {
      pipelineId: state.pipelineId,
      status: WorkflowPipelineStatus.AWAITING_APPROVAL,
      approvalId,
      evidence: { approvalType: 'commit', message: commit.message, paths: workflowPaths },
    }, 'workflow.commit.approval.required', {
      pipelineId: state.pipelineId,
      approvalId,
      message: commit.message,
      paths: workflowPaths,
    });
    return { status: 'pending-approval', approvalType: 'commit', approvalId, applied: appliedSummary, extensionUpdate, warnings };
  }
}
