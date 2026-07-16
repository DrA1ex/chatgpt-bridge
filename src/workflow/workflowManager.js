import fs from 'node:fs/promises';
import path from 'node:path';
import { log, error as logError } from '../logger.js';
import { artifactMatchesResponseScope, looksLikeZipArtifact, selectRequiredZipCompletionCandidate, summarizeArtifact } from '../results/artifacts.js';
import { loadWorkflowConfig } from './config.js';
import { WorkflowStore } from './store.js';
import { ArtifactVerifier } from './artifactVerifier.js';
import { TransactionalApplier } from './transaction.js';
import { ExtensionDeployer } from './extensionDeployer.js';
import { buildCommitContext, createGitCommit, extractMarkedBlock, inspectGitRepository } from './gitCommit.js';
import { ensureProjectIdentity, writeProjectFingerprint } from '../projectIdentity.js';
import { bindVerifiedSource } from './context/bindVerifiedSource.js';
import { syncProjectContext } from './context/syncProjectContext.js';
import { acknowledgeRestartIntent } from './recovery/acknowledgeRestartIntent.js';
import { recoverInterruptedPipeline } from './recovery/recoverInterruptedPipeline.js';
import {
  boundedText,
  compactValue,
  nowIso,
  responseScope,
  tailLines,
  workflowId as createWorkflowId,
} from './support/workflowValues.js';
import {
  applicationSummary,
  applyPlanSummary,
  verificationSummary,
} from './support/workflowSummaries.js';
import { publicWorkflowSnapshot } from './state/workflowProjection.js';
import { DeferredObservedTurnQueue } from './support/deferredObservedTurns.js';
import { WorkflowRefreshScheduler } from './support/workflowRefreshScheduler.js';
import { WorkflowManualOperations } from './manualOperations.js';
import { WorkflowAutomationController } from './automation/controller.js';
import { WorkflowAutomationService } from './automation/service.js';
import { closeWorkflowManager } from './support/closeWorkflowManager.js';
import {
  WorkflowPipelineStatus,
  WorkflowStateEventType,
  WorkflowWatcherStatus,
  createWorkflowState,
  isWorkflowPipelineActive,
  isWorkflowPipelineTerminal,
  isWorkflowAutomationActive,
  reduceWorkflowState,
  restoreWorkflowState,
} from './state/workflowState.js';
export class WorkflowManager {
  constructor({ bridge, fileStore, eventBus = null, dataDir, workflowStore = null, restartHandler = null, turnManager = null } = {}) {
    this.bridge = bridge;
    this.fileStore = fileStore;
    this.eventBus = eventBus;
    this.dataDir = dataDir;
    this.store = workflowStore || new WorkflowStore(dataDir);
    this.restartHandler = typeof restartHandler === 'function' ? restartHandler : null;
    this.workflows = new Map();
    this.queues = new Map();
    this.projectQueues = new Map();
    this.refreshScheduler = new WorkflowRefreshScheduler({
      bridge,
      publish: (workflowId, type, data) => this.#event(workflowId, type, data),
      isBusy: (workflowId) => this.queues.has(workflowId),
    });
    this.deferredTurnQueue = new DeferredObservedTurnQueue({
      enqueue: (workflowId, task) => this.#enqueue(workflowId, task),
      processObserved: (runtime, turn) => this.#processObserved(runtime, turn),
      publish: (workflowId, type, data) => this.#event(workflowId, type, data),
      onError: (workflowId, error) => this.#failRuntime(workflowId, error),
    });
    this.unsubscribe = bridge.onObservedTurn((turn) => this.#handleObservedTurn(turn));
    this.verifier = new ArtifactVerifier({ dataDir, event: (type, data) => this.#event('', type, data) });
    this.applier = new TransactionalApplier({ dataDir, event: (type, data) => this.#event('', type, data) });
    this.extensionDeployer = new ExtensionDeployer({ bridge, dataDir, event: (type, data) => this.#event('', type, data) });
    this.manualOperations = new WorkflowManualOperations({
      bridge,
      fileStore,
      verifier: this.verifier,
      extensionDeployer: this.extensionDeployer,
      enqueue: (workflowId, task) => this.#enqueue(workflowId, task),
      event: (workflowId, type, data) => this.#event(workflowId, type, data),
      processArtifact: (runtime, response, artifact, context) => this.#processArtifact(runtime, response, artifact, context),
    });
    this.automationController = new WorkflowAutomationController({
      turnManager,
      fileStore,
      transition: (runtime, type, data, publishedType, publishedData) => this.#transitionWorkflowState(runtime, type, data, publishedType, publishedData),
      publish: (workflowId, type, data) => this.#event(workflowId, type, data),
      processFile: (runtime, options) => this.manualOperations.processFileResult(runtime, options),
    });
    this.automationService = new WorkflowAutomationService({
      bridge,
      store: this.store,
      controller: this.automationController,
      publish: (workflowId, type, data) => this.#event(workflowId, type, data),
    });
  }
  async close({ timeoutMs = 30_000, cancelActiveTurns = true } = {}) {
    return await closeWorkflowManager({
      unsubscribe: this.unsubscribe,
      refreshScheduler: this.refreshScheduler,
      automationController: this.automationController,
      projectQueues: this.projectQueues,
      timeoutMs,
      cancelActiveTurns,
    });
  }
  async restore() {
    const saved = await this.store.listWorkflows();
    const restored = [];
    for (const item of saved) {
      if (!item?.configPath) continue;
      try {
        const restoredWorkflow = await this.load(item.configPath, {
          start: item.watcher?.status !== WorkflowWatcherStatus.STOPPED,
          includeLatest: false,
          triggerAutomation: false,
        });
        const runtime = this.workflows.get(restoredWorkflow.id);
        if (runtime) {
          runtime.workflowState = restoreWorkflowState(item, { updatedAt: item.updatedAt || nowIso() });
          const restoredPipelineActive = isWorkflowPipelineActive(runtime.workflowState)
            && runtime.workflowState.pipeline.status !== WorkflowPipelineStatus.AWAITING_APPROVAL;
          const interrupted = restoredPipelineActive;
          if (interrupted && runtime.workflowState.pipeline.id
            && runtime.workflowState.pipeline.status !== WorkflowPipelineStatus.RECOVERING) {
            const recovering = reduceWorkflowState(runtime.workflowState, {
              type: WorkflowStateEventType.PIPELINE_STAGE_CHANGED,
              data: {
                pipelineId: runtime.workflowState.pipeline.id,
                status: WorkflowPipelineStatus.RECOVERING,
                evidence: { restoredFrom: runtime.workflowState.pipeline.status },
              },
              at: nowIso(),
            });
            if (recovering.accepted) runtime.workflowState = recovering.state;
          }
          runtime.lastObservedTurnKey = String(item.lastObservedTurnKey || '');
          runtime.lastSourceClientId = String(item.lastSourceClientId || '');
          runtime.lastSessionId = String(item.lastSessionId || '');
          runtime.boundSourceClientId = String(item.boundSourceClientId || '');
          runtime.boundSessionId = String(item.boundSessionId || '');
          runtime.lastPipelineId = String(item.lastPipelineId || '');
          runtime.lastError = String(item.lastError || '');
          runtime.projectId = String(item.projectId || runtime.projectId || '');
          runtime.projectFingerprintSha256 = String(item.projectFingerprintSha256 || runtime.projectFingerprintSha256 || '');
          runtime.contextSyncedSessionId = String(item.contextSyncedSessionId || '');
          runtime.contextSyncFingerprint = String(item.contextSyncFingerprint || '');
          runtime.automationInterrupted = false;
          this.deferredTurnQueue.reset(runtime);
          runtime.updatedAt = nowIso();
          await this.store.setWorkflow(runtime.id, publicWorkflowSnapshot(runtime));
          if (interrupted) await this.#recoverInterruptedPipeline(runtime);
          this.refreshScheduler.sync(runtime);
          await this.automationService.restore(runtime);
          restored.push(publicWorkflowSnapshot(runtime));
        }
      } catch (error) {
        await this.#event(item.id || '', 'workflow.restore.failed', { configPath: item.configPath, message: error.message || String(error) });
      }
    }
    await this.#acknowledgeRestartIntent().catch((error) => this.#event('', 'workflow.daemon.restart.ack.failed', { message: error.message || String(error) }));
    return restored;
  }
  async load(configPath, { start = true, includeLatest = true, triggerAutomation = true } = {}) {
    const config = await loadWorkflowConfig(configPath);
    const projectIdentity = await ensureProjectIdentity(config.projectRoot, { packageName: config.verification.packageName });
    const projectFingerprint = await writeProjectFingerprint(config.projectRoot, { identity: projectIdentity, files: config.projectContext.fallbackFiles });
    const conflicting = Array.from(this.workflows.values()).find((item) => item.id !== config.id && path.resolve(item.config.projectRoot) === path.resolve(config.projectRoot));
    if (conflicting) throw new Error(`Project root is already managed by workflow ${conflicting.id}: ${config.projectRoot}`);
    const runtime = {
      id: config.id,
      config,
      configPath: config.configPath,
      workflowState: createWorkflowState({
        watcherStatus: start && config.enabled ? WorkflowWatcherStatus.RUNNING : WorkflowWatcherStatus.STOPPED,
        updatedAt: nowIso(),
      }),
      loadedAt: nowIso(),
      updatedAt: nowIso(),
      lastObservedTurnKey: '',
      lastSourceClientId: '',
      lastSessionId: '',
      boundSourceClientId: '',
      boundSessionId: '',
      lastPipelineId: '',
      lastError: '',
      projectId: projectIdentity.projectId,
      projectFingerprintSha256: projectFingerprint.fingerprintSha256,
      contextSyncedSessionId: '',
      contextSyncFingerprint: '',
      deferredObservedTurns: [],
      automationInterrupted: false,
    };
    this.workflows.set(config.id, runtime);
    await this.store.setWorkflow(config.id, publicWorkflowSnapshot(runtime));
    this.refreshScheduler.sync(runtime);
    await this.#event(config.id, 'workflow.loaded', { configPath: config.configPath, projectRoot: config.projectRoot, projectId: runtime.projectId, mode: config.watch.mode, watcherStatus: runtime.workflowState.watcher.status, pipelineStatus: runtime.workflowState.pipeline.status });
    if (start && config.enabled && config.projectContext.enabled && config.projectContext.syncOnStart && config.watch.sessionId) {
      this.#enqueue(config.id, () => this.#syncProjectContext(runtime, { reason: 'workflow-start' })).catch((error) => this.#event(config.id, 'workflow.context.sync.failed', { message: error.message || String(error) }));
    }
    if (includeLatest && start && config.enabled && config.watch.includeLatest) {
      this.#enqueue(config.id, async () => {
        try {
          const response = await this.bridge.recoverLatestResponse({ sourceClientId: config.watch.clientId || undefined, index: 1 });
          if (!config.watch.sessionId || response.session?.id === config.watch.sessionId) await this.#processResponse(config.id, response, { source: 'include-latest', remediationAttempt: 0 });
        } catch (error) {
          await this.#failRuntime(config.id, error);
        }
      });
    }
    if (triggerAutomation && start && config.enabled && config.automation.enabled && config.automation.trigger === 'on-start') {
      if (this.automationController.available()) {
        queueMicrotask(() => this.runAutomation(config.id, { trigger: 'on-start' }).catch((error) => this.#failRuntime(config.id, error)));
      } else {
        await this.#event(config.id, 'workflow.automation.unavailable', { reason: 'local-turn-manager-required' });
      }
    }
    return publicWorkflowSnapshot(runtime);
  }
  async unload(workflowId) {
    const runtime = this.workflows.get(workflowId);
    if (!runtime) return false;
    if (isWorkflowAutomationActive(runtime.workflowState)) await this.automationController.stop(runtime, 'workflow unloaded');
    const stopped = reduceWorkflowState(runtime.workflowState, { type: WorkflowStateEventType.WATCHER_STOPPED, at: nowIso() });
    if (stopped.accepted) runtime.workflowState = stopped.state;
    runtime.updatedAt = nowIso();
    this.workflows.delete(workflowId);
    this.refreshScheduler.clear(workflowId);
    await this.store.removeWorkflow(workflowId);
    await this.#event(workflowId, 'workflow.unloaded', {});
    return true;
  }
  async start(workflowId) {
    const runtime = this.#require(workflowId);
    await this.#transitionWorkflowState(runtime, WorkflowStateEventType.WATCHER_STARTED, {}, 'workflow.started');
    this.refreshScheduler.sync(runtime);
    if (runtime.config.projectContext.enabled && runtime.config.projectContext.syncOnStart) {
      this.#enqueue(runtime.id, () => this.#syncProjectContext(runtime, { reason: 'workflow-start' })).catch((error) => this.#event(runtime.id, 'workflow.context.sync.failed', { message: error.message || String(error) }));
    }
    return publicWorkflowSnapshot(runtime);
  }
  async stop(workflowId) {
    const runtime = this.#require(workflowId);
    await this.#transitionWorkflowState(runtime, WorkflowStateEventType.WATCHER_STOPPED, {}, 'workflow.stopped');
    this.refreshScheduler.clear(workflowId);
    return publicWorkflowSnapshot(runtime);
  }
  list() { return Array.from(this.workflows.values()).map((runtime) => publicWorkflowSnapshot(runtime)); }
  get(workflowId) { const runtime = this.workflows.get(workflowId); return runtime ? publicWorkflowSnapshot(runtime) : null; }
  async approvals() { return await this.store.listApprovals({ status: 'pending' }); }
  async events(workflowId, limit = 200) { return await this.store.listEvents({ workflowId, limit }); }
  async approve(approvalId) {
    const approval = await this.store.getApproval(approvalId);
    if (!approval) throw new Error(`Unknown workflow approval: ${approvalId}`);
    if (approval.status !== 'pending') throw new Error(`Workflow approval is not pending: ${approval.status}`);
    const runtime = this.#require(approval.workflowId);
    return await this.#enqueue(runtime.id, async () => {
      approval.status = 'approved'; approval.decidedAt = nowIso();
      await this.store.setApproval(approvalId, approval);
      return await this.#resumeApproved(runtime, approval);
    });
  }
  async reject(approvalId, reason = 'rejected by user') {
    const approval = await this.store.getApproval(approvalId);
    if (!approval) throw new Error(`Unknown workflow approval: ${approvalId}`);
    const runtime = this.workflows.get(approval.workflowId);
    return await this.#enqueue(approval.workflowId, async () => {
      approval.status = 'rejected'; approval.reason = reason; approval.decidedAt = nowIso();
      await this.store.setApproval(approvalId, approval);
      if (runtime && runtime.workflowState?.pipeline?.id === approval.pipelineId) {
        runtime.lastError = '';
        await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_REJECTED, {
          pipelineId: approval.pipelineId,
          approvalId,
          code: 'approval_rejected',
          message: reason,
        }, 'workflow.approval.rejected', { approvalId, reason, pipelineId: approval.pipelineId });
        this.refreshScheduler.sync(runtime);
      } else {
        await this.#event(approval.workflowId, 'workflow.approval.rejected', { approvalId, reason, pipelineId: approval.pipelineId });
      }
      return approval;
    });
  }
  async verifyArtifact(workflowId, options = {}) {
    return await this.manualOperations.verify(this.#require(workflowId), options);
  }
  async processFileResult(workflowId, options = {}) {
    return await this.manualOperations.processFileResult(this.#require(workflowId), options);
  }
  async deployExtension(workflowId) {
    return await this.manualOperations.deployExtension(this.#require(workflowId));
  }
  async runAutomation(workflowId, options = {}) {
    return await this.automationService.run(this.#require(workflowId), options);
  }
  async stopAutomation(workflowId, reason = 'stopped by user') {
    return await this.automationService.stop(this.#require(workflowId), reason);
  }
  async resumeAutomation(workflowId) {
    return await this.automationService.resume(this.#require(workflowId));
  }
  async discardAutomation(workflowId, reason = 'discarded by user') {
    return await this.automationService.discard(this.#require(workflowId), reason);
  }
  async restartAutomation(workflowId, options = {}) {
    return await this.automationService.restart(this.#require(workflowId), options);
  }
  async #handleObservedTurn(turn) {
    const matched = Array.from(this.workflows.values()).filter((runtime) => {
      const cfg = runtime.config;
      if (runtime.workflowState?.watcher?.status === WorkflowWatcherStatus.STOPPED || cfg.watch.mode === 'off') return false;
      if (cfg.automation?.suspendWatcher && isWorkflowAutomationActive(runtime.workflowState)) return false;
      const effectiveClientId = cfg.watch.clientId || runtime.boundSourceClientId || '';
      const effectiveSessionId = cfg.watch.sessionId || runtime.boundSessionId || '';
      const turnClientId = String(turn.sourceClientId || '');
      const turnSessionId = String(turn.sessionId || turn.session?.id || '');
      if (effectiveClientId && effectiveClientId !== turnClientId) return false;
      if (effectiveSessionId && effectiveSessionId !== turnSessionId) return false;
      return true;
    });
    for (const runtime of matched) {
      this.#enqueue(runtime.id, () => this.#processObserved(runtime, turn)).catch((error) => this.#failRuntime(runtime.id, error));
    }
  }
  async #processObserved(runtime, turn) {
    if (isWorkflowPipelineActive(runtime.workflowState)) {
      return await this.deferredTurnQueue.defer(runtime, turn);
    }
    runtime.lastObservedTurnKey = String(turn.turnKey || '');
    runtime.lastSourceClientId = String(turn.sourceClientId || runtime.lastSourceClientId || '');
    runtime.lastSessionId = String(turn.sessionId || turn.session?.id || runtime.lastSessionId || '');
    runtime.updatedAt = nowIso();
    await this.store.setWorkflow(runtime.id, publicWorkflowSnapshot(runtime));
    await this.#event(runtime.id, 'workflow.turn.observed', { turnKey: turn.turnKey || '', sessionId: turn.sessionId || '', sourceClientId: turn.sourceClientId || '', artifactCount: turn.artifacts?.length || 0 });
    return await this.#processResponse(runtime.id, turn, { source: 'passive-observer', remediationAttempt: 0 });
  }
  async #processResponse(workflowId, response, context = {}) {
    const runtime = this.#require(workflowId);
    const requestedPipelineId = String(context.pipelineId || '');
    const reusingPipeline = requestedPipelineId
      && runtime.workflowState?.pipeline?.id === requestedPipelineId
      && isWorkflowPipelineActive(runtime.workflowState);
    const pipelineId = reusingPipeline ? requestedPipelineId : createWorkflowId('pipeline');
    const transitionType = reusingPipeline
      ? WorkflowStateEventType.PIPELINE_STAGE_CHANGED
      : WorkflowStateEventType.PIPELINE_STARTED;
    await this.#transitionWorkflowState(runtime, transitionType, {
      pipelineId,
      status: WorkflowPipelineStatus.OBSERVED,
      evidence: { source: context.source || '', turnKey: response.turnKey || '' },
    }, 'workflow.pipeline.observed', {
      pipelineId,
      source: context.source || '',
      turnKey: response.turnKey || '',
    });
    const artifacts = this.bridge.registerObservedArtifacts(response.artifacts || [], {
      sourceClientId: response.sourceClientId || runtime.config.watch.clientId,
      turnKey: response.turnKey || '',
      sessionId: response.session?.id || response.sessionId || '',
    });
    await this.#event(workflowId, 'workflow.artifacts.discovered', { count: artifacts.length, artifacts: artifacts.map(summarizeArtifact), source: context.source || '' });
    const scope = responseScope(response);
    if (runtime.config.artifact.requireSingleCandidate) {
      const explicitZipCandidates = artifacts.filter((artifact) => looksLikeZipArtifact(artifact) && artifactMatchesResponseScope(artifact, scope));
      if (explicitZipCandidates.length > 1) {
        const candidates = explicitZipCandidates.map(summarizeArtifact);
        runtime.lastError = 'Multiple explicit ZIP candidates were found';
        await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_FAILED, {
          pipelineId,
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
      runtime.lastError = reason;
      await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_FAILED, {
        pipelineId,
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
    return await this.#processArtifact(runtime, response, selected.artifact, { ...context, pipelineId });
  }
  async #processArtifact(runtime, response, artifact, context = {}) {
    const workflow = runtime.config;
    const requestedPipelineId = String(context.pipelineId || '');
    const reusingPipeline = requestedPipelineId
      && runtime.workflowState?.pipeline?.id === requestedPipelineId
      && isWorkflowPipelineActive(runtime.workflowState);
    const pipelineId = reusingPipeline ? requestedPipelineId : createWorkflowId('pipeline');
    runtime.lastError = '';
    const transitionType = reusingPipeline
      ? WorkflowStateEventType.PIPELINE_STAGE_CHANGED
      : WorkflowStateEventType.PIPELINE_STARTED;
    await this.#transitionWorkflowState(runtime, transitionType, {
      pipelineId,
      status: WorkflowPipelineStatus.DOWNLOADING,
      evidence: { source: context.source || '', turnKey: response.turnKey || '' },
    }, 'workflow.artifact.download.started', { pipelineId, artifact: summarizeArtifact(artifact) });
    const fetched = context.localFileId
      ? await this.fileStore.getReadable(context.localFileId)
      : await this.bridge.fetchArtifact(artifact.id, {
        sourceClientId: artifact.sourceClientId || response.sourceClientId || workflow.watch.clientId,
      });
    const readable = context.localFileId ? fetched : await this.fileStore.getReadable(fetched.id || artifact.id);
    if (!readable?.absolutePath) throw new Error(`Downloaded artifact cannot be opened from FileStore: ${fetched.id || artifact.id}`);
    await this.#event(runtime.id, 'workflow.artifact.download.completed', {
      pipelineId,
      fileId: fetched.id,
      name: fetched.name,
      size: fetched.size,
    });
    await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_STAGE_CHANGED, {
      pipelineId,
      status: WorkflowPipelineStatus.VERIFYING,
    }, 'workflow.artifact.verify.started', { pipelineId, fileId: fetched.id });
    const verification = await this.verifier.verify({ workflow, artifactFile: readable, pipelineId });
    const digest = String(verification.zip?.sha256 || fetched.sha256 || artifact.sha256 || '').trim();
    const artifactKey = digest
      ? `${runtime.id}:sha256:${digest}`
      : `${runtime.id}:turn:${response.turnKey || artifact.sourceTurnKey || ''}:artifact:${artifact.id}`;
    if (verification.ok) await this.#bindVerifiedSource(runtime, response, artifact);
    const previous = await this.store.getArtifact(artifactKey);
    if (previous && ['applied', 'verified', 'pending-approval'].includes(previous.status)) {
      runtime.lastError = '';
      await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_COMPLETED, {
        pipelineId,
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
      await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_FAILED, {
        pipelineId,
        code: 'artifact_verification_failed',
        message: runtime.lastError,
        evidence: verificationEvent,
      }, 'workflow.artifact.verify.failed', verificationEvent);
      this.refreshScheduler.sync(runtime);
      return { status: 'invalid', verification };
    }
    if (workflow.watch.mode === 'verify') {
      runtime.lastError = '';
      await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_COMPLETED, {
        pipelineId,
        code: 'artifact_verified',
        evidence: verificationEvent,
      }, 'workflow.artifact.verify.completed', verificationEvent);
      this.refreshScheduler.sync(runtime);
      return { status: 'verified', verification };
    }
    await this.#event(runtime.id, 'workflow.artifact.verify.completed', verificationEvent);
    await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_STAGE_CHANGED, {
      pipelineId,
      status: WorkflowPipelineStatus.PLANNING,
    });
    const plan = await this.applier.plan({ workflow, verification });
    await this.#event(runtime.id, 'workflow.apply.plan', {
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
      const approval = {
        id: approvalId,
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
      await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_STAGE_CHANGED, {
        pipelineId,
        status: WorkflowPipelineStatus.AWAITING_APPROVAL,
        approvalId,
      }, 'workflow.approval.required', {
        approvalId,
        pipelineId,
        reason: workflow.watch.mode === 'ask' ? 'ask-mode' : 'policy-warning',
      }, {
        approvals: { [approvalId]: approval },
        artifacts: { [artifactKey]: pendingArtifact },
      });
      return { status: 'pending-approval', approvalId };
    }
    return await this.#applyVerified(runtime, {
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
  async #resumeApproved(runtime, approval) {
    const artifactState = await this.store.getArtifact(approval.artifactKey);
    if (!artifactState) throw new Error(`Approval artifact state is missing: ${approval.artifactKey}`);
    const readable = await this.fileStore.getReadable(approval.fileId);
    if (!readable?.absolutePath) throw new Error(`Approval artifact file is missing: ${approval.fileId}`);
    await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_STAGE_CHANGED, {
      pipelineId: approval.pipelineId,
      status: WorkflowPipelineStatus.VERIFYING,
      approvalId: approval.id,
      evidence: { resumedFromApproval: approval.id },
    });
    const verification = await this.verifier.verify({ workflow: runtime.config, artifactFile: readable, pipelineId: approval.pipelineId });
    if (!verification.ok) {
      const message = `Artifact no longer verifies: ${verification.reasons.join('; ')}`;
      runtime.lastError = message;
      await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_FAILED, {
        pipelineId: approval.pipelineId,
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
    await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_STAGE_CHANGED, {
      pipelineId: approval.pipelineId,
      status: WorkflowPipelineStatus.PLANNING,
      approvalId: approval.id,
    });
    const plan = await this.applier.plan({ workflow: runtime.config, verification });
    return await this.#applyVerified(runtime, {
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
  async #applyVerified(runtime, state) {
    const workflow = runtime.config;
    await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_STAGE_CHANGED, {
      pipelineId: state.pipelineId,
      status: WorkflowPipelineStatus.APPLYING,
    }, 'workflow.apply.started', { pipelineId: state.pipelineId });
    const preApplyGit = workflow.commit.mode === 'none'
      ? null
      : await inspectGitRepository(workflow.projectRoot);
    let extensionBackup = { available: false, reason: 'disabled' };
    if (workflow.extensionUpdate.enabled) {
      extensionBackup = await this.extensionDeployer.prepareBackup(workflow, { pipelineId: state.pipelineId });
    }
    let applied;
    try {
      applied = await this.applier.apply({ workflow, verification: state.verification, plan: state.plan, pipelineId: state.pipelineId });
      await this.#event(runtime.id, 'workflow.apply.completed', {
        pipelineId: state.pipelineId,
        written: applied.applied.written.length,
        deleted: applied.applied.deleted.length,
        commands: applied.commands.results.map((item) => ({ command: item.command, ok: item.ok, code: item.code, durationMs: item.durationMs })),
      });
    } catch (error) {
      const commandResults = error.commandResults || error.workflowApply?.commands?.results || [];
      const failureEvent = {
        pipelineId: state.pipelineId,
        message: error.message,
        rollback: error.workflowApply?.rollback || null,
        commands: commandResults.map((item) => ({ command: item.command, ok: item.ok, code: item.code })),
      };
      const attempt = Number(state.remediationAttempt || 0);
      if (workflow.remediation.enabled && attempt < workflow.remediation.maxAttempts) {
        await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_STAGE_CHANGED, {
          pipelineId: state.pipelineId,
          status: WorkflowPipelineStatus.REMEDIATING,
          evidence: { attempt: attempt + 1, failure: error.message },
        }, 'workflow.apply.failed', failureEvent);
        return await this.#remediate(runtime, state, error, attempt + 1);
      }
      runtime.lastError = error.message;
      await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_FAILED, {
        pipelineId: state.pipelineId,
        code: 'apply_failed',
        message: error.message,
        evidence: failureEvent,
      }, 'workflow.apply.failed', failureEvent);
      this.refreshScheduler.sync(runtime);
      throw error;
    }
    let commit = { committed: false, reason: 'disabled' };
    let commitError = null;
    try {
      commit = await this.#maybeCommit(runtime, state.response, state.pipelineId, { preApplyGit });
    } catch (error) {
      commitError = error;
      commit = { committed: false, reason: 'commit-failed', error: error.message || String(error) };
      await this.#event(runtime.id, 'workflow.commit.failed', {
        pipelineId: state.pipelineId,
        message: commit.error,
        code: error.code || '',
      });
    }
    const extensionUpdate = await this.extensionDeployer.deploy(workflow, {
      sourceClientId: state.response.sourceClientId || workflow.watch.clientId,
      pipelineId: state.pipelineId,
      backup: extensionBackup,
    }).catch((error) => ({ updated: false, error: error.message, rollback: error.extensionRollback || null, backup: extensionBackup }));
    if (extensionUpdate.updated || extensionUpdate.error) {
      await this.#event(runtime.id, extensionUpdate.error ? 'workflow.extension.update.failed' : 'workflow.extension.update.completed', {
        pipelineId: state.pipelineId,
        ...extensionUpdate,
      });
    }
    const warnings = [commitError?.message, extensionUpdate.error].filter(Boolean);
    await this.store.setArtifact(state.artifactKey, {
      ...(await this.store.getArtifact(state.artifactKey)),
      status: 'applied',
      appliedAt: nowIso(),
      applied: applicationSummary(applied),
      commit,
      extensionUpdate,
      warnings,
    });
    runtime.lastError = warnings.join('; ');
    await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_COMPLETED, {
      pipelineId: state.pipelineId,
      code: warnings.length ? 'completed_with_warnings' : 'completed',
      message: warnings.join('; '),
      evidence: {
        commit: commit.committed ? commit.sha : '',
        extensionUpdated: Boolean(extensionUpdate.updated),
        warnings,
      },
    }, warnings.length ? 'workflow.completed_with_warnings' : 'workflow.completed', {
      pipelineId: state.pipelineId,
      commit: commit.committed ? commit.sha : '',
      extensionUpdated: Boolean(extensionUpdate.updated),
      warnings,
    });
    this.refreshScheduler.sync(runtime);
    const daemonRestart = await this.#requestDaemonRestart(runtime, state, { extensionUpdate, warnings });
    if (daemonRestart.requested) {
      await this.store.setArtifact(state.artifactKey, {
        ...(await this.store.getArtifact(state.artifactKey)),
        daemonRestart: {
          requested: true,
          mode: daemonRestart.mode,
          delayMs: daemonRestart.delayMs,
          exitCode: daemonRestart.exitCode,
          requestedAt: nowIso(),
        },
      });
    }
    return {
      status: warnings.length ? 'applied-with-warnings' : 'applied',
      applied: applicationSummary(applied),
      commit,
      extensionUpdate,
      daemonRestart,
      warnings,
    };
  }
  async #requestDaemonRestart(runtime, state, { extensionUpdate = null, warnings = [] } = {}) {
    const cfg = runtime.config.daemonRestart;
    if (!cfg?.enabled) return { requested: false, reason: 'disabled' };
    if (!this.restartHandler) {
      const message = 'Daemon restart is enabled, but no restart handler is configured';
      await this.#event(runtime.id, 'workflow.daemon.restart.failed', { pipelineId: state.pipelineId, message });
      if (cfg.required) throw new Error(message);
      return { requested: false, reason: 'handler-unavailable', message };
    }
    const request = {
      workflowId: runtime.id,
      pipelineId: state.pipelineId,
      mode: cfg.mode,
      command: cfg.command,
      delayMs: cfg.delayMs,
      exitCode: cfg.exitCode,
      projectRoot: runtime.config.projectRoot,
      expectedPackageVersion: await fs.readFile(path.join(runtime.config.projectRoot, 'package.json'), 'utf8').then((text) => JSON.parse(text).version || '').catch(() => ''),
      extensionUpdated: Boolean(extensionUpdate?.updated),
      warnings,
      requestedAt: nowIso(),
    };
    const intentPath = path.join(this.dataDir, 'workflows', 'restart-request.json');
    await fs.mkdir(path.dirname(intentPath), { recursive: true });
    await fs.writeFile(intentPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
    await this.#event(runtime.id, 'workflow.daemon.restart.requested', request);
    await this.restartHandler(request);
    return { requested: true, mode: cfg.mode, delayMs: cfg.delayMs, exitCode: cfg.exitCode, intentPath };
  }
  async #remediate(runtime, state, error, attempt) {
    const workflow = runtime.config;
    const commandResults = error.commandResults || error.workflowApply?.commands?.results || [];
    const output = commandResults.map((item) => [`$ ${item.command}`, item.stdout, item.stderr].filter(Boolean).join('\n')).join('\n\n');
    const prompt = workflow.remediation.prompt || [
      'The project artifact was downloaded and applied transactionally, but the configured validation commands failed. The project was rolled back.',
      `This is remediation attempt ${attempt} of ${workflow.remediation.maxAttempts}.`,
      '',
      'Fix the project based on the validation output below and return a new downloadable ZIP containing the full updated project at the archive root.',
      'Do not return only a patch. Preserve unrelated project files.',
      '',
      'VALIDATION_OUTPUT_BEGIN',
      tailLines(output || error.message, workflow.remediation.outputTailLines),
      'VALIDATION_OUTPUT_END',
    ].join('\n');
    await this.#event(runtime.id, 'workflow.remediation.prompt.started', { pipelineId: state.pipelineId, attempt, sessionId: state.response.session?.id || state.response.sessionId || '' });
    const sameChat = workflow.remediation.sameChat !== false;
    const response = await this.bridge.sendRequest({
      message: prompt,
      sessionId: sameChat ? (state.response.session?.id || state.response.sessionId || workflow.watch.sessionId || '') : '',
      sourceClientId: state.response.sourceClientId || workflow.watch.clientId || '',
      newSession: !sameChat,
      effort: 'instant',
      output: { expected: 'zip', required: true },
      fullResponse: true,
    });
    await this.#event(runtime.id, 'workflow.remediation.response.completed', { attempt, artifactCount: response.artifacts?.length || 0, turnKey: response.turnKey || '' });
    return await this.#processResponse(runtime.id, response, {
      source: 'remediation',
      remediationAttempt: attempt,
      pipelineId: state.pipelineId,
    });
  }
  async #maybeCommit(runtime, sourceResponse, pipelineId, { preApplyGit = null } = {}) {
    const cfg = runtime.config.commit;
    if (cfg.mode === 'none') return { committed: false, reason: 'disabled' };
    if (preApplyGit?.available && preApplyGit.dirty) {
      const reason = 'pre-existing Git changes were present before artifact application';
      if (cfg.required) throw new Error(`Git commit is required but unsafe: ${reason}`);
      await this.#event(runtime.id, 'workflow.commit.skipped', { pipelineId, committed: false, reason: 'preexisting-changes' });
      return { committed: false, reason: 'preexisting-changes' };
    }
    const gitInfo = await inspectGitRepository(runtime.config.projectRoot);
    if (!gitInfo.available) {
      const reason = gitInfo.reason || 'git-unavailable';
      if (cfg.required) throw new Error(`Git commit is required but the repository is unavailable: ${reason}`);
      return { committed: false, reason };
    }
    if (!gitInfo.dirty) {
      await this.#event(runtime.id, 'workflow.commit.skipped', { pipelineId, committed: false, reason: 'no-changes' });
      return { committed: false, reason: 'no-changes' };
    }
    let answer = String(sourceResponse.answer || '');
    if (cfg.mode === 'same-chat' || cfg.mode === 'new-chat') {
      const prompt = cfg.prompt || [
        'Write a Git commit message for the completed project changes.',
        `Return only the message between exact markers ${cfg.beginMarker} and ${cfg.endMarker}.`,
        cfg.style === 'short' ? 'Use one concise subject line.' : 'Use a concise subject line and an optional explanatory body.',
      ].join('\n');
      if (cfg.mode === 'same-chat') {
        const response = await this.bridge.sendRequest({ message: prompt, sessionId: sourceResponse.session?.id || sourceResponse.sessionId || runtime.config.watch.sessionId || '', sourceClientId: sourceResponse.sourceClientId || runtime.config.watch.clientId || '', effort: 'instant', fullResponse: true });
        answer = response.answer || '';
      } else {
        const contextPath = path.join(this.dataDir, 'workflows', runtime.id, 'pipelines', pipelineId, 'commit-context.txt');
        await buildCommitContext(runtime.config.projectRoot, contextPath, { maxBytes: cfg.maxContextBytes });
        const attachment = await this.fileStore.importLocalPath({ filePath: contextPath, name: 'commit-context.txt', mime: 'text/plain' });
        const response = await this.bridge.sendRequest({ message: prompt, attachments: [attachment.id], newSession: true, effort: 'instant', fullResponse: true });
        answer = response.answer || '';
        if (response.session?.id && response.session.id !== 'new') await this.bridge.deleteSession(response.session.id, { sourceClientId: response.sourceClientId || runtime.config.watch.clientId, expectedUrl: response.session.url || response.url || '' }).catch(() => {});
      }
    }
    const message = extractMarkedBlock(answer, cfg.beginMarker, cfg.endMarker);
    if (!message) {
      if (cfg.required) throw new Error(`Commit message block is required but missing (${cfg.beginMarker} ... ${cfg.endMarker})`);
      return { committed: false, reason: 'marker-block-missing' };
    }
    const result = await createGitCommit({ root: runtime.config.projectRoot, message, authorName: cfg.authorName, authorEmail: cfg.authorEmail });
    if (!result.committed && cfg.required) throw new Error(`Git commit is required but was not created: ${result.reason || 'unknown reason'}`);
    await this.#event(runtime.id, result.committed ? 'workflow.commit.completed' : 'workflow.commit.skipped', { pipelineId, ...result });
    return result;
  }
  async #bindVerifiedSource(runtime, response, artifact = {}) {
    return bindVerifiedSource({
      runtime,
      response,
      artifact,
      persistRuntime: (target) => this.#persistRuntime(target),
      publish: (workflowId, type, data) => this.#event(workflowId, type, data),
      syncRefreshTimer: (target) => this.refreshScheduler.sync(target),
      syncProjectContext: (target, options) => this.#syncProjectContext(target, options),
    });
  }
  async #syncProjectContext(runtime, { reason = 'manual' } = {}) {
    return syncProjectContext({
      runtime,
      reason,
      dataDir: this.dataDir,
      fileStore: this.fileStore,
      bridge: this.bridge,
      persistRuntime: (target) => this.#persistRuntime(target),
      publish: (workflowId, type, data) => this.#event(workflowId, type, data),
    });
  }
  async #acknowledgeRestartIntent() {
    return acknowledgeRestartIntent({
      dataDir: this.dataDir,
      getRuntime: (workflowId) => this.workflows.get(workflowId),
      publish: (workflowId, type, data) => this.#event(workflowId, type, data),
    });
  }
  async #recoverInterruptedPipeline(runtime) {
    return recoverInterruptedPipeline({
      runtime,
      dataDir: this.dataDir,
      applier: this.applier,
      persistRuntime: (target) => this.#persistRuntime(target),
      transition: (target, type, data, publishedType, publishedData) => this.#transitionWorkflowState(
        target,
        type,
        data,
        publishedType,
        publishedData,
      ),
      publish: (workflowId, type, data) => this.#event(workflowId, type, data),
      syncRefreshTimer: (target) => this.refreshScheduler.sync(target),
    });
  }
  #enqueue(workflowId, task) {
    const runtime = this.workflows.get(workflowId);
    const projectKey = runtime?.config?.projectRoot
      ? path.resolve(runtime.config.projectRoot)
      : `workflow:${workflowId}`;
    const previous = this.projectQueues.get(projectKey) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tracked = run.finally(() => {
      if (this.projectQueues.get(projectKey) === tracked) this.projectQueues.delete(projectKey);
      if (this.queues.get(workflowId) === tracked) this.queues.delete(workflowId);
    });
    this.projectQueues.set(projectKey, tracked);
    this.queues.set(workflowId, tracked);
    return tracked;
  }
  #require(workflowId) {
    const runtime = this.workflows.get(workflowId);
    if (!runtime) throw new Error(`Unknown workflow: ${workflowId}`);
    return runtime;
  }
  async #transitionWorkflowState(runtime, type, data = {}, publishedType = '', publishedData = {}, persistence = {}) {
    const at = nowIso();
    const wasPipelineActive = isWorkflowPipelineActive(runtime.workflowState);
    const outcome = reduceWorkflowState(runtime.workflowState, { type, data, at });
    if (!outcome.accepted) {
      const diagnostic = outcome.diagnostics?.[0];
      const error = new Error(diagnostic?.message || `Workflow state transition rejected: ${type}`);
      error.code = diagnostic?.code || 'WORKFLOW_STATE_TRANSITION_REJECTED';
      throw error;
    }
    runtime.workflowState = outcome.state;
    if (outcome.state.pipeline?.id) runtime.lastPipelineId = outcome.state.pipeline.id;
    if (Object.prototype.hasOwnProperty.call(data, 'lastError')) runtime.lastError = String(data.lastError || '');
    runtime.updatedAt = at;
    const workflowSnapshot = publicWorkflowSnapshot(runtime);
    const hasBatchPersistence = Object.keys(persistence.approvals || {}).length > 0
      || Object.keys(persistence.artifacts || {}).length > 0;
    if (hasBatchPersistence) {
      await this.store.commitWorkflow(runtime.id, workflowSnapshot, persistence);
    } else {
      await this.store.setWorkflow(runtime.id, workflowSnapshot);
    }
    if (publishedType) {
      await this.#event(runtime.id, publishedType, {
        ...publishedData,
        workflowStateRevision: outcome.state.revision,
        pipelineStatus: outcome.state.pipeline.status,
        watcherStatus: outcome.state.watcher.status,
      });
    }
    if (wasPipelineActive && isWorkflowPipelineTerminal(outcome.state)) this.deferredTurnQueue.schedule(runtime);
    return outcome.state;
  }
  async #persistRuntime(runtime) {
    runtime.updatedAt = nowIso();
    await this.store.setWorkflow(runtime.id, publicWorkflowSnapshot(runtime));
    return runtime;
  }
  async #failRuntime(workflowId, error) {
    const runtime = this.workflows.get(workflowId);
    const message = error.message || String(error);
    const code = error.code || '';
    if (runtime) {
      runtime.lastError = message;
      const pipelineId = runtime.workflowState?.pipeline?.id || runtime.lastPipelineId || '';
      if (pipelineId && isWorkflowPipelineActive(runtime.workflowState)) {
        await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_FAILED, {
          pipelineId,
          code: code || 'workflow_pipeline_failed',
          message,
        }, 'workflow.failed', { message, code, pipelineId }).catch(async () => {
          await this.#persistRuntime(runtime).catch(() => {});
          await this.#event(workflowId, 'workflow.failed', { message, code, pipelineId });
        });
      } else {
        await this.#persistRuntime(runtime).catch(() => {});
        await this.#event(workflowId, 'workflow.failed', { message, code, pipelineId });
      }
      this.refreshScheduler.sync(runtime);
    } else {
      await this.#event(workflowId, 'workflow.failed', { message, code });
    }
    logError(`[workflow:${workflowId}] ${error.stack || error.message || error}`);
  }
  async #event(workflowId, type, data = {}) {
    const event = { id: createWorkflowId('workflow-event'), workflowId, type, time: nowIso(), data: compactValue(data) };
    await this.store.appendEvent(event).catch(() => {});
    this.eventBus?.emitUser({ type, data: { workflowId, ...data } });
    const summary = JSON.stringify(data, (key, value) => typeof value === 'string' && value.length > 400 ? `${value.slice(0, 400)}…` : value);
    log(`[workflow:${workflowId || 'global'}] ${type}${summary && summary !== '{}' ? ` ${summary}` : ''}`);
    return event;
  }
}
