import test from 'node:test';
import { describeTransfer } from '../src/bridge/transferIntegrity.js';
import assert from 'node:assert/strict';
import { BrowserExtensionHub } from '../src/browserExtensionHub.js';
import { BridgeCommandRegistry } from '../src/bridge/coordinator/bridgeCommandRegistry.js';
import {
  createPromptExecutionPlan,
  createPromptResponseRetryPlan,
  createRequestEffectDescriptor,
} from '../src/bridge/requestExecutionPlan.js';
import { createExtensionEnvelope, ExtensionMessageType } from '../src/bridge/protocol/v5.js';
import { BackgroundStateStore } from '../tools/chrome-bridge-extension/background/stateV6.js';
import { createProtocolOutbox } from '../tools/chrome-bridge-extension/background/outboxV5.js';
import { handlePayload, handleReleaseCleanupSettlement } from '../tools/chrome-bridge-extension/background/portRouter.js';
import { handleServerEnvelope } from '../tools/chrome-bridge-extension/background/serverEnvelopeRouter.js';
import { createExtensionReloadCoordinator } from '../tools/chrome-bridge-extension/background/extensionReloadCoordinator.js';
import { createMaintenanceOperationStore } from '../tools/chrome-bridge-extension/background/maintenanceOperations.js';
import { connectExtensionClient } from './helpers/extensionClient.js';

function memoryStorage() {
  const values = new Map();
  return {
    async get(key) { return { [key]: structuredClone(values.get(key)) }; },
    async set(record) { for (const [key, value] of Object.entries(record)) values.set(key, structuredClone(value)); },
    async remove(key) { values.delete(key); },
  };
}

function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for regression condition'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function serverEnvelope({ sequence, commandId, type, request = null, payload = {} }) {
  return createExtensionEnvelope(ExtensionMessageType.COMMAND_EXECUTE, {
    type, commandId, serverInstanceId: 'server-regression', ...payload,
  }, {
    messageId: `message-${commandId}`,
    commandId,
    request,
    source: { clientId: 'server', tabId: null, backgroundEpoch: 'server-regression', contentEpoch: '', sequence },
  });
}

function promptPayload(request, message = 'hello') {
  return {
    message,
    options: {},
    attachments: [],
    executionPlan: createPromptExecutionPlan({ request, message, options: {}, attachments: [] }),
    executionStepOnly: true,
  };
}

function effectPayload(request, kind, extra = {}) {
  return {
    effect: createRequestEffectDescriptor({ request, kind, logicalId: `${request.requestId}:${kind}` }),
    ...extra,
  };
}

function releaseRecoveryEvent(h, request, commandId) {
  const terminalEnvelope = h.createEnvelopeDraft(h.state, ExtensionMessageType.LEASE_RELEASED, {
    commandId, requestId: request.requestId, released: true, activeRequest: null,
  }, { commandId, causationId: `message-${commandId}`, lease: request });
  const acceptedEnvelope = h.createEnvelopeDraft(h.state, ExtensionMessageType.COMMAND_ACCEPTED, {
    commandId, commandType: 'request.release', requestId: request.requestId, commandScope: 'request', commandMode: 'release',
  }, { commandId, causationId: `message-${commandId}`, lease: request });
  return {
    type: 'lease.release_recover', ...request, commandId, commandType: 'request.release', scope: 'request', mode: 'release',
    causationId: `message-${commandId}`, idempotencyKey: commandId, retryPolicy: 'always', reconcilePolicy: 'lease_cleanup',
    operation: 'control', preconditions: { commandType: 'request.release' }, acceptedEnvelope, terminalEnvelope,
    contentEpoch: h.state.contentEpoch,
  };
}

