import { artifactMatchesResponseScope, looksLikeZipArtifact, selectRequiredZipCompletionCandidate, summarizeArtifact } from '../../results/artifacts.js';
import { boundedText, nowIso, responseScope, workflowId as createWorkflowId } from '../support/workflowValues.js';
import { applyPlanSummary, verificationSummary } from '../support/workflowSummaries.js';
import { publicWorkflowSnapshot } from '../state/workflowProjection.js';
import { forgetWorkflowResponse, rememberWorkflowResponse, workflowResponseIdentity, workflowResponseWasConsumed } from '../support/consumedResponses.js';
import { recordManifestReconciliation } from '../support/manifestReconciliation.js';
import { routeObservedTurn } from '../support/observedTurnRouter.js';
import { workflowSourceClientId } from '../support/workflowBinding.js';
import { executeWorkflowEffect } from '../state/workflowEffects.js';
import { executeLocalEffect } from '../state/localEffects.js';
import {
  WorkflowActionKind,
  WorkflowEffectKind,
  WorkflowEventType,
  WorkflowLocalEffectKind,
  WorkflowPhase,
  WorkflowRunKind,
  isWorkflowActive,
} from '../state/workflowState.js';

function runActive(state) {
  return isWorkflowActive(state) && Boolean(state?.run?.id);
}

export class WorkflowResponseProcessor {
  constructor({
    bridge,
    fileStore,
    store,
    verifier,
    applier,
    resultRepairService,
    contextService,
    applyVerifiedService,
    refreshScheduler,
    deferredTurnQueue,
    passiveMaterializationRecovery,
    workflows,
    enqueue,
    failRuntime,
    requireWorkflow,
    transition,
    publish,
  } = {}) {
    Object.assign(this, {
      bridge,
      fileStore,
      store,
      verifier,
      applier,
      resultRepairService,
      contextService,
      applyVerifiedService,
      refreshScheduler,
      deferredTurnQueue,
      passiveMaterializationRecovery,
      workflows,
      enqueue,
      failRuntime,
      requireWorkflow,
      transition,
      publish,
    });
  }

  async handleObservedTurn(turn) {
    await routeObservedTurn({
      workflows: this.workflows,
      turn,
      enqueue: this.enqueue,
      processObserved: (runtime, observed) => this.processObserved(runtime, observed),
      failRuntime: this.failRuntime,
      isWorkflowActive,
      store: this.store,
    });
  }

