import test from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalRequestRuntime } from '../src/bridge/coordinator/canonicalRequestRuntime.js';
import { markRequestRuntimeFinished } from '../src/bridge/coordinator/requestRuntimeProjection.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(t, callbacks = {}) {
  const calls = [];
  const errors = [];
  const runtime = new CanonicalRequestRuntime({
    dispatch() {},
    deadlineCoordinator: { sync() {}, clear() {}, close() {}, active: () => [] },
    executeEffect: (_state, effect) => calls.push(effect.id),
    onTerminal: (state) => { calls.push('terminal'); markRequestRuntimeFinished(state); },
    onError: (error) => errors.push(error),
    ...callbacks,
  });
  t.after(() => runtime.close());
  const state = { requestId: 'request-1', runtime: { finished: false } };
  const accept = (effects, terminal = null, revision = 1) => runtime.accept(state, {
    accepted: true, state: { requestId: state.requestId, revision, terminal }, effects,
  });
  return { runtime, state, calls, errors, accept };
}

test('a canonical terminal transition invalidates queued ordinary effects and releases once', async (t) => {
  const { accept, calls } = harness(t);
  accept([{ id: 'submit', type: 'prompt.submit' }]);
  accept([{ id: 'release', type: 'request.release' }], { code: 'cancelled' }, 2);
  await flush();
  assert.deepEqual(calls, ['terminal', 'release']);
});

for (const action of ['finish', 'clear', 'close']) {
  test(`${action} prevents a queued effect from starting`, async (t) => {
    const { runtime, state, accept, calls } = harness(t);
    accept([{ id: 'write', type: 'prompt.submit' }]);
    if (action === 'finish') markRequestRuntimeFinished(state);
    else if (action === 'clear') runtime.clear(state.requestId);
    else runtime.close();
    await flush();
    assert.deepEqual(calls, []);
  });
}

test('a cleared terminal callback cannot publish after shutdown', async (t) => {
  const { runtime, accept, calls } = harness(t);
  accept([{ id: 'release' }], { code: 'completed' });
  runtime.close();
  await flush();
  assert.deepEqual(calls, []);
});

test('synchronous executor failures are reported without escaping the microtask', async (t) => {
  const failure = new Error('executor failed synchronously');
  const { accept, errors } = harness(t, { executeEffect() { throw failure; } });
  accept([{ id: 'read' }]);
  await flush();
  assert.deepEqual(errors, [failure]);
});

test('duplicate terminal delivery publishes and releases once', async (t) => {
  const { accept, calls } = harness(t);
  accept([{ id: 'release' }], { code: 'completed' });
  accept([{ id: 'release' }], { code: 'completed' });
  await flush();
  assert.deepEqual(calls, ['terminal', 'release']);
});

test('an old effect completion cannot remove a replacement effect registration', async (t) => {
  let complete;
  let executions = 0;
  const { runtime, state, accept } = harness(t, {
    executeEffect() {
      executions += 1;
      return new Promise((resolve) => { if (executions === 1) complete = resolve; });
    },
  });
  accept([{ id: 'read' }]);
  await flush();
  runtime.clear(state.requestId);
  accept([{ id: 'read' }]);
  await flush();
  complete();
  await flush();
  accept([{ id: 'read' }]);
  await flush();
  assert.equal(executions, 2);
});
