function waitDetails(store, entityId, state) {
  return {
    entityId,
    state: state || null,
    history: store.history(entityId, 20),
  };
}

export class StateWaitRejectedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'StateWaitRejectedError';
    this.code = 'STATE_WAIT_REJECTED';
    Object.assign(this, details);
  }
}

export class StateWaitDeadlineError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'StateWaitDeadlineError';
    this.code = 'STATE_WAIT_DEADLINE';
    Object.assign(this, details);
  }
}

export class StateWaitAbortedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AbortError';
    this.code = 'STATE_WAIT_ABORTED';
    Object.assign(this, details);
  }
}

function rejectionMessage(state) {
  if (state?.terminal?.message) return state.terminal.message;
  if (state?.terminal?.code) return `State became terminal: ${state.terminal.code}`;
  return 'State wait rejected by predicate';
}

export function waitForState(store, entityId, options = {}) {
  const id = String(entityId || '');
  if (!id) return Promise.reject(new TypeError('waitForState requires an entityId'));
  const accept = typeof options.accept === 'function' ? options.accept : () => false;
  const reject = typeof options.reject === 'function' ? options.reject : (state) => Boolean(state?.terminal);
  const signal = options.signal || null;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const now = options.now || Date.now;
  const absoluteDeadline = Number(options.deadline) > 0
    ? Number(options.deadline)
    : Number(options.timeoutMs) > 0 ? now() + Number(options.timeoutMs) : 0;

  return new Promise((resolve, rejectPromise) => {
    let settled = false;
    let timer = null;
    let lastRevision = -1;

    const cleanup = () => {
      unsubscribe();
      if (timer) clearTimer(timer);
      timer = null;
      signal?.removeEventListener?.('abort', onAbort);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const evaluate = (state) => {
      if (settled || !state) return;
      const revision = Number(state.revision) || 0;
      if (revision < lastRevision) return;
      lastRevision = revision;
      let accepted;
      let rejected;
      try {
        accepted = accept(state);
        rejected = !accepted && reject(state);
      } catch (error) {
        settle(rejectPromise, error);
        return;
      }
      if (accepted) {
        settle(resolve, state);
      } else if (rejected) {
        settle(rejectPromise, new StateWaitRejectedError(
          typeof rejected === 'string' ? rejected : rejectionMessage(state),
          waitDetails(store, id, state),
        ));
      }
    };
    const onAbort = () => {
      const state = store.get(id);
      settle(rejectPromise, new StateWaitAbortedError(
        String(signal?.reason || 'State wait aborted'),
        waitDetails(store, id, state),
      ));
    };

    // Subscribe before reading the snapshot so a transition cannot be lost in between.
    const unsubscribe = store.subscribe(id, ({ state }) => evaluate(state));
    signal?.addEventListener?.('abort', onAbort, { once: true });

    if (signal?.aborted) {
      onAbort();
      return;
    }

    evaluate(store.get(id));
    if (settled) return;

    if (absoluteDeadline > 0) {
      const delay = Math.max(0, absoluteDeadline - now());
      timer = setTimer(() => {
        const state = store.get(id);
        settle(rejectPromise, new StateWaitDeadlineError(
          `Timed out waiting for state ${id}`,
          waitDetails(store, id, state),
        ));
      }, delay);
    }
  });
}
