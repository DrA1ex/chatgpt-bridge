import { createHash } from 'node:crypto';
import { bootstrapWorkflowChat, buildWorkflowHandoff, isSessionExhaustionError } from '../session/bootstrap.js';
import { workflowId as createWorkflowId } from '../support/workflowValues.js';
import { workflowRequestEffort } from '../support/workflowIntelligence.js';
import { workflowBinding, workflowSessionId, workflowSourceClientId } from '../support/workflowBinding.js';
import { WorkflowActionKind, WorkflowEffectKind, WorkflowEventType, WorkflowLocalEffectKind } from '../state/workflowState.js';
import { executeWorkflowEffect } from '../state/workflowEffects.js';
import { executeLocalEffect } from '../state/localEffects.js';

export class WorkflowSessionService {
  constructor({ bridge, fileStore, projectService, dataDir, publish, persistRuntime, transition } = {}) {
    this.bridge = bridge;
    this.fileStore = fileStore;
    this.projectService = projectService;
    this.dataDir = dataDir;
    this.publish = publish;
    this.persistRuntime = persistRuntime;
    this.transition = transition;
  }

  async prepareRequest(runtime, context = {}) {
    let sessionId = workflowSessionId(runtime, context.sessionId, { allowLast: false }).trim();
    let sourceClientId = workflowSourceClientId(runtime, context.sourceClientId, { allowLast: false }).trim();
    const runReferences = runtime.workflowState.run?.references || {};
    let workflowTurnCount = runReferences.workflowTurnSessionId === sessionId ? Math.max(0, Number(runReferences.workflowTurnCount) || 0) : 0;
    const maxTurns = Math.max(1, Number(runtime.config.ux?.session?.maxTurns) || 40);
    if (workflowTurnCount >= maxTurns) {
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
      if (recovery?.waitingAction) {
        const error = new Error('The workflow is waiting for a session recovery decision');
        error.code = 'WORKFLOW_SESSION_AWAITING_DECISION';
        throw error;
      }
      if (recovery?.recovered) {
        sessionId = recovery.sessionId;
        sourceClientId = recovery.sourceClientId || sourceClientId;
        workflowTurnCount = 0;
      }
    }
    workflowTurnCount += 1;
    if (runtime.workflowState.run?.id && runtime.workflowState.lifecycle === 'running') {
      await this.transition(runtime, WorkflowEventType.PHASE_CHANGED, {
        runId: runtime.workflowState.run.id,
        phase: runtime.workflowState.run.phase,
        references: { workflowTurnSessionId: sessionId, workflowTurnCount },
      });
    }
    return { sessionId, sourceClientId, turn: workflowTurnCount, maxTurns };
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
      if (typeof this.transition !== 'function') throw new Error('Workflow session recovery requires a state transition callback');
      await this.transition(runtime, WorkflowEventType.ACTION_REQUIRED, {
        runId: runtime.workflowState.run.id,
        actionId: createWorkflowId('session-action'),
        kind: WorkflowActionKind.SESSION_RECOVERY,
        reason: context.error?.message || 'The ChatGPT chat can no longer continue reliably.',
        choices: [
          { id: 'recover', label: 'Start a new chat and transfer context', transition: 'continue' },
          { id: 'stop', label: 'Stop workflow', transition: 'stop' },
        ],
        references: { cycle: context.cycle || 0, automationId: context.automationId || '' },
      }, 'workflow.session.recovery.required', { cycle: context.cycle || 0 });
      return { recovered: false, waitingAction: true };
    }
    if (!this.projectService) {
      const error = new Error('Automatic workflow session recovery requires ProjectService');
      error.code = 'WORKFLOW_SESSION_RECOVERY_UNAVAILABLE';
      throw error;
    }
    await this.publish(runtime.id, 'workflow.session.recovery.started', { automationId: context.automationId || '', cycle: context.cycle || 0, message: 'Starting a new ChatGPT chat and transferring the workflow context.' });
    const oldBinding = workflowBinding(runtime);
    const handoffPreconditionsHash = createHash('sha256').update(JSON.stringify({
      workflowId: runtime.id,
      runId: runtime.workflowState.run?.id || '',
      bindingEpoch: oldBinding.epoch,
      sessionId: oldBinding.sessionId,
      sourceClientId: workflowSourceClientId(runtime, context.sourceClientId),
      cycle: context.cycle || 0,
      maxCycles: context.maxCycles || 0,
    })).digest('hex');
    const handoffEffectId = `${runtime.workflowState.run.id}:session-handoff:${oldBinding.epoch}:${handoffPreconditionsHash.slice(0, 16)}`;
    const snapshotEffectId = `${runtime.workflowState.run.id}:project-snapshot:session-handoff:${handoffPreconditionsHash.slice(0, 16)}`;
    const projectPack = await executeLocalEffect({
      transition: this.transition,
      runtime,
      effect: {
        id: snapshotEffectId,
        kind: WorkflowLocalEffectKind.PROJECT_SNAPSHOT,
        safe: true,
        idempotencyKey: `${runtime.workflowState.run.id}:project-snapshot:session-handoff:${oldBinding.epoch}`,
        preconditionsHash: handoffPreconditionsHash,
        references: { projectRoot: runtime.config.projectRoot, purpose: 'session-handoff' },
      },
      execute: async () => await this.projectService.pack(runtime.config.projectRoot, {
        force: true,
        snapshotPolicy: 'always',
        useGitignore: true,
      }),
    });
    const boot = await executeWorkflowEffect({
      transition: this.transition,
      runtime,
      effect: {
        id: handoffEffectId,
        kind: WorkflowEffectKind.SESSION_HANDOFF,
        safe: false,
        idempotencyKey: `${runtime.workflowState.run.id}:session-handoff:${oldBinding.epoch}`,
        preconditionsHash: handoffPreconditionsHash,
        references: {
          fromBindingEpoch: oldBinding.epoch,
          fromSessionId: oldBinding.sessionId,
          cycle: context.cycle || 0,
        },
      },
      execute: async () => {
        const created = await bootstrapWorkflowChat({
          workflow: runtime.config,
          bridge: this.bridge,
          fileStore: this.fileStore,
          projectService: this.projectService,
          projectPack,
          dataDir: this.dataDir,
          sourceClientId: workflowSourceClientId(runtime, context.sourceClientId),
        });
        const failingChecks = (context.validation?.failed || []).map((item) => `${item.command || item.name}: exit ${item.code ?? 'unknown'}`);
        const response = await this.bridge.sendRequest({
          message: buildWorkflowHandoff({ workflow: runtime.config, automation: { status: 'recovering', cycle: context.cycle, maxCycles: context.maxCycles }, failingChecks }),
          sessionId: created.sessionId,
          sourceClientId: created.sourceClientId || '',
          effort: workflowRequestEffort(runtime.config),
          fullResponse: true,
        });
        return {
          sessionId: created.sessionId,
          sourceClientId: created.sourceClientId || response.sourceClientId || '',
          snapshotId: created.snapshotId,
          projectFileId: created.projectFileId,
          handoffRequestId: response.requestId || '',
        };
      },
    });
    const nextSourceClientId = String(boot.sourceClientId || workflowBinding(runtime).clientId || '');
    if (typeof this.transition === 'function') {
      await this.transition(runtime, WorkflowEventType.BINDING_CHANGED, {
        clientId: nextSourceClientId,
        sessionId: boot.sessionId,
        preserveInputs: false,
        reason: 'session-recovery',
      }, 'workflow.binding.changed', {
        previousEpoch: runtime.workflowState.binding.epoch,
        sessionId: boot.sessionId,
        sourceClientId: nextSourceClientId,
        reason: 'session-recovery',
      });
    }
    runtime.contextSyncedSessionId = boot.sessionId;
    runtime.contextSyncFingerprint = boot.snapshotId;
    runtime.projectFingerprintSha256 = boot.snapshotId;
    if (typeof this.transition === 'function' && runtime.workflowState?.run?.id) {
      await this.transition(runtime, WorkflowEventType.PHASE_CHANGED, {
        runId: runtime.workflowState.run.id,
        phase: runtime.workflowState.run.phase,
        references: { workflowTurnSessionId: boot.sessionId, workflowTurnCount: 0, bindingEpoch: runtime.workflowState.binding.epoch },
      });
    } else await this.persistRuntime(runtime);
    await this.publish(runtime.id, 'workflow.session.recovery.completed', { automationId: context.automationId || '', cycle: context.cycle || 0, sessionId: boot.sessionId, sourceClientId: boot.sourceClientId || '' });
    return { recovered: true, sessionId: boot.sessionId, sourceClientId: boot.sourceClientId || '' };
  }
}
