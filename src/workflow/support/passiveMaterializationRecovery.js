import { isRetryableArtifactMaterializationError } from './materializationFailure.js';
import {
  WorkflowActionKind,
  WorkflowEventType,
  WorkflowLifecycle,
} from '../state/workflowState.js';

export class PassiveMaterializationRecovery {
  constructor({ transition, persist, publish, refresh, enqueueObserved, failRuntime, acknowledgeNotification } = {}) {
    this.transition = transition;
    this.persist = persist;
    this.publish = publish;
    this.refresh = refresh;
    this.enqueueObserved = enqueueObserved;
    this.failRuntime = failRuntime;
    this.acknowledgeNotification = acknowledgeNotification;
    this.retryTimers = new Set();
  }

  close() {
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  canDefer(error, context = {}) {
    return String(context.source || '').startsWith('passive-observer')
      && isRetryableArtifactMaterializationError(error);
  }

  async defer(runtime, response, error, context = {}) {
    const pipelineId = runtime.workflowState?.run?.id || runtime.lastPipelineId || '';
    const attempt = Math.max(0, Number(context.materializationAttempt) || 0);
    const message = error?.message || String(error);
    runtime.lastError = '';
    if (pipelineId && runtime.workflowState.lifecycle === WorkflowLifecycle.RUNNING) {
      await this.transition(runtime, WorkflowEventType.RECOVERY_STARTED, {
        runId: pipelineId,
      }, 'workflow.artifact.materialization.deferred', {
        pipelineId,
        message,
        attempt,
        willRetry: attempt < 1,
      });
    } else {
      await this.persist(runtime);
      await this.publish(runtime.id, 'workflow.artifact.materialization.deferred', { pipelineId, message, attempt, willRetry: attempt < 1 });
    }
    this.refresh(runtime);
    if (attempt < 1 && runtime.workflowState?.lifecycle === WorkflowLifecycle.RECOVERING) {
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        const effect = Object.values(runtime.workflowState.effects || {}).find((item) => item.runId === pipelineId && item.kind === 'download' && item.status === 'failed');
        const prepare = effect
          ? this.transition(runtime, WorkflowEventType.EFFECT_RETRY_PLANNED, { runId: pipelineId, effectId: effect.id, idempotencyKey: effect.idempotencyKey, preconditionsHash: effect.preconditionsHash }, 'workflow.effect.retry.planned', { effectId: effect.id })
          : Promise.resolve();
        prepare.then(() => this.transition(runtime, WorkflowEventType.RECOVERY_RESUMED, { runId: pipelineId }, 'workflow.recovery.resumed'))
          .then(() => this.enqueueObserved(runtime, response, { source: 'passive-observer', materializationAttempt: attempt + 1, runId: pipelineId }))
          .catch((retryError) => this.failRuntime(runtime.id, retryError));
      }, 1_500);
      this.retryTimers.add(timer);
      timer.unref?.();
    } else if (runtime.workflowState?.lifecycle === WorkflowLifecycle.RECOVERING) {
      await this.transition(runtime, WorkflowEventType.ACTION_REQUIRED, {
        runId: pipelineId,
        actionId: `materialization-${pipelineId}-${attempt}`,
        kind: WorkflowActionKind.RECOVERY,
        reason: message,
        choices: [
          { id: 'retry', label: 'Retry artifact download', transition: 'recover' },
          { id: 'stop', label: 'Stop workflow', transition: 'stop' },
        ],
        safeContinuation: 'Retry reuses the same observed turn without writing project files.',
      }, 'workflow.recovery.required');
    }
    return { status: 'materialization-deferred', retrying: attempt < 1, message };
  }
}
