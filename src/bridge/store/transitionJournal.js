export class TransitionJournal {
  #limit;
  #entries = new Map();

  constructor(options = {}) {
    this.#limit = Math.max(1, Number(options.limit) || 100);
  }

  append(entityId, entry) {
    const id = String(entityId || '');
    if (!id) return;
    const history = this.#entries.get(id) || [];
    history.push(entry);
    if (history.length > this.#limit) history.splice(0, history.length - this.#limit);
    this.#entries.set(id, history);
  }

  recent(entityId, limit = this.#limit) {
    const history = this.#entries.get(String(entityId || '')) || [];
    return history.slice(-Math.max(0, Number(limit) || 0));
  }

  clear(entityId) {
    this.#entries.delete(String(entityId || ''));
  }

  entityIds() {
    return Array.from(this.#entries.keys());
  }
}
