import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../tools/chrome-bridge-extension/content/requestTelemetry.js', import.meta.url), 'utf8');

function factory() {
  const context = { console, Date };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.ChatGptRequestTelemetry;
}

function request() {
  return {
    requestId: 'request-persistence',
    leaseId: 'lease-persistence',
    ownerServerInstanceId: 'server-persistence',
    commandId: 'command-persistence',
    responseEpoch: 1,
    phase: 'model_apply',
    update() {},
  };
}

function descriptor() {
  return {
    kind: 'model.apply',
    effectId: 'request-persistence:model.apply:attempt:1',
    idempotencyKey: 'request-persistence:model.apply',
    retryPolicy: 'if_unconfirmed',
    write: true,
    attempt: 1,
    preconditions: {
      requestId: 'request-persistence',
      leaseId: 'lease-persistence',
      ownerServerInstanceId: 'server-persistence',
      responseEpoch: 1,
      model: 'gpt-test',
    },
    preconditionsHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
}

function persistedEffect(payload, status, overrides = {}) {
  return {
    persisted: true,
    effect: {
      ...payload,
      requestId: payload.requestId,
      leaseId: payload.leaseId,
      ownerServerInstanceId: payload.ownerServerInstanceId,
      responseEpoch: payload.responseEpoch,
      attempt: payload.attempt,
      status,
      ...overrides,
    },
  };
}

function telemetry({ planEffect, settleEffect, sent = [], diagnostics = [] } = {}) {
  return factory().createRequestTelemetry({
    diagnostic: (type, data) => diagnostics.push({ type, data }),
    findStopButton: () => null,
    getAssistantNodes: () => [],
    getCurrentSession: () => ({ id: 'session-persistence' }),
    getTurnNodes: () => [],
    pagePresence: () => ({}),
    planEffect,
    settleEffect,
    send: (message) => sent.push(structuredClone(message)),
  });
}

test('request browser action starts only after the exact durable dispatched effect is confirmed', async () => {
  const sent = [];
  let executed = 0;
  const api = telemetry({
    sent,
    planEffect: async (payload) => persistedEffect(payload, 'dispatched'),
    settleEffect: async (payload) => persistedEffect(payload, payload.status),
  });
  const result = await api.runObservedRequestEffect(request(), 'model.apply', async () => {
    executed += 1;
    return { model: 'gpt-test' };
  }, { effect: descriptor(), result: (value) => value });

  assert.deepEqual(result, { model: 'gpt-test' });
  assert.equal(executed, 1);
  assert.deepEqual(sent.map((item) => item.type), ['request.effect.started']);
});

test('mismatched durable plan confirmation fails closed before the browser action', async () => {
  const sent = [];
  let executed = 0;
  const api = telemetry({
    sent,
    planEffect: async (payload) => persistedEffect(payload, 'dispatched', { preconditionsHash: 'wrong-hash' }),
    settleEffect: async (payload) => persistedEffect(payload, payload.status),
  });

  await assert.rejects(
    api.runObservedRequestEffect(request(), 'model.apply', async () => { executed += 1; }, { effect: descriptor() }),
    (error) => error?.code === 'BROWSER_EFFECT_PERSISTENCE_FAILED',
  );
  assert.equal(executed, 0);
  assert.deepEqual(sent, []);
});

test('an unpersisted physical result is not published as a canonical effect result', async () => {
  const sent = [];
  const diagnostics = [];
  let executed = 0;
  const api = telemetry({
    sent,
    diagnostics,
    planEffect: async (payload) => persistedEffect(payload, 'dispatched'),
    settleEffect: async () => { throw new Error('storage unavailable'); },
  });

  await assert.rejects(
    api.runObservedRequestEffect(request(), 'model.apply', async () => {
      executed += 1;
      return { model: 'gpt-test' };
    }, { effect: descriptor(), result: (value) => value }),
    (error) => error?.code === 'BROWSER_EFFECT_PERSISTENCE_FAILED' && error?.bridgeEffectReported === true,
  );
  assert.equal(executed, 1);
  assert.deepEqual(sent.map((item) => item.type), ['request.effect.started']);
  assert.equal(diagnostics.some((item) => item.type === 'request.effect.persistence_failed'), true);
});
