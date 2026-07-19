import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserBridge } from '../src/browserBridge.js';
import { BrowserExtensionHub } from '../src/browserExtensionHub.js';
import { BackgroundStateStore } from '../tools/chrome-bridge-extension/background/stateV4.js';
import { handlePayload } from '../tools/chrome-bridge-extension/background/portRouter.js';
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


test('the hub rejects a direct command dispatch while another request release is pending', async () => {
  const hub = new BrowserExtensionHub(null, { serverInstanceId: 'server-release-race' });
  const connection = await connectExtensionClient(hub, {
    clientId: 'tab-release-race',
    url: 'https://chatgpt.com/c/session-release-race',
  });
  try {
    hub.beginRequestRelease('tab-release-race', 'request-race', 'release-race-command');
    assert.throws(() => hub.sendToClient('tab-release-race', {
      type: 'models.list',
      commandId: 'models-during-release',
    }), (error) => error?.code === 'BROWSER_RELEASE_PENDING' && /request-race/.test(error.message));
  } finally {
    await connection.close();
  }
});

test('a command-scoped models request waits for the previous canonical request release barrier', async () => {
  const hub = new BrowserExtensionHub(null, { serverInstanceId: 'server-release-regression' });
  const connection = await connectExtensionClient(hub, {
    clientId: 'tab-release-regression',
    url: 'https://chatgpt.com/c/session-release-regression',
  });
  const bridge = new BrowserBridge(hub);
  const serverCommands = [];
  connection.ws.on('message', (data) => {
    const envelope = JSON.parse(String(data));
    if (envelope.kind === 'command.execute') serverCommands.push(envelope);
  });

  try {
    hub.beginRequestRelease('tab-release-regression', 'request-finished', 'release-command');
    const modelsPromise = bridge.listModels({ sourceClientId: 'tab-release-regression', timeoutMs: 2_000 });

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(serverCommands.some((entry) => entry.payload?.type === 'models.list'), false);

    connection.send({
      type: 'command.result',
      commandId: 'release-command',
      requestId: 'request-finished',
      resultType: 'request.release.completed',
      released: true,
      activeRequest: null,
    });

    const modelsEnvelope = await waitFor(() => serverCommands.find((entry) => entry.payload?.type === 'models.list'));
    assert.equal(modelsEnvelope.payload.leaseScope, 'command');
    connection.send({
      type: 'command.result',
      commandId: modelsEnvelope.payload.commandId,
      requestId: modelsEnvelope.request.requestId,
      resultType: 'models.snapshot',
      models: [{ id: 'gpt-test', label: 'GPT Test' }],
      current: { id: 'gpt-test' },
    });

    const result = await modelsPromise;
    assert.deepEqual(result.models, [{ id: 'gpt-test', label: 'GPT Test' }]);
    assert.equal(result.current.id, 'gpt-test');
  } finally {
    await bridge.close();
    await connection.close();
  }
});

test('session deletion survives content reload and settles from the next tab observation', async () => {
  const storage = memoryStorage();
  const backgroundState = new BackgroundStateStore(storage, 'background-session-delete-regression');
  const tabId = 77;
  const oldEpoch = 'content-before-delete';
  const newEpoch = 'content-after-delete';
  const lease = {
    requestId: 'command-delete-session',
    leaseId: 'lease-delete-session',
    ownerServerInstanceId: 'server-delete-session',
  };
  await backgroundState.transition(tabId, { type: 'content.attached', contentEpoch: oldEpoch });
  await backgroundState.transition(tabId, { type: 'lease.claim', ...lease, conversationId: 'session-old', contentEpoch: oldEpoch });
  await backgroundState.transition(tabId, { type: 'lease.executing', ...lease, contentEpoch: oldEpoch });
  await backgroundState.transition(tabId, {
    type: 'command.registered',
    commandId: 'delete-command',
    commandType: 'sessions.delete',
    causationId: 'server-envelope-delete',
    releaseOnResult: true,
    idempotencyKey: 'delete-command',
    retryPolicy: 'never',
    preconditions: { commandType: 'sessions.delete', conversationId: 'session-old' },
    ...lease,
    contentEpoch: oldEpoch,
  });
  await backgroundState.transition(tabId, { type: 'command.dispatched', commandId: 'delete-command', contentEpoch: oldEpoch });
  await backgroundState.transition(tabId, { type: 'content.attached', contentEpoch: newEpoch });

  const sent = [];
  const state = {
    tabId,
    clientId: 'client-delete-session',
    contentEpoch: newEpoch,
    protocolReady: false,
    preHelloPayloads: [],
  };
  const deps = {
    backgroundState,
    post() {},
    async replayCriticalOutbox() {},
    async sendProtocolPayload(_state, payload, options = {}) { sent.push({ payload, options }); },
  };

  await handlePayload(deps, null, state, {
    type: 'hello',
    url: 'https://chatgpt.com/c/session-old',
    session: { id: 'session-old' },
  });
  let runtime = await backgroundState.read(tabId);
  assert.equal(runtime.commands['delete-command'].status, 'dispatched');
  assert.equal(sent.some((entry) => entry.payload.code === 'CONTENT_RELOADED_DURING_COMMAND'), false);

  await handlePayload(deps, null, state, {
    type: 'tab.observation',
    observation: {
      conversationId: '',
      url: 'https://chatgpt.com/',
      revision: 1,
    },
  });

  runtime = await backgroundState.read(tabId);
  assert.equal(runtime.commands['delete-command'].status, 'succeeded');
  assert.ok(runtime.commands['delete-command'].reportedAt > 0);
  assert.equal(runtime.lease, null);
  const result = sent.find((entry) => entry.payload.commandId === 'delete-command' && entry.payload.type === 'command.result');
  assert.ok(result);
  assert.equal(result.payload.resultType, 'session.deleted');
  assert.equal(result.payload.deletedSessionId, 'session-old');
  assert.equal(result.payload.afterSessionId, '');
  assert.equal(result.payload.reconciledAfterReload, true);
});

