import {
  GenerationState,
  RequestDeadlineKind,
  RequestLifecycle,
  SourceConnection,
} from '../state/requestEvents.js';

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function requestTime(state, field, fallback = 0) {
  return positive(state?.timestamps?.[field], fallback);
}

function timeoutForState(state, options) {
  const postGeneration = state.lifecycle === RequestLifecycle.FINALIZING
    || state.lifecycle === RequestLifecycle.ARTIFACT_SETTLING;
  return postGeneration ? options.postGenerationTimeoutMs : options.meaningfulProgressTimeoutMs;
}

function intent(state, kind, dueAt, details = {}) {
  const normalizedDueAt = Math.max(0, Number(dueAt) || 0);
  return {
    id: `${kind}:${state.requestId}:${normalizedDueAt}`,
    kind,
    type: kind,
    dueAt: normalizedDueAt,
    scheduledRevision: Number(state.revision) || 0,
    ...details,
  };
}

export function normalizeRequestDeadlineOptions(options = {}) {
  return {
    meaningfulProgressTimeoutMs: positive(options.meaningfulProgressTimeoutMs, 120_000),
    postGenerationTimeoutMs: positive(options.postGenerationTimeoutMs, 60_000),
    hardLivenessTimeoutMs: positive(options.hardLivenessTimeoutMs, 60_000),
    forcedSnapshotAfterMs: positive(options.forcedSnapshotAfterMs, 90_000),
    forcedSnapshotCooldownMs: positive(options.forcedSnapshotCooldownMs, 60_000),
  };
}

export function deadlineIntentsForRequest(state, rawOptions = {}) {
  if (!state || state.terminal) return [];
  const options = normalizeRequestDeadlineOptions(rawOptions);
  const intents = [];
  const createdAt = requestTime(state, 'createdAt', 0);
  const meaningfulAt = requestTime(state, 'meaningfulProgressAt', createdAt);
  const timeoutMs = timeoutForState(state, options);

  if (state.source?.connection === SourceConnection.DISCONNECTED) {
    intents.push(intent(
      state,
      RequestDeadlineKind.SOURCE_RECONNECT,
      meaningfulAt + timeoutMs,
      {
        timeoutMs,
        message: `Source ChatGPT tab/client remained disconnected in phase ${state.lifecycle}`,
      },
    ));
    return intents;
  }

  const heartbeatAt = requestTime(state, 'heartbeatAt', 0);
  if (state.source?.clientId && heartbeatAt > 0) {
    intents.push(intent(
      state,
      RequestDeadlineKind.HARD_LIVENESS,
      heartbeatAt + options.hardLivenessTimeoutMs,
      {
        timeoutMs: options.hardLivenessTimeoutMs,
        message: 'Source ChatGPT tab/client stopped sending heartbeats',
      },
    ));
  }

  if (state.lifecycle === RequestLifecycle.ARTIFACT_SETTLING) {
    const completionDeadline = positive(state.completion?.deadlineAt, 0);
    const nextProbeAt = positive(state.completion?.nextProbeAt, 0);
    if (completionDeadline > 0) {
      intents.push(intent(
        state,
        RequestDeadlineKind.ARTIFACT_SETTLE,
        completionDeadline,
        {
          timeoutMs: Math.max(0, completionDeadline - Number(state.completion?.requestedAt || 0)),
          message: 'Required artifact did not become ready before the settle deadline',
        },
      ));
    }
    if (nextProbeAt > 0 && (!completionDeadline || nextProbeAt < completionDeadline) && !state.effect?.activeId) {
      intents.push(intent(
        state,
        RequestDeadlineKind.ARTIFACT_PROBE,
        nextProbeAt,
        {
          attempt: Number(state.completion?.probeAttempt || 0) + 1,
          delayMs: Math.max(0, nextProbeAt - Number(state.completion?.lastProbeAt || state.completion?.requestedAt || 0)),
          message: 'Probe the source tab for the required artifact',
        },
      ));
    }
    return intents;
  }

  if (state.source?.clientId && !state.effect?.activeId) {
    const lastForcedAt = positive(state.liveness?.lastForcedSnapshotAt, 0);
    const dueAt = Math.max(
      meaningfulAt + options.forcedSnapshotAfterMs,
      lastForcedAt ? lastForcedAt + options.forcedSnapshotCooldownMs : 0,
    );
    intents.push(intent(
      state,
      RequestDeadlineKind.FORCED_SNAPSHOT,
      dueAt,
      {
        generationActive: state.generation === GenerationState.ACTIVE,
        message: state.generation === GenerationState.ACTIVE
          ? 'Generation is active without visible progress; request a source-bound snapshot'
          : 'Meaningful request progress stalled; request a source-bound snapshot',
      },
    ));
  }

  if (state.generation !== GenerationState.ACTIVE) {
    intents.push(intent(
      state,
      RequestDeadlineKind.PROGRESS_LIVENESS,
      meaningfulAt + timeoutMs,
      {
        timeoutMs,
        phase: state.lifecycle,
        message: `Timed out waiting for ChatGPT request progress after ${timeoutMs}ms in phase ${state.lifecycle}`,
      },
    ));
  }

  return intents;
}
