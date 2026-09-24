import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MockExtensionTab } from '../scripts/e2e/mock-chatgpt/extension-client.js';

const reviewed = JSON.parse(fs.readFileSync(new URL('./fixtures/e2e-real/interactive-new-chat-client-collision-debug.json', import.meta.url), 'utf8'));

test('reviewed interactive debug fixture requires cloned storage to remain tab-scoped', () => {
  assert.equal(reviewed.observed.sharedLogicalClientId, true);
  assert.equal(reviewed.requiredSimulatorContract.clonedContentStorageAcrossTabs, true);
  assert.equal(reviewed.requiredSimulatorContract.serverClientIdentityIsTabScoped, true);
  const [firstTabId, secondTabId] = reviewed.observed.alternatingBrowserTabIds;
  assert.notEqual(firstTabId, secondTabId);
});

test('mock extension reproduces cloned content storage while keeping server clients tab-scoped', () => {
  const sharedContentClientId = 'mock-cloned-session-storage';
  const first = new MockExtensionTab({ bridgeUrl: 'http://127.0.0.1:1', tabId: 301, contentClientId: sharedContentClientId });
  const second = new MockExtensionTab({ bridgeUrl: 'http://127.0.0.1:1', tabId: 302, contentClientId: sharedContentClientId });

  assert.equal(first.helloBody().clientId, sharedContentClientId);
  assert.equal(second.helloBody().clientId, sharedContentClientId);
  assert.equal(first.clientId, 'extension:tab:301');
  assert.equal(second.clientId, 'extension:tab:302');
  assert.notEqual(first.clientId, second.clientId);
});
