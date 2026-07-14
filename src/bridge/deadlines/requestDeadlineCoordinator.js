import {
  RequestEventType,
  createRequestEvent,
} from '../state/requestEvents.js';
import { deadlineIntentsForRequest } from './requestDeadlinePolicy.js';

function normalizedIntent(requestId, value = {}) {
  const kind = String(value.kind || value.type || '');
  const dueAt = Number(value.dueAt) || 0;
  if (!requestId || !kind || dueAt <= 0) return null;
  return {
    ...value,
    id: String(value.id || `${kind}:${requestId}:${dueAt}`),
    kind,
    type: kind,
    dueAt,
    scheduledRevision: Number(value.scheduledRevision) || 0,
  };
}

export class RequestDeadlineCoordinator {
  #dispatch;
  #options;
  #now;
  #setTimer;
  #clearTimer;
  #onScheduled;
  #onSuperseded;
  #onError;
  #active = new Map();

  constructor(options = {}) {
    if (typeof options.dispatch !== 'function') {
      throw new TypeError('RequestDeadlineCoordinator requires a dispatch callback');
    }
    this.#dispatch = options.dispatch;
    this.#options = options.policy || {};
    this.#now = options.now || Date.now;
    this.#setTimer = options.setTimer || setTimeout;
    this.#clearTimer = options.clearTimer || clearTimeout;
    this.#onScheduled = typeof options.onScheduled === 'function' ? options.onScheduled : null;
    this.#onSuperseded = typeof options.onSuperseded === 'function' ? options.onSuperseded : null;
    this.#onError = typeof options.onError === 'function' ? options.onError : null;
  }

  sync(requestId, state, explicitDeadlines = []) {
    const id = String(requestId || state?.requestId || '');
    if (!id) return [];
    if (!state || state.terminal) {
      this.clear(id, state?.terminal ? 'terminal' : 'missing_state');
      return [];
    }

    const desired = new Map();
    for (const candidate of [
      ...deadlineIntentsForRequest(state, this.#options),
      ...(Array.isArray(explicitDeadlines) ? explicitDeadlines : []),
    ]) {
      const normalized = normalizedIntent(id, candidate);
      if (normalized) desired.set(normalized.kind, normalized);
    }

    const active = this.#active.get(id) || new Map();
    for (const [kind, entry] of active) {
      const next = desired.get(kind);
      if (next && next.dueAt === entry.intent.dueAt) {
        desired.delete(kind);
        continue;
      }
      this.#clearEntry(id, kind, entry, next ? 'superseded' : 'invalidated');
      active.delete(kind);
    }

    for (const [kind, intent] of desired) {
      const entry = this.#schedule(id, intent);
      active.set(kind, entry);
    }

    if (active.size) this.#active.set(id, active);
    else this.#active.delete(id);
    return this.active(id);
  }

  active(requestId = '') {
    const id = String(requestId || '');
    if (id) {
      return Array.from(this.#active.get(id)?.values() || []).map((entry) => ({ ...entry.intent }));
    }
    return Array.from(this.#active.entries()).flatMap(([entityId, entries]) => (
      Array.from(entries.values()).map((entry) => ({ requestId: entityId, ...entry.intent }))
    ));
  }

  clear(requestId, reason = 'cleared') {
    const id = String(requestId || '');
    const active = this.#active.get(id);
    if (!active) return;
    for (const [kind, entry] of active) this.#clearEntry(id, kind, entry, reason);
    this.#active.delete(id);
  }

  close() {
    for (const requestId of Array.from(this.#active.keys())) this.clear(requestId, 'coordinator_closed');
  }

  #schedule(requestId, intent) {
    const token = Symbol(intent.id);
    const delay = Math.max(0, intent.dueAt - this.#now());
    const timer = this.#setTimer(() => {
      const active = this.#active.get(requestId);
      const entry = active?.get(intent.kind);
      if (!entry || entry.token !== token) return;
      active.delete(intent.kind);
      if (!active.size) this.#active.delete(requestId);
      const at = this.#now();
      try {
        this.#dispatch(requestId, createRequestEvent(RequestEventType.DEADLINE_REACHED, requestId, {
          ...intent,
          deadlineId: intent.id,
          reachedAt: at,
        }, {
          source: 'request_deadline_coordinator',
          occurredAt: at,
          receivedAt: at,
          causationId: intent.id,
        }));
      } catch (error) {
        this.#onError?.(error, { requestId, intent });
      }
    }, delay);
    const entry = { token, timer, intent };
    this.#onScheduled?.(requestId, { ...intent });
    return entry;
  }

  #clearEntry(requestId, kind, entry, reason) {
    this.#clearTimer(entry.timer);
    this.#onSuperseded?.(requestId, { ...entry.intent }, reason, kind);
  }
}
