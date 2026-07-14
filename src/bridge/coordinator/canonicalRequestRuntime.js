import { RequestDeadlineCoordinator } from '../deadlines/requestDeadlineCoordinator.js';

export class CanonicalRequestRuntime {
  #executeEffect;
  #onTerminal;
  #onDeadlineScheduled;
  #onDeadlineSuperseded;
  #onError;
  #deadlineCoordinator;
  #terminalRevisions = new Map();

  constructor(options = {}) {
    if (typeof options.dispatch !== 'function') {
      throw new TypeError('CanonicalRequestRuntime requires a dispatch callback');
    }
    if (typeof options.executeEffect !== 'function') {
      throw new TypeError('CanonicalRequestRuntime requires an executeEffect callback');
    }
    if (typeof options.onTerminal !== 'function') {
      throw new TypeError('CanonicalRequestRuntime requires an onTerminal callback');
    }
    this.#executeEffect = options.executeEffect;
    this.#onTerminal = options.onTerminal;
    this.#onDeadlineScheduled = typeof options.onDeadlineScheduled === 'function'
      ? options.onDeadlineScheduled
      : null;
    this.#onDeadlineSuperseded = typeof options.onDeadlineSuperseded === 'function'
      ? options.onDeadlineSuperseded
      : null;
    this.#onError = typeof options.onError === 'function' ? options.onError : null;
    this.#deadlineCoordinator = options.deadlineCoordinator || new RequestDeadlineCoordinator({
      dispatch: options.dispatch,
      policy: options.deadlinePolicy || {},
      now: options.now,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
      onScheduled: (requestId, intent) => this.#onDeadlineScheduled?.(requestId, intent),
      onSuperseded: (requestId, intent, reason) => this.#onDeadlineSuperseded?.(requestId, intent, reason),
      onError: (error, details) => this.#handleError(error, details),
    });
  }

  accept(runtimeState, outcome) {
    if (!runtimeState || !outcome?.accepted || !outcome.state) return;
    const requestId = String(outcome.state.requestId || runtimeState.requestId || '');
    this.#deadlineCoordinator.sync(requestId, outcome.state, outcome.deadlines || []);
    const effects = Array.isArray(outcome.effects) ? outcome.effects : [];

    if (!outcome.state.terminal) {
      for (const effect of effects) {
        queueMicrotask(() => {
          if (runtimeState.done) return;
          Promise.resolve(this.#executeEffect(runtimeState, effect, outcome))
            .catch((error) => this.#handleError(error, { requestId, effect }));
        });
      }
      return;
    }

    const revision = Number(outcome.state.revision) || 0;
    if ((this.#terminalRevisions.get(requestId) || -1) >= revision) return;
    this.#terminalRevisions.set(requestId, revision);
    queueMicrotask(async () => {
      if (runtimeState.done) return;
      for (const effect of effects) {
        try {
          await this.#executeEffect(runtimeState, effect, outcome);
        } catch (error) {
          this.#handleError(error, { requestId, effect, terminalCleanup: true });
        }
      }
      if (runtimeState.done) return;
      try {
        await this.#onTerminal(runtimeState, outcome.state, outcome);
      } catch (error) {
        this.#handleError(error, { requestId, terminal: outcome.state.terminal });
      }
    });
  }

  deadlines(requestId = '') {
    return this.#deadlineCoordinator.active(requestId);
  }

  clear(requestId, reason = 'request_finished') {
    const id = String(requestId || '');
    this.#deadlineCoordinator.clear(id, reason);
    this.#terminalRevisions.delete(id);
  }

  close() {
    this.#deadlineCoordinator.close();
    this.#terminalRevisions.clear();
  }

  #handleError(error, details) {
    try { this.#onError?.(error, details); } catch {}
  }
}
