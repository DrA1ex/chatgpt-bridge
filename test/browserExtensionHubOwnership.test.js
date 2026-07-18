import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserExtensionHub } from '../src/browserExtensionHub.js';
import { connectExtensionClient } from './helpers/extensionClient.js';

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for extension client state');
}

test('hub exposes server instance identity and preserves active request ownership/current generation', async () => {
  const hub = new BrowserExtensionHub(null, { serverInstanceId: 'server-current' });
  const clientConnection = await connectExtensionClient(hub, {
    clientId: 'tab-a',
    url: 'https://chatgpt.com/c/session-a',
    activeRequest: {
      requestId: 'turn-a',
      ownerServerInstanceId: 'server-other',
      sawGenerating: true,
      generating: false,
      stopButtonVisible: false,
    },
  });
  try {
    const client = hub.clients.find((item) => item.id === 'tab-a');
    assert.equal(hub.serverInstanceId, 'server-current');
    assert.equal(client.serverInstanceId, 'server-current');
    assert.equal(client.activeRequest.ownerServerInstanceId, 'server-other');
    assert.equal(client.activeRequest.sawGenerating, true);
    assert.equal(client.activeRequest.generating, false);
    assert.equal(client.activeRequest.stopButtonVisible, false);
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
