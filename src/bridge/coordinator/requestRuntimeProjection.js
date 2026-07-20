import { GenerationState, SubmissionState } from '../state/requestEvents.js';

export function requestRuntime(state) {
  if (!state) return null;
  if (!state.runtime || typeof state.runtime !== 'object') {
    state.runtime = { finished: false, cancellationRequested: false };
  }
  return state.runtime;
}

export function isRequestRuntimeFinished(state) {
  return Boolean(state?.runtime?.finished);
}

export function markRequestRuntimeFinished(state) {
  const runtime = requestRuntime(state);
  if (!runtime || runtime.finished) return false;
  runtime.finished = true;
  return true;
}

export function isCancellationRequested(state) {
  return Boolean(state?.runtime?.cancellationRequested);
}

export function markCancellationRequested(state) {
  const runtime = requestRuntime(state);
  if (!runtime || runtime.cancellationRequested) return false;
  runtime.cancellationRequested = true;
  return true;
}

export function canonicalPromptAccepted(canonical = null) {
  return Boolean(canonical && canonical.submission !== SubmissionState.PENDING);
}

export function canonicalPromptSubmitted(canonical = null) {
  return canonical?.submission === SubmissionState.SUBMITTED;
}

export function canonicalGenerationActive(canonical = null) {
  return canonical?.generation === GenerationState.ACTIVE;
}
