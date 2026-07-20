import {
  RequestEventType,
  createRequestEvent,
} from '../state/requestEvents.js';

function abortReason(signal) {
  return String(signal?.reason || 'Effect cancelled');
}

function effectId(effect = {}) {
  return String(effect.id || effect.effectId || '').trim();
}

function effectType(effect = {}) {
  return String(effect.type || effect.effectType || '').trim();
}

export class EffectRunner {
  #handlers = new Map();
  #active = new Map();
  #completed = new Map();
  #completedOrder = [];
  #completedLimit;
  #onEvent;
  #now;

  constructor(options = {}) {
    this.#completedLimit = Math.max(10, Number(options.completedLimit) || 500);
    this.#onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
    this.#now = typeof options.now === 'function' ? options.now : Date.now;
    for (const [type, handler] of Object.entries(options.handlers || {})) this.register(type, handler);
  }

  register(type, handler) {
    const normalizedType = String(type || '').trim();
    if (!normalizedType) throw new TypeError('Effect handler type is required');
    if (typeof handler !== 'function') throw new TypeError(`Effect handler for ${normalizedType} must be a function`);
    this.#handlers.set(normalizedType, handler);
    return this;
  }

  has(type) {
    return this.#handlers.has(String(type || '').trim());
  }

  run(requestId, effect, context = {}) {
    const id = effectId(effect);
    const type = effectType(effect);
    if (!requestId) return Promise.reject(new TypeError('EffectRunner.run requires a requestId'));
    if (!id) return Promise.reject(new TypeError('EffectRunner.run requires an effect id'));
    if (!type) return Promise.reject(new TypeError('EffectRunner.run requires an effect type'));
    if (this.#active.has(id)) return this.#active.get(id).promise;
    if (this.#completed.has(id)) return Promise.resolve(this.#completed.get(id));

    const controller = new AbortController();
    const detachExternalSignal = this.#forwardAbort(context.signal, controller);
    const started = this.#event(RequestEventType.EFFECT_STARTED, requestId, {
      effectId: id,
      effectType: type,
      effectDomain: 'coordinator',
      data: effect.data || {},
    });
    this.#emit(started);

    const promise = this.#execute(requestId, { ...effect, id, type }, context, controller)
      .finally(() => {
        detachExternalSignal();
        this.#active.delete(id);
      });
    this.#active.set(id, { requestId, effect: { ...effect, id, type }, controller, promise });
    return promise;
  }

  cancel(id, reason = 'Effect cancelled') {
    const active = this.#active.get(String(id || ''));
    if (!active) return false;
    active.controller.abort(reason);
    return true;
  }

  activeEffects() {
    return Array.from(this.#active.values()).map(({ requestId, effect }) => ({ requestId, ...effect }));
  }

  completedEffect(id) {
    return this.#completed.get(String(id || '')) || null;
  }

  async #execute(requestId, effect, context, controller) {
    const handler = this.#handlers.get(effect.type) || this.#handlers.get('*');
    let terminalEvent;
    try {
      if (!handler) {
        const error = new Error(`No handler registered for effect type: ${effect.type}`);
        error.code = 'EFFECT_HANDLER_MISSING';
        throw error;
      }
      const result = await handler(effect.data || {}, {
        ...context,
        requestId,
        effect,
        signal: controller.signal,
      });
      terminalEvent = controller.signal.aborted
        ? this.#cancelledEvent(requestId, effect, controller.signal)
        : this.#event(RequestEventType.EFFECT_SUCCEEDED, requestId, {
          effectId: effect.id,
          effectType: effect.type,
          effectDomain: 'coordinator',
          result,
        });
    } catch (error) {
      terminalEvent = controller.signal.aborted || error?.name === 'AbortError'
        ? this.#cancelledEvent(requestId, effect, controller.signal, error)
        : this.#event(RequestEventType.EFFECT_FAILED, requestId, {
          effectId: effect.id,
          effectType: effect.type,
          effectDomain: 'coordinator',
          code: String(error?.code || 'EFFECT_FAILED'),
          message: String(error?.message || error || 'Effect failed'),
          retryable: Boolean(error?.retryable),
          evidence: error?.evidence || null,
        });
    }

    this.#remember(effect.id, terminalEvent);
    this.#emit(terminalEvent);
    return terminalEvent;
  }

  #cancelledEvent(requestId, effect, signal, error = null) {
    return this.#event(RequestEventType.EFFECT_CANCELLED, requestId, {
      effectId: effect.id,
      effectType: effect.type,
      effectDomain: 'coordinator',
      message: error?.message || abortReason(signal),
    });
  }

  #event(type, requestId, data) {
    const at = this.#now();
    return createRequestEvent(type, requestId, data, {
      source: 'effect_runner',
      occurredAt: at,
      receivedAt: at,
    });
  }

  #emit(event) {
    try { this.#onEvent?.(event); } catch {}
  }

  #remember(id, event) {
    this.#completed.set(id, event);
    this.#completedOrder.push(id);
    while (this.#completedOrder.length > this.#completedLimit) {
      const evicted = this.#completedOrder.shift();
      this.#completed.delete(evicted);
    }
  }

  #forwardAbort(signal, controller) {
    if (!signal) return () => {};
    const abort = () => controller.abort(signal.reason || 'Effect cancelled');
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    return () => signal.removeEventListener?.('abort', abort);
  }
}
