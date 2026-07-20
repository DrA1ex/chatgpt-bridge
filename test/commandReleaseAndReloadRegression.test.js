import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserExtensionHub } from '../src/browserExtensionHub.js';
import { BridgeCommandRegistry } from '../src/bridge/coordinator/bridgeCommandRegistry.js';
import { BackgroundStateStore } from '../tools/chrome-bridge-extension/background/stateV4.js';
import { handlePayload } from '../tools/chrome-bridge-extension/background/portRouter.js';
import { handleServerEnvelope } from '../tools/chrome-bridge-extension/background/serverEnvelopeRouter.js';
import { connectExtensionClient } from './helpers/extensionClient.js';

function memoryStorage() {
  const values = new Map();
  return {
    async get(key) { return { [key]: values.get(key) }; },
    async set(record) { for (const [key, value] of Object.entries(record)) values.set(key, value); },
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

function envelope({ sequence, commandId, type, request = null, payload = {} }) {
  return {
    kind: 'command.execute',
    messageId: `message-${commandId}`,
    commandId,
    source: { backgroundEpoch: 'server-regression', sequence },
    request,
    payload: { type, commandId, ...payload },
  };
}

function backgroundHarness(tabId = 91) {
  const backgroundState = new BackgroundStateStore(memoryStorage(), 'background-regression');
  const state = {
    tabId,
    contentEpoch: 'content-regression',
    connectionEpoch: 'connection-regression',
    protocolReady: true,
    port: null,
  };
  const sent = [];
  const posted = [];
  const sendProtocolPayload = async (_state, payload, options = {}) => sent.push({ payload, options });
  const post = (_port, message) => posted.push(message);
  return { backgroundState, state, sent, posted, sendProtocolPayload, post };
}

test('Hub is transport-only: standalone payload requestIds cannot create request leases', async () => {
  const hub = new BrowserExtensionHub(null, { serverInstanceId: 'server-hub-owner' });
  const connection = await connectExtensionClient(hub, {
    clientId: 'tab-hub-owner',
    url: 'https://chatgpt.com/c/session-owner',
  });
  const commands = [];
  connection.ws.on('message', (data) => {
    const message = JSON.parse(String(data));
    if (message.kind === 'command.execute') commands.push(message);
  });
  try {
    hub.sendToClientWithDelivery('tab-hub-owner', {
      type: 'debug.layout.capture',
      commandId: 'standalone-layout',
      requestId: 'stale-terminal-request',
    });
    const standalone = await waitFor(() => commands.find((item) => item.commandId === 'standalone-layout'));
    assert.equal(standalone.request, null);
    assert.equal(standalone.payload.commandScope, 'standalone');
    assert.equal(standalone.payload.requestId, 'stale-terminal-request');

    const request = {
      requestId: 'request-current',
      leaseId: 'lease-current',
      ownerServerInstanceId: 'server-hub-owner',
      responseEpoch: 2,
    };
    hub.sendToClientWithDelivery('tab-hub-owner', {
      type: 'prompt.send',
      commandId: 'request-prompt',
      message: 'hello',
    }, { request });
    const scoped = await waitFor(() => commands.find((item) => item.commandId === 'request-prompt'));
    assert.deepEqual(scoped.request, request);
    assert.equal(scoped.payload.commandScope, 'request');
  } finally {
    await connection.close();
  }
});

test('release correlation barrier lives in BridgeCommandRegistry rather than Hub state', async () => {
  const delivered = [];
  const hub = {
    sendToClientWithDelivery(clientId, payload, options) {
      delivered.push({ clientId, payload, options });
      return { client: { id: clientId }, delivered: Promise.resolve() };
    },
  };
  const registry = new BridgeCommandRegistry({ hub });
  const request = {
    requestId: 'request-release',
    leaseId: 'lease-release',
    ownerServerInstanceId: 'server-release',
    responseEpoch: 0,
  };
  try {
    const release = registry.send('request.release', {}, {
      sourceClientId: 'tab-release',
      commandId: 'release-command',
      request,
      timeoutMs: 2_000,
    });
    await waitFor(() => delivered.length === 1);
    const models = registry.send('models.list', {}, {
      sourceClientId: 'tab-release',
      commandId: 'models-command',
      timeoutMs: 2_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(delivered.length, 1);

    registry.handleResponse('tab-release', {
      type: 'command.result',
      resultType: 'request.release.completed',
      commandId: 'release-command',
      released: true,
    });
    await release;
    await waitFor(() => delivered.length === 2);
    assert.equal(delivered[1].payload.type, 'models.list');
    assert.equal(delivered[1].options.request, null);
    registry.handleResponse('tab-release', {
      type: 'command.result',
      resultType: 'models.snapshot',
      commandId: 'models-command',
      models: [],
    });
    await models;
  } finally {
    registry.close();
  }
});


test('timed-out standalone commands settle physical cancellation before the caller is released', async () => {
  const delivered = [];
  let registry;
  const hub = {
    sendToClientWithDelivery(clientId, payload, options) {
      delivered.push({ clientId, payload, options, at: Date.now() });
      if (payload.type === 'command.cancel') {
        setImmediate(() => {
          registry.handleResponse(clientId, {
            type: 'command.result',
            resultType: 'command.cancelled',
            commandId: payload.commandId,
            targetCommandId: payload.targetCommandId,
          });
        });
      }
      return { client: { id: clientId }, delivered: Promise.resolve() };
    },
  };
  registry = new BridgeCommandRegistry({ hub });
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await assert.rejects(
      registry.send('artifact.fetch', { artifactId: 'artifact-timeout' }, {
        sourceClientId: 'tab-timeout',
        commandId: 'artifact-timeout-command',
        timeoutMs: 25,
      }),
      /Timed out waiting for artifact\.fetch response/,
    );
    const cancel = delivered.find((entry) => entry.payload.type === 'command.cancel');
    assert.ok(cancel, 'timeout must dispatch a physical cancellation command');
    assert.equal(cancel.payload.targetCommandId, 'artifact-timeout-command');
    assert.equal(registry.has('artifact-timeout-command'), false);
    assert.equal(registry.has(cancel.payload.commandId), false);

    const followUp = registry.send('models.list', {}, {
      sourceClientId: 'tab-timeout',
      commandId: 'models-after-timeout',
      timeoutMs: 1_000,
    });
    await waitFor(() => delivered.some((entry) => entry.payload.commandId === 'models-after-timeout'));
    registry.handleResponse('tab-timeout', {
      type: 'command.result',
      resultType: 'models.snapshot',
      commandId: 'models-after-timeout',
      models: [],
    });
    await followUp;
  } finally {
    clearInterval(keepAlive);
    registry.close();
  }
});

test('standalone diagnostics never claim a TabLease and the next request can claim it', async () => {
  const h = backgroundHarness();
  await h.backgroundState.transition(h.state.tabId, { type: 'content.attached', contentEpoch: h.state.contentEpoch });
  await handleServerEnvelope({
    ...h,
    envelope: envelope({
      sequence: 1,
      commandId: 'layout-command',
      type: 'debug.layout.capture',
      payload: { requestId: 'stale-request' },
    }),
  });
  let runtime = await h.backgroundState.read(h.state.tabId);
  assert.equal(runtime.lease, null);
  assert.equal(runtime.commands['layout-command'].scope, 'standalone');

  await handlePayload(h, null, h.state, {
    type: 'page.layout.captured',
    commandId: 'layout-command',
    html: '<html></html>',
  });
  runtime = await h.backgroundState.read(h.state.tabId);
  assert.equal(runtime.lease, null);
  assert.equal(runtime.commands['layout-command'].status, 'succeeded');

  const request = {
    requestId: 'request-after-layout',
    leaseId: 'lease-after-layout',
    ownerServerInstanceId: 'server-regression',
    responseEpoch: 0,
  };
  await handleServerEnvelope({
    ...h,
    envelope: envelope({ sequence: 2, commandId: 'prompt-command', type: 'prompt.send', request }),
  });
  runtime = await h.backgroundState.read(h.state.tabId);
  assert.equal(runtime.lease.requestId, request.requestId);
  assert.equal(runtime.lease.leaseId, request.leaseId);
});

test('a mutating standalone command is exclusive but remains outside request lifecycle', async () => {
  const h = backgroundHarness(92);
  await h.backgroundState.transition(h.state.tabId, { type: 'content.attached', contentEpoch: h.state.contentEpoch });
  await handleServerEnvelope({
    ...h,
    envelope: envelope({ sequence: 1, commandId: 'artifact-command', type: 'artifact.fetch' }),
  });
  let runtime = await h.backgroundState.read(h.state.tabId);
  assert.equal(runtime.lease, null);
  assert.equal(runtime.commands['artifact-command'].status, 'dispatched');

  const request = {
    requestId: 'request-during-artifact',
    leaseId: 'lease-during-artifact',
    ownerServerInstanceId: 'server-regression',
    responseEpoch: 0,
  };
  await handleServerEnvelope({
    ...h,
    envelope: envelope({ sequence: 2, commandId: 'blocked-prompt', type: 'prompt.send', request }),
  });
  assert.ok(h.sent.some((entry) => entry.payload.commandId === 'blocked-prompt' && entry.payload.type === 'command.error'));
  runtime = await h.backgroundState.read(h.state.tabId);
  assert.equal(runtime.lease, null);

  await handlePayload(h, null, h.state, {
    type: 'command.result',
    commandId: 'artifact-command',
    resultType: 'artifact.data.done',
  });
  await handleServerEnvelope({
    ...h,
    envelope: envelope({ sequence: 3, commandId: 'accepted-prompt', type: 'prompt.send', request }),
  });
  runtime = await h.backgroundState.read(h.state.tabId);
  assert.equal(runtime.lease.requestId, request.requestId);
});

test('standalone session deletion survives content reload without creating a lease', async () => {
  const h = backgroundHarness(93);
  await h.backgroundState.transition(h.state.tabId, { type: 'content.attached', contentEpoch: h.state.contentEpoch });
  await handleServerEnvelope({
    ...h,
    envelope: envelope({
      sequence: 1,
      commandId: 'delete-command',
      type: 'sessions.delete',
      payload: { sessionId: 'session-old', expectedUrl: 'https://chatgpt.com/c/session-old' },
    }),
  });
  let runtime = await h.backgroundState.read(h.state.tabId);
  assert.equal(runtime.lease, null);
  assert.equal(runtime.commands['delete-command'].scope, 'standalone');

  h.state.contentEpoch = 'content-after-delete';
  await h.backgroundState.transition(h.state.tabId, { type: 'content.attached', contentEpoch: h.state.contentEpoch });
  await handlePayload(h, null, h.state, {
    type: 'tab.observation',
    observation: { url: 'https://chatgpt.com/c/session-new', conversationId: 'session-new' },
  });
  runtime = await h.backgroundState.read(h.state.tabId);
  assert.equal(runtime.lease, null);
  assert.equal(runtime.commands['delete-command'].status, 'succeeded');
  assert.ok(h.sent.some((entry) => entry.payload.commandId === 'delete-command' && entry.payload.resultType === 'session.deleted'));
});

test('release readiness is durable and completes atomically only after request children settle', async () => {
  const tabId = 97;
  const contentEpoch = 'content-release-barrier';
  const request = {
    requestId: 'request-release-barrier',
    leaseId: 'lease-release-barrier',
    ownerServerInstanceId: 'server-release-barrier',
    responseEpoch: 3,
  };
  const store = new BackgroundStateStore(memoryStorage(), 'background-regression');
  const apply = async (event) => {
    const outcome = await store.transition(tabId, { ...event, contentEpoch });
    assert.equal(outcome.accepted, true, `${event.type}: ${outcome.reason}`);
    return outcome.state;
  };
  await apply({ type: 'content.attached', contentEpoch });
  await apply({ type: 'lease.claim', ...request });
  await apply({ type: 'lease.releasing', ...request });
  await apply({ type: 'command.registered', ...request, commandId: 'child-command', commandType: 'prompt.cancel', scope: 'request' });
  await apply({ type: 'command.dispatched', ...request, commandId: 'child-command' });
  await apply({ type: 'command.registered', ...request, commandId: 'release-command', commandType: 'request.release', scope: 'request' });
  await apply({ type: 'command.dispatched', ...request, commandId: 'release-command' });

  let state = await apply({
    type: 'command.release_ready',
    ...request,
    commandId: 'release-command',
    resultPayload: {
      type: 'command.result', commandId: 'release-command', requestId: request.requestId,
      resultType: 'request.release.completed', releaseLease: true, released: true, activeRequest: null,
      proof: { contentCleared: true },
    },
  });
  assert.equal(state.lease.status, 'releasing');
  assert.equal(state.commands['release-command'].status, 'dispatched');
  assert.ok(state.commands['release-command'].releaseReadyAt > 0);

  state = await apply({
    type: 'command.succeeded',
    ...request,
    commandId: 'child-command',
    resultType: 'prompt.cancelled',
    resultPayload: { type: 'command.result', commandId: 'child-command', resultType: 'prompt.cancelled' },
  });
  assert.equal(state.lease, null);
  assert.equal(state.commands['release-command'].status, 'succeeded');
  assert.equal(state.commands['release-command'].resultPayload.proof.contentCleared, true);
  assert.ok(state.commands['release-command'].releaseCompletedAt >= state.commands['release-command'].releaseReadyAt);
});
