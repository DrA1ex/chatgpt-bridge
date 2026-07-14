import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestDeadlineCoordinator } from '../src/bridge/deadlines/requestDeadlineCoordinator.js';
import { RequestDeadlineKind, RequestEventType } from '../src/bridge/state/requestEvents.js';
import { createInitialRequestState } from '../src/bridge/state/requestPolicy.js';

function fakeTimers(startAt = 0) {
  let now = startAt;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, delay) {
      const timer = { id: nextId++, fn, at: now + delay, cleared: false, unref() {} };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimer(timer) {
      if (!timer) return;
      timer.cleared = true;
      timers.delete(timer.id);
    },
    advanceTo(value) {
      now = value;
      const due = Array.from(timers.values()).filter((timer) => timer.at <= now && !timer.cleared);
      for (const timer of due) {
        timers.delete(timer.id);
        timer.fn();
      }
    },
    timers,
  };
}

function requestState(overrides = {}) {
  const base = createInitialRequestState({ requestId: 'req-coordinator', at: 0, sourceClientId: 'client-1' });
  return {
    ...base,
    revision: 1,
    timestamps: { ...base.timestamps, createdAt: 1, meaningfulProgressAt: 100, heartbeatAt: 0 },
    ...overrides,
  };
}

test('deadline coordinator does not postpone an unchanged deadline on unrelated revisions', () => {
  const clock = fakeTimers(100);
  const dispatched = [];
  const coordinator = new RequestDeadlineCoordinator({
    dispatch: (_requestId, event) => dispatched.push(event),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    policy: {
      meaningfulProgressTimeoutMs: 100,
      postGenerationTimeoutMs: 50,
      hardLivenessTimeoutMs: 500,
      forcedSnapshotAfterMs: 1_000,
      forcedSnapshotCooldownMs: 500,
    },
  });

  coordinator.sync('req-coordinator', requestState());
  const original = coordinator.active('req-coordinator')
    .find((item) => item.kind === RequestDeadlineKind.PROGRESS_LIVENESS);
  coordinator.sync('req-coordinator', requestState({ revision: 2 }));
  const afterRevision = coordinator.active('req-coordinator')
    .find((item) => item.kind === RequestDeadlineKind.PROGRESS_LIVENESS);
  assert.equal(afterRevision.dueAt, original.dueAt);
  assert.equal(clock.timers.size, 2, 'progress and forced-snapshot timers remain singletons');

  clock.advanceTo(200);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, RequestEventType.DEADLINE_REACHED);
  assert.equal(dispatched[0].data.kind, RequestDeadlineKind.PROGRESS_LIVENESS);
});

test('meaningful progress supersedes the old liveness deadline', () => {
  const clock = fakeTimers(100);
  const superseded = [];
  const coordinator = new RequestDeadlineCoordinator({
    dispatch: () => {},
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onSuperseded: (_requestId, intent, reason) => superseded.push({ intent, reason }),
    policy: {
      meaningfulProgressTimeoutMs: 100,
      postGenerationTimeoutMs: 50,
      hardLivenessTimeoutMs: 500,
      forcedSnapshotAfterMs: 1_000,
      forcedSnapshotCooldownMs: 500,
    },
  });

  coordinator.sync('req-coordinator', requestState());
  coordinator.sync('req-coordinator', requestState({
    revision: 2,
    timestamps: { createdAt: 1, meaningfulProgressAt: 180, heartbeatAt: 0, transitionedAt: 180 },
  }));
  const liveness = coordinator.active('req-coordinator')
    .find((item) => item.kind === RequestDeadlineKind.PROGRESS_LIVENESS);
  assert.equal(liveness.dueAt, 280);
  assert.ok(superseded.some((entry) => entry.intent.kind === RequestDeadlineKind.PROGRESS_LIVENESS));
});
