import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapExtensionContentRuntime } from './helpers/extensionContentRuntime.js';

test('manifest-ordered content runtime initializes without temporal-dead-zone failures', async () => {
  const { scripts, sandbox } = await bootstrapExtensionContentRuntime();
  assert.equal(scripts.at(-1), 'content.js');
  assert.equal(sandbox.unsafeWindow.__chatgptBrowserBridgeCompanionInstance?.version, '3.0.2');
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
