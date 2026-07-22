import {
  RequestEventType,
  RequestTerminalCode,
  isRequestEvent,
} from './requestEvents.js';
import { requestStateInvariantViolations } from './requestInvariants.js';
import { createInitialRequestState, isTerminalRequestState, terminalState } from './requestPolicy.js';
import {
  appendDiagnostics,
  cloneState,
  sourceSequenceDecision,
  transitionTime,
} from './requestTransitions.js';
import { reduceRequestEffectTransition } from './requestEffectTransitions.js';
import { reduceRequestLifecycleTransition } from './requestLifecycleTransitions.js';

function handleEvent(state, event) {
  return reduceRequestEffectTransition(state, event)
    || reduceRequestLifecycleTransition(state, event);
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
