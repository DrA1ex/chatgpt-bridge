import { EventEmitter } from 'node:events';
import { compactEventData, isNoisyRequestProgress, truncateValue } from './events/compact.js';

function nowIso() { return new Date().toISOString(); }

export class EventBus extends EventEmitter {
  #events = [];
  #debugEvents = [];
  #requestTimeline = new Map();
  #limit;
  #timelineLimit;

  constructor({ limit = 500, timelineLimit = 300 } = {}) {
    super();
    this.#limit = limit;
    this.#timelineLimit = Math.max(50, Number(timelineLimit) || 300);
  }

  emitUser(event = {}) {
    const normalized = this.#normalize(event, 'event');
    this.#push(this.#events, normalized);
    this.#pushRequestTimeline(normalized);
    this.emit('event', normalized);
    return normalized;
  }

  emitTransient(event = {}) {
    const normalized = this.#normalize(event, 'event');
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

  requestTimeline(requestId = '', limit = 100) {
    const id = String(requestId || '');
    if (!id) return [];
    const events = this.#requestTimeline.get(id) || [];
    return events.slice(-Math.max(1, Number(limit) || 100));
  }

  recentRequestTimelines({ limitPerRequest = 80, maxRequests = 20 } = {}) {
    const entries = Array.from(this.#requestTimeline.entries()).slice(-Math.max(1, Number(maxRequests) || 20));
    return entries.map(([requestId, events]) => ({
      requestId,
      events: events.slice(-Math.max(1, Number(limitPerRequest) || 80)),
    }));
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
      requestId: event.requestId || data.requestId || data.turnId || '',
      sessionId: event.sessionId || data.sessionId || '',
      clientId: event.clientId || data.clientId || data.sourceClientId || '',
      data: { ...data, ...rest, type: undefined, level: undefined, time: undefined, requestId: undefined, sessionId: undefined, clientId: undefined },
    };
  }

  #push(buffer, event) {
    buffer.push(event);
    while (buffer.length > this.#limit) buffer.shift();
  }

  #pushRequestTimeline(event = {}) {
    const requestId = String(event.requestId || event.data?.turnId || '');
    if (!requestId || isNoisyRequestProgress(event)) return;
    const compact = {
      time: event.time,
      type: event.type,
      level: event.level,
      requestId,
      clientId: event.clientId || '',
      data: compactEventData(event.data || {}),
    };
    const list = this.#requestTimeline.get(requestId) || [];
    const prev = list[list.length - 1];
    const signature = JSON.stringify([compact.type, compact.clientId, compact.data]);
    if (prev?.signature === signature) {
      prev.repeat = (prev.repeat || 1) + 1;
      prev.time = compact.time;
      return;
    }
    list.push({ ...compact, signature });
    while (list.length > this.#timelineLimit) list.shift();
    this.#requestTimeline.set(requestId, list);
    while (this.#requestTimeline.size > this.#limit) {
      const firstKey = this.#requestTimeline.keys().next().value;
      if (!firstKey) break;
      this.#requestTimeline.delete(firstKey);
    }
  }
}
