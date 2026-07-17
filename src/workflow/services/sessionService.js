import { bootstrapWorkflowChat, buildWorkflowHandoff, isSessionExhaustionError } from '../session/bootstrap.js';
import { nowIso } from '../support/workflowValues.js';
import { workflowRequestEffort } from '../support/workflowIntelligence.js';

export class WorkflowSessionService {
  constructor({ bridge, fileStore, projectService, dataDir, publish, persistRuntime } = {}) {
    this.bridge = bridge;
    this.fileStore = fileStore;
    this.projectService = projectService;
    this.dataDir = dataDir;
    this.publish = publish;
    this.persistRuntime = persistRuntime;
  }

  async prepareRequest(runtime, context = {}) {
    let sessionId = String(context.sessionId || runtime.config.watch.sessionId || runtime.boundSessionId || '').trim();
    let sourceClientId = String(context.sourceClientId || runtime.config.watch.clientId || runtime.boundSourceClientId || '').trim();
    if (runtime.workflowTurnSessionId !== sessionId) {
      runtime.workflowTurnSessionId = sessionId;
      runtime.workflowTurnCount = 0;
    }
    const maxTurns = Math.max(1, Number(runtime.config.ux?.session?.maxTurns) || 40);
    if (runtime.workflowTurnCount >= maxTurns) {
      const limitError = new Error(`Workflow session turn limit reached (${maxTurns})`);
      limitError.code = 'WORKFLOW_SESSION_TURN_LIMIT';
      const recovery = await this.recover(runtime, {
        error: limitError,
        automationId: context.automationId || '',
        cycle: context.cycle || 0,
        maxCycles: context.maxCycles || runtime.config.automation?.maxCycles || 0,
        validation: context.validation || null,
        sourceClientId,
      });
      if (recovery?.attention) {
        const error = new Error('The workflow is waiting for a session recovery decision');
        error.code = 'WORKFLOW_SESSION_AWAITING_DECISION';
        throw error;
      }
      if (recovery?.recovered) {
        sessionId = recovery.sessionId;
        sourceClientId = recovery.sourceClientId || sourceClientId;
        runtime.workflowTurnSessionId = sessionId;
        runtime.workflowTurnCount = 0;
      }
    }
    runtime.workflowTurnSessionId = sessionId;
    runtime.workflowTurnCount = Math.max(0, Number(runtime.workflowTurnCount) || 0) + 1;
    await this.persistRuntime(runtime);
    return { sessionId, sourceClientId, turn: runtime.workflowTurnCount, maxTurns };
  }

  async recover(runtime, context = {}) {
    if (!context.force && !isSessionExhaustionError(context.error || {})) return null;
    const policy = runtime.config.ux?.sessionExhaustion || 'start-new-chat';
    if (policy === 'stop' && !context.force) {
      const error = new Error('The ChatGPT chat can no longer continue and the workflow recovery policy is stop');
      error.code = 'WORKFLOW_SESSION_EXHAUSTED';
      throw error;
    }
    if (policy === 'ask' && !context.force) {
      runtime.pendingSessionRecovery = {
        createdAt: nowIso(),
        automationId: context.automationId || '',
        cycle: context.cycle || 0,
        message: context.error?.message || 'The ChatGPT chat can no longer continue reliably.',
      };
      await this.persistRuntime(runtime);
      await this.publish(runtime.id, 'workflow.session.exhausted.ask', { automationId: context.automationId || '', cycle: context.cycle || 0, message: 'This ChatGPT chat can no longer continue reliably.' });
      return { recovered: false, attention: true };
    }
    if (!this.projectService) {
      const error = new Error('Automatic workflow session recovery requires ProjectService');
      error.code = 'WORKFLOW_SESSION_RECOVERY_UNAVAILABLE';
      throw error;
    }
    await this.publish(runtime.id, 'workflow.session.recovery.started', { automationId: context.automationId || '', cycle: context.cycle || 0, message: 'Starting a new ChatGPT chat and transferring the workflow context.' });
    const boot = await bootstrapWorkflowChat({
      workflow: runtime.config,
      bridge: this.bridge,
      fileStore: this.fileStore,
      projectService: this.projectService,
      dataDir: this.dataDir,
      sourceClientId: context.sourceClientId || runtime.config.watch.clientId || runtime.boundSourceClientId || runtime.lastSourceClientId || '',
    });
    const failingChecks = (context.validation?.failed || []).map((item) => `${item.command || item.name}: exit ${item.code ?? 'unknown'}`);
    await this.bridge.sendRequest({
      message: buildWorkflowHandoff({ workflow: runtime.config, automation: { status: 'recovering', cycle: context.cycle, maxCycles: context.maxCycles }, failingChecks }),
      sessionId: boot.sessionId,
      sourceClientId: boot.sourceClientId || '',
      effort: workflowRequestEffort(runtime.config),
      fullResponse: true,
    });
    runtime.config.watch.sessionId = boot.sessionId;
    runtime.config.watch.clientId = boot.sourceClientId || runtime.config.watch.clientId;
    runtime.config.automation.session = { policy: 'pinned', id: boot.sessionId };
    runtime.boundSessionId = boot.sessionId;
    runtime.boundSourceClientId = boot.sourceClientId || runtime.boundSourceClientId;
    runtime.contextSyncedSessionId = boot.sessionId;
    runtime.contextSyncFingerprint = boot.snapshotId;
    runtime.projectFingerprintSha256 = boot.snapshotId;
    runtime.pendingSessionRecovery = null;
    runtime.workflowTurnSessionId = boot.sessionId;
    runtime.workflowTurnCount = 0;
    await this.persistRuntime(runtime);
    await this.publish(runtime.id, 'workflow.session.recovery.completed', { automationId: context.automationId || '', cycle: context.cycle || 0, sessionId: boot.sessionId, sourceClientId: boot.sourceClientId || '' });
    return { recovered: true, sessionId: boot.sessionId, sourceClientId: boot.sourceClientId || '' };
  }
}
