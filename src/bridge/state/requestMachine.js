import {
  ArtifactState,
  GenerationState,
  OutputState,
  RequestBlocker,
  RequestDeadlineKind,
  RequestEffectType,
  RequestEventType,
  RequestLifecycle,
  RequestTerminalCode,
  SourceConnection,
  SubmissionState,
  isRequestEvent,
} from './requestEvents.js';
import { requestStateInvariantViolations } from './requestInvariants.js';
import {
  applyLifecyclePatch,
  artifactContractSatisfied,
  createInitialRequestState,
  isTerminalRequestState,
} from './requestPolicy.js';

import {
  appendDiagnostics,
  applyArtifactUpdate,
  applyObservation,
  applySourceData,
  applyTerminalSnapshot,
  cloneState,
  sourceSequenceDecision,
  terminalResult,
  transitionTime,
  updateProgressTimestamp,
} from './requestTransitions.js';

function handleEvent(state, event) {
  const data = event.data || {};
  const at = transitionTime(event);
  switch (event.type) {
    case RequestEventType.SOURCE_BOUND:
      return {
        state: updateProgressTimestamp(applyLifecyclePatch(applySourceData(state, {
          ...data,
          connection: SourceConnection.CONNECTED,
        }, event), { lifecycle: RequestLifecycle.PREPARING }), event),
        effects: [], deadlines: [], diagnostics: [],
      };
    case RequestEventType.PROMPT_DELIVERED:
      return {
        state: updateProgressTimestamp(applyLifecyclePatch(state, { lifecycle: RequestLifecycle.PREPARING }), event),
        effects: [], deadlines: [], diagnostics: [],
      };
    case RequestEventType.PROMPT_ACCEPTED:
      return {
        state: updateProgressTimestamp(applyLifecyclePatch(state, {
          lifecycle: RequestLifecycle.PREPARING,
          submission: SubmissionState.ACCEPTED,
        }), event),
        effects: [], deadlines: [], diagnostics: [],
      };
    case RequestEventType.PROMPT_SUBMITTED:
      return {
        state: updateProgressTimestamp(applyLifecyclePatch(state, {
          lifecycle: RequestLifecycle.SUBMITTED,
          submission: SubmissionState.SUBMITTED,
        }), event),
        effects: [], deadlines: [], diagnostics: [],
      };
    case RequestEventType.OBSERVATION_UPDATED:
      return applyObservation(state, event);
    case RequestEventType.OUTPUT_UPDATED: {
      const output = data.final === true
        ? OutputState.FINAL
        : Number(data.answerLength) > 0 ? OutputState.STREAMING
          : Number(data.thinkingLength) > 0 ? OutputState.REASONING : state.output;
      return {
        state: updateProgressTimestamp({ ...state, output }, event, data.meaningful !== false),
        effects: [], deadlines: [], diagnostics: [],
      };
    }
    case RequestEventType.ARTIFACT_UPDATED:
      return applyArtifactUpdate(state, event);
    case RequestEventType.TERMINAL_SNAPSHOT_OBSERVED:
      return applyTerminalSnapshot(state, event);
    case RequestEventType.TERMINAL_FAILURE_OBSERVED:
      return terminalResult(
        state,
        data.code || RequestTerminalCode.FAILED,
        String(data.message || 'Browser observer reported a terminal request failure'),
        data,
        event,
      );
    case RequestEventType.HEARTBEAT:
      return {
        state: {
          ...applySourceData(state, { ...data, connection: SourceConnection.CONNECTED }, event),
          timestamps: { ...state.timestamps, heartbeatAt: at },
        },
        effects: [], deadlines: [], diagnostics: [],
      };
    case RequestEventType.CONNECTION_CHANGED: {
      const connection = data.connected === true || data.connection === SourceConnection.CONNECTED
        ? SourceConnection.CONNECTED
        : SourceConnection.DISCONNECTED;
      const next = applySourceData(state, { ...data, connection }, event);
      if (connection === SourceConnection.DISCONNECTED && data.definitive === true) {
        return terminalResult(next, RequestTerminalCode.SOURCE_LOST, String(data.message || 'Source browser client disconnected'), data, event);
      }
      return { state: next, effects: [], deadlines: [], diagnostics: [] };
    }
    case RequestEventType.CONVERSATION_CHANGED:
      return terminalResult(state, RequestTerminalCode.CONVERSATION_CHANGED, String(data.message || 'Bound ChatGPT conversation changed'), data, event);
    case RequestEventType.REQUEST_REPLACED:
      return terminalResult(state, RequestTerminalCode.REQUEST_REPLACED, String(data.message || 'Source tab replaced the active request'), data, event);
    case RequestEventType.EFFECT_STARTED:
      if (state.effect.activeId && state.effect.activeId !== data.effectId) {
        return terminalResult(
          state,
          RequestTerminalCode.INVALID_TRANSITION,
          `Effect ${data.effectId || data.effectType || 'unknown'} started while ${state.effect.activeId} is still active`,
          data,
          event,
        );
      }
      return {
        state: {
          ...state,
          effect: {
            ...state.effect,
            activeId: String(data.effectId || ''),
            activeType: String(data.effectType || ''),
            startedAt: at,
            lastResult: null,
          },
        },
        effects: [], deadlines: [], diagnostics: [],
      };
    case RequestEventType.EFFECT_SUCCEEDED:
    case RequestEventType.EFFECT_CANCELLED: {
      const mismatched = state.effect.activeId && data.effectId && state.effect.activeId !== data.effectId;
      const diagnostics = mismatched ? [{
        code: 'stale_effect_result',
        message: `Ignored result for stale effect ${data.effectId}; active effect is ${state.effect.activeId}`,
      }] : [];
      if (mismatched) return { state: appendDiagnostics(state, diagnostics), effects: [], deadlines: [], diagnostics, accepted: false };
      return {
        state: {
          ...state,
          effect: {
            ...state.effect,
            activeId: null,
            activeType: null,
            lastResult: { type: event.type, at, data },
          },
        },
        effects: [], deadlines: [], diagnostics: [],
      };
    }
    case RequestEventType.EFFECT_FAILED: {
      const next = {
        ...state,
        effect: {
          ...state.effect,
          activeId: null,
          activeType: null,
          lastResult: { type: event.type, at, data },
        },
      };
      if (data.retryable === true) {
        const diagnostics = [{ code: 'retryable_effect_failure', message: String(data.message || 'Retryable effect failure'), data }];
        return { state: appendDiagnostics(next, diagnostics), effects: [], deadlines: [], diagnostics };
      }
      return terminalResult(next, RequestTerminalCode.EFFECT_FAILED, String(data.message || 'Request effect failed'), data, event);
    }
    case RequestEventType.DEADLINE_REACHED: {
      const kind = String(data.kind || data.type || '');
      const withDeadline = {
        ...state,
        liveness: {
          ...state.liveness,
          lastDeadline: {
            id: String(data.deadlineId || data.id || ''),
            kind,
            dueAt: Number(data.dueAt) || 0,
            reachedAt: at,
            scheduledRevision: Number(data.scheduledRevision) || 0,
          },
        },
      };
      if (kind === RequestDeadlineKind.FORCED_SNAPSHOT) {
        const effectId = String(data.effectId || `forced-snapshot:${state.requestId}:${event.eventId}`);
        return {
          state: {
            ...withDeadline,
            liveness: { ...withDeadline.liveness, lastForcedSnapshotAt: at },
          },
          effects: [{
            id: effectId,
            type: RequestEffectType.RESPONSE_SNAPSHOT,
            data: {
              requestId: state.requestId,
              reason: data.generationActive
                ? 'watchdog.generation_active_no_visible_change'
                : 'watchdog.meaningful_progress_stalled',
              deadline: data,
            },
          }],
          deadlines: [],
          diagnostics: [{ code: 'forced_snapshot_deadline_reached', message: String(data.message || 'Requesting a forced snapshot'), data }],
        };
      }
      if (kind === RequestDeadlineKind.HARD_LIVENESS) {
        return {
          state: appendDiagnostics({
            ...withDeadline,
            source: { ...withDeadline.source, connection: SourceConnection.DISCONNECTED },
          }, [{ code: 'source_heartbeat_deadline_reached', message: String(data.message || 'Source heartbeat deadline reached'), data }]),
          effects: [], deadlines: [], diagnostics: [],
        };
      }
      if (kind === RequestDeadlineKind.SOURCE_RECONNECT) {
        return terminalResult(
          withDeadline,
          RequestTerminalCode.SOURCE_LOST,
          String(data.message || 'Source ChatGPT tab/client did not reconnect'),
          { ...data, recoverable: true },
          event,
        );
      }
      if (kind === RequestDeadlineKind.ARTIFACT_PROBE && state.completion.pending) {
        const attempt = Math.max(1, Number(data.attempt) || Number(state.completion.probeAttempt || 0) + 1);
        const nextDelayMs = Math.min(5_000, 500 * (2 ** Math.min(attempt, 4)));
        const nextProbeAt = state.completion.deadlineAt
          ? Math.min(state.completion.deadlineAt, at + nextDelayMs)
          : at + nextDelayMs;
        return {
          state: {
            ...withDeadline,
            completion: {
              ...state.completion,
              probeAttempt: attempt,
              lastProbeAt: at,
              nextProbeAt: nextProbeAt > at ? nextProbeAt : 0,
            },
          },
          effects: [{
            id: String(data.effectId || `artifact-probe:${state.requestId}:${attempt}`),
            type: RequestEffectType.ARTIFACT_PROBE,
            data: { requestId: state.requestId, attempt, deadline: data },
          }],
          deadlines: [],
          diagnostics: [{ code: 'artifact_probe_deadline_reached', message: String(data.message || 'Probing for required artifact'), data }],
        };
      }
      if (kind === RequestDeadlineKind.ARTIFACT_SETTLE && !artifactContractSatisfied(state)) {
        return terminalResult(withDeadline, RequestTerminalCode.REQUIRED_ARTIFACT_MISSING, String(data.message || 'Required artifact did not become ready'), data, event);
      }
      if (kind === RequestDeadlineKind.EFFECT && state.effect.activeId) {
        return terminalResult(withDeadline, RequestTerminalCode.EFFECT_FAILED, String(data.message || `Effect ${state.effect.activeId} timed out`), data, event);
      }
      if (kind === RequestDeadlineKind.PROGRESS_LIVENESS || data.definitive === true || kind === 'liveness') {
        return terminalResult(withDeadline, RequestTerminalCode.DEADLINE_EXCEEDED, String(data.message || 'Request liveness deadline exceeded'), data, event);
      }
      return {
        state: appendDiagnostics(withDeadline, [{ code: 'non_terminal_deadline', message: String(data.message || 'Non-terminal deadline reached'), data }]),
        effects: [], deadlines: [], diagnostics: [],
      };
    }
    case RequestEventType.COMPLETED:
      return applyTerminalSnapshot(state, event);
    case RequestEventType.FAILED:
      return terminalResult(state, data.code || RequestTerminalCode.FAILED, String(data.message || 'Request failed'), data, event);
    case RequestEventType.CANCELLED:
      return terminalResult(state, RequestTerminalCode.CANCELLED, String(data.message || 'Request cancelled'), data, event);
    default:
      return {
        state: appendDiagnostics(state, [{ code: 'unknown_request_event', message: `Unknown request event type: ${event.type}` }]),
        effects: [], deadlines: [], diagnostics: [], accepted: false,
      };
  }
}

