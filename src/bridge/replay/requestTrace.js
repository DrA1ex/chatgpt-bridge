import { EntityStore } from '../store/entityStore.js';
import { createRequestEvent } from '../state/requestEvents.js';
import { reduceRequestState } from '../state/requestMachine.js';
import { compactCanonicalRequestState } from '../state/requestView.js';

const TRACE_SCHEMA_VERSION = 1;
const SENSITIVE_KEY = /(?:token|secret|authorization|cookie|attachmentbody|sourcehtml|domhtml|html)$/i;

function sanitizeValue(value, depth = 0) {
  if (depth > 8) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeValue(item, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > 20_000) return `${value.slice(0, 20_000)}\n[truncated]`;
    return value;
  }
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeValue(item, depth + 1);
  }
  return output;
}

function normalizeRecord(record, requestId, index) {
  const raw = record?.event && typeof record.event === 'object' ? record.event : record;
  const entityId = String(raw?.entityId || requestId || '');
  const event = createRequestEvent(raw?.type, entityId, sanitizeValue(raw?.data || {}), {
    eventId: raw?.eventId || `replay:${index}:${raw?.type || 'unknown'}`,
    source: raw?.source || 'replay',
    sourceSequence: Number.isInteger(raw?.sourceSequence) ? raw.sourceSequence : undefined,
    causationId: raw?.causationId || '',
    correlationId: raw?.correlationId || entityId,
    occurredAt: Number(raw?.occurredAt) || index + 1,
    receivedAt: Number(raw?.receivedAt) || Number(raw?.occurredAt) || index + 1,
  });
  return {
    event,
    expectedAccepted: Object.prototype.hasOwnProperty.call(record || {}, 'accepted')
      ? Boolean(record.accepted)
      : true,
    expectedDiagnosticCode: String(record?.diagnosticCode || ''),
  };
}

export function requestTraceFromDiagnostics(diagnostics = {}, options = {}) {
  const state = diagnostics?.state || null;
  const requestId = String(state?.requestId || options.requestId || '');
  const history = Array.isArray(diagnostics?.history) ? diagnostics.history : [];
  return sanitizeRequestTrace({
    schemaVersion: TRACE_SCHEMA_VERSION,
    requestId,
    capturedAt: options.capturedAt || new Date().toISOString(),
    reason: String(options.reason || ''),
    events: history.map((entry) => ({ event: entry.event, accepted: true })),
    expected: state ? {
      lifecycle: state.lifecycle,
      terminalCode: state.terminal?.code || '',
      artifactStatus: state.artifact?.status || '',
      displayPhase: state.displayPhase || '',
    } : null,
  });
}

export function sanitizeRequestTrace(trace = {}) {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    requestId: String(trace.requestId || ''),
    capturedAt: String(trace.capturedAt || ''),
    reason: String(trace.reason || ''),
    events: Array.isArray(trace.events) ? trace.events.slice(0, 1_000).map((record) => sanitizeValue(record)) : [],
    expected: trace.expected ? sanitizeValue(trace.expected) : null,
  };
}

export function replayRequestTrace(trace = {}, options = {}) {
  const sanitized = sanitizeRequestTrace(trace);
  const requestId = sanitized.requestId;
  if (!requestId) throw new TypeError('Request replay trace requires requestId');
  const store = options.store || new EntityStore({
    reducer: reduceRequestState,
    historyLimit: Math.max(100, sanitized.events.length + 10),
  });
  const outcomes = [];

  sanitized.events.forEach((record, index) => {
    const normalized = normalizeRecord(record, requestId, index);
    const outcome = store.transition(requestId, normalized.event);
    const diagnosticCode = String(outcome.diagnostics?.[0]?.code || '');
    outcomes.push({
      index,
      type: normalized.event.type,
      accepted: Boolean(outcome.accepted),
      revision: Number(outcome.state?.revision || 0),
      diagnosticCode,
    });
    if (Boolean(outcome.accepted) !== normalized.expectedAccepted) {
      throw new Error(
        `Replay event ${index} (${normalized.event.type}) acceptance mismatch: expected ${normalized.expectedAccepted}, got ${Boolean(outcome.accepted)}`,
      );
    }
    if (normalized.expectedDiagnosticCode && diagnosticCode !== normalized.expectedDiagnosticCode) {
      throw new Error(
        `Replay event ${index} (${normalized.event.type}) diagnostic mismatch: expected ${normalized.expectedDiagnosticCode}, got ${diagnosticCode || '(none)'}`,
      );
    }
  });

  const state = store.get(requestId);
  const compact = compactCanonicalRequestState(state);
  const expected = sanitized.expected || {};
  const mismatches = [];
  if (expected.lifecycle && compact?.lifecycle !== expected.lifecycle) {
    mismatches.push(`lifecycle expected ${expected.lifecycle}, got ${compact?.lifecycle || '(none)'}`);
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'terminalCode')
    && String(compact?.terminal?.code || '') !== String(expected.terminalCode || '')) {
    mismatches.push(`terminalCode expected ${expected.terminalCode || '(none)'}, got ${compact?.terminal?.code || '(none)'}`);
  }
  if (expected.artifactStatus && compact?.artifact?.status !== expected.artifactStatus) {
    mismatches.push(`artifactStatus expected ${expected.artifactStatus}, got ${compact?.artifact?.status || '(none)'}`);
  }
  if (mismatches.length) throw new Error(`Request replay parity failed: ${mismatches.join('; ')}`);

  return {
    requestId,
    state: compact,
    outcomes,
    history: store.history(requestId, sanitized.events.length + 10),
  };
}
