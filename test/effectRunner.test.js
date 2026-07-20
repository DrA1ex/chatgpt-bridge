import test from 'node:test';
import assert from 'node:assert/strict';
import { EffectRunner } from '../src/bridge/effects/effectRunner.js';
import { RequestEventType, createRequestEvent } from '../src/bridge/state/requestEvents.js';
import { reduceRequestState } from '../src/bridge/state/requestMachine.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('EffectRunner deduplicates active and completed effect delivery', async () => {
  const gate = deferred();
  let calls = 0;
  const events = [];
  const runner = new EffectRunner({
    handlers: {
      'prompt.submit': async () => {
        calls += 1;
        return await gate.promise;
      },
    },
    onEvent: (event) => events.push(event),
    now: () => 10,
  });

  const effect = { id: 'effect-1', type: 'prompt.submit', data: { message: 'hello' } };
  const first = runner.run('req-1', effect);
  const duplicate = runner.run('req-1', effect);
  assert.equal(first, duplicate);
  assert.equal(calls, 1);

  gate.resolve({ submitted: true });
  const completed = await first;
  assert.equal(completed.type, RequestEventType.EFFECT_SUCCEEDED);
  assert.equal(events.filter((event) => event.type === RequestEventType.EFFECT_STARTED).length, 1);

  const replay = await runner.run('req-1', effect);
  assert.equal(replay, completed);
  assert.equal(calls, 1);
});

test('late handler success after cancellation becomes effect.cancelled', async () => {
  const gate = deferred();
  const runner = new EffectRunner({
    handlers: { 'artifact.fetch': async () => await gate.promise },
    now: () => 20,
  });
  const pending = runner.run('req-cancel', { id: 'fetch-1', type: 'artifact.fetch' });
  assert.equal(runner.cancel('fetch-1', 'request completed elsewhere'), true);
  gate.resolve({ bytes: 10 });
  const result = await pending;
  assert.equal(result.type, RequestEventType.EFFECT_CANCELLED);
  assert.equal(result.data.message, 'request completed elsewhere');
});

test('effect failures preserve typed retryability and evidence', async () => {
  const runner = new EffectRunner({
    handlers: {
      'model.select': async () => {
        const error = new Error('Model option did not stabilize');
        error.code = 'MODEL_OPTION_UNSTABLE';
        error.retryable = true;
        error.evidence = { attempts: 2 };
        throw error;
      },
    },
    now: () => 30,
  });
  const result = await runner.run('req-failure', { id: 'model-1', type: 'model.select' });
  assert.equal(result.type, RequestEventType.EFFECT_FAILED);
  assert.equal(result.data.code, 'MODEL_OPTION_UNSTABLE');
  assert.equal(result.data.retryable, true);
  assert.deepEqual(result.data.evidence, { attempts: 2 });
});

test('EffectRunner events can drive the pure request reducer', async () => {
  let state = reduceRequestState(null, createRequestEvent(RequestEventType.CREATED, 'req-machine', {}, {
    eventId: 'created', occurredAt: 1, receivedAt: 1,
  })).state;
  const runner = new EffectRunner({
    handlers: { 'prompt.submit': async () => ({ submitted: true }) },
    onEvent: (event) => {
      const outcome = reduceRequestState(state, event);
      assert.equal(outcome.accepted, true);
      state = outcome.state;
    },
    now: () => 40,
  });

  const result = await runner.run('req-machine', { id: 'submit-1', type: 'prompt.submit' });
  assert.equal(result.type, RequestEventType.EFFECT_SUCCEEDED);
  assert.equal(state.effect.coordinator.activeId, null);
  assert.equal(state.effect.coordinator.lastResult.type, RequestEventType.EFFECT_SUCCEEDED);
  assert.equal(state.effect.browser.activeId, null);
  assert.equal(state.terminal, null);
});
