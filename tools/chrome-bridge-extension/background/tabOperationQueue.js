export const TabOperationPriority = Object.freeze({
  OWNER_INVALIDATION: 0,
  RELEASE: 10,
  REQUEST: 20,
  RECONCILE: 30,
  READ_ONLY: 40,
  MAINTENANCE: 50,
});

function tabKey(tabId) {
  return Number.isInteger(tabId) ? tabId : `unknown:${tabId ?? ''}`;
}

function abortError(reason = 'Tab operation cancelled') {
  const error = reason instanceof Error ? reason : new Error(String(reason || 'Tab operation cancelled'));
  error.name ||= 'AbortError';
  error.code ||= 'TAB_OPERATION_CANCELLED';
  return error;
}

function itemOrder(left, right) {
  // Transport envelopes from the same source must retain sequence order even
  // when a later envelope has a higher execution priority. Priority may still
  // move release/recovery work ahead of unrelated local/background work.
  if (left.serialGroup && left.serialGroup === right.serialGroup) {
    const leftOrder = Number.isFinite(left.order) ? left.order : left.sequence;
    const rightOrder = Number.isFinite(right.order) ? right.order : right.sequence;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  }
  if (left.priority !== right.priority) return left.priority - right.priority;
  return left.sequence - right.sequence;
}

export class TabOperationQueue {
  #states = new Map();
  #highWater = new Map();
  #rejected = new Map();
  #cancelled = new Map();
  #sequence = 0;
  #maxPending;
  #reservedCritical;

  constructor({ maxPending = 200, reservedCritical = 8 } = {}) {
    this.#maxPending = Math.max(1, Number(maxPending) || 200);
    this.#reservedCritical = Math.max(1, Number(reservedCritical) || 8);
  }

  #state(key, create = false) {
    let state = this.#states.get(key) || null;
    if (!state && create) {
      state = { running: null, queued: [] };
      this.#states.set(key, state);
    }
    return state;
  }

  pending(tabId) {
    return this.#pendingKey(tabKey(tabId));
  }

  #pendingKey(key) {
    const state = this.#state(key);
    return state ? state.queued.length + (state.running ? 1 : 0) : 0;
  }

  metrics(tabId) {
    const key = tabKey(tabId);
    const state = this.#state(key);
    const items = [...(state?.running ? [state.running] : []), ...(state?.queued || [])];
    const byPriority = {};
    for (const item of items) byPriority[item.priority] = (byPriority[item.priority] || 0) + 1;
    return {
      pending: items.length,
      queued: state?.queued.length || 0,
      running: Boolean(state?.running),
      highWater: this.#highWater.get(key) || 0,
      rejected: this.#rejected.get(key) || 0,
      cancelled: this.#cancelled.get(key) || 0,
      limit: this.#maxPending,
      reservedCritical: this.#reservedCritical,
      byPriority,
    };
  }

  run(tabId, operation, options = {}) {
    if (typeof operation !== 'function') return Promise.reject(new TypeError('Tab operation must be a function'));
    const key = tabKey(tabId);
    const priority = Number.isFinite(options.priority) ? Number(options.priority) : TabOperationPriority.REQUEST;
    const critical = options.critical === true || priority <= TabOperationPriority.RELEASE;
    const count = this.#pendingKey(key);
    const capacity = this.#maxPending + (critical ? this.#reservedCritical : 0);
    if (count >= capacity || (!critical && count >= this.#maxPending)) {
      this.#rejected.set(key, (this.#rejected.get(key) || 0) + 1);
      const error = new Error(`Tab operation queue is full for ${key}`);
      error.code = 'TAB_OPERATION_QUEUE_FULL';
      error.label = String(options.label || 'operation');
      error.queueMetrics = this.metrics(key);
      return Promise.reject(error);
    }
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal.reason));

    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const item = {
        key,
        operation,
        resolve,
        reject,
        controller,
        label: String(options.label || 'operation'),
        priority,
        critical,
        serialGroup: String(options.serialGroup || ''),
        order: Number.isFinite(options.order) ? Number(options.order) : null,
        meta: options.meta && typeof options.meta === 'object' ? Object.freeze({ ...options.meta }) : null,
        sequence: ++this.#sequence,
        abortListener: null,
        sourceSignal: options.signal || null,
      };
      if (options.signal) {
        item.abortListener = () => this.#cancelItem(key, item, options.signal.reason);
        options.signal.addEventListener('abort', item.abortListener, { once: true });
      }
      const state = this.#state(key, true);
      state.queued.push(item);
      state.queued.sort(itemOrder);
      const nextCount = this.#pendingKey(key);
      this.#highWater.set(key, Math.max(this.#highWater.get(key) || 0, nextCount));
      this.#drain(key);
    });
  }

  cancel(tabId, predicate = null, reason = 'Tab operation cancelled') {
    const key = tabKey(tabId);
    const state = this.#state(key);
    if (!state) return 0;
    const shouldCancel = typeof predicate === 'function' ? predicate : () => true;
    let count = 0;
    for (const item of [...state.queued]) {
      if (!shouldCancel(item)) continue;
      if (this.#cancelItem(key, item, reason)) count += 1;
    }
    return count;
  }

  #cancelItem(key, item, reason) {
    const state = this.#state(key);
    if (!state) return false;
    const index = state.queued.indexOf(item);
    if (index < 0) {
      // A running operation may observe cancellation through its own signal,
      // but queue cancellation never pretends that a dispatched action stopped.
      if (state.running === item) item.controller.abort(reason);
      return false;
    }
    state.queued.splice(index, 1);
    item.controller.abort(reason);
    this.#cleanupSignal(item);
    this.#cancelled.set(key, (this.#cancelled.get(key) || 0) + 1);
    item.reject(abortError(reason));
    this.#deleteIfIdle(key);
    return true;
  }

  #drain(key) {
    const state = this.#state(key);
    if (!state || state.running || !state.queued.length) return;
    const item = state.queued.shift();
    state.running = item;
    Promise.resolve()
      .then(() => item.operation(item.controller.signal, item))
      .then(
        (result) => this.#finishItem(key, item, null, result),
        (error) => this.#finishItem(key, item, error),
      );
  }

  #finishItem(key, item, error, result = undefined) {
    this.#cleanupSignal(item);
    const current = this.#state(key);
    if (current?.running === item) current.running = null;
    this.#deleteIfIdle(key);
    this.#drain(key);
    if (error) item.reject(error);
    else item.resolve(result);
  }

  #cleanupSignal(item) {
    if (item.abortListener && item.sourceSignal) {
      item.sourceSignal.removeEventListener('abort', item.abortListener);
    }
    item.abortListener = null;
    item.sourceSignal = null;
  }

  #deleteIfIdle(key) {
    const state = this.#state(key);
    if (state && !state.running && !state.queued.length) this.#states.delete(key);
  }

  clear(tabId, reason = 'Tab operation queue cleared') {
    const key = tabKey(tabId);
    const state = this.#state(key);
    if (!state) return 0;
    const cancelled = this.cancel(key, null, reason);
    if (state.running) state.running.controller.abort(reason);
    this.#deleteIfIdle(key);
    return cancelled;
  }
}