function backgroundHarness(tabId = 91) {
  const backgroundState = new BackgroundStateStore(memoryStorage(), 'background-regression');
  const sent = [];
  const posted = [];
  const state = {
    tabId, clientId: `client-${tabId}`, contentEpoch: 'content-regression', connectionEpoch: 'connection-regression',
    protocolReady: true, port: null, ws: { readyState: 1, send(value) { sent.push(JSON.parse(value)); } },
  };
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const post = (_port, message) => posted.push(message);
  const outbox = createProtocolOutbox({ backgroundEpoch: 'background-regression', backgroundState, post, summarize: (value) => value });
  return {
    backgroundState, state, sent, posted, post,
    createEnvelopeDraft: outbox.createEnvelopeDraft,
    sendProtocolMessage: outbox.sendProtocolMessage,
    flushCriticalOutbox: outbox.flushCriticalOutbox,
    replayCriticalOutbox: outbox.replayCriticalOutbox,
    scheduleReleaseDeadline() {},
    restore() { if (previousWebSocket === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = previousWebSocket; },
  };
}

async function initializeHarness(h) {
  await h.backgroundState.transition(h.state.tabId, { type: 'content.attached', contentEpoch: h.state.contentEpoch });
}

async function quarantineLease(h, request) {
  await h.backgroundState.transition(h.state.tabId, { type: 'lease.claim', ...request, contentEpoch: h.state.contentEpoch });
  await h.backgroundState.transition(h.state.tabId, { type: 'lease.quarantine', ...request, reason: 'release outcome is unresolved', contentEpoch: h.state.contentEpoch });
}

test('Hub sends only explicit Protocol 5 command.execute envelopes', async () => {
  const hub = new BrowserExtensionHub(null, { serverInstanceId: 'server-hub-owner' });
  const connection = await connectExtensionClient(hub, { clientId: 'tab-hub-owner', url: 'https://chatgpt.com/c/session-owner' });
  const commands = [];
  connection.ws.on('message', (data) => {
    const message = JSON.parse(String(data));
    if (message.messageType === ExtensionMessageType.COMMAND_EXECUTE) commands.push(message);
  });
  try {
    hub.sendToClientWithDelivery('tab-hub-owner', { type: 'debug.layout.capture', commandId: 'standalone-layout', requestId: 'stale-request' });
    const standalone = await waitFor(() => commands.find((item) => item.commandId === 'standalone-layout'));
    assert.equal(standalone.request, null);
    assert.equal(standalone.body.commandScope, 'standalone');
    assert.equal(standalone.body.requestId, 'stale-request');
    assert.equal(Object.hasOwn(standalone, 'kind'), false);
    assert.equal(Object.hasOwn(standalone, 'payload'), false);
  } finally { await connection.close(); }
});

test('effect-backed command registry ignores generic command results and settles from one physical effect outcome', async () => {
  const delivered = [];
  const registry = new BridgeCommandRegistry({ hub: {
    sendToClientWithDelivery(clientId, payload, options) { delivered.push({ clientId, payload, options }); return { client: { id: clientId }, delivered: Promise.resolve() }; },
  } });
  const request = { requestId: 'request-steer', leaseId: 'lease-steer', ownerServerInstanceId: 'server-steer', responseEpoch: 0 };
  try {
    const pending = registry.send('prompt.steer', effectPayload(request, 'prompt.steer', { message: 'continue' }), { sourceClientId: 'tab', commandId: 'steer-command', request, timeoutMs: 1_000 });
    await waitFor(() => delivered.length === 1);
    assert.equal(registry.handleResponse('tab', { type: 'command.result', commandId: 'steer-command', resultType: 'prompt.steered' }), false);
    registry.handleResponse('tab', {
      type: 'request.effect.succeeded', commandId: 'steer-command', effectId: 'steer-effect', effectType: 'prompt.steer',
      requestId: request.requestId, responseEpoch: 0, result: { submittedUserTurnKey: 'user-2' },
    });
    const result = await pending;
    assert.equal(result.effectId, 'steer-effect');
    assert.equal(result.result.submittedUserTurnKey, 'user-2');
  } finally { registry.close(); }
});

test('standalone result command never claims a lease and a valid prompt command atomically claims one with its first effect', async () => {
  const h = backgroundHarness();
  try {
    await initializeHarness(h);
    await handleServerEnvelope({ ...h, envelope: serverEnvelope({ sequence: 1, commandId: 'layout-command', type: 'debug.layout.capture', payload: { requestId: 'stale' } }) });
    let runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.lease, null);
    assert.equal(runtime.commands['layout-command'].scope, 'standalone');

    const request = { requestId: 'request-after-layout', leaseId: 'lease-after-layout', ownerServerInstanceId: 'server-regression', responseEpoch: 0 };
    await handleServerEnvelope({ ...h, envelope: serverEnvelope({ sequence: 2, commandId: 'prompt-command', type: 'prompt.send', request, payload: promptPayload(request) }) });
    runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.lease.requestId, request.requestId);
    assert.equal(runtime.commands['prompt-command'].status, 'accepted');
    assert.equal(runtime.effects['request-after-layout:page.ready.initial:attempt:1'].status, 'dispatched');
  } finally { h.restore(); }
});

test('background accepts the server-owned response retry plan without a repeated session write', async () => {
  const h = backgroundHarness(98);
  const initialRequest = {
    requestId: 'request-response-retry',
    leaseId: 'lease-response-retry',
    ownerServerInstanceId: 'server-regression',
    responseEpoch: 0,
  };
  try {
    await initializeHarness(h);
    await handleServerEnvelope({
      ...h,
      envelope: serverEnvelope({
        sequence: 1,
        commandId: 'initial-prompt-command',
        type: 'prompt.send',
        request: initialRequest,
        payload: promptPayload(initialRequest, 'retry this prompt'),
      }),
    });
    const retryRequest = { ...initialRequest, responseEpoch: 1 };
    const executionPlan = createPromptResponseRetryPlan({
      request: retryRequest,
      message: 'retry this prompt',
      options: { sessionId: 'session-proven' },
      attachments: [],
    });
    await handleServerEnvelope({
      ...h,
      envelope: serverEnvelope({
        sequence: 2,
        commandId: 'response-retry-command',
        type: 'prompt.send',
        request: retryRequest,
        payload: {
          message: 'retry this prompt',
          options: { sessionId: 'session-proven' },
          attachments: [],
          executionPlan,
          executionStepOnly: true,
          continuationOfEffectId: 'response-retry-effect',
          continuationReason: 'chatgpt_transient_error_retry',
          responseRetry: {
            attempt: 1,
            previousResponseEpoch: 0,
            targetResponseEpoch: 1,
            failedUserTurnKey: 'user-failed',
            errorCode: 'CHATGPT_TRANSIENT_REQUEST_ERROR',
          },
        },
      }),
    });

    const runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.commands['response-retry-command'].status, 'accepted');
    assert.equal(executionPlan.steps.some((step) => step.kind === 'session.apply'), false);
    assert.equal(runtime.effects[executionPlan.steps[0].effectId].status, 'dispatched');
  } finally { h.restore(); }
});

