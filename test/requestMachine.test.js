import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ArtifactState,
  RequestBlocker,
  RequestDeadlineKind,
  RequestEffectType,
  RequestEventType,
  RequestLifecycle,
  RequestTerminalCode,
  createRequestEvent,
} from '../src/bridge/state/requestEvents.js';
import { reduceRequestState } from '../src/bridge/state/requestMachine.js';

function event(type, id, data = {}, sequence = null, at = 1) {
  return createRequestEvent(type, id, data, {
    eventId: `${type}:${at}:${sequence ?? 'none'}`,
    sourceSequence: sequence ?? undefined,
    occurredAt: at,
    receivedAt: at,
  });
}

function apply(state, nextEvent) {
  const outcome = reduceRequestState(state, nextEvent);
  assert.equal(outcome.accepted, true, JSON.stringify(outcome.diagnostics));
  return outcome;
}

test('pure reducer models normal request progress without reading clocks or invoking effects', () => {
  let outcome = apply(null, event(RequestEventType.CREATED, 'req-normal', {}, null, 10));
  let state = outcome.state;
  assert.equal(state.lifecycle, RequestLifecycle.CREATED);

  state = apply(state, event(RequestEventType.SOURCE_BOUND, 'req-normal', { clientId: 'client-1', sessionId: 'session-1' }, null, 20)).state;
  state = apply(state, event(RequestEventType.PROMPT_ACCEPTED, 'req-normal', {}, null, 30)).state;
  state = apply(state, event(RequestEventType.PROMPT_SUBMITTED, 'req-normal', {}, null, 40)).state;
  outcome = apply(state, event(RequestEventType.LEGACY_PROGRESS, 'req-normal', {
    phase: 'assistant_reasoning',
    generating: true,
    meaningful: true,
  }, 1, 50));
  state = outcome.state;

  assert.equal(state.lifecycle, RequestLifecycle.GENERATING);
  assert.equal(state.source.clientId, 'client-1');
  assert.equal(state.source.observationSequence, 1);
  assert.equal(state.timestamps.meaningfulProgressAt, 50);
  assert.deepEqual(outcome.effects, []);
  assert.deepEqual(outcome.deadlines, []);
});

test('stale and duplicate observation sequences are rejected immediately', () => {
  let state = apply(null, event(RequestEventType.CREATED, 'req-sequence')).state;
  state = apply(state, event(RequestEventType.LEGACY_PROGRESS, 'req-sequence', { phase: 'generating' }, 4, 10)).state;

  const duplicate = reduceRequestState(state, event(RequestEventType.LEGACY_PROGRESS, 'req-sequence', { phase: 'generating' }, 4, 11));
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.diagnostics[0].code, 'duplicate_source_sequence');

  const stale = reduceRequestState(state, event(RequestEventType.LEGACY_PROGRESS, 'req-sequence', { phase: 'created' }, 3, 12));
  assert.equal(stale.accepted, false);
  assert.equal(stale.diagnostics[0].code, 'stale_source_sequence');
  assert.equal(stale.state.lifecycle, RequestLifecycle.GENERATING);
});

test('blockers are represented independently and explicit errors become terminal', () => {
  let state = apply(null, event(RequestEventType.CREATED, 'req-blocker')).state;
  state = apply(state, event(RequestEventType.LEGACY_PROGRESS, 'req-blocker', {
    phase: 'needs_confirmation',
    generating: true,
  }, 1, 10)).state;
  assert.equal(state.blocker, RequestBlocker.CONFIRMATION);
  assert.equal(state.terminal, null);

  const failed = apply(state, event(RequestEventType.OBSERVATION_UPDATED, 'req-blocker', {
    explicitError: true,
    message: 'ChatGPT rejected the action',
  }, 2, 20)).state;
  assert.equal(failed.lifecycle, RequestLifecycle.FAILED);
  assert.equal(failed.terminal.code, RequestTerminalCode.EXPLICIT_UI_ERROR);
  assert.equal(failed.terminal.message, 'ChatGPT rejected the action');
});

