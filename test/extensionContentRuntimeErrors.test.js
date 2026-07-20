import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapExtensionContentRuntime } from './helpers/extensionContentRuntime.js';

test('server command router converts rejected async handlers into correlated command errors', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const sent = [];
  const router = sandbox.ChatGptServerCommandRouter.createServerCommandRouter({
    CONTENT_SCRIPT_VERSION: '4.2.4',
    EXTENSION_VERSION: '2.2.4',
    handleEffectReconcile: async () => { throw new TypeError("Cannot read properties of undefined (reading 'length')"); },
    send(payload) { sent.push(payload); },
  });
  router.handleServerMessage({
    type: 'request.effect.reconcile',
    commandId: 'command-reconcile-runtime-error',
    requestId: 'request-runtime-error',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'command.error');
  assert.equal(sent[0].commandId, 'command-reconcile-runtime-error');
  assert.equal(sent[0].requestId, 'request-runtime-error');
  assert.equal(sent[0].message, "Cannot read properties of undefined (reading 'length')");
});

test('recovered content runtime accepts typed stale-epoch anchor updates without mutable projection compatibility', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime(undefined, {
    startRuntime: 'connect',
    bridgeToken: 'runtime-regression-token',
  });
  sandbox.__extensionPortTest.dispatch({
    type: 'extension.connected',
    browserTabId: 77,
    recovery: {
      lease: {
        requestId: 'request-recovered-runtime',
        leaseId: 'lease-recovered-runtime',
        ownerServerInstanceId: 'server-recovered-runtime',
      },
      effects: [],
    },
  });

  const stateFactory = sandbox.ChatGptRequestState;
  const executionFactory = sandbox.ChatGptRequestExecutionState;
  const store = executionFactory.createRequestExecutionStore({ recoverRequest: stateFactory.recoverRequestState });
  assert.equal(store.setCurrent(stateFactory.createRequestState('request-compat')).accepted, true);
  const handle = store.getCurrent();
  assert.doesNotThrow(() => handle.update('request.anchor_updated', { pendingSubmittedTurnBaseline: new Set(['turn-1']) }));
  assert.deepEqual([...handle.pendingSubmittedTurnBaseline], ['turn-1']);
  assert.throws(() => { handle.pendingSubmittedTurnBaseline = new Set(['forbidden']); }, TypeError);
  assert.equal(store.getSnapshot().journal.at(-1)?.type, 'request.anchor_updated');
});

test('malformed effect reconciliation cannot escape as an unhandled promise rejection', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime(undefined, {
    startRuntime: 'connect',
    bridgeToken: 'runtime-regression-token',
  });
  sandbox.__extensionPortTest.dispatch({
    type: 'extension.connected',
    browserTabId: 78,
    recovery: {
      lease: {
        requestId: 'request-malformed-reconcile',
        leaseId: 'lease-malformed-reconcile',
        ownerServerInstanceId: 'server-malformed-reconcile',
      },
      effects: [],
    },
  });
  assert.doesNotThrow(() => sandbox.__extensionPortTest.dispatch({
    type: 'server.message',
    payload: {
      type: 'request.effect.reconcile',
      commandId: 'command-malformed-reconcile',
      requestId: 'request-malformed-reconcile',
      effectId: 'effect-malformed-reconcile',
      effectType: 'attachments.upload',
      evidence: { attachments: { malformed: true } },
      backgroundEvidence: { downloads: null },
    },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const result = sandbox.__extensionPortTest.messages
    .filter((message) => message.type === 'bridge.payload')
    .map((message) => message.payload)
    .find((payload) => payload.commandId === 'command-malformed-reconcile');
  assert(result, 'Reconciliation did not return a correlated result');
  assert.equal(['request.effect.reconciled', 'command.error'].includes(result.type), true);
});


test('prompt.send echoes its generated command identity in the content acceptance result', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime(undefined, {
    startRuntime: 'connect',
    bridgeToken: 'runtime-regression-token',
  });
  sandbox.__extensionPortTest.dispatch({
    type: 'extension.connected',
    browserTabId: 79,
    recovery: { lease: null, effects: [] },
  });
  sandbox.__extensionPortTest.dispatch({
    type: 'server.message',
    payload: {
      type: 'prompt.send',
      commandId: 'command-prompt-startup',
      requestId: 'request-prompt-startup',
      leaseId: 'lease-prompt-startup',
      ownerServerInstanceId: 'server-prompt-startup',
      message: 'Hello from the startup contract test',
      options: {},
      attachments: [],
      executionPlan: { requestId: 'request-prompt-startup', startAtStepId: 'step-1', steps: [{ stepId: 'step-1', kind: 'page.ready.initial', effectId: 'effect-1', idempotencyKey: 'idem-1', retryPolicy: 'always', write: false, preconditions: {}, preconditionsHash: 'hash-1', attempt: 1 }, { stepId: 'step-2', kind: 'session.apply', effectId: 'effect-2', idempotencyKey: 'idem-2', retryPolicy: 'if_unconfirmed', write: true, preconditions: {}, preconditionsHash: 'hash-2', attempt: 1 }, { stepId: 'step-3', kind: 'model.apply', effectId: 'effect-3', idempotencyKey: 'idem-3', retryPolicy: 'if_unconfirmed', write: true, preconditions: {}, preconditionsHash: 'hash-3', attempt: 1 }, { stepId: 'step-4', kind: 'prompt.submit', effectId: 'effect-4', idempotencyKey: 'idem-4', retryPolicy: 'never', write: true, preconditions: {}, preconditionsHash: 'hash-4', attempt: 1 }] },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const accepted = sandbox.__extensionPortTest.messages
    .filter((message) => message.type === 'bridge.payload')
    .map((message) => message.payload)
    .find((payload) => payload.type === 'prompt.accepted' && payload.requestId === 'request-prompt-startup');
  assert(accepted, 'Content runtime did not acknowledge prompt.send');
  assert.equal(accepted.commandId, 'command-prompt-startup');
});