test('background owns release: content only proves cleanup and the exact lease.released envelope is created atomically', async () => {
  const h = backgroundHarness(92);
  const request = { requestId: 'request-release', leaseId: 'lease-release', ownerServerInstanceId: 'server-regression', responseEpoch: 0 };
  try {
    await initializeHarness(h);
    await handleServerEnvelope({ ...h, envelope: serverEnvelope({ sequence: 1, commandId: 'prompt-command', type: 'prompt.send', request, payload: promptPayload(request) }) });
    const firstEffect = (await h.backgroundState.read(h.state.tabId)).effects['request-release:page.ready.initial:attempt:1'];
    const cancelledBody = {
      requestId: request.requestId, effectId: firstEffect.effectId, effectType: firstEffect.kind,
      idempotencyKey: firstEffect.idempotencyKey, responseEpoch: 0, commandId: firstEffect.commandId,
      provenNotExecuted: true, cancellationEvidence: { source: 'test', reason: 'not_started' },
    };
    const cancelledEnvelope = h.createEnvelopeDraft(h.state, ExtensionMessageType.EFFECT_CANCELLED, cancelledBody, {
      effectId: firstEffect.effectId, commandId: firstEffect.commandId, lease: request,
    });
    const cancelled = await h.backgroundState.transition(h.state.tabId, {
      type: 'effect.cancelled', ...request, effectId: firstEffect.effectId, idempotencyKey: firstEffect.idempotencyKey,
      preconditionsHash: firstEffect.preconditionsHash, provenNotExecuted: true,
      cancellationEvidence: cancelledBody.cancellationEvidence, terminalEnvelope: cancelledEnvelope, contentEpoch: h.state.contentEpoch,
    });
    assert.equal(cancelled.accepted, true, cancelled.reason);
    await handleServerEnvelope({ ...h, envelope: serverEnvelope({ sequence: 2, commandId: 'release-command', type: 'request.release', request }) });
    await handleReleaseCleanupSettlement(h, h.state, { commandId: 'release-command', requestId: request.requestId, status: 'completed', released: true });
    const runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.lease, null);
    assert.equal(runtime.commands['release-command'].status, 'succeeded');
    const releaseEntries = runtime.outbox.filter((item) => item.messageType === ExtensionMessageType.LEASE_RELEASED);
    assert.equal(releaseEntries.length, 1);
    assert.equal(releaseEntries[0].commandId, 'release-command');
  } finally { h.restore(); }
});

test('uncertain steer preserves the server-owned response epoch and a following cancel can use the same lease identity', async () => {
  const h = backgroundHarness(93);
  const request = { requestId: 'request-uncertain', leaseId: 'lease-uncertain', ownerServerInstanceId: 'server-regression', responseEpoch: 0 };
  try {
    await initializeHarness(h);
    await h.backgroundState.transition(h.state.tabId, { type: 'lease.claim', ...request, contentEpoch: h.state.contentEpoch });
    await h.backgroundState.transition(h.state.tabId, { type: 'lease.executing', ...request, contentEpoch: h.state.contentEpoch });
    await handleServerEnvelope({ ...h, envelope: serverEnvelope({ sequence: 1, commandId: 'steer-command', type: 'prompt.steer', request, payload: effectPayload(request, 'prompt.steer', { message: 'continue' }) }) });
    const steer = Object.values((await h.backgroundState.read(h.state.tabId)).effects).find((effect) => effect.commandId === 'steer-command');
    assert.ok(steer);
    const uncertainBody = {
      requestId: request.requestId, effectId: steer.effectId, effectType: steer.kind,
      idempotencyKey: steer.idempotencyKey, responseEpoch: 0, commandId: steer.commandId,
      code: 'PROMPT_SUBMIT_UNCERTAIN', message: 'proof missing', recoverable: true, uncertain: true,
    };
    const uncertainEnvelope = h.createEnvelopeDraft(h.state, ExtensionMessageType.EFFECT_UNCERTAIN, uncertainBody, {
      effectId: steer.effectId, commandId: steer.commandId, lease: request,
    });
    const uncertain = await h.backgroundState.transition(h.state.tabId, {
      type: 'effect.uncertain', ...request, effectId: steer.effectId, idempotencyKey: steer.idempotencyKey,
      preconditionsHash: steer.preconditionsHash, error: { code: uncertainBody.code, message: uncertainBody.message },
      terminalEnvelope: uncertainEnvelope, contentEpoch: h.state.contentEpoch,
    });
    assert.equal(uncertain.accepted, true, uncertain.reason);
    let runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.lease.responseEpoch, 0);
    assert.equal(runtime.commands['steer-command'].status, 'uncertain');

    await handleServerEnvelope({ ...h, envelope: serverEnvelope({ sequence: 2, commandId: 'cancel-command', type: 'prompt.cancel', request, payload: effectPayload(request, 'prompt.cancel') }) });
    runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.commands['cancel-command'].status, 'accepted');
    assert.equal(runtime.lease.responseEpoch, 0);
  } finally { h.restore(); }
});

