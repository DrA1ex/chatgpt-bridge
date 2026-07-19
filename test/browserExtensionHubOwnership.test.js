import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserExtensionHub } from '../src/browserExtensionHub.js';
import { connectExtensionClient } from './helpers/extensionClient.js';
import { ExtensionMessageKind, createExtensionEnvelope } from '../src/bridge/protocol/v4.js';

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for extension client state');
}

test('hub exposes server identity and preserves only immutable request routing ownership', async () => {
  const hub = new BrowserExtensionHub(null, { serverInstanceId: 'server-current' });
  const clientConnection = await connectExtensionClient(hub, {
    clientId: 'tab-a',
    url: 'https://chatgpt.com/c/session-a',
    transportHealth: { outbox: { size: 2, observationCoalesced: 4 }, tabQueue: { pending: 1, highWater: 3 } },
    activeRequest: {
      requestId: 'turn-a',
      leaseId: 'lease-a',
      ownerServerInstanceId: 'server-other',
      responseEpoch: 2,
      submittedUserTurnKey: 'user-a',
      assistantTurnKey: 'assistant-a',
    },
  });
  try {
    const client = hub.clients.find((item) => item.id === 'tab-a');
    assert.equal(hub.serverInstanceId, 'server-current');
    assert.equal(client.serverInstanceId, 'server-current');
    assert.equal(client.activeRequest.ownerServerInstanceId, 'server-other');
    assert.equal(client.transportHealth.outbox.observationCoalesced, 4);
    assert.equal(client.transportHealth.tabQueue.highWater, 3);
    assert.equal(client.activeRequest.leaseId, 'lease-a');
    assert.equal(client.activeRequest.responseEpoch, 2);
    assert.equal(client.activeRequest.submittedUserTurnKey, 'user-a');
    assert.equal(client.activeRequest.assistantTurnKey, 'assistant-a');
    assert.equal(client.activeRequest.generating, undefined);
    assert.equal(client.activeRequest.stopButtonVisible, undefined);
  } finally {
    await clientConnection.close();
  }
});

test('hub recovers a launch token from the ChatGPT URL when the extension handshake omits it', async () => {
  const hub = new BrowserExtensionHub(null, { serverInstanceId: 'server-current' });
  const clientConnection = await connectExtensionClient(hub, {
    clientId: 'tab-launched',
    url: 'https://chatgpt.com/#chatgpt-bridge-launch=bridge-real-e2e-a1b2c3d4e5f6&chatgpt-bridge-server=http%3A%2F%2F127.0.0.1%3A18181',
    launchToken: '',
  });
  try {
    const client = hub.clients.find((item) => item.id === 'tab-launched');
    assert.equal(client.launchToken, 'bridge-real-e2e-a1b2c3d4e5f6');
    assert.equal(client.requestedUrl, 'https://chatgpt.com/');
  } finally {
    await clientConnection.close();
  }
});

