import { randomUUID } from 'node:crypto';

export const REQUEST_STATE_SCHEMA_VERSION = 1;

export const RequestLifecycle = Object.freeze({
  CREATED: 'created',
  TARGETING_SOURCE: 'targeting_source',
  PREPARING: 'preparing',
  SUBMITTING: 'submitting',
  SUBMITTED: 'submitted',
  AWAITING_ASSISTANT: 'awaiting_assistant',
  GENERATING: 'generating',
  FINALIZING: 'finalizing',
  ARTIFACT_SETTLING: 'artifact_settling',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const SourceConnection = Object.freeze({
  UNKNOWN: 'unknown',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  RECONCILING: 'reconciling',
});

export const SubmissionState = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  SUBMITTED: 'submitted',
});

export const GenerationState = Object.freeze({
  IDLE: 'idle',
  ACTIVE: 'active',
  STOPPED: 'stopped',
});

export const RequestBlocker = Object.freeze({
  NONE: 'none',
  CONFIRMATION: 'confirmation',
  CONTINUE: 'continue',
  EXPLICIT_ERROR: 'explicit_error',
  UNKNOWN: 'unknown',
  RECOVERY: 'recovery',
});

export const OutputState = Object.freeze({
  NONE: 'none',
  REASONING: 'reasoning',
  STREAMING: 'streaming',
  FINAL: 'final',
});

export const ArtifactExpectation = Object.freeze({
  NONE: 'none',
  FILE: 'file',
  ZIP: 'zip',
});

export const ArtifactState = Object.freeze({
  NOT_EXPECTED: 'not_expected',
  PENDING: 'pending',
  READY: 'ready',
  MISSING: 'missing',
  FAILED: 'failed',
});


export const RequestDeadlineKind = Object.freeze({
  FORCED_SNAPSHOT: 'forced_snapshot',
  PROGRESS_LIVENESS: 'progress_liveness',
  HARD_LIVENESS: 'hard_liveness',
  SOURCE_RECONNECT: 'source_reconnect',
  ARTIFACT_PROBE: 'artifact_probe',
  ARTIFACT_SETTLE: 'artifact_settle',
  EFFECT: 'effect',
  RECOVERY: 'recovery',
});

export const RequestEffectType = Object.freeze({
  PROMPT_DELIVERY: 'prompt.delivery',
  RESPONSE_SNAPSHOT: 'response.snapshot.requested',
  ARTIFACT_PROBE: 'artifact.probe.requested',
  REQUEST_RELEASE: 'request.release.requested',
  EFFECT_RECONCILE: 'effect.reconcile.requested',
});

export const RequestTerminalCode = Object.freeze({
  COMPLETED: 'completed',
  EXPLICIT_UI_ERROR: 'explicit_ui_error',
  SOURCE_LOST: 'source_lost',
  CONVERSATION_CHANGED: 'conversation_changed',
  REQUEST_REPLACED: 'request_replaced',
  EFFECT_FAILED: 'effect_failed',
  INVALID_TRANSITION: 'invalid_transition',
  REQUIRED_ARTIFACT_MISSING: 'required_artifact_missing',
  DEADLINE_EXCEEDED: 'deadline_exceeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  RECOVERY_UNCERTAIN: 'recovery_uncertain',
});

export const RequestEventType = Object.freeze({
  CREATED: 'request.created',
  SOURCE_BOUND: 'source.bound',
  PROMPT_DELIVERED: 'prompt.delivered',
  PROMPT_ACCEPTED: 'prompt.accepted',
  PROMPT_SUBMITTED: 'prompt.submitted',
  STEER_ACCEPTED: 'prompt.steer_accepted',
  OBSERVATION_UPDATED: 'observation.updated',
  OUTPUT_UPDATED: 'output.updated',
  ARTIFACT_UPDATED: 'artifact.updated',
  TERMINAL_SNAPSHOT_OBSERVED: 'observation.terminal_snapshot',
  TERMINAL_FAILURE_OBSERVED: 'observation.terminal_failure',
  HEARTBEAT: 'source.heartbeat',
  CONNECTION_CHANGED: 'source.connection_changed',
  CONVERSATION_CHANGED: 'source.conversation_changed',
  REQUEST_REPLACED: 'source.request_replaced',
  EFFECT_STARTED: 'effect.started',
  EFFECT_SUCCEEDED: 'effect.succeeded',
  EFFECT_FAILED: 'effect.failed',
  EFFECT_CANCELLED: 'effect.cancelled',
  EFFECT_UNCERTAIN: 'effect.uncertain',
  EFFECT_RECONCILED: 'effect.reconciled',
  DEADLINE_REACHED: 'deadline.reached',
  COMPLETED: 'request.completed',
  FAILED: 'request.failed',
  CANCELLED: 'request.cancelled',
});

function finiteTimestamp(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function createRequestEvent(type, entityId, data = {}, options = {}) {
  const occurredAt = finiteTimestamp(options.occurredAt, finiteTimestamp(options.receivedAt, 0));
  const receivedAt = finiteTimestamp(options.receivedAt, occurredAt);
  return {
    schemaVersion: REQUEST_STATE_SCHEMA_VERSION,
    eventId: String(options.eventId || randomUUID()),
    type: String(type || ''),
    entityType: 'request',
    entityId: String(entityId || ''),
    source: String(options.source || 'bridge'),
    sourceSequence: Number.isInteger(options.sourceSequence) && options.sourceSequence >= 0
      ? options.sourceSequence
      : null,
    causationId: String(options.causationId || ''),
    correlationId: String(options.correlationId || entityId || ''),
    occurredAt,
    receivedAt,
    data: data && typeof data === 'object' ? data : {},
  };
}

export function isRequestEvent(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.entityType === 'request'
    && typeof value.entityId === 'string'
    && value.entityId
    && typeof value.type === 'string'
    && value.type,
  );
}
