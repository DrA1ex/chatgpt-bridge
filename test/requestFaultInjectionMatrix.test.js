import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ArtifactState,
  RequestDeadlineKind,
  RequestEventType,
  RequestTerminalCode,
  createRequestEvent,
} from '../src/bridge/state/requestEvents.js';
import { reduceRequestState } from '../src/bridge/state/requestMachine.js';

let sequence = 0;
function event(type, requestId, data = {}, options = {}) {
  sequence += 1;
  return createRequestEvent(type, requestId, data, {
    eventId: options.eventId || `request-fault-${sequence}`,
    occurredAt: options.at || sequence,
    receivedAt: options.at || sequence,
    sourceSequence: options.sourceSequence,
  });
}
function apply(state, next) {
  const result = reduceRequestState(state, next);
  assert.equal(result.accepted, true, JSON.stringify(result.diagnostics));
  return result;
}

function terminalRequest(requestId = 'request-terminal') {
  let result = apply(null, event(RequestEventType.CREATED, requestId));
  result = apply(result.state, event(RequestEventType.SOURCE_BOUND, requestId, { sourceClientId: 'client-terminal' }));
  return apply(result.state, event(RequestEventType.COMPLETED, requestId, { artifactStatus: ArtifactState.NOT_EXPECTED }));
}

test('terminal request state is absorbing for every late lifecycle, effect, observation, and deadline event', () => {
  const completed = terminalRequest();
  assert.equal(completed.state.terminal.code, RequestTerminalCode.COMPLETED);
  assert.equal(completed.effects.length, 1, 'terminal transition emits exactly one release effect');
  const terminalSnapshot = structuredClone(completed.state);
  const lateEvents = [
    event(RequestEventType.OBSERVATION_UPDATED, 'request-terminal', { completionCandidate: true }),
    event(RequestEventType.OUTPUT_UPDATED, 'request-terminal', { answerLength: 10, final: true }),
    event(RequestEventType.ARTIFACT_UPDATED, 'request-terminal', { artifactCount: 1 }),
    event(RequestEventType.EFFECT_STARTED, 'request-terminal', { effectId: 'late-effect', effectType: 'model.apply' }),
    event(RequestEventType.EFFECT_SUCCEEDED, 'request-terminal', { effectId: 'late-effect' }),
    event(RequestEventType.EFFECT_FAILED, 'request-terminal', { effectId: 'late-effect', message: 'late' }),
    event(RequestEventType.CONNECTION_CHANGED, 'request-terminal', { connected: false, definitive: true }),
    event(RequestEventType.DEADLINE_REACHED, 'request-terminal', { kind: RequestDeadlineKind.HARD_LIVENESS }),
    event(RequestEventType.CANCELLED, 'request-terminal', { message: 'late cancel' }),
  ];
  for (const late of lateEvents) {
    const result = reduceRequestState(completed.state, late);
    assert.equal(result.accepted, false, late.type);
    assert.equal(result.diagnostics[0].code, 'request_already_terminal', late.type);
    assert.deepEqual(result.state, terminalSnapshot, late.type);
    assert.equal(result.effects.length, 0, `${late.type} must not emit another release`);
  }
});

test('stale response epochs are rejected consistently across output, artifact, effect, and completion evidence', () => {
  const requestId = 'request-epoch';
  let result = apply(null, event(RequestEventType.CREATED, requestId));
  result = apply(result.state, event(RequestEventType.STEER_ACCEPTED, requestId, { userTurnKey: 'user-steer' }));
  assert.equal(result.state.response.epoch, 1);
  const before = result.state;
  for (const stale of [
    event(RequestEventType.OBSERVATION_UPDATED, requestId, { responseEpoch: 0, output: 'final', completionCandidate: true }),
    event(RequestEventType.OUTPUT_UPDATED, requestId, { responseEpoch: 0, final: true, answerLength: 10 }),
    event(RequestEventType.ARTIFACT_UPDATED, requestId, { responseEpoch: 0, artifactCount: 1 }),
    event(RequestEventType.EFFECT_SUCCEEDED, requestId, { responseEpoch: 0, effectId: 'old-effect' }),
    event(RequestEventType.COMPLETED, requestId, { responseEpoch: 0, artifactStatus: ArtifactState.NOT_EXPECTED }),
  ]) {
    const rejected = reduceRequestState(before, stale);
    assert.equal(rejected.accepted, false, stale.type);
    assert.equal(rejected.diagnostics[0].code, 'response_epoch_mismatch', stale.type);
    assert.equal(rejected.state.response.epoch, 1);
    assert.equal(rejected.state.terminal, null);
  }
});

test('duplicate and stale source sequences cannot regress request output or produce terminal effects', () => {
  const requestId = 'request-sequence';
  let result = apply(null, event(RequestEventType.CREATED, requestId));
  result = apply(result.state, event(RequestEventType.OBSERVATION_UPDATED, requestId, {
    observationEpoch: 'content-1', output: 'streaming', answerLength: 4,
  }, { sourceSequence: 10 }));
  const current = result.state;
  for (const sourceSequence of [10, 9]) {
    const rejected = reduceRequestState(current, event(RequestEventType.OBSERVATION_UPDATED, requestId, {
      observationEpoch: 'content-1', output: 'final', completionCandidate: true,
    }, { sourceSequence }));
    assert.equal(rejected.accepted, false);
    assert.match(rejected.diagnostics[0].code, /duplicate_source_sequence|stale_source_sequence/);
    assert.equal(rejected.state.terminal, null);
    assert.equal(rejected.effects.length, 0);
  }
});
