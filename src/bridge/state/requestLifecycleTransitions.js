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
} from './requestEvents.js';
import { applyLifecyclePatch, artifactContractSatisfied } from './requestPolicy.js';
import {
  appendDiagnostics,
  applyArtifactUpdate,
  applyObservation,
  applySourceData,
  applyTerminalSnapshot,
  terminalResult,
  transitionTime,
  updateProgressTimestamp,
} from './requestTransitions.js';
import { effectDomain, effectSlot } from './requestMachineSupport.js';

export function reduceRequestLifecycleTransition(state, event) {
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
    case RequestEventType.RESPONSE_BOUNDARY_REBOUND:
      return {
        state: appendDiagnostics({
          ...state,
          response: {
            ...(state.response || {}),
            userTurnKey: String(data.submittedUserTurnKey || state.response?.userTurnKey || ''),
          },
        }, [{
          code: 'response_boundary_rebound',
          message: String(data.message || 'Submitted user-turn identity changed after content reload and was rebound by exact prompt evidence'),
          data,
        }]),
        effects: [], deadlines: [], diagnostics: [],
      };
    case RequestEventType.RESPONSE_BOUNDARY_LOST:
      return terminalResult(
        state,
        RequestTerminalCode.RECOVERY_UNCERTAIN,
        String(data.message || 'The submitted user turn could not be found after content reload'),
        {
          ...data,
          reasonCode: String(data.reasonCode || 'SUBMITTED_TURN_MISSING_AFTER_RELOAD'),
          recoverable: true,
          safeToRetryAsNewRequest: true,
        },
        event,
      );
    case RequestEventType.STEER_ACCEPTED: {
      const previous = state.response || { epoch: 0, history: [] };
      const previousResponseEpoch = Math.max(0, Number(data.previousResponseEpoch ?? previous.epoch) || 0);
      const nextEpoch = Math.max(0, Number(data.targetResponseEpoch ?? (previousResponseEpoch + 1)) || 0);
      if (previousResponseEpoch !== Math.max(0, Number(previous.epoch) || 0) || nextEpoch !== previousResponseEpoch + 1) {
        const diagnostics = [{
          code: 'steer_response_epoch_mismatch',
          message: `Rejected steer epoch transition ${previousResponseEpoch}->${nextEpoch}; active epoch is ${previous.epoch}`,
          data,
        }];
        return { state: appendDiagnostics(state, diagnostics), effects: [], deadlines: [], diagnostics, accepted: false };
      }
      return {
        state: updateProgressTimestamp(applyLifecyclePatch({
          ...state,
          response: {
            epoch: nextEpoch,
            userTurnKey: String(data.userTurnKey || ''),
            startedAt: at,
            history: [...(previous.history || []), { epoch: previous.epoch, userTurnKey: previous.userTurnKey || '', endedAt: at }].slice(-20),
          },
          generation: GenerationState.IDLE,
          blocker: RequestBlocker.NONE,
          output: OutputState.NONE,
          completion: { ...state.completion, pending: false, requestedAt: 0, deadlineAt: 0, probeAttempt: 0, nextProbeAt: 0, evidence: null },
          artifact: { ...state.artifact, status: state.artifact.required ? ArtifactState.PENDING : ArtifactState.NOT_EXPECTED, count: 0 },
        }, { lifecycle: RequestLifecycle.AWAITING_ASSISTANT }), event),
        effects: [], deadlines: [], diagnostics: [],
      };
    }
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
      if (kind === RequestDeadlineKind.EFFECT) {
        const domain = effectDomain(data);
        const active = effectSlot(state, domain);
        if (active.activeId) {
          return terminalResult(withDeadline, RequestTerminalCode.EFFECT_FAILED, String(data.message || `${domain} effect ${active.activeId} timed out`), data, event);
        }
      }
      if (kind === RequestDeadlineKind.RECOVERY && state.source.connection === SourceConnection.RECONCILING) {
        return terminalResult(
          withDeadline,
          RequestTerminalCode.RECOVERY_UNCERTAIN,
          String(data.message || 'Browser effect remained uncertain after the recovery deadline'),
          { ...data, recoverable: true },
          event,
        );
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
