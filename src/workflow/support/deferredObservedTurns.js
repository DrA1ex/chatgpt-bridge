import { isWorkflowPipelineActive } from '../state/workflowState.js';

const DEFAULT_MAX_DEFERRED_TURNS = 50;

export class DeferredObservedTurnQueue {
  constructor({ enqueue, processObserved, publish, onError, maxDeferredTurns = DEFAULT_MAX_DEFERRED_TURNS } = {}) {
    this.enqueue = enqueue;
    this.processObserved = processObserved;
    this.publish = publish;
    this.onError = onError;
    this.maxDeferredTurns = maxDeferredTurns;
  }

  reset(runtime) {
    runtime.deferredObservedTurns = [];
    return runtime.deferredObservedTurns;
  }

  async defer(runtime, turn) {
    const turnKey = String(turn?.turnKey || '');
    const pending = Array.isArray(runtime.deferredObservedTurns) ? runtime.deferredObservedTurns : [];
    runtime.deferredObservedTurns = pending;
    const duplicate = pending.some((item) => turnKey && String(item?.turnKey || '') === turnKey);
    if (!duplicate) {
      pending.push(turn);
      while (pending.length > this.maxDeferredTurns) pending.shift();
    }
    const pipelineId = runtime.workflowState?.pipeline?.id || '';
    const pipelineStatus = runtime.workflowState?.pipeline?.status || '';
    await this.publish?.(runtime.id, 'workflow.turn.deferred', {
      turnKey,
      pipelineId,
      pipelineStatus,
      queued: pending.length,
      duplicate,
    });
    return { status: 'deferred', turnKey, pipelineId, queued: pending.length, duplicate };
  }

  schedule(runtime) {
    if (!runtime || isWorkflowPipelineActive(runtime.workflowState)) return false;
    const pending = Array.isArray(runtime.deferredObservedTurns) ? runtime.deferredObservedTurns : [];
    if (!pending.length) return false;
    const turn = pending.shift();
    this.enqueue(runtime.id, () => this.processObserved(runtime, turn))
      .then(() => this.schedule(runtime))
      .catch((error) => this.onError(runtime.id, error));
    return true;
  }
}