export function reduceRequestState(state, event) {
  if (!isRequestEvent(event)) {
    return {
      accepted: false,
      state,
      effects: [],
      deadlines: [],
      diagnostics: [{ code: 'invalid_event', message: 'Invalid request event envelope' }],
    };
  }

  if (!state) {
    if (event.type !== RequestEventType.CREATED) {
      return {
        accepted: false,
        state: null,
        effects: [],
        deadlines: [],
        diagnostics: [{ code: 'request_not_created', message: `First request event must be ${RequestEventType.CREATED}` }],
      };
    }
    const created = createInitialRequestState({
      ...event.data,
      requestId: event.entityId,
      at: transitionTime(event),
    });
    return { accepted: true, state: created, effects: [], deadlines: [], diagnostics: [] };
  }

  if (state.requestId !== event.entityId) {
    return {
      accepted: false,
      state,
      effects: [],
      deadlines: [],
      diagnostics: [{ code: 'request_id_mismatch', message: `Event ${event.entityId} cannot mutate request ${state.requestId}` }],
    };
  }

  if (isTerminalRequestState(state)) {
    return {
      accepted: false,
      state,
      effects: [],
      deadlines: [],
      diagnostics: [{ code: 'request_already_terminal', message: `Request is already terminal: ${state.terminal.code}` }],
    };
  }

  const sequenceDiagnostic = sourceSequenceDecision(state, event);
  if (sequenceDiagnostic) {
    return {
      accepted: false,
      state: appendDiagnostics(state, [sequenceDiagnostic]),
      effects: [],
      deadlines: [],
      diagnostics: [sequenceDiagnostic],
    };
  }

  const result = handleEvent(cloneState(state), event);
  const accepted = result.accepted !== false;
  let next = result.state;
  const violations = requestStateInvariantViolations(next);
  if (violations.length) {
    next = terminalState(
      appendDiagnostics(next, violations),
      RequestTerminalCode.INVALID_TRANSITION,
      violations.map((item) => item.message).join('; '),
      { event, violations },
      transitionTime(event),
    );
    return {
      accepted: true,
      state: next,
      effects: [],
      deadlines: [],
      diagnostics: [...(result.diagnostics || []), ...violations],
    };
  }

  return {
    accepted,
    state: next,
    effects: result.effects || [],
    deadlines: result.deadlines || [],
    diagnostics: result.diagnostics || [],
  };
}
