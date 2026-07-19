import { randomUUID } from 'node:crypto';

export class ObservedTurnJournal {
  #epoch;
  #sequence = 0;
  #entries = [];
  #limit;
  #turnListeners = new Set();
  #envelopeListeners = new Set();

  constructor({ limit = 200, streamEpoch = randomUUID() } = {}) {
    this.#limit = Math.max(1, Number(limit) || 200);
    this.#epoch = String(streamEpoch || randomUUID());
  }

  get streamEpoch() { return this.#epoch; }

  metadata() {
    return {
      streamEpoch: this.#epoch,
      latestSequence: this.#sequence,
      retainedFromSequence: this.#entries[0]?.sequence || (this.#sequence + 1),
      retainedCount: this.#entries.length,
      limit: this.#limit,
    };
  }

  classifyCursor({ streamEpoch = '', afterSequence = 0 } = {}) {
    const meta = this.metadata();
    const after = Math.max(0, Number(afterSequence) || 0);
    if (streamEpoch && streamEpoch !== meta.streamEpoch) {
      return { status: 'reset', reason: 'stream_epoch_changed', afterSequence: 0, ...meta };
    }
    if (!streamEpoch && after > meta.latestSequence) {
      return { status: 'reset', reason: 'sequence_ahead_of_stream', afterSequence: 0, ...meta };
    }
    if (after && after < meta.retainedFromSequence - 1) {
      return { status: 'gap', reason: 'cursor_before_retained_range', afterSequence: after, ...meta };
    }
    return { status: 'ok', reason: '', afterSequence: after, ...meta };
  }

  list({ afterSequence = 0, limit = 100 } = {}) {
    const after = Math.max(0, Number(afterSequence) || 0);
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    return this.#entries
      .filter((entry) => entry.sequence > after)
      .slice(-safeLimit)
      .map((entry) => ({ ...entry, turn: { ...entry.turn } }));
  }

  publish(turn = {}) {
    const envelope = {
      streamEpoch: this.#epoch,
      sequence: ++this.#sequence,
      observedAt: new Date().toISOString(),
      turn: { ...turn },
    };
    this.#entries.push(envelope);
    if (this.#entries.length > this.#limit) this.#entries.splice(0, this.#entries.length - this.#limit);
    for (const listener of this.#turnListeners) {
      try { listener(envelope.turn); } catch {}
    }
    for (const listener of this.#envelopeListeners) {
      try { listener(envelope); } catch {}
    }
    return envelope;
  }

  onTurn(listener) {
    if (typeof listener !== 'function') return () => {};
    this.#turnListeners.add(listener);
    return () => this.#turnListeners.delete(listener);
  }

  onEnvelope(listener) {
    if (typeof listener !== 'function') return () => {};
    this.#envelopeListeners.add(listener);
    return () => this.#envelopeListeners.delete(listener);
  }
}
