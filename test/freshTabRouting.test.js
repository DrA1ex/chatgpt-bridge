import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserClientCoordinator } from '../src/bridge/coordinator/browserClientCoordinator.js';
import { normalizeOptions } from '../src/bridge/requestState.js';
import { extractRequestFromOpenAIPayload } from '../src/openaiPayload.js';

function makeCoordinator(openedClient = {}) {
  const opened = {
    id: 'fresh-client',
    ready: true,
    compatible: true,
    compatibility: { compatible: true },
    url: 'https://chatgpt.com/',
    session: { id: 'new' },
    ...openedClient,
  };
  const calls = [];
  const coordinator = new BrowserClientCoordinator({
    hub: { clients: new Set(), activeClient: null },
    pending: new Map(),
    lifecycle: { emitRequestEvent() {} },
    runtimeOptions: {
      autoOpenTab: false,
      autoOpenTabTimeoutMs: 30_000,
      autoOpenTabBootstrapWaitMs: 0,
    },
    async sendCommand() { throw new Error('unexpected command'); },
  });
  coordinator.tabs = {
    async openBrowserTab(options) {
      calls.push(options);
      return { client: opened, openedBy: 'extension', sourceClientId: 'controller-client' };
    },
  };
  return { coordinator, calls };
}

test('freshTab always opens and binds a dedicated launch-token client', async () => {
  const { coordinator, calls } = makeCoordinator();
  const result = await coordinator.resolvePromptClient(
    { requestId: 'request-1' },
    { freshTab: true, newSession: true },
    {},
  );

  assert.equal(result.client.id, 'fresh-client');
  assert.equal(result.reason, 'explicit_fresh_tab');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://chatgpt.com/');
  assert.match(calls[0].launchToken, /^bridge-auto-/);
});

test('freshTab fails closed on conflicting or non-fresh destinations', async () => {
  const explicit = makeCoordinator();
  await assert.rejects(
    explicit.coordinator.resolvePromptClient(
      { requestId: 'request-2' },
      { freshTab: true, sourceClientId: 'existing-client' },
      {},
    ),
    /cannot be combined with sourceClientId/i,
  );

  const existingConversation = makeCoordinator({
    url: 'https://chatgpt.com/c/existing-conversation',
    session: { id: 'existing-conversation' },
  });
  await assert.rejects(
    existingConversation.coordinator.resolvePromptClient(
      { requestId: 'request-3' },
      { freshTab: true },
      {},
    ),
    /resolved to an existing ChatGPT conversation/i,
  );
});

test('freshTab implies a new session across native and OpenAI request parsing', () => {
  assert.deepEqual(
    { freshTab: normalizeOptions({ freshTab: true }).freshTab, newSession: normalizeOptions({ freshTab: true }).newSession },
    { freshTab: true, newSession: true },
  );
  const parsed = extractRequestFromOpenAIPayload({ input: 'hello', fresh_tab: true });
  assert.equal(parsed.freshTab, true);
  assert.equal(parsed.newSession, true);
});
