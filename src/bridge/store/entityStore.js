import { TransitionJournal } from './transitionJournal.js';
import { waitForState } from './waitForState.js';

function committedState(previous, next, event) {
  const revision = (Number(previous?.revision) || 0) + 1;
  const transitionedAt = Number(event.receivedAt || event.occurredAt) || 0;
  return {
    ...next,
    revision,
    timestamps: next?.timestamps ? {
      ...next.timestamps,
      transitionedAt,
    } : undefined,
  };
}

export class EntityStore {
  #reducer;
  #states = new Map();
  #listeners = new Map();
  #journal;

  constructor(options = {}) {
    if (typeof options.reducer !== 'function') throw new TypeError('EntityStore requires a reducer');
    this.#reducer = options.reducer;
    this.#journal = options.journal || new TransitionJournal({ limit: options.historyLimit });
  }

  get(entityId) {
    return this.#states.get(String(entityId || '')) || null;
  }

  has(entityId) {
    return this.#states.has(String(entityId || ''));
  }

  entityIds() {
    return Array.from(this.#states.keys());
  }

  transition(entityId, event) {
    const id = String(entityId || event?.entityId || '');
    if (!id) throw new TypeError('EntityStore.transition requires an entityId');
    const previousState = this.get(id);
    const outcome = this.#reducer(previousState, event);
    if (!outcome?.accepted || !outcome.state) {
      return { ...outcome, previousState, state: outcome?.state || previousState };
    }

    const state = committedState(previousState, outcome.state, event);
    const committed = { ...outcome, previousState, state, event };
    this.#states.set(id, state);
    this.#journal.append(id, {
      revision: state.revision,
      event,
      state,
      effects: outcome.effects || [],
      deadlines: outcome.deadlines || [],
      diagnostics: outcome.diagnostics || [],
    });

    const listeners = Array.from(this.#listeners.get(id) || []);
    for (const listener of listeners) listener(committed);
    return committed;
  }

  subscribe(entityId, listener) {
    const id = String(entityId || '');
    if (!id) throw new TypeError('EntityStore.subscribe requires an entityId');
    if (typeof listener !== 'function') throw new TypeError('EntityStore.subscribe requires a listener');
    const listeners = this.#listeners.get(id) || new Set();
    listeners.add(listener);
    this.#listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(id);
    };
  }

  history(entityId, limit = 100) {
    return this.#journal.recent(entityId, limit);
  }

  waitFor(entityId, options = {}) {
    return waitForState(this, entityId, options);
  }

  delete(entityId) {
    const id = String(entityId || '');
    this.#states.delete(id);
    this.#listeners.delete(id);
    this.#journal.clear(id);
  }
}
