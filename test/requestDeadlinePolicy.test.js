import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ArtifactState,
  GenerationState,
  RequestDeadlineKind,
  RequestLifecycle,
  SourceConnection,
} from '../src/bridge/state/requestEvents.js';
import { createInitialRequestState } from '../src/bridge/state/requestPolicy.js';
import { deadlineIntentsForRequest } from '../src/bridge/deadlines/requestDeadlinePolicy.js';

const options = {
  meaningfulProgressTimeoutMs: 1_000,
  postGenerationTimeoutMs: 200,
  hardLivenessTimeoutMs: 500,
  forcedSnapshotAfterMs: 300,
  forcedSnapshotCooldownMs: 150,
};

function state(overrides = {}) {
  const base = createInitialRequestState({ requestId: 'req-deadline', at: 100 });
  return {
    ...base,
    revision: 4,
    source: { ...base.source, clientId: 'client-1', connection: SourceConnection.CONNECTED },
    timestamps: { ...base.timestamps, meaningfulProgressAt: 200, heartbeatAt: 250 },
    ...overrides,
  };
}

test('deadline policy keeps weak heartbeats separate from meaningful progress', () => {
  const intents = deadlineIntentsForRequest(state(), options);
  const byKind = Object.fromEntries(intents.map((item) => [item.kind, item]));
  assert.equal(byKind[RequestDeadlineKind.PROGRESS_LIVENESS].dueAt, 1_200);
  assert.equal(byKind[RequestDeadlineKind.FORCED_SNAPSHOT].dueAt, 500);
  assert.equal(byKind[RequestDeadlineKind.HARD_LIVENESS].dueAt, 750);
});

test('active generation has snapshots and hard liveness but no progress cancellation', () => {
  const intents = deadlineIntentsForRequest(state({ generation: GenerationState.ACTIVE }), options);
  assert.equal(intents.some((item) => item.kind === RequestDeadlineKind.PROGRESS_LIVENESS), false);
  assert.equal(intents.some((item) => item.kind === RequestDeadlineKind.FORCED_SNAPSHOT), true);
  assert.equal(intents.some((item) => item.kind === RequestDeadlineKind.HARD_LIVENESS), true);
});

test('artifact settling uses probe and settle deadlines instead of the request watchdog', () => {
  const base = state();
  const intents = deadlineIntentsForRequest({
    ...base,
    lifecycle: RequestLifecycle.ARTIFACT_SETTLING,
    artifact: { ...base.artifact, required: true, status: ArtifactState.PENDING },
    completion: {
      ...base.completion,
      pending: true,
      requestedAt: 400,
      nextProbeAt: 500,
      deadlineAt: 900,
    },
  }, options);
  assert.deepEqual(intents.map((item) => item.kind).sort(), [
    RequestDeadlineKind.ARTIFACT_PROBE,
    RequestDeadlineKind.ARTIFACT_SETTLE,
    RequestDeadlineKind.HARD_LIVENESS,
  ].sort());
});

test('disconnected sources receive only a reconnect deadline', () => {
  const base = state();
  const intents = deadlineIntentsForRequest({
    ...base,
    source: { ...base.source, connection: SourceConnection.DISCONNECTED },
  }, options);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].kind, RequestDeadlineKind.SOURCE_RECONNECT);
  assert.equal(intents[0].dueAt, 1_200);
});

test('either explicit effect domain suppresses overlapping snapshot and artifact probes', () => {
  for (const domain of ['browser', 'coordinator']) {
    const base = state();
    const activeEffect = {
      ...base.effect,
      [domain]: {
        ...base.effect[domain],
        activeId: `${domain}-effect`,
        activeType: domain === 'browser' ? 'prompt.steer' : 'effect.reconcile.requested',
      },
    };
    const regular = deadlineIntentsForRequest({ ...base, effect: activeEffect }, options);
    assert.equal(
      regular.some((item) => item.kind === RequestDeadlineKind.FORCED_SNAPSHOT),
      false,
      `${domain} effect must suppress a competing forced snapshot`,
    );

    const settling = deadlineIntentsForRequest({
      ...base,
      effect: activeEffect,
      lifecycle: RequestLifecycle.ARTIFACT_SETTLING,
      artifact: { ...base.artifact, required: true, status: ArtifactState.PENDING },
      completion: {
        ...base.completion,
        pending: true,
        requestedAt: 400,
        nextProbeAt: 500,
        deadlineAt: 900,
      },
    }, options);
    assert.equal(
      settling.some((item) => item.kind === RequestDeadlineKind.ARTIFACT_PROBE),
      false,
      `${domain} effect must suppress a competing artifact probe`,
    );
  }
});