test('unproven release cleanup quarantines the tab instead of making it schedulable', async () => {
  const h = backgroundHarness(94);
  const request = { requestId: 'request-quarantine', leaseId: 'lease-quarantine', ownerServerInstanceId: 'server-regression', responseEpoch: 0 };
  try {
    await initializeHarness(h);
    await h.backgroundState.transition(h.state.tabId, { type: 'lease.claim', ...request, contentEpoch: h.state.contentEpoch });
    await h.backgroundState.transition(h.state.tabId, { type: 'lease.releasing', ...request, contentEpoch: h.state.contentEpoch });
    const body = { commandId: 'release-command', requestId: request.requestId, code: 'RELEASE_CLEANUP_UNPROVEN', message: 'cleanup not proven', reason: 'cleanup not proven' };
    const terminalEnvelope = h.createEnvelopeDraft(h.state, ExtensionMessageType.LEASE_QUARANTINED, body, { commandId: 'release-command', lease: request });
    await h.backgroundState.transition(h.state.tabId, {
      type: 'command.registered', ...request, commandId: 'release-command', commandType: 'request.release', mode: 'release', scope: 'request',
      terminalEnvelope, contentEpoch: h.state.contentEpoch,
    });
    await h.backgroundState.transition(h.state.tabId, { type: 'command.dispatched', ...request, commandId: 'release-command', acceptedEnvelope: h.createEnvelopeDraft(h.state, ExtensionMessageType.COMMAND_ACCEPTED, { commandId: 'release-command', requestId: request.requestId, commandMode: 'release', commandScope: 'request' }, { commandId: 'release-command', lease: request }), contentEpoch: h.state.contentEpoch });
    const outcome = await h.backgroundState.transition(h.state.tabId, {
      type: 'command.uncertain', ...request, commandId: 'release-command', error: { code: body.code, message: body.message }, resultPayload: body, terminalEnvelope,
      contentEpoch: h.state.contentEpoch,
    });
    assert.equal(outcome.accepted, true);
    assert.equal(outcome.state.lease.status, 'quarantined');
    assert.equal(outcome.state.outbox.some((item) => item.messageType === ExtensionMessageType.LEASE_QUARANTINED), true);
  } finally { h.restore(); }
});

test('request.release recovers one exact stale lease once without replaying a prompt', async () => {
  const h = backgroundHarness(96);
  const request = { requestId: 'request-stale-release', leaseId: 'lease-stale-release', ownerServerInstanceId: 'server-regression', responseEpoch: 0 };
  try {
    await initializeHarness(h);
    await quarantineLease(h, request);

    await handleServerEnvelope({ ...h, envelope: serverEnvelope({
      sequence: 1, commandId: 'stale-release-command', type: 'request.release', request,
      payload: { recoveryMode: 'stale_lease' },
    }) });

    let runtime = await h.backgroundState.read(h.state.tabId);
    assert.deepEqual({
      requestId: runtime.lease.requestId,
      leaseId: runtime.lease.leaseId,
      ownerServerInstanceId: runtime.lease.ownerServerInstanceId,
      responseEpoch: runtime.lease.responseEpoch,
    }, request);
    assert.equal(runtime.lease.status, 'releasing');
    assert.equal(runtime.lease.releaseRecoveryUsed, true);
    assert.equal(runtime.commands['stale-release-command'].commandType, 'request.release');
    assert.equal(runtime.commands['stale-release-command'].status, 'dispatched');
    assert.equal(Object.values(runtime.commands).some((command) => String(command.commandType || '').startsWith('prompt.')), false);
    assert.equal(Object.keys(runtime.effects).length, 0);
    assert.equal(runtime.outbox.some((entry) => entry.messageType === ExtensionMessageType.LEASE_RELEASED), false);
    assert.equal(h.posted.filter((entry) => entry.type === 'server.message' && entry.payload.type === 'request.release'
      && entry.payload.commandId === 'stale-release-command').length, 1);

    await handleServerEnvelope({ ...h, envelope: serverEnvelope({
      sequence: 2, commandId: 'stale-release-command-repeat', type: 'request.release', request,
      payload: { recoveryMode: 'stale_lease' },
    }) });

    runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.commands['stale-release-command-repeat'], undefined);
    assert.equal(runtime.lease.status, 'releasing');
    assert.equal(runtime.lease.releaseRecoveryUsed, true);
    assert.equal(h.posted.filter((entry) => entry.type === 'server.message' && entry.payload.type === 'request.release'
      && entry.payload.commandId === 'stale-release-command').length, 1);
    assert.equal(h.sent.some((entry) => entry.messageType === ExtensionMessageType.COMMAND_REJECTED
      && entry.body.commandId === 'stale-release-command-repeat'), true);
  } finally { h.restore(); }
});

test('committed stale release dispatch is never sent a second time after an interruption before content post', async () => {
  const h = backgroundHarness(101);
  const request = { requestId: 'request-stale-release-crash', leaseId: 'lease-stale-release-crash', ownerServerInstanceId: 'server-regression', responseEpoch: 0 };
  try {
    await initializeHarness(h);
    await quarantineLease(h, request);
    const transition = h.backgroundState.transition.bind(h.backgroundState);
    let interruptAfterCommit = true;
    h.backgroundState.transition = async (tabId, event) => {
      const outcome = await transition(tabId, event);
      if (interruptAfterCommit && event.type === 'lease.release_recover') {
        interruptAfterCommit = false;
        throw new Error('simulated worker exit after atomic recovery commit');
      }
      return outcome;
    };

    await assert.rejects(handleServerEnvelope({ ...h, envelope: serverEnvelope({
      sequence: 1, commandId: 'stale-release-crash-command', type: 'request.release', request,
      payload: { recoveryMode: 'stale_lease' },
    }) }), /simulated worker exit after atomic recovery commit/);

    let runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.lease.status, 'releasing');
    assert.equal(runtime.lease.releaseRecoveryUsed, true);
    assert.equal(runtime.commands['stale-release-crash-command'].status, 'dispatched');
    assert.equal(runtime.outbox.filter((entry) => entry.messageType === ExtensionMessageType.COMMAND_ACCEPTED
      && entry.commandId === 'stale-release-crash-command').length, 1);
    assert.equal(h.posted.filter((entry) => entry.type === 'server.message' && entry.payload.type === 'request.release').length, 0);

    h.backgroundState.transition = transition;
    await handleServerEnvelope({ ...h, envelope: serverEnvelope({
      sequence: 2, commandId: 'stale-release-crash-command', type: 'request.release', request,
      payload: { recoveryMode: 'stale_lease' },
    }) });

    runtime = await h.backgroundState.read(h.state.tabId);
    const releaseCommands = Object.values(runtime.commands).filter((command) => command.commandType === 'request.release');
    assert.equal(releaseCommands.length, 1);
    assert.equal(releaseCommands[0].commandId, 'stale-release-crash-command');
    assert.equal(releaseCommands[0].status, 'dispatched');
    assert.equal(h.posted.filter((entry) => entry.type === 'server.message' && entry.payload.type === 'request.release').length, 0);
  } finally { h.restore(); }
});

