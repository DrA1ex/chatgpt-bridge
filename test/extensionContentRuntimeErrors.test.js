import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { bootstrapExtensionContentRuntime } from './helpers/extensionContentRuntime.js';

const routerHandlerDependencies = [
  'handleRequestResume', 'handleEffectReconcile', 'handlePromptSend', 'handlePassivePromptSubmit',
  'handlePromptCancel', 'handleRequestRelease', 'handlePromptSteer', 'handleSessionsList',
  'handleSessionsNew', 'handleSessionsSelect', 'handleSessionsDelete', 'handleBrowserTabOpen',
  'handleBrowserTabClose', 'handleBrowserOwnedTabClose', 'handleBrowserTabReload', 'handleLayoutCapture',
  'handleExtensionReload', 'handleArtifactFetch', 'handleResponseSnapshotRequest', 'handleResponseRecoverLatest',
  'handleResponseRecoverTurnKey', 'handleResponseRecoverList', 'handleModelsList', 'handleEffortsList',
  'handleIntelligenceApply', 'handleComposerAttachmentsClear',
];

function completeRouterDeps(overrides = {}) {
  return {
    CONTENT_SCRIPT_VERSION: '4.3.0',
    EXTENSION_VERSION: '2.3.0',
    ...Object.fromEntries(routerHandlerDependencies.map((name) => [name, async () => {}])),
    ...overrides,
  };
}

test('server command router rejects an incomplete handler registry at construction', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  assert.throws(
    () => sandbox.ChatGptServerCommandRouter.createServerCommandRouter({}),
    /Missing content command handler dependency/,
  );
});

test('server command router converts rejected async handlers into correlated command errors', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const sent = [];
  const router = sandbox.ChatGptServerCommandRouter.createServerCommandRouter(completeRouterDeps({
    handleEffectReconcile: async () => { throw new TypeError("Cannot read properties of undefined (reading 'length')"); },
    send(payload) { sent.push(payload); },
  }));
  router.handleServerMessage({
    type: 'request.effect.reconcile',
    commandScope: 'request',
    commandId: 'command-reconcile-runtime-error',
    requestId: 'request-runtime-error',
    effectId: 'effect-reconcile-runtime-error',
    effectType: 'model.apply',
    retryPolicy: 'if_unconfirmed',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'command.error');
  assert.equal(sent[0].commandId, 'command-reconcile-runtime-error');
  assert.equal(sent[0].requestId, 'request-runtime-error');
  assert.equal(sent[0].message, "Cannot read properties of undefined (reading 'length')");
});


test('effect-backed handler failures durably settle uncertainty without emitting a competing command terminal', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const sent = [];
  const settlements = [];
  const router = sandbox.ChatGptServerCommandRouter.createServerCommandRouter(completeRouterDeps({
    handlePromptSteer: async () => { throw new Error('unexpected effect executor failure'); },
    async settleUnexecutableEffect(...args) { settlements.push(args); },
    send(payload) { sent.push(payload); },
  }));
  router.handleServerMessage({
    type: 'prompt.steer',
    commandScope: 'request',
    commandId: 'command-steer-runtime-error',
    requestId: 'request-runtime-error',
    leaseId: 'lease-runtime-error',
    ownerServerInstanceId: 'server-runtime-error',
    responseEpoch: 2,
    message: 'Continue with the revised answer.',
    effect: {
      effectId: 'effect-steer-runtime-error',
      kind: 'prompt.steer',
      idempotencyKey: 'request-runtime-error:prompt.steer:1',
      preconditionsHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.some((payload) => payload.type === 'command.error' || payload.type === 'command.result'), false);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0][0].requestId, 'request-runtime-error');
  assert.equal(settlements[0][0].leaseId, 'lease-runtime-error');
  assert.equal(settlements[0][0].ownerServerInstanceId, 'server-runtime-error');
  assert.equal(settlements[0][0].responseEpoch, 2);
  assert.equal(settlements[0][1], 'prompt.steer');
  assert.equal(settlements[0][2].effectId, 'effect-steer-runtime-error');
  assert.equal(settlements[0][4].provenNotExecuted, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'diagnostic');
  assert.equal(sent[0].diagnosticType, 'effect.command.unhandled_error_settled');
});

test('prompt execution handler failures settle the exact current execution-plan effect', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const settlements = [];
  const router = sandbox.ChatGptServerCommandRouter.createServerCommandRouter(completeRouterDeps({
    handlePromptSend: async () => { throw new Error('prompt handler crashed before executor entry'); },
    async settleUnexecutableEffect(...args) { settlements.push(args); },
    send() {},
  }));
  router.handleServerMessage({
    type: 'prompt.send',
    commandScope: 'request',
    commandId: 'command-prompt-runtime-error',
    requestId: 'request-prompt-runtime-error',
    leaseId: 'lease-prompt-runtime-error',
    ownerServerInstanceId: 'server-prompt-runtime-error',
    executionStepOnly: true,
    message: 'Hello',
    executionPlan: {
      startAtStepId: 'model.apply',
      steps: [{
        stepId: 'page.ready.initial', kind: 'page.ready.initial', effectId: 'effect-ready', idempotencyKey: 'ready', preconditionsHash: 'ready-hash',
      }, {
        stepId: 'model.apply', kind: 'model.apply', effectId: 'effect-model', idempotencyKey: 'model', preconditionsHash: 'model-hash',
      }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0][1], 'model.apply');
  assert.equal(settlements[0][2].effectId, 'effect-model');
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


test('prompt.send does not create a second content-owned command acceptance or terminal result', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestPromptCommands.js'), 'utf8');
  assert.doesNotMatch(source, /send\(\{\s*type:\s*['"]prompt\.accepted/);
  assert.doesNotMatch(source, /prompt\.execution\.step\.completed/);
  assert.doesNotMatch(source, /send\(\{\s*type:\s*['"]prompt\.(?:steered|cancelled)/);
  assert.match(source, /runObservedRequestEffect\(request, currentStepKind/);
  assert.match(source, /settleEffectCommandWithoutExecution/);
});
