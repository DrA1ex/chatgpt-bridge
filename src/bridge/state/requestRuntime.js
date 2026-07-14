import { legacyRequestEventToCanonical } from '../adapters/legacyProgressAdapter.js';
import { EntityStore } from '../store/entityStore.js';
import { reduceRequestState } from './requestMachine.js';
import { compactCanonicalRequestState, compatibilityPhaseForState } from './requestProjection.js';

const COMPATIBLE_PHASE_ALIASES = new Map([
  ['finalizing', new Set(['post_stop_settle'])],
  ['final_snapshot_ready', new Set(['post_stop_settle', 'completed'])],
  ['resumed', new Set(['waiting_for_assistant_turn'])],
  ['reattached', new Set(['waiting_for_assistant_turn', 'generating', 'post_stop_settle', 'artifact_settle'])],
]);

function phasesCompatible(legacyPhase, canonicalPhase) {
  if (!legacyPhase || !canonicalPhase || legacyPhase === canonicalPhase) return true;
  return COMPATIBLE_PHASE_ALIASES.get(legacyPhase)?.has(canonicalPhase) || false;
}

export class CanonicalRequestState {
  #eventBus;
  #store;
  #completed = [];
  #diagnosticKeys = new Set();
  #diagnosticOrder = [];
  #retainedCompleted;

  constructor(options = {}) {
    this.#eventBus = options.eventBus || null;
    this.#store = options.store || new EntityStore({
      reducer: reduceRequestState,
      historyLimit: options.historyLimit || 100,
    });
    this.#retainedCompleted = Math.max(10, Number(options.retainedCompleted) || 100);
  }

  get store() {
    return this.#store;
  }

  ingestLegacyEvent(requestId, legacyEvent, legacyState = null) {
    const event = legacyRequestEventToCanonical(requestId, legacyEvent);
    if (!event) return null;
    return this.transition(requestId, event, legacyState);
  }

  transition(requestId, event, legacyState = null) {
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

    const canonicalPhase = compatibilityPhaseForState(outcome.state);
    const legacyPhase = String(legacyState?.progress?.phase || legacyEventPhase(event) || '');
    if (event.type === 'legacy.progress' && !phasesCompatible(legacyPhase, canonicalPhase)) {
      const key = `${requestId}:divergence:${legacyPhase}:${canonicalPhase}`;
      if (this.#rememberDiagnostic(key)) {
        this.#eventBus?.emitDebug({
          type: 'request.state.compatibility_divergence',
          requestId,
          data: {
            legacyPhase,
            canonicalPhase,
            lifecycle: outcome.state.lifecycle,
            revision: outcome.state.revision,
            eventType: event.type,
            diagnostics: outcome.diagnostics || [],
          },
        });
      }
    }

    if (outcome.state.terminal) this.#retainCompleted(requestId);
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

  #retainCompleted(requestId) {
    if (this.#completed.includes(requestId)) return;
    this.#completed.push(requestId);
    while (this.#completed.length > this.#retainedCompleted) {
      const evicted = this.#completed.shift();
      this.#store.delete(evicted);
    }
  }
}

function legacyEventPhase(event = {}) {
  return String(event.data?.phase || event.data?.status || '');
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
    compatibilityPhase: entry.state ? compatibilityPhaseForState(entry.state) : '',
    terminal: entry.state?.terminal || null,
    effects: entry.effects || [],
    deadlines: entry.deadlines || [],
    diagnostics: entry.diagnostics || [],
  };
}
