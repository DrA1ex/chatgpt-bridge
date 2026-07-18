import { publicWorkflowSnapshot } from '../state/workflowProjection.js';
import { recoveryDecisionForWorkflow } from '../state/workflowEffects.js';
import {
  WorkflowActionKind,
  WorkflowEventType,
  WorkflowLifecycle,
  WorkflowRunKind,
  isWorkflowActive,
  restoreWorkflowState,
} from '../state/workflowState.js';
import { nowIso, workflowId as createWorkflowId } from '../support/workflowValues.js';

export class WorkflowRecoveryCoordinator {
  constructor({ store, transition, resetDeferredQueue, syncRefresh, processResponse, ensureAutomation } = {}) {
    this.store = store;
    this.transition = transition;
    this.resetDeferredQueue = resetDeferredQueue;
    this.syncRefresh = syncRefresh;
    this.processResponse = processResponse;
    this.ensureAutomation = ensureAutomation;
  }

  async restore(runtime, saved) {
    runtime.workflowState = restoreWorkflowState(saved, { updatedAt: saved.updatedAt || nowIso() });
    const interrupted = isWorkflowActive(runtime.workflowState) && Boolean(runtime.workflowState.run.id);
    runtime.boundSourceClientId = runtime.workflowState.binding.clientId;
    runtime.boundSessionId = runtime.workflowState.binding.sessionId;
    runtime.lastPipelineId = runtime.workflowState.run.id;
    runtime.lastError = runtime.workflowState.lastOutcome?.message || '';
    runtime.projectId = runtime.workflowState.project.id;
    runtime.projectFingerprintSha256 = runtime.workflowState.project.fingerprintSha256;
    this.resetDeferredQueue(runtime);
    runtime.consumedResponseIdentities = new Set();
    if (runtime.lastObservedTurnKey) runtime.consumedResponseIdentities.add(`turn:${runtime.lastObservedTurnKey}`);
    runtime.updatedAt = nowIso();
    await this.store.setWorkflow(runtime.id, publicWorkflowSnapshot(runtime));
    if (interrupted) await this.#recoverActiveRun(runtime);
    this.syncRefresh(runtime);
    if (interrupted && runtime.workflowState.lifecycle === WorkflowLifecycle.RUNNING && runtime.workflowState.run.references?.inputPayload) {
      await this.processResponse(runtime.id, runtime.workflowState.run.references.inputPayload, {
        source: 'restart-recovery',
        runId: runtime.workflowState.run.id,
      });
    }
    if (interrupted && runtime.workflowState.run.kind === WorkflowRunKind.AUTOMATION && runtime.workflowState.lifecycle === WorkflowLifecycle.RUNNING) {
      await this.ensureAutomation(runtime);
    }
    return publicWorkflowSnapshot(runtime);
  }

  async #recoverActiveRun(runtime) {
    const runId = runtime.workflowState.run.id;
    const pendingAction = runtime.workflowState.nextAction ? structuredClone(runtime.workflowState.nextAction) : null;
    await this.transition(runtime, WorkflowEventType.RECOVERY_STARTED, { runId }, 'workflow.recovery.started');
    if (pendingAction) {
      await this.transition(runtime, WorkflowEventType.ACTION_REQUIRED, {
        ...pendingAction,
        actionId: pendingAction.id,
        runId,
      }, 'workflow.action.restored', { actionId: pendingAction.id });
      return;
    }
    if (runtime.workflowState.run.kind === WorkflowRunKind.AUTOMATION) {
      const restartPolicy = runtime.config.automation.restartPolicy || 'ask';
      if (restartPolicy === 'discard') {
        await this.transition(runtime, WorkflowEventType.STOPPED, {
          runId,
          reason: 'discarded after daemon restart',
        }, 'workflow.automation.stopped', { automationId: runId, reason: 'discarded after daemon restart' });
        return;
      }
      if (restartPolicy !== 'auto') {
        await this.#requireAction(runtime, {
          reason: 'An automation run was interrupted by daemon restart. Confirm whether it should resume.',
          references: { runId, restartPolicy },
        });
        return;
      }
    }
    const recovery = recoveryDecisionForWorkflow(runtime.workflowState);
    const inputPayload = runtime.workflowState.run.references?.inputPayload || null;
    if (recovery.automatic && (runtime.workflowState.run.kind === WorkflowRunKind.AUTOMATION || inputPayload)) {
      for (const effectId of recovery.effectIds || []) {
        const effect = runtime.workflowState.effects[effectId];
        if (effect?.status === 'planned') continue;
        await this.transition(runtime, WorkflowEventType.EFFECT_RETRY_PLANNED, {
          runId,
          effectId,
          idempotencyKey: effect.idempotencyKey,
          preconditionsHash: effect.preconditionsHash,
        }, 'workflow.effect.retry.planned', { effectId });
      }
      await this.transition(runtime, WorkflowEventType.RECOVERY_RESUMED, { runId }, 'workflow.recovery.resumed');
      return;
    }
    if (recovery.automatic) {
      await this.#requireAction(runtime, {
        reason: 'The observed response must be supplied again after restart before processing can safely continue.',
        references: { runId },
        retryLabel: 'Retry observed input',
      });
      return;
    }
    await this.transition(runtime, WorkflowEventType.ACTION_REQUIRED, {
      ...recovery.action,
      runId,
      actionId: createWorkflowId('recovery-action'),
    }, 'workflow.recovery.required');
  }

  async #requireAction(runtime, { reason, references, retryLabel = 'Resume automation' }) {
    await this.transition(runtime, WorkflowEventType.ACTION_REQUIRED, {
      runId: runtime.workflowState.run.id,
      actionId: createWorkflowId('recovery-action'),
      kind: WorkflowActionKind.RECOVERY,
      reason,
      choices: [
        { id: 'retry', label: retryLabel, transition: 'recover' },
        { id: 'stop', label: 'Stop workflow', transition: 'stop' },
      ],
      references,
    }, 'workflow.recovery.required');
  }
}