test('stale request.release continues only the same persisted registered command', async () => {
  const h = backgroundHarness(102);
  const request = { requestId: 'request-stale-release-registered', leaseId: 'lease-stale-release-registered', ownerServerInstanceId: 'server-regression', responseEpoch: 0 };
  const commandId = 'stale-release-registered-command';
  try {
    await initializeHarness(h);
    await h.backgroundState.transition(h.state.tabId, { type: 'lease.claim', ...request, contentEpoch: h.state.contentEpoch });
    await h.backgroundState.transition(h.state.tabId, { type: 'lease.releasing', ...request, contentEpoch: h.state.contentEpoch });
    await h.backgroundState.transition(h.state.tabId, { ...releaseRecoveryEvent(h, request, commandId), type: 'command.registered' });

    await handleServerEnvelope({ ...h, envelope: serverEnvelope({
      sequence: 1, commandId: 'different-release-logical-command', type: 'request.release', request,
      payload: { recoveryMode: 'stale_lease' },
    }) });
    await handleServerEnvelope({ ...h, envelope: serverEnvelope({
      sequence: 2, commandId, type: 'request.release', request: { ...request, responseEpoch: 1 },
      payload: { recoveryMode: 'stale_lease' },
    }) });
    let runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.commands[commandId].status, 'registered');
    assert.equal(runtime.lease.releaseRecoveryUsed, undefined);
    assert.equal(Object.values(runtime.commands).filter((command) => command.commandType === 'request.release').length, 1);
    assert.equal(h.posted.filter((entry) => entry.type === 'server.message' && entry.payload.type === 'request.release').length, 0);

    await handleServerEnvelope({ ...h, envelope: serverEnvelope({
      sequence: 3, commandId, type: 'request.release', request, payload: { recoveryMode: 'stale_lease' },
    }) });

    runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.lease.releaseRecoveryUsed, true);
    assert.equal(runtime.lease.releaseRecoveryCommandId, commandId);
    assert.equal(runtime.commands[commandId].status, 'dispatched');
    assert.equal(runtime.outbox.filter((entry) => entry.messageType === ExtensionMessageType.COMMAND_ACCEPTED
      && entry.commandId === commandId).length, 1);
    assert.equal(h.posted.filter((entry) => entry.type === 'server.message' && entry.payload.type === 'request.release'
      && entry.payload.commandId === commandId).length, 1);

    await handleServerEnvelope({ ...h, envelope: serverEnvelope({
      sequence: 4, commandId, type: 'request.release', request, payload: { recoveryMode: 'stale_lease' },
    }) });
    runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(Object.values(runtime.commands).filter((command) => command.commandType === 'request.release').length, 1);
    assert.equal(h.posted.filter((entry) => entry.type === 'server.message' && entry.payload.type === 'request.release'
      && entry.payload.commandId === commandId).length, 1);
  } finally { h.restore(); }
});

test('request.release accepts only the optional stale_lease recovery discriminator', () => {
  const manifest = globalThis.ChatGptBridgeCommandManifest;
  assert.equal(manifest.validateCommandPayload('request.release', { type: 'request.release' }, { requestScoped: true }).valid, true);
  assert.equal(manifest.validateCommandPayload('request.release', { type: 'request.release', recoveryMode: 'stale_lease' }, { requestScoped: true }).valid, true);
  const invalid = manifest.validateCommandPayload('request.release', { type: 'request.release', recoveryMode: 'force_release' }, { requestScoped: true });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join('; '), /recoveryMode must be stale_lease/);
});

test('stale request.release rejects without an exact persisted lease and never claims one', async () => {
  const h = backgroundHarness(97);
  const request = { requestId: 'request-stale-release-missing', leaseId: 'lease-stale-release-missing', ownerServerInstanceId: 'server-regression', responseEpoch: 0 };
  try {
    await initializeHarness(h);
    await handleServerEnvelope({ ...h, envelope: serverEnvelope({
      sequence: 1, commandId: 'stale-release-no-lease', type: 'request.release', request,
      payload: { recoveryMode: 'stale_lease' },
    }) });

    const runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.lease, null);
    assert.equal(runtime.commands['stale-release-no-lease'], undefined);
    assert.equal(runtime.journal.some((entry) => entry.type === 'lease.claim'), false);
    assert.equal(h.sent.some((entry) => entry.messageType === ExtensionMessageType.COMMAND_REJECTED
      && entry.body.commandId === 'stale-release-no-lease'), true);
  } finally { h.restore(); }
});

