import {
  ArtifactState,
  GenerationState,
  OutputState,
  RequestBlocker,
  RequestDeadlineKind,
  RequestEffectType,
  RequestLifecycle,
  RequestTerminalCode,
  SourceConnection,
} from './requestEvents.js';
import {
  applyLifecyclePatch,
  artifactContractSatisfied,
  terminalState,
} from './requestPolicy.js';

const DIAGNOSTIC_LIMIT = 50;

export function transitionTime(event) {
  return Number(event?.receivedAt || event?.occurredAt) || 0;
}

export function appendDiagnostics(state, diagnostics = []) {
  if (!diagnostics.length) return state;
  return {
    ...state,
    diagnostics: [...(state.diagnostics || []), ...diagnostics].slice(-DIAGNOSTIC_LIMIT),
  };
}

export function cloneState(state) {
  return {
    ...state,
    source: { ...state.source },
    artifact: { ...state.artifact },
    response: { ...state.response, history: [...(state.response?.history || [])] },
    effect: { ...state.effect },
    completion: { ...state.completion },
    liveness: { ...state.liveness },
    timestamps: { ...state.timestamps },
    terminal: state.terminal ? { ...state.terminal } : null,
    diagnostics: [...(state.diagnostics || [])],
  };
}

export function updateProgressTimestamp(state, event, meaningful = true) {
  const at = transitionTime(event);
  return {
    ...state,
    timestamps: {
      ...state.timestamps,
      meaningfulProgressAt: meaningful ? at : state.timestamps.meaningfulProgressAt,
    },
  };
}

export function eventObservationEpoch(event = {}) {
  return String(event.data?.observationEpoch || event.data?.sourceEpoch || '');
}

export function applySourceData(state, data = {}, event = null) {
  const sourceSequence = event?.sourceSequence ?? data.sourceSequence ?? data.observationSequence;
  const observationEpoch = String(data.observationEpoch || data.sourceEpoch || state.source.observationEpoch || '');
  return {
    ...state,
    source: {
      ...state.source,
      clientId: String(data.clientId || data.sourceClientId || state.source.clientId || ''),
      connection: data.connection || state.source.connection,
      conversationId: String(data.conversationId || data.sessionId || data.session?.id || state.source.conversationId || ''),
      url: String(data.url || state.source.url || ''),
      observationEpoch,
      observationSequence: Number.isInteger(sourceSequence) && sourceSequence >= 0
        ? sourceSequence
        : state.source.observationSequence,
    },
  };
}

export function sourceSequenceDecision(state, event) {
  if (!Number.isInteger(event.sourceSequence)) return null;
  const previous = state.source?.observationSequence;
  if (!Number.isInteger(previous)) return null;
  const currentEpoch = String(state.source?.observationEpoch || '');
  const nextEpoch = eventObservationEpoch(event);
  if (currentEpoch && nextEpoch && currentEpoch !== nextEpoch) return null;
  if (event.sourceSequence === previous) {
    return { code: 'duplicate_source_sequence', message: `Ignored duplicate source sequence ${event.sourceSequence}` };
  }
  if (event.sourceSequence < previous) {
    return { code: 'stale_source_sequence', message: `Ignored stale source sequence ${event.sourceSequence}; current is ${previous}` };
  }
  return null;
}

export function terminalReleaseEffect(state, code, event) {
  const sourceClientId = String(state?.source?.clientId || '');
  if (!sourceClientId) return [];
  return [{
    id: `request-release:${state.requestId}:${event?.eventId || code}`,
    type: RequestEffectType.REQUEST_RELEASE,
    data: {
      requestId: state.requestId,
      sourceClientId,
      terminalCode: code,
      reason: String(event?.data?.message || code || 'request_terminal'),
    },
  }];
}

export function terminalResult(state, code, message, evidence, event, diagnostics = []) {
  const next = appendDiagnostics(
    terminalState(state, code, message, evidence, transitionTime(event)),
    diagnostics,
  );
  return {
    state: next,
    effects: terminalReleaseEffect(next, code, event),
    deadlines: [],
    diagnostics,
  };
}