test('required artifact completion is deferred and completes when the artifact becomes ready', () => {
  let state = apply(null, event(RequestEventType.CREATED, 'req-artifact', {
    expectedOutput: { expected: 'zip', required: true },
  }, null, 1)).state;

  const completion = apply(state, event(RequestEventType.COMPLETED, 'req-artifact', {
    artifactCount: 0,
    artifactSettleDeadlineAt: 500,
  }, null, 100));
  state = completion.state;
  assert.equal(state.lifecycle, RequestLifecycle.ARTIFACT_SETTLING);
  assert.equal(state.completion.pending, true);
  assert.equal(state.terminal, null);
  assert.deepEqual(completion.effects, []);
  assert.deepEqual(
    completion.deadlines.map((deadline) => deadline.kind).sort(),
    [RequestDeadlineKind.ARTIFACT_PROBE, RequestDeadlineKind.ARTIFACT_SETTLE].sort(),
  );

  const probe = apply(state, event(RequestEventType.DEADLINE_REACHED, 'req-artifact', {
    kind: RequestDeadlineKind.ARTIFACT_PROBE,
    attempt: 1,
    dueAt: 110,
  }, null, 110));
  state = probe.state;
  assert.equal(probe.effects[0].type, RequestEffectType.ARTIFACT_PROBE);
  assert.equal(state.completion.probeAttempt, 1);
  assert.equal(state.completion.lastProbeAt, 110);

  const artifact = apply(state, event(RequestEventType.ARTIFACT_UPDATED, 'req-artifact', {
    artifactCount: 1,
    status: ArtifactState.READY,
  }, null, 120)).state;
  assert.equal(artifact.lifecycle, RequestLifecycle.COMPLETED);
  assert.equal(artifact.terminal.code, RequestTerminalCode.COMPLETED);
});

test('artifact settle deadline fails with a typed terminal cause', () => {
  let state = apply(null, event(RequestEventType.CREATED, 'req-artifact-timeout', {
    expectedOutput: { expected: 'zip', required: true },
  })).state;
  state = apply(state, event(RequestEventType.COMPLETED, 'req-artifact-timeout', {}, null, 10)).state;
  state = apply(state, event(RequestEventType.DEADLINE_REACHED, 'req-artifact-timeout', {
    kind: RequestDeadlineKind.ARTIFACT_SETTLE,
  }, null, 20)).state;
  assert.equal(state.terminal.code, RequestTerminalCode.REQUIRED_ARTIFACT_MISSING);
});

test('non-retryable effect failures and definitive source loss fail immediately', () => {
  let state = apply(null, event(RequestEventType.CREATED, 'req-effect')).state;
  state = apply(state, event(RequestEventType.EFFECT_STARTED, 'req-effect', {
    effectId: 'submit-1',
    effectType: 'prompt.submit',
  }, null, 10)).state;
  state = apply(state, event(RequestEventType.EFFECT_FAILED, 'req-effect', {
    effectId: 'submit-1',
    message: 'Composer disappeared',
    retryable: false,
  }, null, 20)).state;
  assert.equal(state.terminal.code, RequestTerminalCode.EFFECT_FAILED);

  let sourceState = apply(null, event(RequestEventType.CREATED, 'req-source')).state;
  sourceState = apply(sourceState, event(RequestEventType.CONNECTION_CHANGED, 'req-source', {
    connected: false,
    definitive: false,
  }, null, 10)).state;
  assert.equal(sourceState.terminal, null);
  sourceState = apply(sourceState, event(RequestEventType.CONNECTION_CHANGED, 'req-source', {
    connected: false,
    definitive: true,
  }, null, 20)).state;
  assert.equal(sourceState.terminal.code, RequestTerminalCode.SOURCE_LOST);
});


