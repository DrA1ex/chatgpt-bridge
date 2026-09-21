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

function isTemporaryConversationId(value = '') {
  return /^WEB:/i.test(normalizedConversationId(value));
}

function conversationBoundaryMatches({
  observationAppliesToRequest,
  submittedUserTurnKey,
  contentSubmittedUserTurnKey,
  observedUserTurnKey,
} = {}) {
  if (!observationAppliesToRequest || !submittedUserTurnKey) return false;
  if (observedUserTurnKey) return submittedUserTurnKey === observedUserTurnKey;
  return submittedUserTurnKey === contentSubmittedUserTurnKey;
}

function canonicalSubmittedUserTurnKey(currentState = null) {
  const direct = String(currentState?.response?.userTurnKey || '');
  if (direct) return direct;
  const previous = currentState?.lastObservation?.data || null;
  if (previous?.responseBoundaryEstablished !== true || previous?.scopedToRequest !== true) return '';
  return String(previous.submittedUserTurnKey || previous.observation?.turn?.userKey || '');
}

function previousResponseUserTurnKey(currentState = null) {
  const history = Array.isArray(currentState?.response?.history) ? currentState.response.history : [];
  return String(history.at(-1)?.userTurnKey || '');
}

function steerContinuationBoundaryMatches({
  currentState,
  observationAppliesToRequest,
  submittedUserTurnKey,
  contentSubmittedUserTurnKey,
  observedUserTurnKey,
} = {}) {
  if (!observationAppliesToRequest || !submittedUserTurnKey || !observedUserTurnKey) return false;
  if (Math.max(0, Number(currentState?.response?.epoch) || 0) < 1) return false;
  if (contentSubmittedUserTurnKey !== submittedUserTurnKey) return false;
  const originalUserTurnKey = previousResponseUserTurnKey(currentState);
  return Boolean(originalUserTurnKey && observedUserTurnKey === originalUserTurnKey);
}

