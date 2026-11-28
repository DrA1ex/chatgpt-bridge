import { retainedSize } from '../../events/retainedSize.js';

export class TransitionJournal {
  #limit;
  #maxBytes;
  #bytes = 0;
  #entries = new Map();
  #order = new Set();

  constructor(options = {}) {
    this.#limit = Math.max(1, Number(options.limit) || 100);
    this.#maxBytes = options.maxBytes ?? Infinity;
  }

  append(entityId, entry) {
    const id = String(entityId || '');
    if (!id) return;
    const size = Number.isFinite(this.#maxBytes) ? retainedSize(entry, this.#maxBytes) : 0;
    if (size > this.#maxBytes) return;
    const history = this.#entries.get(id) || [];
    const record = { id, entry, size };
    history.push(record);
    this.#entries.set(id, history);
    this.#order.add(record);
    this.#bytes += size;
    if (history.length > this.#limit) this.#dropOldest(history[0]);
    while (this.#bytes > this.#maxBytes) this.#dropOldest(this.#order.values().next().value);
  }

  recent(entityId, limit = this.#limit) {
    const history = this.#entries.get(String(entityId || '')) || [];
    return history.slice(-Math.max(0, Number(limit) || 0)).map(record => record.entry);
  }

  clear(entityId) {
    const id = String(entityId || '');
    for (const record of this.#entries.get(id) || []) this.#forget(record);
    this.#entries.delete(id);
  }

  entityIds() {
    return Array.from(this.#entries.keys());
  }

  #dropOldest(record) {
    const history = this.#entries.get(record.id);
    history.shift();
    if (!history.length) this.#entries.delete(record.id);
    this.#forget(record);
  }

  #forget(record) {
    this.#order.delete(record);
    this.#bytes -= record.size;
  }
}