test('reload-mid-request reuses the active request lease instead of creating a conflicting command lease', async () => {
  const hub = new BrowserExtensionHub(null, { serverInstanceId: 'server-active-reload' });
  const activeRequest = {
    requestId: 'request-active-reload',
    leaseId: 'lease-active-reload',
    ownerServerInstanceId: 'server-active-reload',
  };
  const connection = await connectExtensionClient(hub, {
    clientId: 'tab-active-reload',
    url: 'https://chatgpt.com/c/session-active-reload',
    activeRequest,
  });
  const bridge = new BrowserBridge(hub);
  const commands = [];
  connection.ws.on('message', (data) => {
    const envelope = JSON.parse(String(data));
    if (envelope.kind === 'command.execute') commands.push(envelope);
  });

  try {
    const reloadPromise = bridge.reloadBrowserTab({
      sourceClientId: 'tab-active-reload',
      reason: 'fault-injection reload while request is active',
      timeoutMs: 2_000,
    });
    const envelope = await waitFor(() => commands.find((entry) => entry.payload?.type === 'browser.tab.reload'));
    assert.equal(envelope.request.requestId, activeRequest.requestId);
    assert.equal(envelope.request.leaseId, activeRequest.leaseId);
    assert.equal(envelope.request.ownerServerInstanceId, activeRequest.ownerServerInstanceId);
    assert.equal(envelope.payload.requestId, activeRequest.requestId);
    assert.equal(envelope.payload.leaseScope, undefined);

    connection.send({
      type: 'command.result',
      resultType: 'browser.tab.reloading',
      commandId: envelope.payload.commandId,
      requestId: activeRequest.requestId,
      url: 'https://chatgpt.com/c/session-active-reload',
    });
    const result = await reloadPromise;
    assert.equal(result.type, 'browser.tab.reloading');
  } finally {
    await bridge.close();
    await connection.close();
  }
});

test('layout capture during an active request reuses the request lease for failure diagnostics', async () => {
  const hub = new BrowserExtensionHub(null, { serverInstanceId: 'server-active-layout' });
  const activeRequest = {
    requestId: 'request-active-layout',
    leaseId: 'lease-active-layout',
    ownerServerInstanceId: 'server-active-layout',
  };
  const connection = await connectExtensionClient(hub, {
    clientId: 'tab-active-layout',
    url: 'https://chatgpt.com/c/session-active-layout',
    activeRequest,
  });
  const bridge = new BrowserBridge(hub);
  const commands = [];
  connection.ws.on('message', (data) => {
    const envelope = JSON.parse(String(data));
    if (envelope.kind === 'command.execute') commands.push(envelope);
  });

  try {
    const capturePromise = bridge.capturePageLayout({
      sourceClientId: 'tab-active-layout',
      maxNodes: 1_000,
      maxBytes: 200_000,
      timeoutMs: 2_000,
    });
    const envelope = await waitFor(() => commands.find((entry) => entry.payload?.type === 'debug.layout.capture'));
    assert.equal(envelope.request.requestId, activeRequest.requestId);
    assert.equal(envelope.request.leaseId, activeRequest.leaseId);
    assert.equal(envelope.request.ownerServerInstanceId, activeRequest.ownerServerInstanceId);
    assert.equal(envelope.payload.requestId, activeRequest.requestId);
    assert.equal(envelope.payload.leaseScope, undefined);

    connection.send({
      type: 'command.result',
      resultType: 'page.layout.captured',
      commandId: envelope.payload.commandId,
      requestId: activeRequest.requestId,
      html: '<!doctype html><html><body data-testid="composer"></body></html>',
      metadata: { nodeCount: 2, sanitized: true },
    });
    const result = await capturePromise;
    assert.match(result.html, /data-testid="composer"/);
    assert.equal(result.metadata.nodeCount, 2);
  } finally {
    await bridge.close();
    await connection.close();
  }
});
