import {
  ArtifactExpectation,
  ArtifactState,
  GenerationState,
  OutputState,
  REQUEST_STATE_SCHEMA_VERSION,
  RequestBlocker,
  RequestLifecycle,
  RequestTerminalCode,
  SourceConnection,
  SubmissionState,
} from './requestEvents.js';

const LIFECYCLE_RANK = Object.freeze({
  [RequestLifecycle.CREATED]: 0,
  [RequestLifecycle.TARGETING_SOURCE]: 1,
  [RequestLifecycle.PREPARING]: 2,
  [RequestLifecycle.SUBMITTING]: 3,
  [RequestLifecycle.SUBMITTED]: 4,
  [RequestLifecycle.AWAITING_ASSISTANT]: 5,
  [RequestLifecycle.GENERATING]: 6,
  [RequestLifecycle.FINALIZING]: 7,
  [RequestLifecycle.ARTIFACT_SETTLING]: 8,
  [RequestLifecycle.COMPLETED]: 9,
  [RequestLifecycle.FAILED]: 9,
  [RequestLifecycle.CANCELLED]: 9,
});

export function normalizeArtifactExpectation(expectedOutput = {}) {
  if (!expectedOutput?.required) return ArtifactExpectation.NONE;
  const expected = String(expectedOutput.expected || expectedOutput.format || '').trim().toLowerCase();
  return expected === 'zip' ? ArtifactExpectation.ZIP : ArtifactExpectation.FILE;
}

export function createInitialRequestState(options = {}) {
  const at = Number(options.at) || 0;
  const expectation = normalizeArtifactExpectation(options.expectedOutput);
  return {
    schemaVersion: REQUEST_STATE_SCHEMA_VERSION,
    requestId: String(options.requestId || ''),
    revision: 0,
    lifecycle: options.resumed ? RequestLifecycle.AWAITING_ASSISTANT : RequestLifecycle.CREATED,
    source: {
      clientId: String(options.sourceClientId || ''),
      connection: options.sourceClientId ? SourceConnection.CONNECTED : SourceConnection.UNKNOWN,
      conversationId: String(options.conversationId || options.sessionId || ''),
      url: String(options.url || ''),
      observationEpoch: '',
      observationSequence: null,
    },
    submission: options.resumed ? SubmissionState.SUBMITTED : SubmissionState.PENDING,
    generation: GenerationState.IDLE,
    blocker: RequestBlocker.NONE,
    output: OutputState.NONE,
    artifact: {
      expectation,
      required: expectation !== ArtifactExpectation.NONE,
      status: expectation === ArtifactExpectation.NONE ? ArtifactState.NOT_EXPECTED : ArtifactState.PENDING,
      count: 0,
    },
    effect: {
      activeId: null,
      activeType: null,
      startedAt: 0,
      lastResult: null,
    },
    completion: {
      pending: false,
      requestedAt: 0,
      deadlineAt: 0,
      probeAttempt: 0,
      nextProbeAt: 0,
      lastProbeAt: 0,
      evidence: null,
    },
    liveness: {
      lastForcedSnapshotAt: 0,
      lastDeadline: null,
    },
    terminal: null,
    timestamps: {
      createdAt: at,
      transitionedAt: at,
      meaningfulProgressAt: at,
      heartbeatAt: 0,
    },
    lastObservation: null,
    diagnostics: [],
  };
}

export function isTerminalRequestState(state) {
  return Boolean(state?.terminal);
}

export function canAdvanceLifecycle(current, next) {
  if (!next || current === next) return true;
  if (current === RequestLifecycle.GENERATING && next === RequestLifecycle.AWAITING_ASSISTANT) return true;
  if (current === RequestLifecycle.FINALIZING && next === RequestLifecycle.GENERATING) return true;
  return (LIFECYCLE_RANK[next] ?? -1) >= (LIFECYCLE_RANK[current] ?? -1);
}

export function applyLifecyclePatch(state, patch = {}, diagnostics = []) {
  const next = { ...state };
  if (patch.lifecycle && canAdvanceLifecycle(state.lifecycle, patch.lifecycle)) {
    next.lifecycle = patch.lifecycle;
  } else if (patch.lifecycle && patch.lifecycle !== state.lifecycle) {
    diagnostics.push({
      code: 'legacy_lifecycle_regression_ignored',
      message: `Ignored lifecycle regression ${state.lifecycle} -> ${patch.lifecycle}`,
      from: state.lifecycle,
      to: patch.lifecycle,
    });
  }
  if (patch.submission) next.submission = patch.submission;
  if (patch.generation) next.generation = patch.generation;
  if (patch.blocker) next.blocker = patch.blocker;
  if (patch.output) next.output = patch.output;
  if (patch.artifactStatus) next.artifact = { ...state.artifact, status: patch.artifactStatus };
  return next;
}

export function terminalState(state, code, message, evidence = null, at = 0) {
  const cancelled = code === RequestTerminalCode.CANCELLED;
  const completed = code === RequestTerminalCode.COMPLETED;
  return {
    ...state,
    lifecycle: completed
      ? RequestLifecycle.COMPLETED
      : cancelled ? RequestLifecycle.CANCELLED : RequestLifecycle.FAILED,
    generation: GenerationState.STOPPED,
    effect: {
      ...state.effect,
      activeId: null,
      activeType: null,
    },
    completion: {
      ...state.completion,
      pending: false,
      nextProbeAt: 0,
    },
    terminal: {
      code,
      message: String(message || code),
      evidence,
      at,
    },
  };
}

export function artifactContractSatisfied(state) {
  if (!state?.artifact?.required) return true;
  return state.artifact.status === ArtifactState.READY;
}
