const GLOBAL_LANE = 'global';

/**
 * Runs one turn at a time for each explicitly bound browser client. Unbound
 * turns retain an exclusive lane because their browser target is selected at
 * dispatch time.
 */
export class TurnQueueCoordinator {
  constructor({ runTurn }) {
    if (typeof runTurn !== 'function') throw new TypeError('TurnQueueCoordinator requires runTurn');
    this.runTurn = runTurn;
    this.queues = new Map();
    this.running = new Map();
  }

  enqueue(turnId, sourceClientId = '') {
    const lane = this.#lane(sourceClientId);
    const queue = this.queues.get(lane) || [];
    queue.push(turnId);
    this.queues.set(lane, queue);
    this.pump();
  }

  remove(turnId) {
    let removed = false;
    for (const [lane, queue] of this.queues) {
      const next = queue.filter((queuedId) => queuedId !== turnId);
      if (next.length !== queue.length) removed = true;
      if (next.length) this.queues.set(lane, next);
      else this.queues.delete(lane);
    }
    this.pump();
    return removed;
  }

  has(turnId) {
    return this.isRunning(turnId) || Array.from(this.queues.values()).some((queue) => queue.includes(turnId));
  }

  isRunning(turnId) {
    return Array.from(this.running.values()).includes(turnId);
  }

  claim(turnId, sourceClientId = '') {
    const lane = this.#lane(sourceClientId);
    const existingLane = this.#runningLane(turnId);
    if (existingLane) return false;
    if (!this.#canRun(lane)) return false;
    this.#removeQueued(turnId);
    this.running.set(lane, turnId);
    this.pump();
    return true;
  }

  release(turnId) {
    const lane = this.#runningLane(turnId);
    if (!lane) return false;
    this.running.delete(lane);
    this.pump();
    return true;
  }

  pump() {
    for (const [lane, queue] of Array.from(this.queues.entries())) {
      if (!queue.length) {
        this.queues.delete(lane);
        continue;
      }
      if (!this.#canRun(lane)) continue;

      const turnId = queue.shift();
      if (!queue.length) this.queues.delete(lane);
      this.running.set(lane, turnId);
      Promise.resolve()
        .then(() => this.runTurn(turnId))
        .finally(() => {
          if (this.running.get(lane) === turnId) this.running.delete(lane);
          this.pump();
        });
    }
  }

  #lane(sourceClientId = '') {
    const clientId = String(sourceClientId || '').trim();
    return clientId ? `client:${clientId}` : GLOBAL_LANE;
  }

  #canRun(lane) {
    if (this.running.has(GLOBAL_LANE)) return false;
    if (lane === GLOBAL_LANE) return this.running.size === 0;
    if (this.queues.get(GLOBAL_LANE)?.length) return false;
    return !this.running.has(lane);
  }

  #runningLane(turnId) {
    for (const [lane, activeTurnId] of this.running) {
      if (activeTurnId === turnId) return lane;
    }
    return '';
  }

  #removeQueued(turnId) {
    for (const [lane, queue] of this.queues) {
      const next = queue.filter((queuedId) => queuedId !== turnId);
      if (next.length) this.queues.set(lane, next);
      else this.queues.delete(lane);
    }
  }
}
