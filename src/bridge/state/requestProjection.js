import {
  ArtifactState,
  GenerationState,
  OutputState,
  RequestBlocker,
  RequestLifecycle,
  SubmissionState,
} from './requestEvents.js';

const PHASE_PROJECTIONS = Object.freeze({
  created: { lifecycle: RequestLifecycle.CREATED },
  resumed: { lifecycle: RequestLifecycle.AWAITING_ASSISTANT },
  reattached: {},
  prompt_delivered_to_extension: { lifecycle: RequestLifecycle.PREPARING },
  prompt_accepted_by_content_script: {
    lifecycle: RequestLifecycle.PREPARING,
    submission: SubmissionState.ACCEPTED,
  },
  attachments_uploading: { lifecycle: RequestLifecycle.PREPARING },
  prompt_submitted: {
    lifecycle: RequestLifecycle.SUBMITTED,
    submission: SubmissionState.SUBMITTED,
  },
  steer_submitted: {
    lifecycle: RequestLifecycle.SUBMITTED,
    submission: SubmissionState.SUBMITTED,
  },
  waiting_for_user_turn: { lifecycle: RequestLifecycle.SUBMITTED },
  waiting_for_assistant_turn: { lifecycle: RequestLifecycle.AWAITING_ASSISTANT },
  waiting_for_assistant_output: { lifecycle: RequestLifecycle.AWAITING_ASSISTANT },
  generating: {
    lifecycle: RequestLifecycle.GENERATING,
    generation: GenerationState.ACTIVE,
  },
  assistant_reasoning: {
    lifecycle: RequestLifecycle.GENERATING,
    generation: GenerationState.ACTIVE,
    output: OutputState.REASONING,
  },
  tool_running: {
    lifecycle: RequestLifecycle.GENERATING,
    generation: GenerationState.ACTIVE,
    output: OutputState.REASONING,
  },
  assistant_final_streaming: {
    lifecycle: RequestLifecycle.GENERATING,
    generation: GenerationState.ACTIVE,
    output: OutputState.STREAMING,
  },
  needs_confirmation: { blocker: RequestBlocker.CONFIRMATION },
  needs_continue: { blocker: RequestBlocker.CONTINUE },
  steer_available: { blocker: RequestBlocker.CONTINUE },
  continuation_wait: { blocker: RequestBlocker.CONTINUE },
  finalizing: {
    lifecycle: RequestLifecycle.FINALIZING,
    generation: GenerationState.STOPPED,
  },
  post_stop_settle: {
    lifecycle: RequestLifecycle.FINALIZING,
    generation: GenerationState.STOPPED,
  },
  artifact_settle: {
    lifecycle: RequestLifecycle.ARTIFACT_SETTLING,
    generation: GenerationState.STOPPED,
    artifactStatus: ArtifactState.PENDING,
  },
  final_snapshot_ready: {
    lifecycle: RequestLifecycle.FINALIZING,
    generation: GenerationState.STOPPED,
    output: OutputState.FINAL,
  },
  completed: {
    lifecycle: RequestLifecycle.COMPLETED,
    generation: GenerationState.STOPPED,
    output: OutputState.FINAL,
  },
  failed: {
    lifecycle: RequestLifecycle.FAILED,
    generation: GenerationState.STOPPED,
  },
  cancelled: {
    lifecycle: RequestLifecycle.CANCELLED,
    generation: GenerationState.STOPPED,
  },
});

export const KNOWN_LEGACY_REQUEST_PHASES = Object.freeze(Object.keys(PHASE_PROJECTIONS));

export function projectLegacyPhase(phase, payload = {}) {
  const normalizedPhase = String(phase || '').trim().toLowerCase() || 'unknown';
  const knownProjection = PHASE_PROJECTIONS[normalizedPhase] || null;
  const patch = knownProjection ? { ...knownProjection } : {};

  if (Object.hasOwn(payload, 'generating') || Object.hasOwn(payload, 'stopButtonVisible')) {
    patch.generation = payload.generating || payload.stopButtonVisible
      ? GenerationState.ACTIVE
      : GenerationState.STOPPED;
  }
  if (payload.needsConfirmation === true) patch.blocker = RequestBlocker.CONFIRMATION;
  else if (payload.needsContinue === true || payload.continueButtonVisible === true) patch.blocker = RequestBlocker.CONTINUE;
  else if (payload.explicitError === true || payload.error === true) patch.blocker = RequestBlocker.EXPLICIT_ERROR;
  else if (payload.needsConfirmation === false && payload.needsContinue === false) patch.blocker = RequestBlocker.NONE;

  if (Number(payload.answerLength) > 0 && patch.output !== OutputState.FINAL) {
    patch.output = patch.generation === GenerationState.ACTIVE ? OutputState.STREAMING : OutputState.FINAL;
  } else if (Number(payload.thinkingLength) > 0 && patch.output == null) {
    patch.output = OutputState.REASONING;
  }

  if (Number(payload.artifactCount) > 0) patch.artifactStatus = ArtifactState.READY;

  return {
    phase: normalizedPhase,
    known: Boolean(knownProjection),
    patch,
    diagnostic: knownProjection ? null : {
      code: 'unknown_legacy_phase',
      message: `No canonical request-state projection exists for legacy phase: ${normalizedPhase}`,
      phase: normalizedPhase,
    },
  };
}

export function compatibilityPhaseForState(state = {}) {
  if (state.terminal?.code === 'cancelled') return 'cancelled';
  if (state.terminal && state.lifecycle === RequestLifecycle.FAILED) return 'failed';
  if (state.lifecycle === RequestLifecycle.COMPLETED) return 'completed';
  if (state.lifecycle === RequestLifecycle.ARTIFACT_SETTLING) return 'artifact_settle';
  if (state.blocker === RequestBlocker.CONFIRMATION) return 'needs_confirmation';
  if (state.blocker === RequestBlocker.CONTINUE) return 'needs_continue';
  if (state.lifecycle === RequestLifecycle.FINALIZING) return 'post_stop_settle';
  if (state.lifecycle === RequestLifecycle.GENERATING) {
    if (state.output === OutputState.REASONING) return 'assistant_reasoning';
    if (state.output === OutputState.STREAMING) return 'assistant_final_streaming';
    return 'generating';
  }
  if (state.lifecycle === RequestLifecycle.AWAITING_ASSISTANT) return 'waiting_for_assistant_turn';
  if (state.lifecycle === RequestLifecycle.SUBMITTED) return 'prompt_submitted';
  if (state.submission === SubmissionState.ACCEPTED) return 'prompt_accepted_by_content_script';
  if (state.lifecycle === RequestLifecycle.PREPARING) return 'prompt_delivered_to_extension';
  return state.lifecycle || 'unknown';
}

export function compactCanonicalRequestState(state = null) {
  if (!state) return null;
  return {
    schemaVersion: state.schemaVersion,
    requestId: state.requestId,
    revision: state.revision,
    lifecycle: state.lifecycle,
    compatibilityPhase: compatibilityPhaseForState(state),
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
