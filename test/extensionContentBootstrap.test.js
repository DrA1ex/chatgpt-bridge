import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapExtensionContentRuntime } from './helpers/extensionContentRuntime.js';

test('manifest-ordered content runtime initializes without temporal-dead-zone failures', async () => {
  const { scripts, sandbox } = await bootstrapExtensionContentRuntime();
  assert.equal(scripts.at(-1), 'content.js');
  assert.equal(sandbox.__chatgptBrowserBridgeCompanionInstance?.version, '3.0.17');
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
