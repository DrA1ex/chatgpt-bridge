import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestControlCoordinator } from '../src/bridge/coordinator/requestControlCoordinator.js';
import { markRequestRuntimeFinished } from '../src/bridge/coordinator/requestRuntimeProjection.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const state = { requestId: 'req-1', clientId: 'tab-1', thinking: 'working', progress: {}, runtime: { finished: false } };
  const canonical = { submission: 'submitted', generation: 'active', response: { epoch: 0 }, terminal: null };
  const calls = [];
  const events = [];
  let complete;
  const coordinator = new RequestControlCoordinator({
    pending: new Map([[state.requestId, state]]), operations: {},
    sendCommand(type, payload) {
      calls.push({ type, payload });
      return new Promise((resolve) => { complete = resolve; });
    },
    lifecycle: {
      getState: () => canonical,
      requestIdentity: () => ({ requestId: 'req-1', leaseId: 'lease-1', ownerServerInstanceId: 'server-1', responseEpoch: canonical.response.epoch }),
      runRequestEffect: (_state, effect) => effect.execute(),
      canonicalEvent: (_state, type, data) => ({ type, data }),
      ingestRequestTransition(_state, event) {
        canonical.response.epoch = event.data.targetResponseEpoch;
        return { accepted: true };
      },
      emitRequestEvent: (_state, event) => events.push(event),
      touchState() {},
    },
  });
  return { coordinator, state, canonical, calls, events, finish: () => complete({ previousResponseEpoch: 0, targetResponseEpoch: 1 }) };
}

test('steering rejects a browser source other than the request owner', async () => {
  const { coordinator, calls } = harness();
  await assert.rejects(coordinator.steerRequest('req-1', 'change', { sourceClientId: 'tab-2' }),
    (error) => error.code === 'REQUEST_STEER_SOURCE_MISMATCH');
  assert.deepEqual(calls, []);
});

test('concurrent steering cannot alias distinct messages to one response epoch', async () => {
  const { coordinator, calls, finish } = harness();
  const first = coordinator.steerRequest('req-1', 'first instruction');
  const second = coordinator.steerRequest('req-1', 'second instruction');
  const rejected = assert.rejects(second, (error) => error.code === 'REQUEST_STEER_IN_PROGRESS');
  await flush();
  finish();
  await rejected;
  await first;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.message, 'first instruction');
});

for (const action of ['finish', 'abort']) {
  test(`${action} between readiness and dispatch prevents steering`, async () => {
    const { coordinator, state, calls } = harness();
    const controller = new AbortController();
    const pending = coordinator.steerRequest('req-1', 'change', { signal: controller.signal });
    if (action === 'finish') markRequestRuntimeFinished(state);
    else controller.abort('cancelled');
    await assert.rejects(pending, (error) => action === 'finish'
      ? error.code === 'REQUEST_COMPLETED_BEFORE_STEER' : error.name === 'AbortError');
    assert.deepEqual(calls, []);
  });
}

test('a late physical steer result cannot publish acceptance for a finished request', async () => {
  const { coordinator, state, events, finish } = harness();
  const pending = coordinator.steerRequest('req-1', 'change');
  const rejected = assert.rejects(pending, (error) => error.code === 'REQUEST_COMPLETED_BEFORE_STEER');
  await flush();
  markRequestRuntimeFinished(state);
  finish();
  await rejected;
  assert.equal(events.some((event) => event.type === 'prompt.steer.accepted'), false);
});
