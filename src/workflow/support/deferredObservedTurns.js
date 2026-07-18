import { WorkflowEventType, WorkflowLifecycle } from '../state/workflowState.js';

const DEFAULT_MAX_DEFERRED_TURNS = 50;

export class DeferredObservedTurnQueue {
  constructor({ enqueue, processObserved, transition, publish, onError, maxDeferredTurns = DEFAULT_MAX_DEFERRED_TURNS } = {}) {
    this.enqueue = enqueue;
    this.processObserved = processObserved;
    this.transition = transition;
    this.publish = publish;
    this.onError = onError;
    this.maxDeferredTurns = maxDeferredTurns;
    this.closed = false;
    this.scheduled = new Set();
  }

  close() { this.closed = true; this.scheduled.clear(); }

  reset(runtime) {
    return runtime.workflowState.inputs;
  }

  async defer(runtime, turn) {
    const turnKey = String(turn?.turnKey || '');
    const inputId = String(turn?.requestId || turn?.sourceRequestId || turnKey || `observed-${Date.now()}`);
    try {
      await this.transition(runtime, WorkflowEventType.INPUT_ENQUEUED, {
        inputId,
        kind: 'observed_turn',
        deduplicationKey: turnKey || inputId,
        source: { clientId: turn?.sourceClientId || '', sessionId: turn?.sessionId || turn?.session?.id || '' },
        observedAt: turn?.observedAt || turn?.time || '',
        references: { requestId: turn?.requestId || turn?.sourceRequestId || '', turnId: turn?.turnId || '', turnKey },
        payload: turn,
      }, 'workflow.turn.deferred', { turnKey, inputId });
    } catch (error) {
      if (error.code !== 'input_duplicate') throw error;
      return { status: 'deferred', turnKey, inputId, queued: runtime.workflowState.inputs.length, duplicate: true };
    }
    return { status: 'deferred', turnKey, inputId, queued: runtime.workflowState.inputs.length, duplicate: false };
  }

  schedule(runtime) {
    if (this.closed) return false;
    if (!runtime || runtime.workflowState.lifecycle !== WorkflowLifecycle.READY) return false;
    const input = runtime.workflowState.inputs[0];
    if (!input) return false;
    const scheduledKey = `${runtime.id}:${input.id}`;
    if (this.scheduled.has(scheduledKey)) return false;
    this.scheduled.add(scheduledKey);
    this.enqueue(runtime.id, () => this.processObserved(runtime, input.payload || {}, { queuedInputId: input.id }))
      .catch((error) => this.onError(runtime.id, error))
      .finally(() => {
        this.scheduled.delete(scheduledKey);
        this.schedule(runtime);
      });
    return true;
  }
}
