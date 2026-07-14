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
  if (observation.activeRequest?.requestId && currentState?.submission === 'submitted') return RequestLifecycle.AWAITING_ASSISTANT;
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

function blockerState(observation = {}) {
  const value = String(observation.blocker?.state || '');
  return Object.values(RequestBlocker).includes(value) ? value : undefined;
}

function generationState(observation = {}) {
  const value = String(observation.generation?.state || '');
  return Object.values(GenerationState).includes(value) ? value : undefined;
}

function outputState(observation = {}) {
  const value = String(observation.output?.state || '');
  return Object.values(OutputState).includes(value) ? value : undefined;
}

function normalizedConversationId(value = '') {
  const id = String(value || '').trim();
  return id === 'new' ? '' : id;
}

export function tabObservationToCanonicalEvent(requestId, clientId, payload = {}, currentState = null, at = 0) {
  const observation = observationPayload(payload);
  if (!requestId || !observation) return null;

  const observedRequestId = String(observation.activeRequest?.requestId || '');
  const expectedConversationId = normalizedConversationId(currentState?.source?.conversationId || '');
  const observedConversationId = normalizedConversationId(observation.conversationId || '');
  const bindingEstablished = currentState?.submission === SubmissionState.ACCEPTED
    || currentState?.submission === SubmissionState.SUBMITTED;
  const observationAppliesToRequest = bindingEstablished || observedRequestId === requestId;
  const requestReplaced = Boolean(
    bindingEstablished
    && observedRequestId
    && observedRequestId !== requestId,
  );
  const conversationChanged = Boolean(
    bindingEstablished
    && expectedConversationId
    && observedConversationId
    && expectedConversationId !== observedConversationId,
  );
  const occurredAt = Number(observation.observedAt || payload.observedAt || at) || 0;
  const revision = Number(observation.revision ?? payload.revision);

  return createRequestEvent(RequestEventType.OBSERVATION_UPDATED, requestId, {
    clientId,
    url: observation.url || payload.url || '',
    conversationId: bindingEstablished
      ? observation.conversationId || payload.session?.id || ''
      : '',
    observationEpoch: String(observation.observerId || ''),
    lifecycle: observationAppliesToRequest ? lifecycleFromObservation(observation, currentState) : undefined,
    generation: observationAppliesToRequest ? generationState(observation) : undefined,
    blocker: observationAppliesToRequest ? blockerState(observation) : undefined,
    output: observationAppliesToRequest ? outputState(observation) : undefined,
    artifactStatus: observationAppliesToRequest
      ? (currentState?.artifact?.required && artifactStatus(observation) === ArtifactState.READY
        ? undefined
        : artifactStatus(observation))
      : undefined,
    artifactCount: observationAppliesToRequest ? Number(observation.artifact?.count) || 0 : undefined,
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
    source: 'tab_observer',
    sourceSequence: Number.isInteger(revision) && revision >= 0 ? revision : undefined,
    occurredAt,
    receivedAt: Number(at) || occurredAt,
  });
}
