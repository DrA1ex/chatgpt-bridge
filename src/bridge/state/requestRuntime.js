import { EntityStore } from '../store/entityStore.js';
import { TransitionJournal } from '../store/transitionJournal.js';
import { retainedSize } from '../../events/retainedSize.js';
import { reduceRequestState } from './requestMachine.js';
import { compactCanonicalRequestState, displayPhaseForState } from './requestView.js';

export class CanonicalRequestState {
  #eventBus;
  #store;
  #completed = new Map();
  #completedBytes = 0;
  #diagnosticKeys = new Set();
  #diagnosticOrder = [];
  #retainedCompleted;
  #maxCompletedBytes;

  constructor(options = {}) {
    this.#eventBus = options.eventBus || null;
    this.#store = options.store || new EntityStore({
      reducer: reduceRequestState,
      journal: new TransitionJournal({
        limit: options.historyLimit || 100,
        maxBytes: options.historyBytes ?? (32 * 1024 * 1024),
      }),
    });
    this.#retainedCompleted = Math.max(10, Number(options.retainedCompleted) || 100);
    this.#maxCompletedBytes = options.completedBytes ?? (16 * 1024 * 1024);
  }

  get store() {
    return this.#store;
  }


  transition(requestId, event) {
    const outcome = this.#store.transition(requestId, event);
    if (!outcome.accepted) {
      const diagnosticCode = outcome.diagnostics?.[0]?.code || 'rejected';
      if (this.#rememberDiagnostic(`${requestId}:rejected:${event.type}:${diagnosticCode}`)) {
        this.#eventBus?.emitDebug({
          type: 'request.state.event_rejected',
          requestId,
          data: {
            eventType: event.type,
            diagnostics: outcome.diagnostics || [],
            revision: outcome.state?.revision || 0,
          },
        });
      }
      return outcome;
    }

    if (outcome.state.terminal) this.#retainCompleted(requestId, outcome.state);
    return outcome;
  }

  snapshot(requestId) {
    return compactCanonicalRequestState(this.#store.get(requestId));
  }

  diagnostics(requestId = '') {
    if (requestId) {
      return {
        state: this.snapshot(requestId),
        history: this.#store.history(requestId, 50).map(compactHistoryEntry),
      };
    }
    return this.#store.entityIds().map((id) => ({
      requestId: id,
      state: this.snapshot(id),
      transitionCount: this.#store.history(id, this.#retainedCompleted + 1000).length,
    }));
  }

  #rememberDiagnostic(key) {
    if (this.#diagnosticKeys.has(key)) return false;
    this.#diagnosticKeys.add(key);
    this.#diagnosticOrder.push(key);
    while (this.#diagnosticOrder.length > 500) {
      this.#diagnosticKeys.delete(this.#diagnosticOrder.shift());
    }
    return true;
  }

  #retainCompleted(requestId, state) {
    if (this.#completed.has(requestId)) return;
    const size = retainedSize(state, this.#maxCompletedBytes);
    this.#completed.set(requestId, size);
    this.#completedBytes += size;
    // Keep the latest terminal state available for release and diagnostics.
    while (this.#completed.size > this.#retainedCompleted
      || (this.#completedBytes > this.#maxCompletedBytes && this.#completed.size > 1)) {
      const [evicted, bytes] = this.#completed.entries().next().value;
      this.#completed.delete(evicted);
      this.#completedBytes -= bytes;
      this.#store.delete(evicted);
    }
  }
}


function compactHistoryEntry(entry = {}) {
  return {
    revision: entry.revision,
    event: {
      eventId: entry.event?.eventId || '',
      type: entry.event?.type || '',
      source: entry.event?.source || '',
      sourceSequence: entry.event?.sourceSequence ?? null,
      occurredAt: entry.event?.occurredAt || 0,
      data: entry.event?.data || {},
    },
    lifecycle: entry.state?.lifecycle || '',
    displayPhase: entry.state ? displayPhaseForState(entry.state) : '',
    terminal: entry.state?.terminal || null,
    effects: entry.effects || [],
    deadlines: entry.deadlines || [],
    diagnostics: entry.diagnostics || [],
  };
}
