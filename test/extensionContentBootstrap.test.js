import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapExtensionContentRuntime } from './helpers/extensionContentRuntime.js';

test('manifest-ordered content runtime initializes without temporal-dead-zone failures', async () => {
  const { scripts, sandbox } = await bootstrapExtensionContentRuntime();
  assert.equal(scripts.at(-1), 'content.js');
  assert.equal(sandbox.__chatgptBrowserBridgeCompanionInstance?.version, '4.2.0');
});

test('turn snapshot factory validates cross-module request and artifact dependencies at bootstrap', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const factory = sandbox.ChatGptTurnSnapshots;
  assert.throws(() => factory.createTurnSnapshots({
    collectArtifactsForAssistantNode() {},
    collectArtifactsFromNode() {},
  }), /setRequestPhase/);
  assert.doesNotThrow(() => factory.createTurnSnapshots({
    collectArtifactsForAssistantNode() {},
    collectArtifactsFromNode() {},
    setRequestPhase() {},
  }));
});


test('artifact DOM factory requires button usability as an explicit dependency', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const factory = sandbox.ChatGptArtifactDom;
  assert.throws(() => factory.createArtifactDom({}), /isUsableButton/);
  assert.doesNotThrow(() => factory.createArtifactDom({ isUsableButton() { return true; } }));
});

test('artifact DOM rejects the current ChatGPT conversation URL as a downloadable file source', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  sandbox.location.href = 'https://chatgpt.com/c/conversation-1';
  const artifactDom = sandbox.ChatGptArtifactDom.createArtifactDom({ isUsableButton() { return true; } });
  assert.equal(artifactDom.isCurrentPageNavigationUrl('https://chatgpt.com/c/conversation-1'), true);
  assert.equal(artifactDom.isCurrentPageNavigationUrl('https://chatgpt.com/c/conversation-1#toolbar'), true);
  assert.equal(artifactDom.isCurrentPageNavigationUrl('https://chatgpt.com/backend-api/files/file-1'), false);
});

test('artifact transfer validates navigation URL dependencies at bootstrap', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const factory = sandbox.ChatGptArtifactTransfer;
  assert.throws(() => factory.createArtifactTransfer({}), /isBrowserOnlyArtifactUrl/);
  assert.throws(() => factory.createArtifactTransfer({ isBrowserOnlyArtifactUrl() { return false; } }), /isCurrentPageNavigationUrl/);
  assert.doesNotThrow(() => factory.createArtifactTransfer({
    isBrowserOnlyArtifactUrl() { return false; },
    isCurrentPageNavigationUrl() { return false; },
  }));
});

test('manifest bootstrap sends a protocol hello after lease-only request recovery', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime(undefined, {
    startRuntime: 'connect',
    bridgeToken: 'bootstrap-token',
  });
  sandbox.__extensionPortTest.dispatch({
    type: 'extension.connected',
    browserTabId: 42,
    launchToken: 'bridge-bootstrap-reload',
    recovery: {
      lease: {
        requestId: 'request-reload',
        leaseId: 'lease-reload',
        ownerServerInstanceId: 'server-reload',
        claimedAt: 123,
      },
      effects: [{ effectId: 'effect-before-reload' }],
    },
  });
  const hello = sandbox.__extensionPortTest.messages
    .filter((message) => message.type === 'bridge.payload' && message.payload?.type === 'hello')
    .at(-1)?.payload;
  assert(hello, 'Reloaded content runtime did not emit a protocol hello');
  assert.equal(hello.recoveryError, undefined);
  assert.equal(hello.activeRequest?.requestId, 'request-reload');
  assert.equal(hello.activeRequest?.leaseId, 'lease-reload');
  assert.equal(hello.activeRequest?.ownerServerInstanceId, 'server-reload');
  assert.equal(hello.activeRequest?.responseEpoch, 0);
  assert.equal(hello.activeRequest?.phase, undefined);
  assert.equal(hello.activeRequest?.lastAnswerLength, undefined);
  assert.equal(hello.activeRequest?.artifactCount, undefined);
});

test('request recovery failure degrades the hello instead of suppressing the handshake', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime(undefined, {
    startRuntime: 'connect',
    bridgeToken: 'bootstrap-token',
  });
  sandbox.__extensionPortTest.dispatch({
    type: 'extension.connected',
    browserTabId: 43,
    launchToken: 'bridge-bootstrap-invalid-recovery',
    recovery: { lease: { leaseId: 'lease-without-request' } },
  });
  const hello = sandbox.__extensionPortTest.messages
    .filter((message) => message.type === 'bridge.payload' && message.payload?.type === 'hello')
    .at(-1)?.payload;
  assert(hello, 'Recovery failure prevented the protocol hello');
  assert.match(hello.recoveryError || '', /requestId/);
  assert.equal(hello.activeRequest, null);
});

test('manifest-ordered content runtime routes sanitized layout capture commands end to end', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime(undefined, {
    startRuntime: 'connect',
    bridgeToken: 'layout-capture-token',
  });
  sandbox.__extensionPortTest.dispatch({
    type: 'extension.connected',
    browserTabId: 44,
    launchToken: 'bridge-layout-capture',
    recovery: null,
  });
  sandbox.__extensionPortTest.dispatch({
    type: 'server.message',
    payload: {
      type: 'debug.layout.capture',
      commandId: 'layout-capture-command',
      requestId: 'layout-capture-request',
      options: { maxNodes: 1_000, maxBytes: 200_000 },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const result = sandbox.__extensionPortTest.messages
    .filter((message) => message.type === 'bridge.payload' && message.payload?.type === 'page.layout.captured')
    .at(-1)?.payload;
  assert.ok(result, 'Manifest runtime did not return a page.layout.captured result');
  assert.equal(result.commandId, 'layout-capture-command');
  assert.equal(result.requestId, 'layout-capture-request');
  assert.match(result.html, /Sanitized ChatGPT layout capture/);
  assert.equal(result.metadata.url, 'https://chatgpt.com/');
});
