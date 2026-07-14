import {
  ArtifactState,
  RequestEventType,
  RequestTerminalCode,
  SourceConnection,
  createRequestEvent,
} from '../state/requestEvents.js';

function eventTimestamp(event = {}) {
  const numeric = Number(event.time || event.at);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const parsed = Date.parse(String(event.time || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionsFor(event, source = 'legacy_bridge') {
  const at = eventTimestamp(event);
  return {
    source,
    occurredAt: at,
    receivedAt: at,
    sourceSequence: Number.isInteger(event.sourceSequence) ? event.sourceSequence : undefined,
    causationId: String(event.eventId || ''),
  };
}

function outputUpdate(requestId, event) {
  return createRequestEvent(RequestEventType.OUTPUT_UPDATED, requestId, {
    answerLength: Number(event.answerLength ?? event.text?.length) || 0,
    thinkingLength: event.type.startsWith('thinking.') ? Number(event.text?.length || event.thinking?.length || 0) : 0,
    final: false,
    meaningful: true,
    legacyType: event.type,
  }, optionsFor(event));
}

export function legacyRequestEventToCanonical(requestId, event = {}) {
  const id = String(requestId || event.requestId || '');
  if (!id || !event?.type) return null;
  const options = optionsFor(event);

  switch (event.type) {
    case 'request.started':
      return createRequestEvent(RequestEventType.CREATED, id, {
        expectedOutput: event.expectedOutput || { expected: '', required: false },
        sessionId: event.sessionId || '',
        sourceClientId: event.sourceClientId || '',
      }, options);
    case 'request.resumed':
      return createRequestEvent(RequestEventType.CREATED, id, {
        resumed: true,
        sourceClientId: event.clientId || '',
        sessionId: event.activeRequest?.sessionId || '',
      }, options);
    case 'client.target.resolved':
      return createRequestEvent(RequestEventType.SOURCE_BOUND, id, {
        clientId: event.clientId || '',
        sessionId: event.sessionId || '',
        url: event.sourceUrl || '',
      }, options);
    case 'prompt.delivered':
      return createRequestEvent(RequestEventType.PROMPT_DELIVERED, id, event, options);
    case 'prompt.accepted':
      return createRequestEvent(RequestEventType.PROMPT_ACCEPTED, id, event, options);
    case 'status.sent':
      return createRequestEvent(RequestEventType.PROMPT_SUBMITTED, id, event.payload || event, options);
    case 'status.generating':
    case 'status.finalizing':
      return createRequestEvent(RequestEventType.LEGACY_PROGRESS, id, {
        ...(event.payload || {}),
        phase: event.type.slice('status.'.length),
        meaningful: true,
      }, options);
    case 'request.progress':
      return createRequestEvent(RequestEventType.LEGACY_PROGRESS, id, event, options);
    case 'thinking.delta':
    case 'thinking.snapshot':
    case 'answer.delta':
    case 'answer.snapshot':
    case 'assistant.progress.snapshot':
      return outputUpdate(id, event);
    case 'artifact.snapshot':
      return createRequestEvent(RequestEventType.ARTIFACT_UPDATED, id, {
        artifacts: event.artifacts || [],
        artifactCount: Array.isArray(event.artifacts) ? event.artifacts.length : 0,
        status: event.canonicalArtifactStatus
          || (Array.isArray(event.artifacts) && event.artifacts.length && event.requiredArtifact !== true
            ? ArtifactState.READY
            : undefined),
        meaningful: true,
      }, options);
    case 'request.reattached':
      return createRequestEvent(RequestEventType.CONNECTION_CHANGED, id, {
        connected: true,
        connection: SourceConnection.CONNECTED,
        clientId: event.clientId || '',
      }, options);
    case 'watchdog.source_disconnected':
      return createRequestEvent(RequestEventType.CONNECTION_CHANGED, id, {
        connected: false,
        connection: SourceConnection.DISCONNECTED,
        definitive: false,
        message: event.message || '',
        clientId: event.sourceClientId || '',
      }, options);
    case 'request.done':
      return createRequestEvent(RequestEventType.COMPLETED, id, {
        artifactCount: Number(event.artifactCount) || 0,
        artifacts: event.artifacts || [],
        message: 'Legacy request lifecycle completed',
        finishReason: event.finishReason || '',
      }, options);
    case 'request.recoverable_failed':
      return createRequestEvent(RequestEventType.FAILED, id, {
        code: RequestTerminalCode.SOURCE_LOST,
        message: event.message || 'Source browser client disconnected',
        recoverable: true,
      }, options);
    case 'request.error':
      if (event.finishReason === 'cancelled' || event.code === 'ABORT_ERR' || event.name === 'AbortError') {
        return createRequestEvent(RequestEventType.CANCELLED, id, { message: event.message || 'Request cancelled' }, options);
      }
      return createRequestEvent(RequestEventType.FAILED, id, {
        code: event.code || RequestTerminalCode.FAILED,
        message: event.message || 'Legacy request lifecycle failed',
        recoverable: Boolean(event.recoverable),
      }, options);
    default:
      return null;
  }
}