test('forced snapshot and hard liveness deadlines remain non-terminal until reconnect expires', () => {
  let state = apply(null, event(RequestEventType.CREATED, 'req-liveness')).state;
  state = apply(state, event(RequestEventType.SOURCE_BOUND, 'req-liveness', {
    clientId: 'client-1',
    sessionId: 'session-1',
  }, null, 5)).state;

  const snapshot = apply(state, event(RequestEventType.DEADLINE_REACHED, 'req-liveness', {
    kind: RequestDeadlineKind.FORCED_SNAPSHOT,
    dueAt: 20,
    generationActive: true,
  }, null, 20));
  state = snapshot.state;
  assert.equal(snapshot.effects[0].type, RequestEffectType.RESPONSE_SNAPSHOT);
  assert.equal(state.terminal, null);
  assert.equal(state.liveness.lastForcedSnapshotAt, 20);

  state = apply(state, event(RequestEventType.DEADLINE_REACHED, 'req-liveness', {
    kind: RequestDeadlineKind.HARD_LIVENESS,
    dueAt: 30,
  }, null, 30)).state;
  assert.equal(state.source.connection, 'disconnected');
  assert.equal(state.terminal, null);

  state = apply(state, event(RequestEventType.DEADLINE_REACHED, 'req-liveness', {
    kind: RequestDeadlineKind.SOURCE_RECONNECT,
    dueAt: 40,
  }, null, 40)).state;
  assert.equal(state.terminal.code, RequestTerminalCode.SOURCE_LOST);
  assert.equal(state.terminal.evidence.recoverable, true);
});

test('terminal browser observations are authoritative and request an explicit source release', () => {
  let state = apply(null, event(RequestEventType.CREATED, 'req-terminal-observation')).state;
  state = apply(state, event(RequestEventType.SOURCE_BOUND, 'req-terminal-observation', {
    clientId: 'client-release',
    sessionId: 'session-release',
  }, null, 2)).state;

  const completed = apply(state, event(RequestEventType.TERMINAL_SNAPSHOT_OBSERVED, 'req-terminal-observation', {
    artifactStatus: ArtifactState.NOT_EXPECTED,
    answerLength: 12,
    message: 'Browser terminal snapshot is stable',
  }, null, 10));

  assert.equal(completed.state.terminal.code, RequestTerminalCode.COMPLETED);
  assert.equal(completed.effects.length, 1);
  assert.equal(completed.effects[0].type, RequestEffectType.REQUEST_RELEASE);
  assert.equal(completed.effects[0].data.sourceClientId, 'client-release');
  assert.equal(completed.effects[0].data.terminalCode, RequestTerminalCode.COMPLETED);
});

test('required artifacts remain server-owned after a terminal browser observation', () => {
  let state = apply(null, event(RequestEventType.CREATED, 'req-terminal-artifact', {
    expectedOutput: { expected: 'zip', required: true },
  })).state;
  state = apply(state, event(RequestEventType.SOURCE_BOUND, 'req-terminal-artifact', {
    clientId: 'client-artifact',
  }, null, 2)).state;

  const observed = apply(state, event(RequestEventType.TERMINAL_SNAPSHOT_OBSERVED, 'req-terminal-artifact', {
    artifactStatus: ArtifactState.PENDING,
    artifactCount: 0,
    artifactSettleDeadlineAt: 500,
    artifactProbeAt: 50,
  }, null, 10));
  assert.equal(observed.state.lifecycle, RequestLifecycle.ARTIFACT_SETTLING);
  assert.equal(observed.state.terminal, null);
  assert.deepEqual(observed.effects, []);

  const ready = apply(observed.state, event(RequestEventType.ARTIFACT_UPDATED, 'req-terminal-artifact', {
    artifactCount: 1,
    status: ArtifactState.READY,
  }, null, 20));
  assert.equal(ready.state.terminal.code, RequestTerminalCode.COMPLETED);
  assert.equal(ready.effects[0].type, RequestEffectType.REQUEST_RELEASE);
});

test('terminal browser failures fail immediately and request source release', () => {
  let state = apply(null, event(RequestEventType.CREATED, 'req-terminal-failure')).state;
  state = apply(state, event(RequestEventType.SOURCE_BOUND, 'req-terminal-failure', {
    clientId: 'client-failure',
  }, null, 2)).state;

  const failed = apply(state, event(RequestEventType.TERMINAL_FAILURE_OBSERVED, 'req-terminal-failure', {
    code: RequestTerminalCode.EFFECT_FAILED,
    message: 'Composer disappeared during submission',
    effectType: 'prompt.submit',
  }, null, 10));
  assert.equal(failed.state.terminal.code, RequestTerminalCode.EFFECT_FAILED);
  assert.equal(failed.state.terminal.message, 'Composer disappeared during submission');
  assert.equal(failed.effects[0].type, RequestEffectType.REQUEST_RELEASE);
});
