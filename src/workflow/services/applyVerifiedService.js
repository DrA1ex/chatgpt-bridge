import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectGitRepository, verifyGitPathStates } from '../gitCommit.js';
import { applicationSummary } from '../support/workflowSummaries.js';
import { nowIso, workflowId as createWorkflowId } from '../support/workflowValues.js';
import { WorkflowActionKind, WorkflowEffectKind, WorkflowEventType, WorkflowLocalEffectKind, WorkflowPhase } from '../state/workflowState.js';
import { executeWorkflowEffect } from '../state/workflowEffects.js';
import { workflowGitState } from '../state/workflowGitState.js';
import { executeLocalEffect } from '../state/localEffects.js';

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
    await this.transition(runtime, WorkflowEventType.PHASE_CHANGED, {
      runId: runtime.workflowState.run.id,
      phase: WorkflowPhase.APPLYING,
    }, 'workflow.apply.started', { pipelineId: state.pipelineId });
    const workflowPaths = workflowPathsFromPlan(state.plan);
    const preApplyGit = workflow.commit.mode === 'none' ? null : await inspectGitRepository(workflow.projectRoot);
    await this.#assertNoUserOverlap(runtime, state.pipelineId, workflowPaths, preApplyGit);

    let applied;
    try {
      const effectId = `${runtime.workflowState.run.id}:apply:${Number(state.remediationAttempt || 0) + 1}`;
      const preconditionsHash = createHash('sha256').update(JSON.stringify({
        project: runtime.workflowState.project.fingerprintSha256,
        head: preApplyGit?.head || '',
        artifact: state.verification?.zip?.sha256 || state.artifactKey || '',
        paths: workflowPaths,
      })).digest('hex');
      applied = await executeLocalEffect({
        transition: this.transition,
        runtime,
        effect: { id: effectId, kind: WorkflowLocalEffectKind.APPLY, safe: false, idempotencyKey: effectId, preconditionsHash, references: { paths: workflowPaths, pipelineId: state.pipelineId, manifestPath: path.join(this.applier.dataDir, 'workflows', workflow.id, 'pipelines', state.pipelineId, 'rollback', 'manifest.json'), receiptPath: path.join(this.applier.dataDir, 'workflows', workflow.id, 'pipelines', state.pipelineId, 'rollback', 'apply-completed.json') } },
        execute: () => this.applier.apply({ workflow, verification: state.verification, plan: state.plan, pipelineId: state.pipelineId }),
      });
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
    const extensionUpdate = await this.#deployExtension(runtime, state);
    if (extensionUpdate.updated || extensionUpdate.error) {
      await this.publish(runtime.id, extensionUpdate.error ? 'workflow.extension.update.failed' : 'workflow.extension.update.completed', {
        pipelineId: state.pipelineId,
        ...extensionUpdate,
      });
    }
    return await this.#commitOrComplete(runtime, state, { workflowPaths, preApplyGit, appliedSummary, extensionUpdate });
  }

  async #deployExtension(runtime, state) {
    const workflow = runtime.config;
    if (!workflow.extensionUpdate.enabled) return { updated: false, reason: 'disabled' };
    const preconditionsHash = createHash('sha256').update(JSON.stringify({
      project: runtime.workflowState.project.fingerprintSha256,
      sourceDir: workflow.extensionUpdate.sourceDir,
      targetDir: workflow.extensionUpdate.targetDir,
      artifact: state.verification?.zip?.sha256 || state.artifactKey || '',
    })).digest('hex');
    const effectId = `${runtime.workflowState.run.id}:apply:extension:${preconditionsHash.slice(0, 16)}`;
    try {
      return await executeWorkflowEffect({
        transition: this.transition,
        runtime,
        effect: { id: effectId, kind: WorkflowEffectKind.APPLY, safe: false, idempotencyKey: effectId, preconditionsHash, references: { operation: 'extension-deploy' } },
        execute: async () => {
          const backup = await this.extensionDeployer.prepareBackup(workflow, { pipelineId: state.pipelineId });
          return await this.extensionDeployer.deploy(workflow, {
            sourceClientId: state.response.sourceClientId || workflow.watch.clientId,
            pipelineId: state.pipelineId,
            backup,
          });
        },
      });
    } catch (error) {
      return { updated: false, error: error.message, rollback: error.extensionRollback || null };
    }
  }

  async #assertNoUserOverlap(runtime, pipelineId, workflowPaths, preApplyGit) {
    if (!preApplyGit?.available) return;
    const dirtyPaths = new Set(preApplyGit.paths || []);
    const overlap = workflowPaths.filter((item) => dirtyPaths.has(item));
    const git = workflowGitState(runtime);
    const expected = Object.fromEntries(overlap
      .filter((item) => git.pathStates[item])
      .map((item) => [item, git.pathStates[item]]));
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
      await this.transition(runtime, WorkflowEventType.PHASE_CHANGED, {
        runId: runtime.workflowState.run.id,
        phase: WorkflowPhase.REMEDIATING,
        references: { attempt: attempt + 1, failure: error.message },
      }, 'workflow.apply.failed', failureEvent);
      return await this.resultRepairService.remediate(runtime, state, error, attempt + 1);
    }
    runtime.lastError = error.message;
    await this.transition(runtime, WorkflowEventType.RUN_FAILED, {
      runId: runtime.workflowState.run.id,
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
    const decision = {
      id: approvalId,
      kind: WorkflowActionKind.COMMIT,
      workflowId: runtime.id,
      status: 'pending',
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
    const artifact = {
      ...(await this.store.getArtifact(state.artifactKey)),
      status: 'awaiting-commit',
      appliedAt: nowIso(),
      applied: appliedSummary,
      extensionUpdate,
      warnings,
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
      references: { decisionId: approvalId, paths: workflowPaths },
    }, 'workflow.commit.approval.required', {
      pipelineId: state.pipelineId,
      approvalId,
      message: commit.message,
      paths: workflowPaths,
    }, {
      decisions: { [approvalId]: decision },
      artifacts: { [state.artifactKey]: artifact },
    });
    return { status: 'pending-approval', approvalType: 'commit', approvalId, applied: appliedSummary, extensionUpdate, warnings };
  }
}
