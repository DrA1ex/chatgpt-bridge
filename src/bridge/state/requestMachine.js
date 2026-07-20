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
  terminalState,
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

function effectDomain(data = {}) {
  return String(data.effectDomain || data.domain || 'browser') === 'coordinator'
    ? 'coordinator'
    : 'browser';
}

function effectSlot(state, domain) {
  return state?.effect?.[domain]
    || { activeId: null, activeType: null, startedAt: 0, lastResult: null };
}

function withEffectSlot(state, domain, patch) {
  const current = effectSlot(state, domain);
  const nextSlot = { ...current, ...patch };
  return {
    ...state,
    effect: {
      browser: { ...(state.effect?.browser || {}) },
      coordinator: { ...(state.effect?.coordinator || {}) },
      [domain]: nextSlot,
    },
  };
}

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
    case RequestEventType.EFFECT_STARTED: {
      const domain = effectDomain(data);
      const slot = effectSlot(state, domain);
      if (slot.activeId && slot.activeId !== data.effectId) {
        return terminalResult(
          state,
          RequestTerminalCode.INVALID_TRANSITION,
          `${domain} effect ${data.effectId || data.effectType || 'unknown'} started while ${slot.activeId} is still active`,
          data,
          event,
        );
      }
      return {
        state: withEffectSlot(state, domain, {
          activeId: String(data.effectId || ''),
          activeType: String(data.effectType || ''),
          startedAt: at,
          lastResult: null,
        }),
        effects: [], deadlines: [], diagnostics: [],
      };
    }
    case RequestEventType.EFFECT_SUCCEEDED:
    case RequestEventType.EFFECT_CANCELLED: {
      const domain = effectDomain(data);
      const slot = effectSlot(state, domain);
      const duplicate = String(slot.lastResult?.data?.effectId || '') === String(data.effectId || '')
        && slot.lastResult?.type === event.type;
      if (duplicate) {
        const diagnostics = [{ code: 'duplicate_effect_result', message: `Ignored duplicate ${domain} effect result for ${data.effectId || data.effectType || 'effect'}` }];
        return { state: appendDiagnostics(state, diagnostics), effects: [], deadlines: [], diagnostics, accepted: false };
      }
      const mismatched = slot.activeId && data.effectId && slot.activeId !== data.effectId;
      const diagnostics = mismatched ? [{
        code: 'stale_effect_result',
        message: `Ignored result for stale ${domain} effect ${data.effectId}; active effect is ${slot.activeId}`,
      }] : [];
      if (mismatched) return { state: appendDiagnostics(state, diagnostics), effects: [], deadlines: [], diagnostics, accepted: false };
      const nextState = withEffectSlot(state, domain, {
        activeId: null,
        activeType: null,
        lastResult: { type: event.type, at, data },
      });
      if (domain === 'browser' && String(data.effectType || '') === 'prompt.cancel') {
        if (event.type === RequestEventType.EFFECT_SUCCEEDED) {
          return terminalResult(
            nextState,
            RequestTerminalCode.CANCELLED,
            String(data.message || 'Browser generation was cancelled'),
            { ...data, cancelEffectId: data.effectId || '' },
            event,
          );
        }
        return terminalResult(
          nextState,
          RequestTerminalCode.EFFECT_FAILED,
          String(data.message || 'Browser cancellation was proved not to have executed'),
          { ...data, recoverable: true },
          event,
        );
      }
      const preparationKinds = new Set(['page.ready.initial', 'session.apply', 'model.apply', 'attachments.upload']);
      const continueExecution = event.type === RequestEventType.EFFECT_SUCCEEDED
        && domain === 'browser'
        && state.submission !== SubmissionState.SUBMITTED
        && preparationKinds.has(String(data.effectType || ''));
      return {
        state: nextState,
        effects: continueExecution ? [{
          id: `prompt-execution-next:${state.requestId}:${data.effectId || event.eventId}`,
          type: RequestEffectType.PROMPT_EXECUTION_STEP,
          data: {
            requestId: state.requestId,
            originalEffectId: String(data.effectId || ''),
            effectType: String(data.effectType || ''),
            resumeMode: 'continue_after',
            reason: 'effect_succeeded',
          },
        }] : [],
        deadlines: [], diagnostics: [],
      };
    }
    case RequestEventType.EFFECT_FAILED: {
      const domain = effectDomain(data);
      const next = withEffectSlot(state, domain, {
        activeId: null,
        activeType: null,
        lastResult: { type: event.type, at, data },
      });
      if (data.retryable === true) {
        const diagnostics = [{ code: 'retryable_effect_failure', message: String(data.message || 'Retryable effect failure'), data }];
        return { state: appendDiagnostics(next, diagnostics), effects: [], deadlines: [], diagnostics };
      }
      return terminalResult(next, RequestTerminalCode.EFFECT_FAILED, String(data.message || 'Request effect failed'), data, event);
    }
    case RequestEventType.EFFECT_UNCERTAIN: {
      const domain = effectDomain(data);
      if (domain !== 'browser') {
        const diagnostics = [{ code: 'invalid_uncertain_effect_domain', message: 'Only physical browser effects may become uncertain' }];
        return { state: appendDiagnostics(state, diagnostics), effects: [], deadlines: [], diagnostics, accepted: false };
      }
      const slot = effectSlot(state, 'browser');
      const previousUncertain = slot.lastResult?.type === RequestEventType.EFFECT_UNCERTAIN
        && String(slot.lastResult?.data?.effectId || '') === String(data.effectId || '')
        && state.source?.connection === SourceConnection.RECONCILING;
      if (previousUncertain) {
        const diagnostics = [{ code: 'duplicate_effect_uncertain', message: `Ignored duplicate uncertain result for ${data.effectId || data.effectType || 'browser effect'}` }];
        return { state: appendDiagnostics(state, diagnostics), effects: [], deadlines: [], diagnostics, accepted: false };
      }
      const mismatched = slot.activeId && data.effectId && slot.activeId !== data.effectId;
      if (mismatched) {
        const diagnostics = [{
          code: 'stale_effect_result',
          message: `Ignored uncertain result for stale browser effect ${data.effectId}; active effect is ${slot.activeId}`,
        }];
        return { state: appendDiagnostics(state, diagnostics), effects: [], deadlines: [], diagnostics, accepted: false };
      }
      const deadlineAt = at + Math.max(5_000, Number(data.recoveryTimeoutMs) || 30_000);
      const uncertainState = withEffectSlot(state, 'browser', {
        activeId: null,
        activeType: null,
        lastResult: { type: event.type, at, data },
      });
      return {
        state: appendDiagnostics({
          ...uncertainState,
          source: { ...uncertainState.source, connection: SourceConnection.RECONCILING },
          blocker: RequestBlocker.RECOVERY,
        }, [{
          code: 'browser_effect_uncertain',
          message: String(data.message || 'Browser effect result is uncertain after reload'),
          data,
        }]),
        effects: [{
          id: `effect-reconcile:${state.requestId}:${data.effectId || event.eventId}`,
          type: RequestEffectType.EFFECT_RECONCILE,
          data: {
            requestId: state.requestId,
            effectId: data.effectId || '',
            effectType: data.effectType || '',
            idempotencyKey: data.idempotencyKey || '',
            retryPolicy: data.retryPolicy || 'if_unconfirmed',
            preconditions: data.preconditions || {},
            preconditionsHash: data.preconditionsHash || '',
            attempt: Math.max(1, Number(data.attempt) || 1),
            evidence: data.evidence || null,
          },
        }],
        deadlines: [{
          id: `recovery:${state.requestId}:${deadlineAt}`,
          kind: RequestDeadlineKind.RECOVERY,
          type: RequestDeadlineKind.RECOVERY,
          dueAt: deadlineAt,
          message: 'Browser effect could not be reconciled after content reload',
        }],
        diagnostics: [],
      };
    }
    case RequestEventType.EFFECT_RECONCILED: {
      const outcome = String(data.outcome || 'uncertain');
      if (outcome === 'succeeded') {
        if (String(data.effectType || '') === 'prompt.cancel') {
          const reconciledState = withEffectSlot(state, 'browser', {
            activeId: null,
            activeType: null,
            lastResult: { type: event.type, at, data },
          });
          return terminalResult(
            reconciledState,
            RequestTerminalCode.CANCELLED,
            String(data.message || 'Browser cancellation was proved after reconciliation'),
            { ...data, cancelEffectId: data.originalEffectId || data.effectId || '' },
            event,
          );
        }
        const resumablePreparationEffects = new Set([
          'page.ready.initial',
          'session.apply',
          'model.apply',
          'attachments.upload',
        ]);
        const resumePreparation = state.submission !== SubmissionState.SUBMITTED
          && resumablePreparationEffects.has(String(data.effectType || ''));
        const reconciledState = withEffectSlot(state, 'browser', {
          activeId: null,
          activeType: null,
          lastResult: { type: event.type, at, data },
        });
        return {
          state: appendDiagnostics({
            ...reconciledState,
            source: { ...reconciledState.source, connection: SourceConnection.CONNECTED },
            blocker: RequestBlocker.NONE,
          }, [{ code: 'browser_effect_reconciled', message: String(data.message || 'Browser effect outcome was proved after reload'), data }]),
          effects: resumePreparation ? [{
            id: `prompt-execution-resume:${state.requestId}:${data.originalEffectId || event.eventId}`,
            type: RequestEffectType.PROMPT_EXECUTION_STEP,
            data: {
              requestId: state.requestId,
              originalEffectId: String(data.originalEffectId || data.effectId || ''),
              effectType: String(data.effectType || ''),
              resumeMode: 'continue_after',
            },
          }] : [],
          deadlines: [], diagnostics: [],
        };
      }
      if (outcome === 'not_started') {
        const retryable = String(data.retryPolicy || 'if_unconfirmed') !== 'never';
        if (!retryable) {
          return terminalResult(
            state,
            RequestTerminalCode.RECOVERY_UNCERTAIN,
            String(data.message || 'Browser effect was proved not to have started but its retry policy forbids automatic retry'),
            { ...data, recoverable: true, safeToRetryAsNewRequest: true },
            event,
          );
        }
        const reconciledState = withEffectSlot(state, 'browser', {
          activeId: null,
          activeType: null,
          lastResult: { type: event.type, at, data },
        });
        const cancelRetry = String(data.effectType || '') === 'prompt.cancel';
        return {
          state: appendDiagnostics({
            ...reconciledState,
            source: { ...reconciledState.source, connection: SourceConnection.CONNECTED },
            blocker: RequestBlocker.NONE,
          }, [{ code: 'browser_effect_proved_not_started', message: String(data.message || 'Browser effect was proved not to have started and will be retried with the same logical identity'), data }]),
          effects: [{
            id: `${cancelRetry ? 'prompt-cancel' : 'prompt-execution'}-retry:${state.requestId}:${data.originalEffectId || data.effectId || event.eventId}`,
            type: cancelRetry ? RequestEffectType.PROMPT_CANCEL_RETRY : RequestEffectType.PROMPT_EXECUTION_STEP,
            data: {
              requestId: state.requestId,
              originalEffectId: String(data.originalEffectId || data.effectId || ''),
              effectType: String(data.effectType || ''),
              idempotencyKey: String(data.idempotencyKey || ''),
              retryPolicy: String(data.retryPolicy || 'if_unconfirmed'),
              preconditions: data.preconditions || {},
              attempt: Math.max(1, Number(data.attempt) || 1),
              resumeMode: 'retry_same',
            },
          }],
          deadlines: [],
          diagnostics: [],
        };
      }
      if (outcome === 'failed') {
        return terminalResult(
          state,
          RequestTerminalCode.EFFECT_FAILED,
          String(data.message || 'Browser effect was proved to have failed'),
          { ...data, recoverable: Boolean(data.recoverable) },
          event,
        );
      }
      return {
        state: appendDiagnostics(state, [{
          code: 'browser_effect_reconcile_inconclusive',
          message: String(data.message || 'Browser effect reconciliation remained inconclusive'),
          data,
        }]),
        effects: [], deadlines: [], diagnostics: [],
      };
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

  const eventResponseEpoch = event.data?.responseEpoch;
  if (eventResponseEpoch != null && Number(eventResponseEpoch) !== Number(state.response?.epoch || 0)
      && event.type !== RequestEventType.STEER_ACCEPTED) {
    const diagnostic = { code: 'response_epoch_mismatch', message: `Ignored response epoch ${eventResponseEpoch}; active epoch is ${state.response?.epoch || 0}` };
    return { accepted: false, state: appendDiagnostics(state, [diagnostic]), effects: [], deadlines: [], diagnostics: [diagnostic] };
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