export function applyObservation(state, event) {
  const data = event.data || {};
  const diagnostics = [];
  let next = applySourceData(state, data, event);
  next = applyLifecyclePatch(next, {
    lifecycle: data.lifecycle,
    submission: data.submission,
    generation: data.generation,
    blocker: data.blocker,
    output: data.output,
    artifactStatus: data.artifactStatus,
  }, diagnostics);
  next = updateProgressTimestamp(next, event, data.meaningful !== false);
  next.lastObservation = {
    kind: 'normalized',
    sourceSequence: event.sourceSequence,
    observedAt: event.occurredAt,
    data,
    responseEpoch: Number(data.responseEpoch ?? state.response?.epoch ?? 0),
  };

  if (data.conversationChanged === true) {
    return terminalResult(next, RequestTerminalCode.CONVERSATION_CHANGED, 'Bound ChatGPT conversation changed', data, event, diagnostics);
  }
  if (data.requestReplaced === true) {
    return terminalResult(next, RequestTerminalCode.REQUEST_REPLACED, 'Source tab replaced the active request', data, event, diagnostics);
  }
  if (data.explicitError === true || next.blocker === RequestBlocker.EXPLICIT_ERROR) {
    return terminalResult(
      next,
      RequestTerminalCode.EXPLICIT_UI_ERROR,
      String(data.message || data.errorMessage || 'ChatGPT reported an explicit request error'),
      data,
      event,
      diagnostics,
    );
  }
  if (data.completionCandidate === true) {
    return applyTerminalSnapshot(appendDiagnostics(next, diagnostics), {
      ...event,
      data: {
        ...data,
        authoritative: true,
        completionSource: 'server_tab_observation_policy',
        finishReason: 'stable_normalized_observation',
      },
    });
  }
  return { state: appendDiagnostics(next, diagnostics), effects: [], deadlines: [], diagnostics };
}

export function applyArtifactUpdate(state, event) {
  const data = event.data || {};
  const count = Math.max(0, Number(data.count ?? data.artifactCount ?? data.artifacts?.length ?? state.artifact.count) || 0);
  const status = data.status
    || data.artifactStatus
    || (!state.artifact.required && count > 0 ? ArtifactState.READY : state.artifact.status);
  let next = {
    ...state,
    artifact: { ...state.artifact, count, status },
  };
  next = updateProgressTimestamp(next, event, data.meaningful !== false);
  if (next.completion.pending && artifactContractSatisfied(next)) {
    const completed = terminalState(
      {
        ...next,
        completion: {
          ...next.completion,
          pending: false,
          nextProbeAt: 0,
        },
        output: OutputState.FINAL,
      },
      RequestTerminalCode.COMPLETED,
      'Request completed after required artifact became ready',
      next.completion.evidence || data,
      transitionTime(event),
    );
    return {
      state: completed,
      effects: terminalReleaseEffect(completed, RequestTerminalCode.COMPLETED, event),
      deadlines: [],
      diagnostics: [],
    };
  }
  return { state: next, effects: [], deadlines: [], diagnostics: [] };
}

export function applyTerminalSnapshot(state, event) {
  const data = event.data || {};
  let next = {
    ...state,
    generation: GenerationState.STOPPED,
    blocker: RequestBlocker.NONE,
    output: OutputState.FINAL,
  };
  if (data.artifactStatus || data.artifactCount != null || Array.isArray(data.artifacts)) {
    next = applyArtifactUpdate(next, {
      ...event,
      data: {
        status: data.artifactStatus,
        artifactCount: data.artifactCount,
        artifacts: data.artifacts,
        meaningful: true,
      },
    }).state;
  }
  if (!artifactContractSatisfied(next)) {
    const at = transitionTime(event);
    const settleDeadlineAt = Number(data.artifactSettleDeadlineAt) > 0
      ? Number(data.artifactSettleDeadlineAt)
      : 0;
    const firstProbeAt = Number(data.artifactProbeAt) > 0
      ? Number(data.artifactProbeAt)
      : at + 500;
    const deadlines = [
      settleDeadlineAt > 0 ? {
        id: String(data.artifactDeadlineId || `artifact-settle:${state.requestId}:${settleDeadlineAt}`),
        kind: RequestDeadlineKind.ARTIFACT_SETTLE,
        type: RequestDeadlineKind.ARTIFACT_SETTLE,
        dueAt: settleDeadlineAt,
      } : null,
      firstProbeAt > 0 ? {
        id: String(data.artifactProbeDeadlineId || `artifact-probe:${state.requestId}:${firstProbeAt}`),
        kind: RequestDeadlineKind.ARTIFACT_PROBE,
        type: RequestDeadlineKind.ARTIFACT_PROBE,
        dueAt: firstProbeAt,
        attempt: 1,
        delayMs: Math.max(0, firstProbeAt - at),
      } : null,
    ].filter(Boolean);
    return {
      state: {
        ...next,
        lifecycle: RequestLifecycle.ARTIFACT_SETTLING,
        completion: {
          pending: true,
          requestedAt: at,
          deadlineAt: settleDeadlineAt,
          probeAttempt: 0,
          nextProbeAt: firstProbeAt,
          lastProbeAt: 0,
          evidence: data,
        },
        artifact: { ...next.artifact, status: ArtifactState.PENDING },
      },
      effects: [],
      deadlines,
      diagnostics: [{ code: 'completion_waits_for_required_artifact', message: 'Visible response completed before the required artifact was ready' }],
    };
  }
  return terminalResult(next, RequestTerminalCode.COMPLETED, String(data.message || 'Request completed'), data, event);
}