test('stale request.release rejects a mismatched exact lease identity without adopting or replacing it', async () => {
  const h = backgroundHarness(99);
  const request = { requestId: 'request-stale-release-mismatch', leaseId: 'lease-stale-release-mismatch', ownerServerInstanceId: 'server-regression', responseEpoch: 0 };
  try {
    await initializeHarness(h);
    await quarantineLease(h, request);
    await handleServerEnvelope({ ...h, envelope: serverEnvelope({
      sequence: 1, commandId: 'stale-release-mismatched-epoch', type: 'request.release',
      request: { ...request, responseEpoch: 1 }, payload: { recoveryMode: 'stale_lease' },
    }) });

    const runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.lease.requestId, request.requestId);
    assert.equal(runtime.lease.leaseId, request.leaseId);
    assert.equal(runtime.lease.responseEpoch, request.responseEpoch);
    assert.equal(runtime.lease.status, 'quarantined');
    assert.equal(runtime.lease.releaseRecoveryUsed, undefined);
    assert.equal(runtime.commands['stale-release-mismatched-epoch'], undefined);
    assert.equal(runtime.journal.some((entry) => entry.type === 'lease.epoch_adopted'), false);

    await handleServerEnvelope({ ...h, envelope: serverEnvelope({
      sequence: 2, commandId: 'canonical-release-still-quarantined', type: 'request.release', request,
    }) });
    await handleServerEnvelope({ ...h, envelope: serverEnvelope({
      sequence: 3, commandId: 'other-command-still-quarantined', type: 'request.resume', request,
    }) });
    const afterQuarantinedCommands = await h.backgroundState.read(h.state.tabId);
    assert.equal(afterQuarantinedCommands.commands['canonical-release-still-quarantined'], undefined);
    assert.equal(afterQuarantinedCommands.commands['other-command-still-quarantined'], undefined);
    assert.equal(afterQuarantinedCommands.lease.status, 'quarantined');
  } finally { h.restore(); }
});

test('lease.release_recover refuses active request commands, effects, and downloads', async () => {
  const request = { requestId: 'request-release-recovery-child', leaseId: 'lease-release-recovery-child', ownerServerInstanceId: 'server-regression', responseEpoch: 0 };
  const activeChildSetups = [
    {
      name: 'command',
      event: { type: 'command.registered', ...request, scope: 'request', commandId: 'active-request-command', commandType: 'prompt.send', contentEpoch: 'content-regression' },
    },
    {
      name: 'effect',
      event: { type: 'effect.planned', ...request, effectId: 'active-request-effect', kind: 'prompt.submit', idempotencyKey: 'active-request-effect-key', preconditionsHash: 'active-request-effect-hash' },
    },
    {
      name: 'download',
      event: { type: 'download.transition', ...request, captureId: 'active-request-download', status: 'planned', effectId: 'active-request-effect', expectedNames: ['artifact.zip'] },
    },
  ];

  for (const child of activeChildSetups) {
    const h = backgroundHarness(100);
    try {
      await initializeHarness(h);
      await h.backgroundState.transition(h.state.tabId, { type: 'lease.claim', ...request, contentEpoch: h.state.contentEpoch });
      const created = await h.backgroundState.transition(h.state.tabId, child.event);
      assert.equal(created.accepted, true, `${child.name} setup: ${created.reason}`);
      await h.backgroundState.transition(h.state.tabId, { type: 'lease.quarantine', ...request, contentEpoch: h.state.contentEpoch });

      const recovered = await h.backgroundState.transition(h.state.tabId, releaseRecoveryEvent(h, request, `active-child-release-${child.name}`));
      assert.equal(recovered.accepted, false, `${child.name} child must block recovery`);
      assert.equal(recovered.reason, 'lease_children_active');
      assert.equal(recovered.state.lease.status, 'quarantined');
      assert.equal(recovered.state.lease.releaseRecoveryUsed, undefined);
    } finally { h.restore(); }
  }
});

test('layout capture chunks stay non-terminal in background and the durable terminal envelope remains small', async () => {
  const h = backgroundHarness(95);
  try {
    await initializeHarness(h);
    await handleServerEnvelope({
      ...h,
      envelope: serverEnvelope({ sequence: 1, commandId: 'layout-chunk-command', type: 'debug.layout.capture' }),
    });
    await handlePayload(h, null, h.state, {
      type: 'command.progress',
      progressType: 'page.layout.chunk',
      commandId: 'layout-chunk-command',
      index: 0,
      totalChunks: 2,
      content: 'A'.repeat(48 * 1024),
    });
    let runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.commands['layout-chunk-command'].status, 'dispatched');
    assert.equal(runtime.outbox.some((entry) => entry.messageType === ExtensionMessageType.COMMAND_RESULT), false);
    assert.ok(h.sent.some((entry) => entry.messageType === ExtensionMessageType.COMMAND_PROGRESS));

    await handlePayload(h, null, h.state, {
      type: 'page.layout.captured',
      commandId: 'layout-chunk-command',
      chunked: true,
      totalChunks: 2,
      htmlLength: 96 * 1024,
      metadata: { sanitized: true },
    });
    runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.commands['layout-chunk-command'].status, 'succeeded');
    const terminal = runtime.outbox.find((entry) => entry.messageType === ExtensionMessageType.COMMAND_RESULT);
    assert.ok(terminal);
    assert.equal(Object.hasOwn(terminal.body, 'html'), false);
    assert.ok(JSON.stringify(terminal).length < 20_000);
  } finally { h.restore(); }
});

