import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RequestEventType,
  RequestLifecycle,
  createRequestEvent,
} from '../src/bridge/state/requestEvents.js';
import { reduceRequestState } from '../src/bridge/state/requestMachine.js';
import { EntityStore } from '../src/bridge/store/entityStore.js';
import {
  StateWaitAbortedError,
  StateWaitDeadlineError,
  StateWaitRejectedError,
} from '../src/bridge/store/waitForState.js';

function event(type, id, data = {}, at = 1) {
  return createRequestEvent(type, id, data, {
    eventId: `${type}:${at}`,
    occurredAt: at,
    receivedAt: at,
  });
}

function createStore() {
  return new EntityStore({ reducer: reduceRequestState, historyLimit: 10 });
}

test('EntityStore commits state before publishing the transition', () => {
  const store = createStore();
  const observed = [];
  store.subscribe('req-atomic', ({ state }) => {
    observed.push({ callbackRevision: state.revision, storedRevision: store.get('req-atomic').revision });
  });

  const created = store.transition('req-atomic', event(RequestEventType.CREATED, 'req-atomic', {}, 10));
  const accepted = store.transition('req-atomic', event(RequestEventType.PROMPT_ACCEPTED, 'req-atomic', {}, 20));

  assert.equal(created.state.revision, 1);
  assert.equal(accepted.state.revision, 2);
  assert.deepEqual(observed, [
    { callbackRevision: 1, storedRevision: 1 },
    { callbackRevision: 2, storedRevision: 2 },
  ]);
  assert.deepEqual(store.history('req-atomic').map((item) => item.revision), [1, 2]);
});

test('waitFor subscribes before reading and cannot miss a synchronous following transition', async () => {
  const store = createStore();
  store.transition('req-race', event(RequestEventType.CREATED, 'req-race'));
  const waiting = store.waitFor('req-race', {
    accept: (state) => state.lifecycle === RequestLifecycle.COMPLETED,
    timeoutMs: 100,
  });
  store.transition('req-race', event(RequestEventType.COMPLETED, 'req-race', {}, 2));
  const state = await waiting;
  assert.equal(state.lifecycle, RequestLifecycle.COMPLETED);
  assert.equal(state.revision, 2);
});

test('waitFor resolves or rejects immediately from the current snapshot', async () => {
  const completedStore = createStore();
  completedStore.transition('req-complete', event(RequestEventType.CREATED, 'req-complete'));
  completedStore.transition('req-complete', event(RequestEventType.COMPLETED, 'req-complete', {}, 2));
  const completed = await completedStore.waitFor('req-complete', {
    accept: (state) => state.lifecycle === RequestLifecycle.COMPLETED,
  });
  assert.equal(completed.terminal.code, 'completed');

  const failedStore = createStore();
  failedStore.transition('req-failed', event(RequestEventType.CREATED, 'req-failed'));
  failedStore.transition('req-failed', event(RequestEventType.FAILED, 'req-failed', { message: 'boom' }, 2));
  await assert.rejects(
    failedStore.waitFor('req-failed', { accept: () => false }),
    (error) => error instanceof StateWaitRejectedError
      && error.state.terminal.message === 'boom'
      && error.history.length === 2,
  );
});

test('waitFor cleans up on abort and deadline and includes diagnostics', async () => {
  const abortStore = createStore();
  abortStore.transition('req-abort', event(RequestEventType.CREATED, 'req-abort'));
  const controller = new AbortController();
  const aborted = abortStore.waitFor('req-abort', { accept: () => false, signal: controller.signal });
  controller.abort('test abort');
  await assert.rejects(aborted, (error) => error instanceof StateWaitAbortedError && error.state.requestId === 'req-abort');

  const deadlineStore = createStore();
  deadlineStore.transition('req-deadline', event(RequestEventType.CREATED, 'req-deadline'));
  await assert.rejects(
    deadlineStore.waitFor('req-deadline', { accept: () => false, timeoutMs: 5 }),
    (error) => error instanceof StateWaitDeadlineError
      && error.state.requestId === 'req-deadline'
      && error.history.length === 1,
  );
});

test('rejected duplicate events do not publish a new revision', () => {
  const store = createStore();
  const created = createRequestEvent(RequestEventType.CREATED, 'req-duplicate', {}, {
    eventId: 'created', occurredAt: 1, receivedAt: 1,
  });
  store.transition('req-duplicate', created);
  const progress = createRequestEvent(RequestEventType.LEGACY_PROGRESS, 'req-duplicate', { phase: 'generating' }, {
    eventId: 'progress-1', sourceSequence: 1, occurredAt: 2, receivedAt: 2,
  });
  store.transition('req-duplicate', progress);
  const duplicate = store.transition('req-duplicate', {
    ...progress,
    eventId: 'progress-duplicate',
    occurredAt: 3,
    receivedAt: 3,
  });
  assert.equal(duplicate.accepted, false);
  assert.equal(store.get('req-duplicate').revision, 2);
  assert.equal(store.history('req-duplicate').length, 2);
});
