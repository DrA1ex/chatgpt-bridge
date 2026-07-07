import { EventEmitter } from 'node:events';

function nowIso() { return new Date().toISOString(); }

function truncateValue(value, max = 800) {
  if (typeof value === 'string' && value.length > max) return `${value.slice(0, max)}…`;
  if (Array.isArray(value)) return value.map((item) => truncateValue(item, max));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      if (/contentBase64|base64|dataUrl|rawDom|html/i.test(key) && typeof nested === 'string') {
        result[key] = `<${nested.length} chars>`;
      } else {
        result[key] = truncateValue(nested, max);
      }
    }
    return result;
  }
  return value;
}

export class EventBus extends EventEmitter {
  #events = [];
  #debugEvents = [];
  #limit;

  constructor({ limit = 500 } = {}) {
    super();
    this.#limit = limit;
  }

  emitUser(event = {}) {
    const normalized = this.#normalize(event, 'event');
    this.#push(this.#events, normalized);
    this.emit('event', normalized);
    return normalized;
  }

  emitDebug(event = {}) {
    const normalized = this.#normalize(event, 'debug');
    normalized.data = truncateValue(normalized.data || {});
    this.#push(this.#debugEvents, normalized);
    this.emit('debug', normalized);
    return normalized;
  }

  emitBoth(event = {}) {
    this.emitUser(event);
    this.emitDebug(event);
  }

  recentEvents(limit = 100) {
    return this.#events.slice(-limit);
  }

  recentDebugEvents(limit = 100) {
    return this.#debugEvents.slice(-limit);
  }

  #normalize(event, channel) {
    const type = String(event.type || 'event');
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const rest = { ...event };
    delete rest.data;
    return {
      time: event.time || nowIso(),
      channel,
      type,
      level: event.level || (channel === 'debug' ? 'debug' : 'info'),
      requestId: event.requestId || data.requestId || '',
      sessionId: event.sessionId || data.sessionId || '',
      clientId: event.clientId || data.clientId || '',
      data: { ...data, ...rest, type: undefined, level: undefined, time: undefined, requestId: undefined, sessionId: undefined, clientId: undefined },
    };
  }

  #push(buffer, event) {
    buffer.push(event);
    while (buffer.length > this.#limit) buffer.shift();
  }
}