test('hub stores always-on tab observations and rejects stale revisions within one observer epoch', async () => {
  const hub = new BrowserExtensionHub(null, { serverInstanceId: 'server-current' });
  const clientConnection = await connectExtensionClient(hub, {
    clientId: 'tab-observer',
    url: 'https://chatgpt.com/c/session-a',
  });
  const activities = [];
  hub.on('client.activity', (event) => activities.push(event));

  try {
    clientConnection.send({
      type: 'tab.observation',
      observation: {
        observerId: 'observer-a', revision: 2, observedAt: 20,
        url: 'https://chatgpt.com/c/session-a', conversationId: 'session-a', activeRequest: null,
        document: { readyState: 'complete', chatMainReady: true, pageReady: true },
        composer: { ready: true }, visibility: 'visible', focused: true,
      },
    });
    await waitFor(() => activities.length === 1);
    clientConnection.send({
      type: 'tab.observation',
      observation: {
        observerId: 'observer-a', revision: 1, observedAt: 10,
        url: 'https://chatgpt.com/c/stale', conversationId: 'stale', activeRequest: { requestId: 'stale-request' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    let client = hub.clients.find((item) => item.id === 'tab-observer');
    assert.equal(client.tabObservation.revision, 2);
    assert.equal(client.session.id, 'session-a');
    assert.equal(client.activeRequest, null);
    assert.equal(activities.length, 1);

    clientConnection.send({
      type: 'tab.observation',
      observation: {
        observerId: 'observer-b', revision: 1, observedAt: 30,
        url: 'https://chatgpt.com/c/session-b', conversationId: 'session-b', activeRequest: null,
      },
    });
    await waitFor(() => activities.length === 2);
    client = hub.clients.find((item) => item.id === 'tab-observer');
    assert.equal(client.tabObservation.observerId, 'observer-b');
    assert.equal(client.tabObservation.revision, 1);
    assert.equal(client.session.id, 'session-b');
  } finally {
    await clientConnection.close();
  }
});

test('hub rejects every command, including reload, from a non-protocol-4 client', async () => {
  const hub = new BrowserExtensionHub(null, { serverInstanceId: 'server-current' });
  const clientConnection = await connectExtensionClient(hub, {
    clientId: 'tab-outdated',
    extensionVersion: '0.9.0',
    clientVersion: '3.0.14',
    extensionProtocolVersion: 3,
  });
  try {
    const client = hub.clients.find((item) => item.id === 'tab-outdated');
    assert.equal(client.compatible, false);
    assert.throws(() => hub.sendToClient('tab-outdated', { type: 'request.snapshot' }), /incompatible/);

    assert.throws(() => hub.sendToClient('tab-outdated', { type: 'extension.reload', commandId: 'reload-outdated' }), /incompatible/);
    assert.throws(() => hub.sendReloadControlToClient('tab-outdated', { type: 'extension.reload', commandId: 'reload-outdated' }), /incompatible/);
  } finally {
    await clientConnection.close();
  }
});

test('hub permits only extension.reload to bypass version compatibility for protocol 4', async () => {
  const hub = new BrowserExtensionHub(null, { serverInstanceId: 'server-current' });
  const clientConnection = await connectExtensionClient(hub, {
    clientId: 'tab-outdated-v4',
    extensionVersion: '2.0.1',
    clientVersion: '4.0.1',
    extensionProtocolVersion: 4,
  });
  try {
    const client = hub.clients.find((item) => item.id === 'tab-outdated-v4');
    assert.equal(client.compatible, false);
    assert.throws(() => hub.sendToClient('tab-outdated-v4', { type: 'request.snapshot' }), /incompatible/);
    assert.throws(() => hub.sendToClient('tab-outdated-v4', { type: 'extension.reload', commandId: 'ordinary-reload' }), /incompatible/);
    assert.throws(() => hub.sendReloadControlToClient('tab-outdated-v4', { type: 'request.snapshot' }), /Unsupported compatibility-bypass command/);

    const received = new Promise((resolve) => {
      const onMessage = (data) => {
        const envelope = JSON.parse(String(data));
        if (envelope.payload?.type !== 'extension.reload') return;
        clientConnection.ws.off('message', onMessage);
        resolve(envelope);
      };
      clientConnection.ws.on('message', onMessage);
    });
    hub.sendReloadControlToClient('tab-outdated-v4', { type: 'extension.reload', commandId: 'reload-v4' });
    const envelope = await received;
    assert.equal(envelope.protocolVersion, 4);
    assert.equal(envelope.kind, 'command.execute');
    assert.equal(envelope.payload.commandId, 'reload-v4');
  } finally {
    await clientConnection.close();
  }
});


test('hub gives every correlated command a command-scoped protocol lease', async () => {
  const hub = new BrowserExtensionHub(null, { serverInstanceId: 'server-current' });
  const clientConnection = await connectExtensionClient(hub, {
    clientId: 'tab-command-lease',
    url: 'https://chatgpt.com/c/session-command',
  });
  try {
    const received = new Promise((resolve) => {
      const onMessage = (data) => {
        const envelope = JSON.parse(String(data));
        if (envelope.payload?.type !== 'models.list') return;
        clientConnection.ws.off('message', onMessage);
        resolve(envelope);
      };
      clientConnection.ws.on('message', onMessage);
    });
    hub.sendToClient('tab-command-lease', { type: 'models.list', commandId: 'models-command' });
    const envelope = await received;
    assert.equal(envelope.kind, 'command.execute');
    assert.equal(envelope.request.requestId, 'command_models-command');
    assert.equal(envelope.request.ownerServerInstanceId, 'server-current');
    assert.ok(envelope.request.leaseId);
    assert.equal(envelope.payload.requestId, 'command_models-command');
    assert.equal(envelope.payload.leaseScope, 'command');
  } finally {
    await clientConnection.close();
  }
});

test('hub keeps a tab unschedulable until the correlated release result is accepted', async () => {
  const hub = new BrowserExtensionHub(null, { serverInstanceId: 'server-current' });
  const lease = {
    requestId: 'turn-release',
    leaseId: 'lease-release',
    ownerServerInstanceId: 'server-current',
  };
  const clientConnection = await connectExtensionClient(hub, {
    clientId: 'tab-release',
    url: 'https://chatgpt.com/c/session-release',
    activeRequest: lease,
  });
  try {
    hub.beginRequestRelease('tab-release', lease.requestId, 'release-command');
    const releaseWait = hub.waitForClientRelease('tab-release', lease.requestId, 1_000);
    let settled = false;
    releaseWait.then(() => { settled = true; }, () => { settled = true; });

    clientConnection.send({
      type: 'page.changed',
      url: 'https://chatgpt.com/c/session-release',
      activeRequest: null,
    });
    await waitFor(() => hub.clients.find((client) => client.id === 'tab-release')?.activeRequest === null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    let client = hub.clients.find((item) => item.id === 'tab-release');
    assert.equal(settled, false);
    assert.equal(client.releasingRequestId, lease.requestId);

    clientConnection.send({
      type: 'command.result',
      commandId: 'release-command',
      requestId: lease.requestId,
      released: true,
      activeRequest: null,
    });
    await releaseWait;
    client = hub.clients.find((item) => item.id === 'tab-release');
    assert.equal(client.releasingRequestId, '');
    assert.equal(client.releaseStatus, '');
  } finally {
    await clientConnection.close();
  }
});

test('hub ACKs critical input only after canonical handling succeeds and allows exact retry', async () => {
  const hub = new BrowserExtensionHub(null, { serverInstanceId: 'server-current' });
  let attempts = 0;
  hub.setCanonicalMessageHandler(async ({ eventName }) => {
    if (eventName !== 'client.activity') return;
    attempts += 1;
    if (attempts === 1) throw new Error('simulated canonical store failure');
  });
  const clientConnection = await connectExtensionClient(hub, {
    clientId: 'tab-transactional-ack',
    browserTabId: 77,
    url: 'https://chatgpt.com/c/session-a',
  });
  const envelope = createExtensionEnvelope(ExtensionMessageKind.REQUEST_OBSERVATION, {
    type: 'tab.observation',
    observation: {
      observerId: 'observer-ack', revision: 1, observedAt: 10,
      url: 'https://chatgpt.com/c/session-b', conversationId: 'session-b', activeRequest: null,
    },
  }, {
    source: {
      clientId: 'tab-transactional-ack', tabId: 77,
      backgroundEpoch: 'test-background-epoch', contentEpoch: 'test-content-epoch', sequence: 2,
    },
    messageId: 'transactional-message-1',
  });
  const ackFor = () => new Promise((resolve) => {
    const onMessage = (data) => {
      const value = JSON.parse(String(data));
      if (value.kind !== ExtensionMessageKind.TRANSPORT_ACK || value.payload?.ackMessageId !== envelope.messageId) return;
      clientConnection.ws.off('message', onMessage);
      resolve(value.payload);
    };
    clientConnection.ws.on('message', onMessage);
  });
  try {
    let ackPromise = ackFor();
    clientConnection.ws.send(JSON.stringify(envelope));
    let ack = await ackPromise;
    assert.equal(ack.accepted, false);
    assert.equal(ack.reason, 'canonical_commit_failed');
    assert.equal(hub.clients.find((item) => item.id === 'tab-transactional-ack').session.id, 'session-a');

    ackPromise = ackFor();
    clientConnection.ws.send(JSON.stringify(envelope));
    ack = await ackPromise;
    assert.equal(ack.accepted, true);
    await waitFor(() => hub.clients.find((item) => item.id === 'tab-transactional-ack')?.session?.id === 'session-b');
    assert.equal(attempts, 2);
  } finally {
    await clientConnection.close();
  }
});


test('hub assigns a durable command identity to request-scoped prompt delivery', async () => {
  const hub = new BrowserExtensionHub(null, { serverInstanceId: 'server-current' });
  const clientConnection = await connectExtensionClient(hub, {
    clientId: 'tab-prompt-command-id',
    url: 'https://chatgpt.com/',
  });
  try {
    const received = new Promise((resolve) => {
      const onMessage = (data) => {
        const envelope = JSON.parse(String(data));
        if (envelope.payload?.type !== 'prompt.send') return;
        clientConnection.ws.off('message', onMessage);
        resolve(envelope);
      };
      clientConnection.ws.on('message', onMessage);
    });
    hub.sendToClient('tab-prompt-command-id', {
      type: 'prompt.send',
      requestId: 'request-prompt-command-id',
      message: 'Bootstrap prompt',
      options: {},
      attachments: [],
    });
    const envelope = await received;
    assert.equal(envelope.kind, 'command.execute');
    assert.ok(envelope.commandId);
    assert.equal(envelope.payload.commandId, envelope.commandId);
    assert.equal(envelope.request.requestId, 'request-prompt-command-id');
    assert.ok(envelope.request.leaseId);
  } finally {
    await clientConnection.close();
  }
});