test('command registry keeps result commands pending across progress before the terminal result', async () => {
  const delivered = [];
  const registry = new BridgeCommandRegistry({ hub: {
    sendToClientWithDelivery(clientId, payload) {
      delivered.push({ clientId, payload });
      return { client: { id: clientId }, delivered: Promise.resolve() };
    },
  } });
  try {
    const pending = registry.send('passive.prompt.submit', { message: 'progress marker' }, {
      sourceClientId: 'tab-progress', commandId: 'progress-command', timeoutMs: 1_000,
    });
    await waitFor(() => delivered.length === 1);
    assert.equal(registry.handleResponse('tab-progress', {
      type: 'command.progress', progressType: 'passive.prompt.submit.started', commandId: 'progress-command',
    }), true);
    assert.equal(registry.has('progress-command'), true);
    registry.handleResponse('tab-progress', {
      type: 'command.result', resultType: 'passive.prompt.submitted', commandId: 'progress-command',
      submittedUserTurnKey: 'progress-user-turn',
    });
    const result = await pending;
    assert.equal(result.submittedUserTurnKey, 'progress-user-turn');
  } finally { registry.close(); }
});

test('command registry reconstructs chunked layout capture without putting HTML in the terminal result', async () => {
  const layoutIntegrity = describeTransfer(Buffer.from('<html><body></body></html>'), 26, 2, 'utf8');
  const delivered = [];
  const registry = new BridgeCommandRegistry({ hub: {
    sendToClientWithDelivery(clientId, payload, options) {
      delivered.push({ clientId, payload, options });
      return { client: { id: clientId }, delivered: Promise.resolve() };
    },
  } });
  try {
    const pending = registry.send('debug.layout.capture', { requestId: '', options: { maxNodes: 1_000, maxBytes: 2_000_000 } }, {
      sourceClientId: 'tab-layout', commandId: 'layout-registry-command', timeoutMs: 1_000,
    });
    await waitFor(() => delivered.length === 1);
    registry.handleResponse('tab-layout', {
      type: 'command.progress', progressType: 'page.layout.chunk', commandId: 'layout-registry-command',
      ...layoutIntegrity, index: 0, offset: 0, content: '<html><body>',
    });
    registry.handleResponse('tab-layout', {
      type: 'command.progress', progressType: 'page.layout.chunk', commandId: 'layout-registry-command',
      ...layoutIntegrity, index: 1, offset: 12, content: '</body></html>',
    });
    registry.handleResponse('tab-layout', {
      type: 'command.result', resultType: 'page.layout.captured', commandId: 'layout-registry-command',
      ...layoutIntegrity, chunked: true, htmlLength: 26, metadata: { sanitized: true },
    });
    const result = await pending;
    assert.equal(result.html, '<html><body></body></html>');
    assert.equal(result.metadata.sanitized, true);
  } finally { registry.close(); }
});

test('command registry rejects a sparse layout capture before resolving the command', async () => {
  const delivered = [];
  const registry = new BridgeCommandRegistry({ hub: {
    sendToClientWithDelivery(clientId, payload) {
      delivered.push({ clientId, payload });
      return { client: { id: clientId }, delivered: Promise.resolve() };
    },
  } });
  try {
    const pending = registry.send('debug.layout.capture', { requestId: '', options: {} }, {
      sourceClientId: 'tab-layout', commandId: 'layout-sparse-command', timeoutMs: 1_000,
    });
    await waitFor(() => delivered.length === 1);
    registry.handleResponse('tab-layout', {
      type: 'command.progress', progressType: 'page.layout.chunk', commandId: 'layout-sparse-command',
      index: 1, totalChunks: 2, content: '</html>',
    });
    registry.handleResponse('tab-layout', {
      type: 'command.result', resultType: 'page.layout.captured', commandId: 'layout-sparse-command',
      chunked: true, totalChunks: 2, htmlLength: 13, metadata: {},
    });
    await assert.rejects(pending, (error) => error?.code === 'TRANSFER_INTEGRITY_INVALID');
  } finally { registry.close(); }
});


