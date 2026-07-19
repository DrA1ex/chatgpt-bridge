import {
  GenerationState,
  RequestLifecycle,
  RequestTerminalCode,
} from './requestEvents.js';
import { artifactContractSatisfied } from './requestPolicy.js';

export function requestStateInvariantViolations(state) {
  const violations = [];
  if (!state || typeof state !== 'object') return [{ code: 'state_missing', message: 'Request state is missing' }];
  if (!state.requestId) violations.push({ code: 'request_id_missing', message: 'Request state has no requestId' });
  if (!Number.isInteger(state.revision) || state.revision < 0) {
    violations.push({ code: 'revision_invalid', message: `Invalid request revision: ${state.revision}` });
  }
  if (!Number.isInteger(state.response?.epoch) || state.response.epoch < 0) violations.push({ code: 'response_epoch_invalid', message: 'Response epoch must be a non-negative integer' });
  if (state.source?.observationSequence != null
      && (!Number.isInteger(state.source.observationSequence) || state.source.observationSequence < 0)) {
    violations.push({ code: 'observation_sequence_invalid', message: 'Observation sequence must be a non-negative integer or null' });
  }

  if (state.terminal) {
    if (state.generation === GenerationState.ACTIVE) {
      violations.push({ code: 'terminal_generation_active', message: 'Terminal request cannot remain actively generating' });
    }
    if (state.effect?.activeId || state.effect?.activeType) {
      violations.push({ code: 'terminal_effect_active', message: 'Terminal request cannot retain an active effect' });
    }
  }

  if (state.lifecycle === RequestLifecycle.COMPLETED) {
    if (state.terminal?.code !== RequestTerminalCode.COMPLETED) {
      violations.push({ code: 'completed_without_terminal', message: 'Completed lifecycle requires completed terminal outcome' });
    }
    if (!artifactContractSatisfied(state)) {
      violations.push({ code: 'completed_without_artifact', message: 'Required artifact contract is not satisfied' });
    }
  }

  if (state.lifecycle === RequestLifecycle.CANCELLED && state.terminal?.code !== RequestTerminalCode.CANCELLED) {
    violations.push({ code: 'cancelled_without_terminal', message: 'Cancelled lifecycle requires cancelled terminal outcome' });
  }
  if (state.lifecycle === RequestLifecycle.FAILED && !state.terminal) {
    violations.push({ code: 'failed_without_terminal', message: 'Failed lifecycle requires a terminal outcome' });
  }
  return violations;
}

export function assertRequestStateInvariants(state) {
  const violations = requestStateInvariantViolations(state);
  if (!violations.length) return state;
  const error = new Error(violations.map((item) => item.message).join('; '));
  error.code = 'REQUEST_STATE_INVARIANT_VIOLATION';
  error.violations = violations;
  throw error;
}
