import path from 'node:path';
import { log, error as logError } from '../logger.js';
import { artifactMatchesResponseScope, looksLikeZipArtifact, selectRequiredZipCompletionCandidate, summarizeArtifact } from '../results/artifacts.js';
import { loadWorkflowConfig } from './config.js';
import { WorkflowStore } from './store.js';
import { ArtifactVerifier } from './artifactVerifier.js';
import { TransactionalApplier } from './transaction.js';
import { ExtensionDeployer } from './extensionDeployer.js';
import { inspectGitRepository } from './gitCommit.js';
import { runWorkflowCommands } from './commandRunner.js';
import { ensureProjectIdentity, writeProjectFingerprint } from '../projectIdentity.js';
import {
  boundedText,
  compactValue,
  nowIso,
  responseScope,
  workflowId as createWorkflowId,
} from './support/workflowValues.js';
import {
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
import { WorkflowNotificationService } from './attention/notificationService.js';
import { attentionForWorkflowEvent } from './attention/attentionState.js';
import { WorkflowApplyCompletionService } from './services/applyCompletionService.js';
import { WorkflowCommitService } from './services/commitService.js';
import { WorkflowContextService } from './services/contextService.js';
import { WorkflowDaemonRestartService } from './services/daemonRestartService.js';
import { WorkflowResultRepairService } from './services/resultRepairService.js';
import { WorkflowSessionService } from './services/sessionService.js';
import { WorkflowSettingsService } from './services/settingsService.js';
import { WorkflowCheckFailureService } from './services/checkFailureService.js';
import { WorkflowApplyVerifiedService } from './services/applyVerifiedService.js';
import { validateResultManifestAgainstPlan } from './result/resultProtocol.js';
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
  constructor({ bridge, fileStore, eventBus = null, dataDir, workflowStore = null, restartHandler = null, turnManager = null, projectService = null, notificationService = null } = {}) {
    this.bridge = bridge;
    this.fileStore = fileStore;
    this.eventBus = eventBus;
    this.dataDir = dataDir;
    this.projectService = projectService || null;
    this.store = workflowStore || new WorkflowStore(dataDir);
    this.restartHandler = typeof restartHandler === 'function' ? restartHandler : null;
    this.notificationService = notificationService || new WorkflowNotificationService({ dataDir });
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
    this.contextService = new WorkflowContextService({
      dataDir, fileStore, bridge, projectService: this.projectService, applier: this.applier,
      getRuntime: (workflowId) => this.workflows.get(workflowId),
      persistRuntime: (runtime) => this.#persistRuntime(runtime),
      transition: (runtime, type, data, publishedType, publishedData) => this.#transitionWorkflowState(runtime, type, data, publishedType, publishedData),
      publish: (workflowId, type, data) => this.#event(workflowId, type, data),
      syncRefreshTimer: (runtime) => this.refreshScheduler.sync(runtime),
    });
    this.daemonRestartService = new WorkflowDaemonRestartService({ dataDir, restartHandler, publish: (workflowId, type, data) => this.#event(workflowId, type, data) });
    this.applyCompletionService = new WorkflowApplyCompletionService({
      store: this.store,
      transition: (runtime, type, data, publishedType, publishedData) => this.#transitionWorkflowState(runtime, type, data, publishedType, publishedData),
      contextService: this.contextService,
      daemonRestartService: this.daemonRestartService,
      syncRefresh: (runtime) => this.refreshScheduler.sync(runtime),
      publish: (workflowId, type, data) => this.#event(workflowId, type, data),
    });
    this.commitService = new WorkflowCommitService({
      bridge, fileStore, dataDir,
      publish: (workflowId, type, data) => this.#event(workflowId, type, data),
      persistRuntime: (runtime) => this.#persistRuntime(runtime),
      completeAppliedPipeline: (runtime, state, options) => this.applyCompletionService.complete(runtime, state, options),
    });
    this.checkFailureService = new WorkflowCheckFailureService({
      applier: this.applier,
      store: this.store,
      commitService: this.commitService,
      applyCompletionService: this.applyCompletionService,
      transition: (runtime, type, data, publishedType, publishedData) => this.#transitionWorkflowState(runtime, type, data, publishedType, publishedData),
      persistRuntime: (runtime) => this.#persistRuntime(runtime),
      persistConfig: (runtime) => this.settingsService.persist(runtime),
      publish: (workflowId, type, data) => this.#event(workflowId, type, data),
      runAutomation: (runtime, options) => this.automationService.run(runtime, options),
      stopWatcher: (runtime) => this.stop(runtime.id),
    });
    this.resultRepairService = new WorkflowResultRepairService({
      bridge,
      transition: (runtime, type, data, publishedType, publishedData) => this.#transitionWorkflowState(runtime, type, data, publishedType, publishedData),
      publish: (workflowId, type, data) => this.#event(workflowId, type, data),
      processResponse: (workflowId, response, context) => this.#processResponse(workflowId, response, context),
      prepareRequest: (runtime, context) => this.sessionService.prepareRequest(runtime, context),
    });
    this.sessionService = new WorkflowSessionService({
      bridge, fileStore, projectService: this.projectService, dataDir,
      publish: (workflowId, type, data) => this.#event(workflowId, type, data),
      persistRuntime: (runtime) => this.#persistRuntime(runtime),
    });
    this.applyVerifiedService = new WorkflowApplyVerifiedService({
      applier: this.applier,
      extensionDeployer: this.extensionDeployer,
      commitService: this.commitService,
      checkFailureService: this.checkFailureService,
      applyCompletionService: this.applyCompletionService,
      resultRepairService: this.resultRepairService,
      store: this.store,
      transition: (runtime, type, data, publishedType, publishedData) => this.#transitionWorkflowState(runtime, type, data, publishedType, publishedData),
      publish: (workflowId, type, data) => this.#event(workflowId, type, data),
      refresh: (runtime) => this.refreshScheduler.sync(runtime),
    });
    this.settingsService = new WorkflowSettingsService({
      persistRuntime: (runtime) => this.#persistRuntime(runtime),
      invalidateNotifications: () => this.notificationService.invalidateConfig(),
    });
    this.automationController = new WorkflowAutomationController({
      turnManager,
      fileStore,
      transition: (runtime, type, data, publishedType, publishedData) => this.#transitionWorkflowState(runtime, type, data, publishedType, publishedData),
      publish: (workflowId, type, data) => this.#event(workflowId, type, data),
      processFile: (runtime, options) => this.manualOperations.processFileResult(runtime, options),
      beforeRequest: async (runtime, options) => {
        const prepared = await this.sessionService.prepareRequest(runtime, options);
        await this.contextService.sync(runtime, { reason: 'before-request', ...options, ...prepared });
        return prepared;
      },
      finalize: (runtime, options) => this.commitService.finalize(runtime, options),
      recoverSession: (runtime, options) => this.sessionService.recover(runtime, options),
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
          runtime.workflowCommitBaseSha = String(item.workflowCommitBaseSha || runtime.workflowCommitBaseSha || '');
          runtime.workflowCommitShas = Array.isArray(item.workflowCommitShas) ? item.workflowCommitShas.map(String) : [];
          runtime.workflowCommitPaths = Array.isArray(item.workflowCommitPaths) ? item.workflowCommitPaths.map(String) : [];
          runtime.workflowCommitPathStates = item.workflowCommitPathStates && typeof item.workflowCommitPathStates === 'object'
            ? item.workflowCommitPathStates
            : {};
          runtime.lastWorkflowCommitMessage = String(item.lastWorkflowCommitMessage || '');
          runtime.pendingSessionRecovery = item.pendingSessionRecovery || null;
          runtime.pendingCommit = item.pendingCommit || null;
          runtime.pendingCheckFailure = item.pendingCheckFailure || null;
          runtime.workflowTurnSessionId = String(item.workflowTurnSessionId || '');
          runtime.workflowTurnCount = Math.max(0, Number(item.workflowTurnCount) || 0);
          runtime.attention = item.attention || null; runtime.automationInterrupted = Boolean(item.automationInterrupted);
          this.deferredTurnQueue.reset(runtime);
          runtime.updatedAt = nowIso();
          await this.store.setWorkflow(runtime.id, publicWorkflowSnapshot(runtime));
          if (interrupted) await this.contextService.recoverInterrupted(runtime);
          this.refreshScheduler.sync(runtime);
          if (!runtime.automationInterrupted) await this.automationService.restore(runtime);
          if (runtime.attention?.required) await this.notificationService.notify({
            key: runtime.attention.key,
            title: runtime.attention.title,
            body: runtime.attention.message,
            config: runtime.config.ux?.notifications,
          }).catch(() => null);
          restored.push(publicWorkflowSnapshot(runtime));
        }
      } catch (error) {
        await this.#event(item.id || '', 'workflow.restore.failed', { configPath: item.configPath, message: error.message || String(error) });
      }
    }
    await this.contextService.acknowledgeRestart().catch((error) => this.#event('', 'workflow.daemon.restart.ack.failed', { message: error.message || String(error) }));
    return restored;
  }
  async load(configPath, { start = true, includeLatest = true, triggerAutomation = true } = {}) {
    const config = await loadWorkflowConfig(configPath);
    const projectIdentity = await ensureProjectIdentity(config.projectRoot, { packageName: config.verification.packageName });
    const projectFingerprint = await writeProjectFingerprint(config.projectRoot, { identity: projectIdentity, files: config.projectContext.fallbackFiles }); const initialGit = await inspectGitRepository(config.projectRoot);
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
      boundSourceClientId: String(config.watch.clientId || ''),
      boundSessionId: String(config.watch.sessionId || ''),
      lastPipelineId: '',
      lastError: '',
      projectId: projectIdentity.projectId,
      projectFingerprintSha256: projectFingerprint.fingerprintSha256,
      contextSyncedSessionId: '',
      contextSyncFingerprint: '',
      workflowCommitBaseSha: initialGit.available ? initialGit.head : '',
      workflowCommitShas: [],
      workflowCommitPaths: [],
      workflowCommitPathStates: {},
      lastWorkflowCommitMessage: '',
      pendingSessionRecovery: null,
      pendingCommit: null,
      pendingCheckFailure: null,
      workflowTurnSessionId: '',
      workflowTurnCount: 0,
      deferredObservedTurns: [],
      automationInterrupted: false,
    };
    this.workflows.set(config.id, runtime);
    await this.store.setWorkflow(config.id, publicWorkflowSnapshot(runtime));
    this.refreshScheduler.sync(runtime);
    await this.#event(config.id, 'workflow.loaded', { configPath: config.configPath, projectRoot: config.projectRoot, projectId: runtime.projectId, mode: config.watch.mode, watcherStatus: runtime.workflowState.watcher.status, pipelineStatus: runtime.workflowState.pipeline.status });
    if (start && config.enabled && config.projectContext.enabled && config.projectContext.syncOnStart && config.watch.sessionId) {
      this.#enqueue(config.id, () => this.contextService.sync(runtime, { reason: 'workflow-start' })).catch((error) => this.#event(config.id, 'workflow.context.sync.failed', { message: error.message || String(error) }));
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
    runtime.boundSourceClientId = runtime.boundSourceClientId || String(runtime.config.watch.clientId || '');
    runtime.boundSessionId = runtime.boundSessionId || String(runtime.config.watch.sessionId || '');
    await this.#transitionWorkflowState(runtime, WorkflowStateEventType.WATCHER_STARTED, {}, 'workflow.started', {
      sourceClientId: runtime.boundSourceClientId,
      sessionId: runtime.boundSessionId,
    });
    this.refreshScheduler.sync(runtime);
    if (runtime.config.projectContext.enabled && runtime.config.projectContext.syncOnStart) {
      this.#enqueue(runtime.id, () => this.contextService.sync(runtime, { reason: 'workflow-start' })).catch((error) => this.#event(runtime.id, 'workflow.context.sync.failed', { message: error.message || String(error) }));
    }
    return publicWorkflowSnapshot(runtime);
  }
  async stop(workflowId) {
    const runtime = this.#require(workflowId);
    await this.#transitionWorkflowState(runtime, WorkflowStateEventType.WATCHER_STOPPED, {}, 'workflow.stopped');
    this.refreshScheduler.clear(workflowId);
    return publicWorkflowSnapshot(runtime);
  }
  async completeGuidedWorkflow(workflowId) {
    const runtime = this.#require(workflowId);
    if (isWorkflowAutomationActive(runtime.workflowState)) await this.automationController.stop(runtime, 'guided task completed');
    await this.#transitionWorkflowState(runtime, WorkflowStateEventType.WATCHER_STOPPED, {}, 'workflow.stopped');
    await this.#event(runtime.id, 'workflow.guided.completed', { message: 'The guided task was finished by the user.' });
    return publicWorkflowSnapshot(runtime);
  }
  list() { return Array.from(this.workflows.values()).map((runtime) => publicWorkflowSnapshot(runtime)); } get(workflowId) { const runtime = this.workflows.get(workflowId); return runtime ? publicWorkflowSnapshot(runtime) : null; } async processResponse(workflowId, response, context = {}) { const runtime = this.#require(workflowId); return await this.#enqueue(runtime.id, () => this.#processResponse(runtime.id, response, context)); } async assumeProjectContext(workflowId, sessionId = '') { const runtime = this.#require(workflowId); return await this.#enqueue(runtime.id, () => this.contextService.recordRemoteSnapshot(runtime, { session: { id: sessionId || runtime.config.watch.sessionId || runtime.boundSessionId || '' } })); } async restoreStartingState(workflowId) { const runtime = this.#require(workflowId); return await this.#enqueue(runtime.id, () => this.commitService.restoreStartingState(runtime)); }
  async approvals() { return await this.store.listApprovals({ status: 'pending' }); }
  async events(workflowId, limit = 200) { return await this.store.listEvents({ workflowId, limit }); }
  attention(workflowId) { return this.workflows.get(workflowId)?.attention || null; }
  async acknowledgeAttention(workflowId) {
    const runtime = this.#require(workflowId);
    const key = runtime.attention?.key || '';
    runtime.attention = null;
    this.notificationService.acknowledge(key);
    await this.#persistRuntime(runtime);
    return publicWorkflowSnapshot(runtime);
  }
  reloadGlobalConfig() { this.notificationService.invalidateConfig(); }
  async updateWorkflowSettings(workflowId, defaults = {}) { return await this.settingsService.apply(this.#require(workflowId), defaults); }
  async approvePendingCommit(workflowId) {
    const runtime = this.#require(workflowId);
    return await this.#enqueue(runtime.id, async () => {
      const stopAfterCommit = Boolean(runtime.pendingCommit?.stopAfterCommit);
      const result = await this.commitService.approvePending(runtime);
      if (stopAfterCommit) await this.stop(runtime.id);
      return result;
    });
  }
  async skipPendingCommit(workflowId, reason = 'skipped by user') {
    const runtime = this.#require(workflowId);
    return await this.#enqueue(runtime.id, async () => {
      const stopAfterCommit = Boolean(runtime.pendingCommit?.stopAfterCommit);
      const result = await this.commitService.skipPending(runtime, reason);
      if (stopAfterCommit) await this.stop(runtime.id);
      return result;
    });
  }
  async startFixLoopAfterFailedChecks(workflowId) { const runtime = this.#require(workflowId); return await this.#enqueue(runtime.id, () => this.checkFailureService.startFixLoop(runtime)); }
  async keepFailedCheckChanges(workflowId) { const runtime = this.#require(workflowId); return await this.#enqueue(runtime.id, () => this.checkFailureService.keepAndStop(runtime)); }
  async revertFailedCheckChanges(workflowId) { const runtime = this.#require(workflowId); return await this.#enqueue(runtime.id, () => this.checkFailureService.revert(runtime)); }
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
  async refreshProjectContext(workflowId, options = {}) {
    const runtime = this.#require(workflowId);
    return await this.#enqueue(runtime.id, () => this.contextService.sync(runtime, { reason: 'manual-refresh', ...options }));
  }
  async prepareWorkflowRequest(workflowId, options = {}) { return await this.sessionService.prepareRequest(this.#require(workflowId), options); }
  async runChecks(workflowId) {
    const runtime = this.#require(workflowId);
    const commands = runtime.config.automation?.steps?.map((item) => item.command).filter(Boolean)
      || runtime.config.apply?.commands || [];
    if (!commands.length) return { ok: true, results: [], reason: 'no-checks' };
    await this.#event(runtime.id, 'workflow.checks.started', { commands });
    const result = await runWorkflowCommands(commands, {
      cwd: runtime.config.projectRoot,
      timeoutMs: runtime.config.apply?.timeoutMs || 20 * 60_000,
      onOutput: (stream, output) => this.#event(runtime.id, 'workflow.checks.output', { stream, output: boundedText(output, 4_000) }),
    });
    await this.#event(runtime.id, 'workflow.checks.completed', {
      ok: result.ok,
      results: result.results.map((item) => ({ command: item.command, ok: item.ok, code: item.code, durationMs: item.durationMs })),
    });
    return result;
  }
  async deployExtension(workflowId) {
    return await this.manualOperations.deployExtension(this.#require(workflowId));
  }
  async runAutomation(workflowId, options = {}) {
    return await this.automationService.run(this.#require(workflowId), options);
  }
  async pauseAutomation(workflowId, reason = 'paused by user') {
    return await this.automationService.pause(this.#require(workflowId), reason);
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
  async recoverWorkflowSession(workflowId, context = {}) { return await this.sessionService.recover(this.#require(workflowId), context); }
  async recoverSessionAndRestart(workflowId) {
    const runtime = this.#require(workflowId);
    const recovery = await this.sessionService.recover(runtime, {
      error: Object.assign(new Error('Session recovery requested by user'), { code: 'WORKFLOW_SESSION_EXHAUSTED' }),
      force: true,
      automationId: runtime.workflowState.automation?.id || '',
      cycle: runtime.workflowState.automation?.cycle || 0,
      maxCycles: runtime.workflowState.automation?.maxCycles || runtime.config.automation.maxCycles,
      validation: null,
      sourceClientId: runtime.config.watch.clientId || runtime.boundSourceClientId || runtime.lastSourceClientId || '',
    });
    if (!recovery?.recovered) throw new Error('Workflow session could not be recovered');
    await this.acknowledgeAttention(runtime.id).catch(() => null);
    return await this.automationService.restart(runtime, {
      trigger: 'session-recovery',
      sessionPolicy: 'pinned',
      sessionId: recovery.sessionId,
      sourceClientId: recovery.sourceClientId,
    });
  }
  async requestResultRepair(workflowId) {
    const runtime = this.#require(workflowId);
    return await this.#enqueue(runtime.id, () => this.resultRepairService.requestManual(runtime));
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
        const repaired = await this.resultRepairService.maybeRepair(runtime, response, {
          pipelineId,
          reasons: [runtime.lastError],
          context,
        });
        if (repaired) return repaired;
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
      if (runtime.config.resultProtocol?.allowTextOnly) {
        runtime.lastError = '';
        await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_COMPLETED, {
          pipelineId,
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
    if (verification.ok) await this.contextService.bindVerified(runtime, response, artifact);
    const previous = await this.store.getArtifact(artifactKey);
    if (previous && ['applied', 'verified', 'pending-approval', 'awaiting-commit'].includes(previous.status)) {
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
      const repaired = await this.resultRepairService.maybeRepair(runtime, response, {
        pipelineId,
        reasons: verification.reasons,
        context,
      });
      if (repaired) return repaired;
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
    const manifestReasons = validateResultManifestAgainstPlan({
      manifest: verification.resultProtocol?.manifest,
      plan,
    });
    if (manifestReasons.length) {
      runtime.lastError = manifestReasons.join('; ');
      await this.store.setArtifact(artifactKey, {
        ...(await this.store.getArtifact(artifactKey)),
        status: 'invalid',
        verification: {
          ...verificationSummary(verification),
          resultManifestReasons: manifestReasons,
        },
      });
      const repaired = await this.resultRepairService.maybeRepair(runtime, response, {
        pipelineId,
        reasons: manifestReasons,
        context,
      });
      if (repaired) return repaired;
      await this.#transitionWorkflowState(runtime, WorkflowStateEventType.PIPELINE_FAILED, {
        pipelineId,
        code: 'result_manifest_mismatch',
        message: runtime.lastError,
        evidence: { reasons: manifestReasons },
      }, 'workflow.artifact.verify.failed', { pipelineId, ok: false, reasons: manifestReasons });
      this.refreshScheduler.sync(runtime);
      return { status: 'invalid', verification, plan, reasons: manifestReasons };
    }
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
    const manifestReasons = validateResultManifestAgainstPlan({ manifest: verification.resultProtocol?.manifest, plan });
    if (manifestReasons.length) throw new Error(`Approved artifact result manifest no longer matches the apply plan: ${manifestReasons.join('; ')}`);
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
    return await this.applyVerifiedService.apply(runtime, state);
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
    const runtime = workflowId ? this.workflows.get(workflowId) : null;
    const attention = workflowId ? attentionForWorkflowEvent(workflowId, type, data) : null;
    if (runtime && attention) {
      runtime.attention = attention;
      await this.store.setWorkflow(runtime.id, publicWorkflowSnapshot(runtime)).catch(() => {});
      await this.notificationService.notify({
        key: attention.key,
        title: attention.title,
        body: attention.message,
        config: runtime.config.ux?.notifications,
      }).catch(() => {});
    }
    this.eventBus?.emitUser({ type, data: { workflowId, ...data } });
    const summary = JSON.stringify(data, (key, value) => typeof value === 'string' && value.length > 400 ? `${value.slice(0, 400)}…` : value);
    log(`[workflow:${workflowId || 'global'}] ${type}${summary && summary !== '{}' ? ` ${summary}` : ''}`);
    return event;
  }
}
