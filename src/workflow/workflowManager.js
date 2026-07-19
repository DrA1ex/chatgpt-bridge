import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadWorkflowConfig } from './config.js';
import { WorkflowStore } from './store.js';
import { ArtifactVerifier } from './artifactVerifier.js';
import { TransactionalApplier } from './transaction.js';
import { ExtensionDeployer } from './extensionDeployer.js';
import { inspectGitRepository } from './gitCommit.js';
import { runWorkflowCommands } from './commandRunner.js';
import { ensureProjectIdentity, writeProjectFingerprint } from '../projectIdentity.js';
import { boundedText, nowIso, workflowId as createWorkflowId } from './support/workflowValues.js';
import { publicWorkflowSnapshot } from './state/workflowProjection.js';
import { DeferredObservedTurnQueue } from './support/deferredObservedTurns.js';
import { WorkflowRefreshScheduler } from './support/workflowRefreshScheduler.js';
import { completeWorkflowHydration } from './support/observedTurnRouter.js';
import { WorkflowManualOperations } from './manualOperations.js';
import { WorkflowAutomationController } from './automation/controller.js';
import { WorkflowAutomationService } from './automation/service.js';
import { closeWorkflowManager } from './support/closeWorkflowManager.js';
import { PassiveMaterializationRecovery } from './support/passiveMaterializationRecovery.js';
import { WorkflowRecoveryCoordinator } from './recovery/workflowRecoveryCoordinator.js';
import { WorkflowNotificationService } from './attention/notificationService.js';
import { WorkflowApplyCompletionService } from './services/applyCompletionService.js';
import { WorkflowCommitService } from './services/commitService.js';
import { WorkflowContextService } from './services/contextService.js';
import { WorkflowDaemonRestartService } from './services/daemonRestartService.js';
import { WorkflowResultRepairService } from './services/resultRepairService.js';
import { WorkflowSessionService } from './services/sessionService.js';
import { WorkflowSettingsService } from './services/settingsService.js';
import { WorkflowCheckFailureService } from './services/checkFailureService.js';
import { WorkflowApplyVerifiedService } from './services/applyVerifiedService.js';
import { WorkflowCommandCoordinator } from './services/commandCoordinator.js';
import { WorkflowResponseProcessor } from './services/responseProcessor.js';
import { WorkflowRuntimeCoordinator } from './services/runtimeCoordinator.js';
import { WorkflowRemoteTransportService } from './services/remoteTransportService.js';
import { executeWorkflowEffect } from './state/workflowEffects.js';
import { WorkflowEffectKind, WorkflowEventType, WorkflowLifecycle, WorkflowPhase, WorkflowRunKind, createWorkflowState, isWorkflowActive, reduceWorkflowState } from './state/workflowState.js';
const automationRunActive = (state) => state?.run?.kind === WorkflowRunKind.AUTOMATION && isWorkflowActive(state);
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
    this.transitionQueues = new Map();
    this.refreshScheduler = new WorkflowRefreshScheduler({
      bridge,
      publish: (workflowId, type, data) => this.runtimeCoordinator.publish(workflowId, type, data),
      isBusy: (workflowId) => this.queues.has(workflowId),
    });
    this.deferredTurnQueue = new DeferredObservedTurnQueue({
      enqueue: (workflowId, task) => this.runtimeCoordinator.enqueue(workflowId, task),
      processObserved: (runtime, turn, context) => this.responseProcessor.processObserved(runtime, turn, context),
      transition: (...args) => this.runtimeCoordinator.transition(...args),
      publish: (workflowId, type, data) => this.runtimeCoordinator.publish(workflowId, type, data),
      onError: (workflowId, error) => this.runtimeCoordinator.fail(workflowId, error),
    });
    this.runtimeCoordinator = new WorkflowRuntimeCoordinator({
      workflows: this.workflows,
      queues: this.queues,
      projectQueues: this.projectQueues,
      transitionQueues: this.transitionQueues,
      store: this.store,
      notificationService: this.notificationService,
      eventBus: this.eventBus,
      refreshScheduler: this.refreshScheduler,
      deferredTurnQueue: this.deferredTurnQueue,
    });
    this.passiveMaterializationRecovery = new PassiveMaterializationRecovery({
      transition: (...args) => this.runtimeCoordinator.transition(...args), persist: (runtime) => this.runtimeCoordinator.persist(runtime),
      publish: (workflowId, type, data) => this.runtimeCoordinator.publish(workflowId, type, data), refresh: (runtime) => this.refreshScheduler.sync(runtime),
      enqueueObserved: (runtime, response, context) => this.runtimeCoordinator.enqueue(runtime.id, () => this.responseProcessor.processResponse(runtime.id, response, context)),
      failRuntime: (workflowId, error) => this.runtimeCoordinator.fail(workflowId, error), acknowledgeNotification: (key) => this.notificationService.acknowledge(key),
    });
    this.unsubscribe = bridge.onObservedTurn((turn, observation = {}) => this.responseProcessor.handleObservedTurn({ ...turn, observation }));
    this.verifier = new ArtifactVerifier({ dataDir, event: (type, data) => this.runtimeCoordinator.publish('', type, data) });
    this.applier = new TransactionalApplier({ dataDir, event: (type, data) => this.runtimeCoordinator.publish('', type, data) });
    this.extensionDeployer = new ExtensionDeployer({ bridge, dataDir, event: (type, data) => this.runtimeCoordinator.publish('', type, data) });
    this.manualOperations = new WorkflowManualOperations({
      bridge,
      fileStore,
      verifier: this.verifier,
      extensionDeployer: this.extensionDeployer,
      enqueue: (workflowId, task) => this.runtimeCoordinator.enqueue(workflowId, task),
      event: (workflowId, type, data) => this.runtimeCoordinator.publish(workflowId, type, data),
      processArtifact: (runtime, response, artifact, context) => this.responseProcessor.processArtifact(runtime, response, artifact, context),
    });
    this.contextService = new WorkflowContextService({
      dataDir, fileStore, bridge, projectService: this.projectService, applier: this.applier,
      getRuntime: (workflowId) => this.workflows.get(workflowId),
      persistRuntime: (runtime) => this.runtimeCoordinator.persist(runtime),
      transition: (...args) => this.runtimeCoordinator.transition(...args),
      publish: (workflowId, type, data) => this.runtimeCoordinator.publish(workflowId, type, data),
      syncRefreshTimer: (runtime) => this.refreshScheduler.sync(runtime),
    });
    this.daemonRestartService = new WorkflowDaemonRestartService({ dataDir, restartHandler, publish: (workflowId, type, data) => this.runtimeCoordinator.publish(workflowId, type, data) });
    this.applyCompletionService = new WorkflowApplyCompletionService({
      store: this.store,
      transition: (...args) => this.runtimeCoordinator.transition(...args),
      contextService: this.contextService,
      daemonRestartService: this.daemonRestartService,
      syncRefresh: (runtime) => this.refreshScheduler.sync(runtime),
      publish: (workflowId, type, data) => this.runtimeCoordinator.publish(workflowId, type, data),
    });
    this.commitService = new WorkflowCommitService({
      bridge, fileStore, dataDir, store: this.store,
      publish: (workflowId, type, data) => this.runtimeCoordinator.publish(workflowId, type, data),
      persistRuntime: (runtime) => this.runtimeCoordinator.persist(runtime),
      transition: (...args) => this.runtimeCoordinator.transition(...args),
      completeAppliedPipeline: (runtime, state, options) => this.applyCompletionService.complete(runtime, state, options),
    });
    this.checkFailureService = new WorkflowCheckFailureService({
      applier: this.applier,
      store: this.store,
      commitService: this.commitService,
      applyCompletionService: this.applyCompletionService,
      transition: (...args) => this.runtimeCoordinator.transition(...args),
      persistRuntime: (runtime) => this.runtimeCoordinator.persist(runtime),
      persistConfig: (runtime) => this.settingsService.persist(runtime),
      publish: (workflowId, type, data) => this.runtimeCoordinator.publish(workflowId, type, data),
      runAutomation: (runtime, options) => this.automationService.run(runtime, options),
      stopWatcher: (runtime) => this.stop(runtime.id),
    });
    this.resultRepairService = new WorkflowResultRepairService({
      bridge,
      transition: (...args) => this.runtimeCoordinator.transition(...args),
      publish: (workflowId, type, data) => this.runtimeCoordinator.publish(workflowId, type, data),
      processResponse: (workflowId, response, context) => this.responseProcessor.processResponse(workflowId, response, context),
      prepareRequest: (runtime, context) => this.sessionService.prepareRequest(runtime, context),
    });
    this.sessionService = new WorkflowSessionService({
      bridge, fileStore, projectService: this.projectService, dataDir,
      publish: (workflowId, type, data) => this.runtimeCoordinator.publish(workflowId, type, data),
      persistRuntime: (runtime) => this.runtimeCoordinator.persist(runtime),
      transition: (...args) => this.runtimeCoordinator.transition(...args),
    });
    this.applyVerifiedService = new WorkflowApplyVerifiedService({
      applier: this.applier,
      extensionDeployer: this.extensionDeployer,
      commitService: this.commitService,
      checkFailureService: this.checkFailureService,
      applyCompletionService: this.applyCompletionService,
      resultRepairService: this.resultRepairService,
      store: this.store,
      transition: (...args) => this.runtimeCoordinator.transition(...args),
      publish: (workflowId, type, data) => this.runtimeCoordinator.publish(workflowId, type, data),
      refresh: (runtime) => this.refreshScheduler.sync(runtime),
    });
    this.responseProcessor = new WorkflowResponseProcessor({
      bridge,
      fileStore,
      store: this.store,
      verifier: this.verifier,
      applier: this.applier,
      resultRepairService: this.resultRepairService,
      contextService: this.contextService,
      applyVerifiedService: this.applyVerifiedService,
      refreshScheduler: this.refreshScheduler,
      deferredTurnQueue: this.deferredTurnQueue,
      passiveMaterializationRecovery: this.passiveMaterializationRecovery,
      workflows: this.workflows,
      enqueue: (workflowId, task) => this.runtimeCoordinator.enqueue(workflowId, task),
      failRuntime: (workflowId, error) => this.runtimeCoordinator.fail(workflowId, error),
      requireWorkflow: (workflowId) => this.runtimeCoordinator.require(workflowId),
      transition: (...args) => this.runtimeCoordinator.transition(...args),
      publish: (workflowId, type, data) => this.runtimeCoordinator.publish(workflowId, type, data),
    });
    this.settingsService = new WorkflowSettingsService({
      persistRuntime: (runtime) => this.runtimeCoordinator.persist(runtime),
      invalidateNotifications: () => this.notificationService.invalidateConfig(),
    });
    this.automationController = new WorkflowAutomationController({
      turnManager,
      fileStore,
      transition: (...args) => this.runtimeCoordinator.transition(...args),
      publish: (workflowId, type, data) => this.runtimeCoordinator.publish(workflowId, type, data),
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
      publish: (workflowId, type, data) => this.runtimeCoordinator.publish(workflowId, type, data),
    });
    this.recoveryCoordinator = new WorkflowRecoveryCoordinator({
      store: this.store,
      transition: (...args) => this.runtimeCoordinator.transition(...args),
      resetDeferredQueue: (runtime) => this.deferredTurnQueue.reset(runtime),
      syncRefresh: (runtime) => this.refreshScheduler.sync(runtime),
      processResponse: (...args) => this.responseProcessor.processResponse(...args),
      ensureAutomation: (runtime) => this.automationService.ensure(runtime),
    });
    this.remoteTransportService = new WorkflowRemoteTransportService({
      bridge,
      workflows: this.workflows,
      runtimeCoordinator: this.runtimeCoordinator,
      ensureAutomation: (runtime) => this.automationService.ensure(runtime),
    });
    this.commandCoordinator = new WorkflowCommandCoordinator({
      transition: (...args) => this.runtimeCoordinator.transition(...args), activate: (runtime) => this.start(runtime.id), deactivate: (runtime) => this.stop(runtime.id),
      startGuided: (runtime, options) => this.#startGuidedRun(runtime, options), runAutomation: (runtime, options) => this.automationService.run(runtime, options),
      pauseAutomation: (runtime, reason) => this.automationService.pause(runtime, reason), resumeAutomation: (runtime) => this.automationService.resume(runtime),
      stopAutomation: (runtime, reason) => this.automationService.stop(runtime, reason), restartAutomation: (runtime, options) => this.automationService.restart(runtime, options),
      restoreAutomation: (runtime) => this.automationService.restore(runtime), resumeApproved: (runtime, decision) => this.responseProcessor.resumeApproved(runtime, decision),
      ensureAutomation: (runtime) => this.automationService.ensure(runtime), getDecision: (id) => this.store.getDecision(id), setDecision: (id, value) => this.store.setDecision(id, value),
      commit: (runtime, decision) => this.commitService.approvePending(runtime, decision), skipCommit: (runtime, decision, reason) => this.commitService.skipPending(runtime, decision, reason),
      fixChecks: (runtime, decision) => this.checkFailureService.startFixLoop(runtime, decision), keepChecks: (runtime, decision) => this.checkFailureService.keepAndStop(runtime, decision),
      revertChecks: (runtime, decision) => this.checkFailureService.revert(runtime, decision), recoverSession: (runtime) => this.recoverSessionAndRestart(runtime.id),
      resyncRemoteTransport: (runtime) => this.remoteTransportService.resync(runtime),
    });
  }
  async handleRemoteStreamGap(gap = {}) { return await this.remoteTransportService.handleGap(gap); }
  async close({ timeoutMs = 30_000, cancelActiveTurns = true } = {}) {
    this.passiveMaterializationRecovery.close();
    this.deferredTurnQueue.close();
    return await closeWorkflowManager({ unsubscribe: this.unsubscribe, refreshScheduler: this.refreshScheduler, automationController: this.automationController, projectQueues: this.projectQueues, transitionQueues: this.transitionQueues, timeoutMs, cancelActiveTurns });
  }
  async restore() {
    const saved = await this.store.listWorkflows();
    const restored = [];
    for (const item of saved) {
      if (!item?.configPath) continue;
      try {
        restored.push(await this.load(item.configPath, {
          start: item.lifecycle !== WorkflowLifecycle.STOPPED,
          includeLatest: false,
          triggerAutomation: false,
          restoreSnapshot: item,
        }));
      } catch (error) {
        await this.runtimeCoordinator.publish(item.id || '', 'workflow.restore.failed', { configPath: item.configPath, message: error.message || String(error) });
      }
    }
    await this.contextService.acknowledgeRestart().catch((error) => this.runtimeCoordinator.publish('', 'workflow.daemon.restart.ack.failed', { message: error.message || String(error) }));
    return restored;
  }
  async load(configPath, { start = true, includeLatest = true, triggerAutomation = true, restoreSnapshot = null } = {}) {
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
        lifecycle: restoreSnapshot ? WorkflowLifecycle.STOPPED : (start && config.enabled ? WorkflowLifecycle.READY : WorkflowLifecycle.STOPPED),
        subscription: { enabled: restoreSnapshot ? false : Boolean(start && config.enabled && config.watch.mode !== 'off') },
        project: { id: projectIdentity.projectId, root: config.projectRoot, fingerprintSha256: projectFingerprint.fingerprintSha256 },
        binding: { clientId: config.watch.clientId || '', sessionId: config.watch.sessionId || '', epoch: (config.watch.clientId || config.watch.sessionId) ? 1 : 0 },
        git: { baseSha: initialGit.available ? initialGit.head : '' },
        queueLimit: config.execution.maxDeferredTurns,
        retryPolicy: config.execution?.retryPolicy || config.retryPolicy || {},
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
      workflowTurnSessionId: '',
      workflowTurnCount: 0,
      deferredObservedTurns: [],
      consumedResponseIdentities: new Set(),
      hydrationStatus: restoreSnapshot ? 'hydrating' : 'ready',
      startupInbox: [],
    };
    this.workflows.set(config.id, runtime);
    if (restoreSnapshot) {
      return await completeWorkflowHydration({ runtime, snapshot: restoreSnapshot,
        restore: (...args) => this.recoveryCoordinator.restore(...args), enqueue: (...args) => this.runtimeCoordinator.enqueue(...args),
        processObserved: (...args) => this.responseProcessor.processObserved(...args), syncRefresh: (item) => this.refreshScheduler.sync(item),
        publish: (...args) => this.runtimeCoordinator.publish(...args) });
    }
    await this.store.setWorkflow(config.id, publicWorkflowSnapshot(runtime));
    this.refreshScheduler.sync(runtime);
    await this.runtimeCoordinator.publish(config.id, 'workflow.loaded', { configPath: config.configPath, projectRoot: config.projectRoot, projectId: runtime.projectId, mode: config.watch.mode, lifecycle: runtime.workflowState.lifecycle, phase: runtime.workflowState.run.phase });
    if (start && config.enabled && config.projectContext.enabled && config.projectContext.syncOnStart && config.watch.sessionId) {
      this.runtimeCoordinator.enqueue(config.id, () => this.contextService.sync(runtime, { reason: 'workflow-start' })).catch((error) => this.runtimeCoordinator.publish(config.id, 'workflow.context.sync.failed', { message: error.message || String(error) }));
    }
    if (includeLatest && start && config.enabled && config.watch.includeLatest) {
      this.runtimeCoordinator.enqueue(config.id, async () => {
        try {
          const response = await this.bridge.recoverLatestResponse({ sourceClientId: config.watch.clientId || undefined, index: 1 });
          if (!config.watch.sessionId || response.session?.id === config.watch.sessionId) await this.responseProcessor.processResponse(config.id, response, { source: 'include-latest', remediationAttempt: 0 });
        } catch (error) {
          await this.runtimeCoordinator.fail(config.id, error);
        }
      });
    }
    if (triggerAutomation && start && config.enabled && config.automation.enabled && config.automation.trigger === 'on-start') {
      if (this.automationController.available()) {
        queueMicrotask(() => this.runAutomation(config.id, { trigger: 'on-start' }).catch((error) => this.runtimeCoordinator.fail(config.id, error)));
      } else {
        await this.runtimeCoordinator.publish(config.id, 'workflow.automation.unavailable', { reason: 'local-turn-manager-required' });
      }
    }
    return publicWorkflowSnapshot(runtime);
  }
  async unload(workflowId) {
    const runtime = this.workflows.get(workflowId);
    if (!runtime) return false;
    if (automationRunActive(runtime.workflowState)) await this.automationController.stop(runtime, 'workflow unloaded');
    runtime.updatedAt = nowIso();
    this.workflows.delete(workflowId);
    this.refreshScheduler.clear(workflowId);
    await this.store.removeWorkflow(workflowId);
    await this.runtimeCoordinator.publish(workflowId, 'workflow.unloaded', {});
    return true;
  }
  async start(workflowId) {
    const runtime = this.runtimeCoordinator.require(workflowId);
    runtime.boundSourceClientId = runtime.boundSourceClientId || String(runtime.config.watch.clientId || '');
    runtime.boundSessionId = runtime.boundSessionId || String(runtime.config.watch.sessionId || '');
    await this.runtimeCoordinator.transition(runtime, WorkflowEventType.ACTIVATED, {
      subscriptionEnabled: runtime.config.watch.mode !== 'off',
      clientId: runtime.boundSourceClientId,
      sessionId: runtime.boundSessionId,
    }, 'workflow.started', {
      sourceClientId: runtime.boundSourceClientId,
      sessionId: runtime.boundSessionId,
    });
    this.refreshScheduler.sync(runtime);
    if (runtime.config.projectContext.enabled && runtime.config.projectContext.syncOnStart) {
      this.runtimeCoordinator.enqueue(runtime.id, () => this.contextService.sync(runtime, { reason: 'workflow-start' })).catch((error) => this.runtimeCoordinator.publish(runtime.id, 'workflow.context.sync.failed', { message: error.message || String(error) }));
    }
    return publicWorkflowSnapshot(runtime);
  }
  async stop(workflowId, reason = 'stopped by user') {
    const runtime = this.runtimeCoordinator.require(workflowId);
    return await this.runtimeCoordinator.enqueue(runtime.id, async () => {
      if (automationRunActive(runtime.workflowState)) await this.automationController.stop(runtime, reason);
      else if (runtime.workflowState.lifecycle !== WorkflowLifecycle.STOPPED) {
        if (!runtime.workflowState.control?.stopRequested) await this.runtimeCoordinator.transition(runtime, WorkflowEventType.STOP_REQUESTED, { runId: runtime.workflowState.run.id, reason }, 'workflow.stop_requested', { reason });
        await this.runtimeCoordinator.transition(runtime, WorkflowEventType.STOPPED, { runId: runtime.workflowState.run.id, reason }, 'workflow.stopped', { reason });
      }
      this.refreshScheduler.clear(workflowId);
      return publicWorkflowSnapshot(runtime);
    });
  }
  async completeGuidedWorkflow(workflowId) {
    const runtime = this.runtimeCoordinator.require(workflowId);
    if (runtime.workflowState.lifecycle !== WorkflowLifecycle.STOPPED) await this.stop(workflowId, 'guided task completed');
    await this.runtimeCoordinator.publish(runtime.id, 'workflow.guided.completed', { message: 'The guided task was finished by the user.' });
    return publicWorkflowSnapshot(runtime);
  }
  list() { return Array.from(this.workflows.values()).map((runtime) => publicWorkflowSnapshot(runtime)); } get(workflowId) { const runtime = this.workflows.get(workflowId); return runtime ? publicWorkflowSnapshot(runtime) : null; } async processResponse(workflowId, response, context = {}) { const runtime = this.runtimeCoordinator.require(workflowId); return await this.runtimeCoordinator.enqueue(runtime.id, () => this.responseProcessor.processResponse(runtime.id, response, context)); } async assumeProjectContext(workflowId, sessionId = '') { const runtime = this.runtimeCoordinator.require(workflowId); return await this.runtimeCoordinator.enqueue(runtime.id, () => this.contextService.recordRemoteSnapshot(runtime, { session: { id: sessionId || runtime.config.watch.sessionId || runtime.boundSessionId || '' } })); } async restoreStartingState(workflowId) { const runtime = this.runtimeCoordinator.require(workflowId); return await this.runtimeCoordinator.enqueue(runtime.id, () => this.commitService.restoreStartingState(runtime)); }
  async command(workflowId, command = {}) {
    const runtime = this.runtimeCoordinator.require(workflowId);
    return await this.runtimeCoordinator.enqueue(runtime.id, () => this.commandCoordinator.execute(runtime, command));
  }
  async events(workflowId, limit = 200) { return await this.store.listEvents({ workflowId, limit }); }
  reloadGlobalConfig() { this.notificationService.invalidateConfig(); }
  async updateWorkflowSettings(workflowId, defaults = {}) { return await this.settingsService.apply(this.runtimeCoordinator.require(workflowId), defaults); }
  async verifyArtifact(workflowId, options = {}) {
    return await this.manualOperations.verify(this.runtimeCoordinator.require(workflowId), options);
  }
  async processFileResult(workflowId, options = {}) {
    return await this.manualOperations.processFileResult(this.runtimeCoordinator.require(workflowId), options);
  }
  async refreshProjectContext(workflowId, options = {}) {
    const runtime = this.runtimeCoordinator.require(workflowId);
    return await this.runtimeCoordinator.enqueue(runtime.id, () => this.contextService.sync(runtime, { reason: 'manual-refresh', ...options }));
  }
  async prepareWorkflowRequest(workflowId, options = {}) { return await this.sessionService.prepareRequest(this.runtimeCoordinator.require(workflowId), options); }
  async sendGuidedRequest(workflowId, request = {}, callbacks = {}, options = {}) {
    const runtime = this.runtimeCoordinator.require(workflowId);
    return await this.runtimeCoordinator.enqueue(runtime.id, async () => {
      if (runtime.workflowState.run.kind !== WorkflowRunKind.GUIDED || runtime.workflowState.lifecycle !== WorkflowLifecycle.RUNNING) throw new Error(`Workflow ${workflowId} has no running guided task`);
      const promptHash = createHash('sha256').update(JSON.stringify({ message: request.message || '', sessionId: request.sessionId || '', attachments: request.attachments || [] })).digest('hex');
      const effectId = `${runtime.workflowState.run.id}:prompt:guided:${promptHash.slice(0, 16)}`;
      return await executeWorkflowEffect({
        transition: (target, type, data) => this.runtimeCoordinator.transition(target, type, data),
        runtime,
        effect: { id: effectId, kind: WorkflowEffectKind.PROMPT, safe: false, idempotencyKey: effectId, preconditionsHash: promptHash },
        afterDispatch: () => this.runtimeCoordinator.transition(runtime, WorkflowEventType.PHASE_CHANGED, { runId: runtime.workflowState.run.id, phase: WorkflowPhase.WAITING_RESPONSE }),
        execute: () => this.bridge.sendRequest(request, callbacks, options),
      });
    });
  }
  async completeGuidedResponse(workflowId, response = {}) {
    const runtime = this.runtimeCoordinator.require(workflowId);
    return await this.runtimeCoordinator.enqueue(runtime.id, async () => {
      if (runtime.workflowState.run.kind !== WorkflowRunKind.GUIDED) return publicWorkflowSnapshot(runtime);
      await this.runtimeCoordinator.transition(runtime, WorkflowEventType.RUN_COMPLETED, {
        runId: runtime.workflowState.run.id,
        code: 'guided_response_completed',
        evidence: { requestId: response.requestId || response.id || '', turnKey: response.turnKey || '' },
      }, 'workflow.guided.response.completed');
      return publicWorkflowSnapshot(runtime);
    });
  }
  async runChecks(workflowId) {
    const runtime = this.runtimeCoordinator.require(workflowId);
    const commands = runtime.config.automation?.steps?.map((item) => item.command).filter(Boolean)
      || runtime.config.apply?.commands || [];
    if (!commands.length) return { ok: true, results: [], reason: 'no-checks' };
    await this.runtimeCoordinator.publish(runtime.id, 'workflow.checks.started', { commands });
    const result = await runWorkflowCommands(commands, {
      cwd: runtime.config.projectRoot,
      timeoutMs: runtime.config.apply?.timeoutMs || 20 * 60_000,
      onOutput: (stream, output) => this.runtimeCoordinator.publish(runtime.id, 'workflow.checks.output', { stream, output: boundedText(output, 4_000) }),
    });
    await this.runtimeCoordinator.publish(runtime.id, 'workflow.checks.completed', {
      ok: result.ok,
      results: result.results.map((item) => ({ command: item.command, ok: item.ok, code: item.code, durationMs: item.durationMs })),
    });
    return result;
  }
  async deployExtension(workflowId) {
    return await this.manualOperations.deployExtension(this.runtimeCoordinator.require(workflowId));
  }
  async runAutomation(workflowId, options = {}) {
    return await this.automationService.run(this.runtimeCoordinator.require(workflowId), options);
  }
  async pauseAutomation(workflowId, reason = 'paused by user') {
    return await this.automationService.pause(this.runtimeCoordinator.require(workflowId), reason);
  }
  async stopAutomation(workflowId, reason = 'stopped by user') {
    return await this.automationService.stop(this.runtimeCoordinator.require(workflowId), reason);
  }
  async resumeAutomation(workflowId) {
    return await this.automationService.resume(this.runtimeCoordinator.require(workflowId));
  }
  async discardAutomation(workflowId, reason = 'discarded by user') {
    return await this.automationService.discard(this.runtimeCoordinator.require(workflowId), reason);
  }
  async restartAutomation(workflowId, options = {}) {
    return await this.automationService.restart(this.runtimeCoordinator.require(workflowId), options);
  }
  async recoverWorkflowSession(workflowId, context = {}) { return await this.sessionService.recover(this.runtimeCoordinator.require(workflowId), context); }
  async recoverSessionAndRestart(workflowId) {
    const runtime = this.runtimeCoordinator.require(workflowId);
    const recovery = await this.sessionService.recover(runtime, {
      error: Object.assign(new Error('Session recovery requested by user'), { code: 'WORKFLOW_SESSION_EXHAUSTED' }),
      force: true,
      automationId: runtime.workflowState.run?.id || '',
      cycle: runtime.workflowState.run?.cycle || 0,
      maxCycles: runtime.workflowState.run?.maxCycles || runtime.config.automation.maxCycles,
      validation: null,
      sourceClientId: runtime.config.watch.clientId || runtime.boundSourceClientId || runtime.lastSourceClientId || '',
    });
    if (!recovery?.recovered) throw new Error('Workflow session could not be recovered');
    return await this.automationService.restart(runtime, {
      trigger: 'session-recovery',
      sessionPolicy: 'pinned',
      sessionId: recovery.sessionId,
      sourceClientId: recovery.sourceClientId,
    });
  }
  async requestResultRepair(workflowId) {
    const runtime = this.runtimeCoordinator.require(workflowId);
    return await this.runtimeCoordinator.enqueue(runtime.id, async () => {
      if (runtime.workflowState.lifecycle === WorkflowLifecycle.READY) {
        await this.runtimeCoordinator.transition(runtime, WorkflowEventType.RUN_STARTED, {
          runId: createWorkflowId('run'), kind: WorkflowRunKind.MANUAL, phase: WorkflowPhase.PROMPTING,
        }, 'workflow.result.repair.manual.started');
      }
      return await this.resultRepairService.requestManual(runtime);
    });
  }
  async #startGuidedRun(runtime, options = {}) {
    const runId = createWorkflowId('run');
    await this.runtimeCoordinator.transition(runtime, WorkflowEventType.RUN_STARTED, {
      runId,
      kind: WorkflowRunKind.GUIDED,
      phase: WorkflowPhase.CONTEXT_SYNC,
      source: { clientId: String(options.sourceClientId || runtime.workflowState.binding.clientId), sessionId: String(options.sessionId || runtime.workflowState.binding.sessionId) },
      references: { trigger: String(options.trigger || 'guided-command') },
    }, 'workflow.guided.started', { runId });
    return publicWorkflowSnapshot(runtime);
  }
}
