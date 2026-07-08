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

function compactEventData(data = {}) {
  const result = {};
  for (const key of [
    'turnId', 'jobId', 'clientId', 'phase', 'previousPhase', 'reason', 'status', 'finishReason',
    'answerLength', 'thinkingLength', 'progressLength', 'artifactCount', 'artifactId', 'fileId',
    'name', 'sourceClientId', 'sourceTurnKey', 'turnKey', 'assistantTurnKey', 'submittedUserTurnKey',
    'anchorConfidence', 'anchorReason', 'visibilityState', 'focused', 'message', 'expected', 'recovered',
  ]) {
    if (data[key] !== undefined && data[key] !== null && data[key] !== '') result[key] = truncateValue(data[key], 220);
  }
  return result;
}

function isNoisyRequestProgress(event = {}) {
  if (event.type !== 'request.progress') return false;
  const data = event.data || {};
  return data.meaningful === false || data.reason === 'dom.poll' || data.snapshotReason === 'dom.poll';
}

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
      requestId: event.requestId || data.requestId || data.turnId || data.jobId || '',
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
    const requestId = String(event.requestId || event.data?.turnId || event.data?.jobId || '');
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
