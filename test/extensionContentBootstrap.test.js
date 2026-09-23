import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapExtensionContentRuntime } from './helpers/extensionContentRuntime.js';
import { readBundledExtensionInfo } from '../src/extensionStartup.js';

test('manifest-ordered content runtime initializes without temporal-dead-zone failures', async () => {
  const { scripts, sandbox } = await bootstrapExtensionContentRuntime();
  assert.equal(scripts.at(-1), 'content.js');
  assert.ok(scripts.indexOf('content/turnDom.js') < scripts.indexOf('content/artifactDom.js'));
  assert.deepEqual(Array.from(sandbox.ChatGptTurnDom.createTurnDom().getTurnNodes()), []);
  assert.equal(sandbox.__chatgptBrowserBridgeCompanionInstance?.version, '4.4.1');
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

test('artifact DOM emits image diagnostics once per semantic image state', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const diagnostics = [];
  const src = 'https://chatgpt.com/backend-api/estuary/content?id=image-one&sig=same';
  const image = () => ({
    tagName: 'IMG',
    currentSrc: src,
    src,
    complete: true,
    naturalWidth: 1024,
    naturalHeight: 1024,
    parentElement: null,
    getAttribute(name) {
      return ({ alt: 'Generated image', width: '1024', height: '1024' })[name] || null;
    },
    closest() { return null; },
    matches() { return false; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 1024, height: 1024 }; },
  });
  const images = [image(), image()];
  const root = {
    matches() { return false; },
    contains() { return true; },
    querySelectorAll(selector) { return selector === 'img' ? images : []; },
  };
  const artifactDom = sandbox.ChatGptArtifactDom.createArtifactDom({
    DOM_PARSER: sandbox.ChatGptDomParserCore,
    actionSelectorHint: () => '',
    diagnostic: (name, details) => diagnostics.push({ name, details }),
    guessMime: () => 'image/png',
    guessNameFromUrl: () => '',
    isUsableButton: () => true,
    isVisible: () => true,
    normalizeText: (value) => String(value || '').trim(),
    simpleHash: (value) => String(value.length),
    visibleText: (element) => String(element?.textContent || ''),
  });

  assert.equal(artifactDom.collectArtifactsFromNode(root, { turnKey: 'turn-image' }).length, 1);
  assert.equal(artifactDom.collectArtifactsFromNode(root, { turnKey: 'turn-image' }).length, 1);
  assert.deepEqual(
    diagnostics.map(({ name }) => name),
    ['image.candidate.observed', 'image.artifact.registered'],
  );
});

test('artifact transfer validates navigation URL dependencies at bootstrap', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const factory = sandbox.ChatGptArtifactTransfer;
  const transfer = factory.createArtifactTransfer({
    isBrowserOnlyArtifactUrl: () => false, isCurrentPageNavigationUrl: () => false,
  });
  assert.throws(() => transfer.validateArtifactBytes(new Uint8Array([1, 2, 3]), { kind: 'image', mime: 'image/*' }),
    { code: 'ARTIFACT_IMAGE_INVALID' });
  assert.throws(() => factory.createArtifactTransfer({}), /isBrowserOnlyArtifactUrl/);
  assert.throws(() => factory.createArtifactTransfer({ isBrowserOnlyArtifactUrl() { return false; } }), /isCurrentPageNavigationUrl/);
  assert.doesNotThrow(() => factory.createArtifactTransfer({
    isBrowserOnlyArtifactUrl() { return false; },
    isCurrentPageNavigationUrl() { return false; },
  }));
});

test('manifest bootstrap sends a protocol hello after lease-only request recovery', async () => {
  const bundledExtension = await readBundledExtensionInfo();
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
  assert.equal(hello.extensionVersion, bundledExtension.version);
  assert.equal(hello.extensionBundleId, bundledExtension.bundleId);
  assert.equal(hello.clientVersion, bundledExtension.contentVersion);
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
  for (let attempt = 0; attempt < 100 && !sandbox.__extensionPortTest.messages.some((message) => message.payload?.type === 'page.layout.captured'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const payloads = sandbox.__extensionPortTest.messages
    .filter((message) => message.type === 'bridge.payload')
    .map((message) => message.payload);
  const result = payloads.filter((payload) => payload?.type === 'page.layout.captured').at(-1);
  const chunks = payloads.filter((payload) => payload?.type === 'command.progress' && payload.progressType === 'page.layout.chunk');
  assert.ok(result, 'Manifest runtime did not return a page.layout.captured result');
  assert.equal(result.commandId, 'layout-capture-command');
  assert.equal(result.requestId, 'layout-capture-request');
  const html = chunks.sort((a, b) => a.index - b.index).map((chunk) => chunk.content).join('');
  assert.equal(html.length, result.htmlLength);
  assert.match(html, /Sanitized ChatGPT layout capture/);
  assert.equal(result.metadata.url, 'https://chatgpt.com/');
});


test('manifest runtime dispatches image reads and rejects UI-action sources without entering a write', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime(undefined, { startRuntime: 'connect', bridgeToken: 'image-read-token' });
  sandbox.__extensionPortTest.dispatch({ type: 'extension.connected', browserTabId: 45, recovery: null });
  sandbox.__extensionPortTest.dispatch({ type: 'server.message', payload: {
    type: 'artifact.image.read', commandId: 'read-image',
    artifact: { id: 'image', kind: 'image', url: 'https://chatgpt.com/' },
  } });
  await new Promise((resolve) => setImmediate(resolve));
  const result = sandbox.__extensionPortTest.messages.map((message) => message.payload)
    .find((payload) => payload?.commandId === 'read-image' && payload.type === 'command.error');
  assert.equal(result?.code, 'ARTIFACT_IMAGE_SOURCE_INVALID');
});
