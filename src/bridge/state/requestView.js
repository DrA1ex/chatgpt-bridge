import {
  OutputState,
  RequestBlocker,
  RequestLifecycle,
  SubmissionState,
} from './requestEvents.js';

export function displayPhaseForState(state = {}) {
  if (state.terminal?.code === 'cancelled') return 'cancelled';
  if (state.terminal && state.lifecycle === RequestLifecycle.FAILED) return 'failed';
  if (state.lifecycle === RequestLifecycle.COMPLETED) return 'completed';
  if (state.lifecycle === RequestLifecycle.ARTIFACT_SETTLING) return 'artifact_settling';
  if (state.blocker === RequestBlocker.CONFIRMATION) return 'needs_confirmation';
  if (state.blocker === RequestBlocker.CONTINUE) return 'needs_continue';
  if (state.lifecycle === RequestLifecycle.FINALIZING) return 'finalizing';
  if (state.lifecycle === RequestLifecycle.GENERATING) {
    if (state.output === OutputState.REASONING) return 'reasoning';
    if (state.output === OutputState.STREAMING) return 'streaming';
    return 'generating';
  }
  if (state.lifecycle === RequestLifecycle.AWAITING_ASSISTANT) return 'awaiting_assistant';
  if (state.lifecycle === RequestLifecycle.SUBMITTED) return 'submitted';
  if (state.submission === SubmissionState.ACCEPTED) return 'accepted';
  if (state.lifecycle === RequestLifecycle.PREPARING) return 'preparing';
  return state.lifecycle || 'unknown';
}

export function compactCanonicalRequestState(state = null) {
  if (!state) return null;
  return {
    schemaVersion: state.schemaVersion,
    requestId: state.requestId,
    revision: state.revision,
    lifecycle: state.lifecycle,
    displayPhase: displayPhaseForState(state),
    submission: state.submission,
    generation: state.generation,
    blocker: state.blocker,
    output: state.output,
    source: state.source,
    artifact: state.artifact,
    effect: state.effect,
    completion: state.completion,
    liveness: state.liveness,
    terminal: state.terminal,
    timestamps: state.timestamps,
    lastObservation: state.lastObservation,
    diagnostics: Array.isArray(state.diagnostics) ? state.diagnostics.slice(-10) : [],
  };
}