  async processObserved(runtime, turn, context = {}) {
    if (!context.queuedInputId) {
      const queued = await this.deferredTurnQueue.defer(runtime, turn);
      this.deferredTurnQueue.schedule(runtime);
      return queued;
    }
    if (workflowResponseWasConsumed(runtime, turn)) {
      const identity = workflowResponseIdentity(turn);
      await this.transition(runtime, WorkflowEventType.INPUT_DISCARDED, { inputId: context.queuedInputId, reason: 'duplicate' });
      await this.publish(runtime.id, 'workflow.turn.duplicate.skipped', {
        identity,
        turnKey: String(turn.turnKey || ''),
        requestId: String(turn.requestId || turn.sourceRequestId || ''),
      });
      return { status: 'duplicate-turn', identity };
    }
    if (runActive(runtime.workflowState)) return { status: 'queued', inputId: context.queuedInputId };
    runtime.lastObservedTurnKey = String(turn.turnKey || '');
    runtime.lastSourceClientId = String(turn.sourceClientId || runtime.lastSourceClientId || '');
    runtime.lastSessionId = String(turn.sessionId || turn.session?.id || runtime.lastSessionId || '');
    runtime.updatedAt = nowIso();
    await this.store.setWorkflow(runtime.id, publicWorkflowSnapshot(runtime));
    await this.publish(runtime.id, 'workflow.turn.observed', { turnKey: turn.turnKey || '', sessionId: turn.sessionId || '', sourceClientId: turn.sourceClientId || '', artifactCount: turn.artifacts?.length || 0 });
    return await this.processResponse(runtime.id, turn, { source: 'passive-observer', remediationAttempt: 0, inputId: context.queuedInputId, ...context });
  }
  async processResponse(workflowId, response, context = {}) {
    const runtime = this.requireWorkflow(workflowId);
    const claimedIdentity = rememberWorkflowResponse(runtime, response);
    try {
    const requestedPipelineId = String(context.runId || context.pipelineId || '');
    const activeRun = runActive(runtime.workflowState);
    const reusingPipeline = activeRun && (runtime.workflowState.run.kind === WorkflowRunKind.AUTOMATION
      || runtime.workflowState.run.id === requestedPipelineId
      || ['manual-result-repair', 'remediation', 'invalid-result-repair', 'guided-task'].includes(String(context.source || '')));
    const pipelineId = reusingPipeline ? runtime.workflowState.run.id : createWorkflowId('run');
    const transitionType = reusingPipeline ? WorkflowEventType.PHASE_CHANGED : WorkflowEventType.RUN_STARTED;
    await this.transition(runtime, transitionType, {
      runId: pipelineId,
      inputId: reusingPipeline ? '' : context.inputId,
      kind: WorkflowRunKind.PASSIVE,
      phase: WorkflowPhase.OBSERVING,
      references: { source: context.source || '', turnKey: response.turnKey || '', inputPayload: response },
    }, 'workflow.run.observed', {
      pipelineId,
      source: context.source || '',
      turnKey: response.turnKey || '',
    });
    const artifacts = this.bridge.registerObservedArtifacts(response.artifacts || [], {
      sourceClientId: workflowSourceClientId(runtime, response.sourceClientId, { allowLast: false }),
      turnKey: response.turnKey || '',
      sessionId: response.session?.id || response.sessionId || '',
    });
    await this.publish(workflowId, 'workflow.artifacts.discovered', { count: artifacts.length, artifacts: artifacts.map(summarizeArtifact), source: context.source || '' });
    const scope = responseScope(response);
    if (runtime.config.artifact.requireSingleCandidate) {
      const explicitZipCandidates = artifacts.filter((artifact) => looksLikeZipArtifact(artifact) && artifactMatchesResponseScope(artifact, scope));
      if (explicitZipCandidates.length > 1) {
        const candidates = explicitZipCandidates.map(summarizeArtifact);
        runtime.lastError = 'Multiple explicit ZIP candidates were found';
        const repaired = await this.resultRepairService.maybeRepair(runtime, response, {
          pipelineId,
          reasons: [runtime.lastError],
          context,
        });
        if (repaired) return repaired;
        await this.transition(runtime, WorkflowEventType.RUN_FAILED, {
          runId: pipelineId,
          code: 'multiple_explicit_zip_candidates',
          message: runtime.lastError,
          evidence: { candidates },
        }, 'workflow.artifact.ambiguous', {
          pipelineId,
          reason: 'multiple_explicit_zip_candidates',
          candidates,
        });
        this.refreshScheduler.sync(runtime);
        return { status: 'ambiguous-artifacts', candidates };
      }
    }
    const selected = selectRequiredZipCompletionCandidate(artifacts, scope);
    if (!selected.artifact) {
      const reason = selected.reason || 'no suitable ZIP';
      if (runtime.config.resultProtocol?.allowTextOnly) {
        runtime.lastError = '';
        await this.transition(runtime, WorkflowEventType.RUN_COMPLETED, {
          runId: pipelineId,
          code: 'text_response_completed',
          evidence: { answer: boundedText(response.answer || '', 4_000) },
        }, 'workflow.response.text.completed', { pipelineId, answerLength: String(response.answer || '').length });
        this.refreshScheduler.sync(runtime);
        return { status: 'text-response', answer: response.answer || '' };
      }
      runtime.lastError = reason;
      const repaired = await this.resultRepairService.maybeRepair(runtime, response, {
        pipelineId,
        reasons: [reason],
        context,
      });
      if (repaired) return repaired;
      await this.transition(runtime, WorkflowEventType.RUN_FAILED, {
        runId: pipelineId,
        code: 'required_artifact_unavailable',
        message: reason,
        evidence: { candidates: selected.candidates || [] },
      }, 'workflow.artifact.skipped', {
        pipelineId,
        reason,
        candidates: selected.candidates || [],
      });
      this.refreshScheduler.sync(runtime);
      return { status: 'no-artifact', reason };
    }
    return await this.processArtifact(runtime, response, selected.artifact, { ...context, pipelineId });
    } catch (error) {
      forgetWorkflowResponse(runtime, claimedIdentity);
      if (this.passiveMaterializationRecovery.canDefer(error, context)) {
        return await this.passiveMaterializationRecovery.defer(runtime, response, error, context);
      }
      throw error;
    }
  }
  async processArtifact(runtime, response, artifact, context = {}) {
    const workflow = runtime.config;
    const requestedPipelineId = String(context.runId || context.pipelineId || '');
    const activeRun = runActive(runtime.workflowState);
    const reusingPipeline = activeRun && (runtime.workflowState.run.kind === WorkflowRunKind.AUTOMATION
      || runtime.workflowState.run.id === requestedPipelineId
      || ['manual-result-repair', 'remediation', 'invalid-result-repair', 'guided-task'].includes(String(context.source || '')));
    const pipelineId = reusingPipeline ? runtime.workflowState.run.id : createWorkflowId('run');
    runtime.lastError = '';
    const transitionType = reusingPipeline ? WorkflowEventType.PHASE_CHANGED : WorkflowEventType.RUN_STARTED;
    await this.transition(runtime, transitionType, {
      runId: pipelineId,
      kind: WorkflowRunKind.MANUAL,
      phase: WorkflowPhase.DOWNLOADING,
      references: { source: context.source || '', turnKey: response.turnKey || '' },
    }, 'workflow.artifact.download.started', { pipelineId, artifact: summarizeArtifact(artifact) });
    const downloadEffectId = `${pipelineId}:download:${context.localFileId || artifact.id}`;
    const fetched = await executeWorkflowEffect({
      transition: (target, type, data) => this.transition(target, type, data),
      runtime,
      effect: { id: downloadEffectId, kind: WorkflowEffectKind.DOWNLOAD, safe: true, idempotencyKey: downloadEffectId, preconditionsHash: `${runtime.workflowState.project.fingerprintSha256}:${artifact.id}` },
      execute: () => context.localFileId
        ? this.fileStore.getReadable(context.localFileId)
        : this.bridge.fetchArtifact(artifact.id, { sourceClientId: workflowSourceClientId(runtime, artifact.sourceClientId || response.sourceClientId, { allowLast: false }) }),
    });
    const readable = context.localFileId ? fetched : await this.fileStore.getReadable(fetched.id || artifact.id);
    if (!readable?.absolutePath) throw new Error(`Downloaded artifact cannot be opened from FileStore: ${fetched.id || artifact.id}`);
    await this.publish(runtime.id, 'workflow.artifact.download.completed', {
      pipelineId,
      fileId: fetched.id,
      name: fetched.name,
      size: fetched.size,
    });
    await this.transition(runtime, WorkflowEventType.PHASE_CHANGED, {
      runId: pipelineId,
      phase: WorkflowPhase.VERIFYING,
    }, 'workflow.artifact.verify.started', { pipelineId, fileId: fetched.id });
    const verifyEffectId = `${pipelineId}:verify:${fetched.id || artifact.id}`;
    const verification = await executeLocalEffect({
      transition: (target, type, data) => this.transition(target, type, data),
      runtime,
      effect: { id: verifyEffectId, kind: WorkflowLocalEffectKind.VERIFY, safe: true, idempotencyKey: verifyEffectId, preconditionsHash: `${runtime.workflowState.project.fingerprintSha256}:${fetched.sha256 || artifact.sha256 || fetched.id || artifact.id}` },
      execute: () => this.verifier.verify({ workflow, artifactFile: readable, pipelineId }),
    });
    const digest = String(verification.zip?.sha256 || fetched.sha256 || artifact.sha256 || '').trim();
    const artifactKey = digest
      ? `${runtime.id}:sha256:${digest}`
      : `${runtime.id}:turn:${response.turnKey || artifact.sourceTurnKey || ''}:artifact:${artifact.id}`;
    if (verification.ok) await this.contextService.bindVerified(runtime, response, artifact);
    const previous = await this.store.getArtifact(artifactKey);
    if (previous && ['applied', 'verified', 'pending-approval', 'awaiting-commit'].includes(previous.status)) {
      runtime.lastError = '';
      await this.transition(runtime, WorkflowEventType.RUN_COMPLETED, {
        runId: pipelineId,
        code: 'duplicate_artifact',
        evidence: { artifactKey, sha256: digest, previousStatus: previous.status },
      }, 'workflow.artifact.duplicate', { pipelineId, artifactKey, sha256: digest, previousStatus: previous.status });
      this.refreshScheduler.sync(runtime);
      return { status: 'duplicate', artifactKey, sha256: digest };
    }
    await this.store.setArtifact(artifactKey, {
      workflowId: runtime.id,
      pipelineId,
      artifactKey,
      sha256: digest,
      artifactId: artifact.id,
      fileId: fetched.id,
      turnKey: response.turnKey || '',
      sessionId: response.session?.id || response.sessionId || '',
      sourceClientId: response.sourceClientId || artifact.sourceClientId || '',
      status: verification.ok ? 'verified' : 'invalid',
      verification: verificationSummary(verification),
      answer: boundedText(response.answer || ''),
      createdAt: nowIso(),
      remediationAttempt: context.remediationAttempt || 0,
    });
    const verificationEvent = {
      pipelineId,
      ok: verification.ok,
      reasons: verification.reasons,
      overlapScore: verification.overlapScore,
      entries: verification.zip?.entries || 0,
      identityStatus: verification.identityStatus,
      projectId: verification.projectIdentity?.projectId || '',
      artifactProjectId: verification.artifactProjectId || '',
      identityFallback: verification.identityFallback || [],
    };
    if (!verification.ok) {
      runtime.lastError = verification.reasons.join('; ');
      const repaired = await this.resultRepairService.maybeRepair(runtime, response, {
        pipelineId,
        reasons: verification.reasons,
        context,
      });
      if (repaired) return repaired;
      await this.transition(runtime, WorkflowEventType.RUN_FAILED, {
        runId: pipelineId,
        code: 'artifact_verification_failed',
        message: runtime.lastError,
        evidence: verificationEvent,
      }, 'workflow.artifact.verify.failed', verificationEvent);
      this.refreshScheduler.sync(runtime);
      return { status: 'invalid', verification };
    }
    if (workflow.watch.mode === 'verify') {
      runtime.lastError = '';
      await this.transition(runtime, WorkflowEventType.RUN_COMPLETED, {
        runId: pipelineId,
        code: 'artifact_verified',
        evidence: verificationEvent,
      }, 'workflow.artifact.verify.completed', verificationEvent);
      this.refreshScheduler.sync(runtime);
      return { status: 'verified', verification };
    }
    await this.publish(runtime.id, 'workflow.artifact.verify.completed', verificationEvent);
    await this.transition(runtime, WorkflowEventType.PHASE_CHANGED, {
      runId: pipelineId,
      phase: WorkflowPhase.PLANNING,
    });
    const planEffectId = `${pipelineId}:plan:${digest || fetched.id || artifact.id}`;
    const plan = await executeLocalEffect({
      transition: (target, type, data) => this.transition(target, type, data),
      runtime,
      effect: { id: planEffectId, kind: WorkflowLocalEffectKind.PLAN, safe: true, idempotencyKey: planEffectId, preconditionsHash: `${runtime.workflowState.project.fingerprintSha256}:${digest || fetched.id || artifact.id}` },
      execute: () => this.applier.plan({ workflow, verification }),
    });
    const manifestReconciliation = await recordManifestReconciliation({
      verification,
      plan,
      publish: (data) => this.publish(runtime.id, 'workflow.result.manifest.reconciled', { pipelineId, ...data }),
    });
    await this.store.setArtifact(artifactKey, {
      ...(await this.store.getArtifact(artifactKey)),
      verification: {
        ...verificationSummary(verification),
        resultManifestReconciliation: manifestReconciliation,
      },
    });
    await this.publish(runtime.id, 'workflow.apply.plan', {
      pipelineId,
      policyOk: plan.policyOk,
      reasons: plan.policyReasons,
      create: plan.plan.filesToCreate,
      update: plan.plan.filesToUpdate + plan.plan.filesLocallyChanged,
      delete: plan.plan.filesToDelete + plan.plan.filesLocallyChangedDelete,
      unchanged: plan.plan.filesUnchanged,
    });
    const shouldAsk = workflow.watch.mode === 'ask' || !plan.policyOk || plan.requiresConfirmation;
    if (shouldAsk) {
      const approvalId = createWorkflowId('approval');
      const decision = {
        id: approvalId,
        kind: WorkflowActionKind.APPLY,
        workflowId: runtime.id,
        pipelineId,
        artifactKey,
        artifactId: artifact.id,
        fileId: fetched.id,
        status: 'pending',
        createdAt: nowIso(),
        response: {
          answer: boundedText(response.answer || ''),
          turnKey: response.turnKey || '',
          session: response.session || null,
          sessionId: response.sessionId || '',
          sourceClientId: response.sourceClientId || '',
        },
        plan: applyPlanSummary(plan),
      };
      const pendingArtifact = {
        ...(await this.store.getArtifact(artifactKey)),
        status: 'pending-approval',
        approvalId,
      };
      runtime.lastError = '';
      await this.transition(runtime, WorkflowEventType.ACTION_REQUIRED, {
        runId: pipelineId,
        actionId: approvalId,
        kind: WorkflowActionKind.APPLY,
        reason: workflow.watch.mode === 'ask' ? 'Review the planned project changes.' : 'The apply policy requires confirmation.',
        choices: [
          { id: 'approve', label: 'Apply changes', transition: 'continue', phase: WorkflowPhase.VERIFYING },
          { id: 'reject', label: 'Reject changes', transition: 'finish', outcome: { status: 'cancelled', code: 'apply_rejected' } },
          { id: 'stop', label: 'Stop workflow', transition: 'stop' },
        ],
        references: { decisionId: approvalId, artifactKey },
      }, 'workflow.action.required', {
        actionId: approvalId,
        pipelineId,
        reason: workflow.watch.mode === 'ask' ? 'ask-mode' : 'policy-warning',
      }, {
        decisions: { [approvalId]: decision },
        artifacts: { [artifactKey]: pendingArtifact },
      });
      return { status: 'pending-approval', approvalId };
    }
    return await this.applyVerified(runtime, {
      pipelineId,
      artifactKey,
      response,
      artifact,
      fetched,
      verification,
      plan,
      remediationAttempt: context.remediationAttempt || 0,
    });
  }
  async resumeApproved(runtime, approval) {
    const artifactState = await this.store.getArtifact(approval.artifactKey);
    if (!artifactState) throw new Error(`Approval artifact state is missing: ${approval.artifactKey}`);
    const readable = await this.fileStore.getReadable(approval.fileId);
    if (!readable?.absolutePath) throw new Error(`Approval artifact file is missing: ${approval.fileId}`);
    await this.transition(runtime, WorkflowEventType.PHASE_CHANGED, {
      runId: runtime.workflowState.run.id,
      phase: WorkflowPhase.VERIFYING,
      references: { resumedFromAction: approval.id },
    });
    const verification = await this.verifier.verify({ workflow: runtime.config, artifactFile: readable, pipelineId: approval.pipelineId });
    if (!verification.ok) {
      const message = `Artifact no longer verifies: ${verification.reasons.join('; ')}`;
      runtime.lastError = message;
      await this.transition(runtime, WorkflowEventType.RUN_FAILED, {
        runId: runtime.workflowState.run.id,
        code: 'approved_artifact_verification_failed',
        message,
        approvalId: approval.id,
      }, 'workflow.artifact.verify.failed', {
        pipelineId: approval.pipelineId,
        approvalId: approval.id,
        ok: false,
        reasons: verification.reasons,
      });
      throw new Error(message);
    }
    await this.transition(runtime, WorkflowEventType.PHASE_CHANGED, {
      runId: runtime.workflowState.run.id,
      phase: WorkflowPhase.PLANNING,
    });
    const plan = await this.applier.plan({ workflow: runtime.config, verification });
    const manifestReconciliation = await recordManifestReconciliation({
      verification,
      plan,
      publish: (data) => this.publish(runtime.id, 'workflow.result.manifest.reconciled', {
        pipelineId: approval.pipelineId, approvalId: approval.id, ...data,
      }),
    });
    return await this.applyVerified(runtime, {
      pipelineId: approval.pipelineId,
      artifactKey: approval.artifactKey,
      response: approval.response || {},
      artifact: { id: approval.artifactId },
      fetched: { id: approval.fileId },
      verification,
      plan,
      remediationAttempt: artifactState.remediationAttempt || 0,
    });
  }
  async applyVerified(runtime, state) {
    return await this.applyVerifiedService.apply(runtime, state);
  }
}
