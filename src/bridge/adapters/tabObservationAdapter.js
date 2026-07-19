import {
  ArtifactState,
  GenerationState,
  OutputState,
  RequestBlocker,
  RequestEventType,
  RequestLifecycle,
  SubmissionState,
  createRequestEvent,
} from '../state/requestEvents.js';
import { classifyTurnObservation } from '../observation/turnEvidence.js';

function observationPayload(payload = {}) {
  return payload.observation && typeof payload.observation === 'object'
    ? payload.observation
    : payload.tabObservation && typeof payload.tabObservation === 'object'
      ? payload.tabObservation
      : null;
}

function lifecycleFromObservation(observation = {}, currentState = null) {
  if (observation.generation?.state === GenerationState.ACTIVE) return RequestLifecycle.GENERATING;
  if (observation.output?.state === OutputState.FINAL) return RequestLifecycle.FINALIZING;
  if (observation.activeRequest?.requestId && currentState?.submission === SubmissionState.SUBMITTED) return RequestLifecycle.AWAITING_ASSISTANT;
  return undefined;
}

function artifactStatus(observation = {}) {
  switch (observation.artifact?.state) {
    case 'ready': return ArtifactState.READY;
    case 'pending': return ArtifactState.PENDING;
    case 'failed': return ArtifactState.FAILED;
    default: return undefined;
  }
}

function enumValue(values, value) {
  const normalized = String(value || '');
  return Object.values(values).includes(normalized) ? normalized : undefined;
}

function normalizedConversationId(value = '') {
  const id = String(value || '').trim();
  return id === 'new' ? '' : id;
}

function terminalEvidence(observation, currentState, requestId, applies) {
  const common = classifyTurnObservation(observation);
  const active = observation.activeRequest || null;
  const responseEpoch = Number(active?.responseEpoch ?? observation.responseEpoch ?? 0);
  const expectedResponseEpoch = Number(currentState?.response?.epoch || 0);
  const scoped = Boolean(active?.requestId === requestId && applies);
  const responseMatches = responseEpoch === expectedResponseEpoch;
  const submittedBoundary = Boolean(active?.submittedUserTurnKey);
  const assistantBoundary = Boolean(common.assistantTurnKey || active?.assistantTurnKey);
  const candidate = Boolean(
    common.terminalCandidate
    && scoped
    && currentState?.submission === SubmissionState.SUBMITTED
    && responseMatches
    && submittedBoundary
    && assistantBoundary
  );
  return {
    ...common,
    candidate,
    scoped,
    responseMatches,
    submittedBoundary,
    assistantBoundary,
    responseEpoch,
    expectedResponseEpoch,
  };
}