test('extension reload waits for the server ACK of its durable command acceptance', async (t) => {
  const h = backgroundHarness(96);
  const previousChrome = globalThis.chrome;
  t.after(() => {
    h.restore();
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  });
  const localStorage = memoryStorage();
  globalThis.chrome = {
    storage: { local: localStorage },
    tabs: { async query() { return []; } },
  };
  await initializeHarness(h);
  await handleServerEnvelope({
    ...h,
    envelope: serverEnvelope({ sequence: 1, commandId: 'reload-ack-command', type: 'extension.reload', payload: { reloadTabs: false } }),
  });

  let runtime = await h.backgroundState.read(h.state.tabId);
  const accepted = runtime.outbox.find((entry) => entry.messageType === ExtensionMessageType.COMMAND_ACCEPTED
    && entry.commandId === 'reload-ack-command');
  assert.ok(accepted, 'Reload command acceptance must be durable before maintenance scheduling');

  let reloads = 0;
  const recoveryWakes = [];
  const coordinator = createExtensionReloadCoordinator({
    backgroundState: h.backgroundState,
    maintenanceOperations: createMaintenanceOperationStore(localStorage),
    safeBridgeServerUrl: (value) => String(value || ''),
    async readLaunchedTab() { return null; },
    async rememberLaunchedTab() {},
    async navigateTab() {},
    async reloadTab() {},
    launchTokenPattern: /^bridge-[a-z0-9_-]+$/i,
    reloadRuntime() { reloads += 1; },
    async scheduleRecoveryWake(alarmName) {
      recoveryWakes.push(alarmName);
      return { armed: true, alarmName, when: Date.now() + 750 };
    },
    ackTimeoutMs: 1_000,
  });
  const scheduled = await coordinator.scheduleExtensionReload({
    reloadTabs: false,
    sourceTabId: h.state.tabId,
    commandId: 'reload-ack-command',
    expectedVersion: '2.3.11',
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(reloads, 0, 'Runtime must remain alive until the server acknowledges command acceptance');
  assert.equal(recoveryWakes.length, 0, 'Recovery alarm must not be armed before the accepted result is acknowledged');

  const ack = createExtensionEnvelope(ExtensionMessageType.TRANSPORT_ACK, {
    ackMessageId: accepted.messageId,
    acceptedSequence: accepted.source.sequence,
    accepted: true,
    reason: '',
  }, {
    messageId: 'reload-acceptance-ack',
    source: {
      clientId: 'server',
      tabId: h.state.tabId,
      backgroundEpoch: 'server-regression',
      contentEpoch: '',
      sequence: 2,
    },
    causationId: accepted.messageId,
  });
  await handleServerEnvelope({ ...h, envelope: ack });
  await waitFor(() => reloads === 1);
  assert.deepEqual(recoveryWakes, [`chatgptBridge:extensionReload:${scheduled.operationId}`]);
  const pendingReload = (await localStorage.get('bridgePendingExtensionReload')).bridgePendingExtensionReload;
  assert.equal(pendingReload.recoveryAlarmName, recoveryWakes[0]);
  assert.ok(Number(pendingReload.recoveryWakeAt) > Date.now());
  runtime = await h.backgroundState.read(h.state.tabId);
  assert.equal(runtime.outbox.some((entry) => entry.messageId === accepted.messageId), false);
  assert.equal(runtime.commands['reload-ack-command'].status, 'dispatched');
});

test('extension reload stages a localhost trampoline before restarting the runtime', async (t) => {
  const h = backgroundHarness(97);
  const previousChrome = globalThis.chrome;
  t.after(() => {
    h.restore();
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  });
  const localStorage = memoryStorage();
  globalThis.chrome = {
    storage: { local: localStorage },
    tabs: {
      async query() { return [{ id: 97, url: 'https://chatgpt.com/c/trampoline-fixture' }]; },
      async get(tabId) { return { id: tabId, url: 'https://chatgpt.com/c/trampoline-fixture' }; },
    },
  };
  await initializeHarness(h);
  await handleServerEnvelope({
    ...h,
    envelope: serverEnvelope({ sequence: 1, commandId: 'reload-trampoline-command', type: 'extension.reload', payload: { reloadTabs: true } }),
  });
  const accepted = (await h.backgroundState.read(h.state.tabId)).outbox.find((entry) => entry.messageType === ExtensionMessageType.COMMAND_ACCEPTED
    && entry.commandId === 'reload-trampoline-command');
  assert.ok(accepted);

  const order = [];
  const navigations = [];
  const coordinator = createExtensionReloadCoordinator({
    backgroundState: h.backgroundState,
    maintenanceOperations: createMaintenanceOperationStore(localStorage),
    safeBridgeServerUrl: (value) => String(value || ''),
    async readLaunchedTab() {
      return { launchToken: 'bridge-real-e2e-trampoline', requestedUrl: 'https://chatgpt.com/c/trampoline-fixture', serverUrl: 'http://127.0.0.1:18181' };
    },
    async rememberLaunchedTab() {},
    async navigateTab(tabId, url) { order.push('navigate'); navigations.push({ tabId, url }); },
    async reloadTab() {},
    launchTokenPattern: /^bridge-[a-z0-9_-]+$/i,
    reloadRuntime() { order.push('reload'); },
    async scheduleRecoveryWake(alarmName) { return { armed: true, alarmName, when: Date.now() + 750 }; },
    ackTimeoutMs: 1_000,
  });
  await coordinator.scheduleExtensionReload({
    reloadTabs: true,
    sourceTabId: 97,
    sourceLaunchToken: 'bridge-real-e2e-trampoline',
    temporaryServerUrl: 'http://127.0.0.1:18181',
    commandId: 'reload-trampoline-command',
    expectedVersion: '2.3.11',
  });
  await handleServerEnvelope({
    ...h,
    envelope: createExtensionEnvelope(ExtensionMessageType.TRANSPORT_ACK, {
      ackMessageId: accepted.messageId,
      acceptedSequence: accepted.source.sequence,
      accepted: true,
      reason: '',
    }, {
      messageId: 'reload-trampoline-ack',
      source: { clientId: 'server', tabId: 97, backgroundEpoch: 'server', contentEpoch: '', sequence: 2 },
      causationId: accepted.messageId,
    }),
  });
  await waitFor(() => order.includes('reload'));
  assert.deepEqual(order.slice(0, 2), ['navigate', 'reload']);
  assert.equal(navigations[0].tabId, 97);
  const trampoline = new URL(navigations[0].url);
  assert.equal(trampoline.origin, 'http://127.0.0.1:18181');
  assert.equal(trampoline.pathname, '/extension/reload-trampoline');
  const target = new URL(trampoline.searchParams.get('target'));
  assert.equal(target.origin, 'https://chatgpt.com');
  assert.equal(target.pathname, '/c/trampoline-fixture');
  assert.equal(new URLSearchParams(target.hash.slice(1)).get('chatgpt-bridge-launch'), 'bridge-real-e2e-trampoline');
});
