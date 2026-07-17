import { isRetryableArtifactMaterializationError } from './materializationFailure.js';
import {
  WorkflowStateEventType,
  WorkflowWatcherStatus,
  isWorkflowPipelineActive,
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

  clearStaleAttention(runtime) {
    if (!runtime?.attention?.required) return false;
    if (runtime.workflowState?.watcher?.status !== WorkflowWatcherStatus.RUNNING) return false;
    if (!isRetryableArtifactMaterializationError(runtime.attention.message || runtime.lastError)) return false;
    this.acknowledgeNotification?.(runtime.attention.key || '');
    runtime.attention = null;
    runtime.lastError = '';
    return true;
  }

  async defer(runtime, response, error, context = {}) {
    const pipelineId = runtime.workflowState?.pipeline?.id || runtime.lastPipelineId || '';
    const attempt = Math.max(0, Number(context.materializationAttempt) || 0);
    const message = error?.message || String(error);
    runtime.lastError = '';
    this.clearStaleAttention(runtime);
    if (pipelineId && isWorkflowPipelineActive(runtime.workflowState)) {
      await this.transition(runtime, WorkflowStateEventType.PIPELINE_FAILED, {
        pipelineId,
        code: 'artifact_materialization_deferred',
        message,
        evidence: { retryable: true, attempt, source: context.source || 'passive-observer' },
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
    if (attempt < 1 && runtime.workflowState?.watcher?.status === WorkflowWatcherStatus.RUNNING) {
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        this.enqueueObserved(runtime, response, {
          source: 'passive-observer',
          materializationAttempt: attempt + 1,
        }).catch((retryError) => this.failRuntime(runtime.id, retryError));
      }, 1_500);
      this.retryTimers.add(timer);
      timer.unref?.();
    }
    return { status: 'materialization-deferred', retrying: attempt < 1, message };
  }
}
