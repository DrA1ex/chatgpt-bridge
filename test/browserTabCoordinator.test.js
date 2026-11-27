import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserTabCoordinator } from '../src/bridge/coordinator/browserTabCoordinator.js';
import { EXTENSION_COMPATIBILITY } from '../src/extensionCompatibility.js';

test('system browser launch failure recommends the current compatible extension versions', async () => {
  const coordinator = new BrowserTabCoordinator({
    hub: { clients: [] },
    runtimeOptions: {
      publicBaseUrl: 'http://127.0.0.1:3589',
      openExternalUrl: async () => {},
    },
    sendCommand: async () => {},
    rankClients: () => [],
  });
  coordinator.waitForBrowserClient = async () => {
    throw new Error('Timed out waiting for the new ChatGPT browser tab after 250ms');
  };

  await assert.rejects(
    () => coordinator.openSystemBrowserTab({
      url: 'https://chatgpt.com/',
      launchToken: 'bridge-test-launch-token',
      timeoutMs: 250,
    }),
    (error) => {
      const expectedVersions = `ChatGPT Bridge extension ${EXTENSION_COMPATIBILITY.recommendedExtensionVersion} with content runtime ${EXTENSION_COMPATIBILITY.minContentVersion} installed and configured`;
      assert.ok(error.message.includes(expectedVersions), error.message);
      assert.doesNotMatch(error.message, /2\.3\.14|4\.3\.12/);
      return true;
    },
  );
});