export function tabObservationToCanonicalEvent(
  requestId,
  clientId,
  payload = {},
  currentState = null,
  at = 0,
  envelope = null,
) {
  const observation = observationPayload(payload);
  if (!requestId || !observation) return null;

  const observedRequestId = String(observation.activeRequest?.requestId || '');
  const expectedConversationId = normalizedConversationId(currentState?.source?.conversationId || '');
  const observedConversationId = normalizedConversationId(observation.conversationId || '');
  const bindingEstablished = currentState?.submission === SubmissionState.ACCEPTED
    || currentState?.submission === SubmissionState.SUBMITTED;
  const observationAppliesToRequest = bindingEstablished || observedRequestId === requestId;
  const requestReplaced = Boolean(bindingEstablished && observedRequestId && observedRequestId !== requestId);
  const conversationChanged = Boolean(
    bindingEstablished
    && expectedConversationId
    && observedConversationId
    && expectedConversationId !== observedConversationId,
  );
  const occurredAt = Number(observation.observedAt || payload.observedAt || at) || 0;
  const observationRevision = Number(observation.revision ?? payload.revision);
  const transportSequence = Number(envelope?.source?.sequence);
  const evidence = terminalEvidence(observation, currentState, requestId, observationAppliesToRequest);
  const artifacts = observationAppliesToRequest && Array.isArray(observation.artifacts)
    ? observation.artifacts
    : [];

  return createRequestEvent(RequestEventType.OBSERVATION_UPDATED, requestId, {
    clientId,
    url: observation.url || payload.url || '',
    conversationId: bindingEstablished ? observation.conversationId || payload.session?.id || '' : '',
    observationEpoch: String(envelope?.source?.contentEpoch || observation.observerId || ''),
    observationRevision: Number.isInteger(observationRevision) ? observationRevision : 0,
    transport: envelope ? {
      messageId: String(envelope.messageId || ''),
      backgroundEpoch: String(envelope.source?.backgroundEpoch || ''),
      contentEpoch: String(envelope.source?.contentEpoch || ''),
      sequence: Number(envelope.source?.sequence) || 0,
      causationId: String(envelope.causationId || ''),
    } : null,
    lifecycle: observationAppliesToRequest ? lifecycleFromObservation(observation, currentState) : undefined,
    generation: observationAppliesToRequest ? enumValue(GenerationState, observation.generation?.state) : undefined,
    blocker: observationAppliesToRequest ? enumValue(RequestBlocker, observation.blocker?.state) : undefined,
    output: observationAppliesToRequest ? enumValue(OutputState, observation.output?.state) : undefined,
    artifactStatus: observationAppliesToRequest
      ? (currentState?.artifact?.required && artifactStatus(observation) === ArtifactState.READY
        ? undefined
        : artifactStatus(observation))
      : undefined,
    artifactCount: observationAppliesToRequest ? Number(observation.artifact?.count) || 0 : undefined,
    artifacts,
    answer: observationAppliesToRequest ? String(observation.output?.answer || '') : '',
    thinking: observationAppliesToRequest ? String(observation.output?.thinking || '') : '',
    progress: observationAppliesToRequest ? String(observation.output?.progress || '') : '',
    progressItems: observationAppliesToRequest ? observation.output?.progressItems || [] : [],
    reasoningHistory: observationAppliesToRequest ? observation.output?.reasoningHistory || [] : [],
    responseBlocks: observationAppliesToRequest ? observation.output?.responseBlocks || [] : [],
    codeBlocks: observationAppliesToRequest ? observation.output?.codeBlocks || [] : [],
    codeBlockDiagnostics: observationAppliesToRequest ? observation.output?.codeBlockDiagnostics || [] : [],
    parserAudit: observationAppliesToRequest ? observation.output?.parserAudit || null : null,
    format: observationAppliesToRequest ? String(observation.output?.format || '') : '',
    raw: observationAppliesToRequest ? String(observation.output?.raw || '') : '',
    turnKey: observationAppliesToRequest ? String(observation.turn?.key || '') : '',
    turnIndex: observationAppliesToRequest ? Number(observation.turn?.index ?? -1) : -1,
    messageId: observationAppliesToRequest ? String(observation.turn?.messageId || '') : '',
    modelSlug: observationAppliesToRequest ? String(observation.turn?.modelSlug || '') : '',
    responseEpoch: evidence.responseEpoch,
    completionCandidate: evidence.candidate,
    completionEvidence: evidence,
    explicitError: observationAppliesToRequest && Boolean(observation.error?.explicit),
    errorMessage: observationAppliesToRequest ? String(observation.error?.message || '') : '',
    conversationChanged,
    requestReplaced,
    scopedToRequest: observationAppliesToRequest,
    meaningful: observationAppliesToRequest && Boolean(
      observation.activeRequest?.requestId
      || observation.generation?.state === GenerationState.ACTIVE
      || observation.output?.state !== OutputState.NONE
      || observation.blocker?.state !== RequestBlocker.NONE
      || Number(observation.artifact?.count) > 0
    ),
    observation,
  }, {
    eventId: String(envelope?.messageId || '') || undefined,
    source: 'tab_observer',
    sourceSequence: Number.isInteger(transportSequence) && transportSequence >= 0
      ? transportSequence
      : Number.isInteger(observationRevision) && observationRevision >= 0 ? observationRevision : undefined,
    causationId: String(envelope?.causationId || ''),
    occurredAt,
    receivedAt: Number(at) || occurredAt,
  });
}
