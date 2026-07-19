export class TabOperationQueue {
  #queues = new Map();
  #pending = new Map();
  #highWater = new Map();
  #rejected = new Map();
  #maxPending;

  constructor({ maxPending = 200 } = {}) {
    this.#maxPending = Math.max(1, Number(maxPending) || 200);
  }

  pending(tabId) { return this.#pending.get(tabId) || 0; }

  metrics(tabId) {
    const key = Number.isInteger(tabId) ? tabId : `unknown:${tabId ?? ''}`;
    return {
      pending: this.pending(key),
      highWater: this.#highWater.get(key) || 0,
      rejected: this.#rejected.get(key) || 0,
      limit: this.#maxPending,
    };
  }

  run(tabId, operation, { label = 'operation' } = {}) {
    if (typeof operation !== 'function') return Promise.reject(new TypeError('Tab operation must be a function'));
    const key = Number.isInteger(tabId) ? tabId : `unknown:${tabId ?? ''}`;
    const count = this.pending(key);
    if (count >= this.#maxPending) {
      this.#rejected.set(key, (this.#rejected.get(key) || 0) + 1);
      const error = new Error(`Tab operation queue is full for ${key}`);
      error.code = 'TAB_OPERATION_QUEUE_FULL';
      error.label = label;
      error.queueMetrics = this.metrics(key);
      return Promise.reject(error);
    }
    const nextCount = count + 1;
    this.#pending.set(key, nextCount);
    this.#highWater.set(key, Math.max(this.#highWater.get(key) || 0, nextCount));
    const previous = this.#queues.get(key) || Promise.resolve();
    const next = previous.then(operation);
    const settled = next.finally(() => {
      const remaining = Math.max(0, this.pending(key) - 1);
      if (remaining) this.#pending.set(key, remaining);
      else this.#pending.delete(key);
      if (this.#queues.get(key) === guarded) this.#queues.delete(key);
    });
    const guarded = settled.catch(() => {});
    this.#queues.set(key, guarded);
    return next;
  }

  clear(tabId) {
    const key = Number.isInteger(tabId) ? tabId : `unknown:${tabId ?? ''}`;
    this.#queues.delete(key);
    this.#pending.delete(key);
  }
}
