import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserExtensionHub } from '../src/browserExtensionHub.js';
import { BridgeCommandRegistry } from '../src/bridge/coordinator/bridgeCommandRegistry.js';
import { createPromptExecutionPlan, createRequestEffectDescriptor } from '../src/bridge/requestExecutionPlan.js';
import { createExtensionEnvelope, ExtensionMessageType } from '../src/bridge/protocol/v5.js';
import { BackgroundStateStore } from '../tools/chrome-bridge-extension/background/stateV6.js';
import { createProtocolOutbox } from '../tools/chrome-bridge-extension/background/outboxV5.js';
import { handlePayload } from '../tools/chrome-bridge-extension/background/portRouter.js';
import { handleServerEnvelope } from '../tools/chrome-bridge-extension/background/serverEnvelopeRouter.js';
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
    const pending = registry.send('prompt.steer', { message: 'continue' }, { sourceClientId: 'tab', commandId: 'steer-command', request, timeoutMs: 1_000 });
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
    await handlePayload(h, null, h.state, { type: 'request.cleanup.completed', commandId: 'release-command', requestId: request.requestId, released: true });
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
    await h.backgroundState.transition(h.state.tabId, { type: 'command.dispatched', ...request, commandId: 'release-command', acceptedEnvelope: h.createEnvelopeDraft(h.state, ExtensionMessageType.COMMAND_ACCEPTED, { commandId: 'release-command' }, { commandId: 'release-command', lease: request }), contentEpoch: h.state.contentEpoch });
    const outcome = await h.backgroundState.transition(h.state.tabId, {
      type: 'command.uncertain', ...request, commandId: 'release-command', error: { code: body.code, message: body.message }, resultPayload: body, terminalEnvelope,
      contentEpoch: h.state.contentEpoch,
    });
    assert.equal(outcome.accepted, true);
    assert.equal(outcome.state.lease.status, 'quarantined');
    assert.equal(outcome.state.outbox.some((item) => item.messageType === ExtensionMessageType.LEASE_QUARANTINED), true);
  } finally { h.restore(); }
});