function terminalEvidence(observation, currentState, requestId, applies, submittedUserTurnKey = '') {
  const common = classifyTurnObservation(observation);
  const active = observation.activeRequest || null;
  const transientErrorAfterFinalOutput = Boolean(
    observation.error?.explicit === true
    && observation.error?.retryable === true
    && String(observation.error?.code || '') === 'CHATGPT_TRANSIENT_REQUEST_ERROR'
    && observation.generation?.state === GenerationState.STOPPED
    && observation.output?.state === OutputState.FINAL
    && observation.output?.finalMessage === true
    && observation.output?.actionBarVisible === true
    && Boolean(
      String(observation.output?.answer || '').trim()
      || (Array.isArray(observation.artifacts) && observation.artifacts.length)
    )
    && common.assistantTurnKey
  );
  const expectedResponseEpoch = Number(currentState?.response?.epoch || 0);
  // The server owns the response epoch. A reloaded content runtime may only
  // reconstruct the physical lease and therefore cannot be trusted to retain
  // this canonical boundary projection.
  const responseEpoch = expectedResponseEpoch;
  const scoped = Boolean(active?.requestId === requestId && applies);
  const responseMatches = true;
  const submittedBoundary = Boolean(submittedUserTurnKey);
  const assistantBoundary = Boolean(common.assistantTurnKey || active?.assistantTurnKey);
  const candidate = Boolean(
    (common.terminalCandidate || transientErrorAfterFinalOutput)
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
    transientErrorAfterFinalOutput,
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
  const observationAppliesToRequest = observedRequestId === requestId;
  const contentSubmittedUserTurnKey = String(observation.activeRequest?.submittedUserTurnKey || '');
  const submittedUserTurnKey = canonicalSubmittedUserTurnKey(currentState) || contentSubmittedUserTurnKey;
  const observedUserTurnKey = String(observation.turn?.userKey || '');
  const directResponseBoundary = currentState?.submission === SubmissionState.SUBMITTED
    && Boolean(submittedUserTurnKey)
    && submittedUserTurnKey === observedUserTurnKey;
  const steerContinuationBoundary = currentState?.submission === SubmissionState.SUBMITTED
    && steerContinuationBoundaryMatches({
      currentState,
      observationAppliesToRequest,
      submittedUserTurnKey,
      contentSubmittedUserTurnKey,
      observedUserTurnKey,
    });
  const responseBoundaryEstablished = directResponseBoundary || steerContinuationBoundary;
  const responseAppliesToRequest = observationAppliesToRequest && responseBoundaryEstablished;
  const requestReplaced = Boolean(bindingEstablished && observedRequestId && observedRequestId !== requestId);
  const conversationIdChanged = Boolean(
    bindingEstablished
    && expectedConversationId
    && observedConversationId
    && expectedConversationId !== observedConversationId
  );
  const conversationCanonicalized = Boolean(
    conversationIdChanged
    && isTemporaryConversationId(expectedConversationId)
    && !isTemporaryConversationId(observedConversationId)
    && conversationBoundaryMatches({
      observationAppliesToRequest,
      submittedUserTurnKey,
      contentSubmittedUserTurnKey,
      observedUserTurnKey,
    })
  );
  const conversationChanged = conversationIdChanged && !conversationCanonicalized;
  const occurredAt = Number(observation.observedAt || payload.observedAt || at) || 0;
  const observationRevision = Number(observation.revision ?? payload.revision);
  const transportSequence = Number(envelope?.source?.sequence);
  const evidence = terminalEvidence(observation, currentState, requestId, responseAppliesToRequest, submittedUserTurnKey);
  const artifacts = responseAppliesToRequest && Array.isArray(observation.artifacts)
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
    lifecycle: responseAppliesToRequest ? lifecycleFromObservation(observation, currentState) : undefined,
    generation: responseAppliesToRequest ? enumValue(GenerationState, observation.generation?.state) : undefined,
    blocker: observationAppliesToRequest ? enumValue(RequestBlocker, observation.blocker?.state) : undefined,
    output: responseAppliesToRequest ? enumValue(OutputState, observation.output?.state) : undefined,
    artifactStatus: responseAppliesToRequest
      ? (currentState?.artifact?.required && artifactStatus(observation) === ArtifactState.READY
        ? undefined
        : artifactStatus(observation))
      : undefined,
    artifactCount: responseAppliesToRequest ? Number(observation.artifact?.count) || 0 : undefined,
    artifacts,
    answer: responseAppliesToRequest ? String(observation.output?.answer || '') : '',
    thinking: responseAppliesToRequest ? String(observation.output?.thinking || '') : '',
    progress: responseAppliesToRequest ? String(observation.output?.progress || '') : '',
    progressItems: responseAppliesToRequest ? observation.output?.progressItems || [] : [],
    reasoningHistory: responseAppliesToRequest ? observation.output?.reasoningHistory || [] : [],
    responseBlocks: responseAppliesToRequest ? observation.output?.responseBlocks || [] : [],
    codeBlocks: responseAppliesToRequest ? observation.output?.codeBlocks || [] : [],
    codeBlockDiagnostics: responseAppliesToRequest ? observation.output?.codeBlockDiagnostics || [] : [],
    parserAudit: responseAppliesToRequest ? observation.output?.parserAudit || null : null,
    format: responseAppliesToRequest ? String(observation.output?.format || '') : '',
    raw: responseAppliesToRequest ? String(observation.output?.raw || '') : '',
    turnKey: responseAppliesToRequest ? String(observation.turn?.key || '') : '',
    turnIndex: responseAppliesToRequest ? Number(observation.turn?.index ?? -1) : -1,
    messageId: responseAppliesToRequest ? String(observation.turn?.messageId || '') : '',
    modelSlug: responseAppliesToRequest ? String(observation.turn?.modelSlug || '') : '',
    responseEpoch: evidence.responseEpoch,
    completionCandidate: evidence.candidate,
    completionEvidence: evidence,
    explicitError: observationAppliesToRequest && Boolean(observation.error?.explicit),
    errorMessage: observationAppliesToRequest ? String(observation.error?.message || '') : '',
    errorCode: observationAppliesToRequest ? String(observation.error?.code || '') : '',
    errorKind: observationAppliesToRequest ? String(observation.error?.kind || '') : '',
    errorRetryable: observationAppliesToRequest && Boolean(observation.error?.retryable),
    failedUserTurnKey: observationAppliesToRequest ? String(observation.error?.userTurnKey || '') : '',
    conversationChanged,
    conversationCanonicalized,
    previousConversationId: conversationCanonicalized ? expectedConversationId : '',
    requestReplaced,
    scopedToRequest: responseAppliesToRequest,
    leaseScopedToRequest: observationAppliesToRequest,
    responseBoundaryEstablished,
    steerContinuationBoundary,
    originalSubmittedUserTurnKey: steerContinuationBoundary ? observedUserTurnKey : '',
    submittedUserTurnKey: responseBoundaryEstablished ? submittedUserTurnKey : '',
    meaningful: responseAppliesToRequest && Boolean(
      observation.generation?.state === GenerationState.ACTIVE
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
