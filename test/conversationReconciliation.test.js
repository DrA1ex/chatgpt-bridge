import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import '../tools/chrome-bridge-extension/content/conversationReconciliation.js';
import { BridgeOperations } from '../src/bridge/coordinator/bridgeOperations.js';

const { reconcile, read } = globalThis.ChatGptConversationReconciliation;
const expected = { conversationId: 'conversation', userMessageId: 'user', assistantMessageId: 'assistant' };
const url = 'https://chatgpt.com/c/conversation';
function record() {
  return { conversation_id: 'conversation', current_node: 'assistant-node', mapping: {
    root: { parent: null, message: null },
    'user-node': { parent: 'root', message: { id: 'user', author: { role: 'user' } } },
    'assistant-node': { parent: 'user-node', message: { id: 'assistant', author: { role: 'assistant' },
      status: 'finished_successfully', end_turn: true, recipient: 'all', channel: 'final',
      content: { content_type: 'text', parts: ['Answer'] } } },
  } };
}

test('conversation reconciliation requires exact branch, role and submitted user boundary', () => {
  const complete = reconcile(record(), expected, 'Answer');
  assert.equal(complete.status, 'matched_complete');
  assert.equal(complete.textMatches, true);
  assert.equal(reconcile(record(), expected, 'Temporarily stable').textMatches, false);
  for (const key of ['conversationId', 'userMessageId', 'assistantMessageId']) {
    assert.equal(reconcile(record(), { ...expected, [key]: 'unrelated' }).status, 'mismatch');
    assert.equal(reconcile(record(), { ...expected, [key]: '' }).status, 'unavailable');
  }
  const branch = record();
  branch.current_node = 'user-node';
  assert.equal(reconcile(branch, expected).reason, 'assistant_not_on_current_branch');
  branch.current_node = 'new-answer';
  branch.mapping['new-answer'] = { parent: 'assistant-node', message: { id: 'new', author: { role: 'assistant' } } };
  assert.equal(reconcile(branch, expected).reason, 'superseded_message');
});

test('unfinished, tool and reasoning messages never supply final-message evidence', () => {
  for (const patch of [{ status: 'in_progress' }, { end_turn: false }, { recipient: 'python' }, { channel: 'analysis' }]) {
    const data = record();
    Object.assign(data.mapping['assistant-node'].message, patch);
    assert.equal(reconcile(data, expected).status, 'matched_incomplete');
  }
  const malformed = record();
  delete malformed.mapping['assistant-node'].message.end_turn;
  assert.equal(reconcile(malformed, expected).status, 'unavailable');
  malformed.mapping.root.parent = 'assistant-node';
  assert.equal(reconcile(malformed, expected).reason, 'invalid_branch');
  assert.equal(reconcile({}, expected).status, 'unavailable');
  const duplicate = record();
  duplicate.mapping.root.message = { id: 'assistant' };
  assert.equal(reconcile(duplicate, expected).status, 'unavailable');
});

test('authenticated read stays same-origin and returns no credentials or conversation bodies', async () => {
  const calls = [];
  const response = await read(expected, 'Answer', { url, fetch: async (target, options) => {
    calls.push({ target, options });
    if (calls.length === 1) return new Response('', { status: 401 });
    if (calls.length === 2) return Response.json({ accessToken: 'PRIVATE_TOKEN' });
    return Response.json(record());
  } });
  assert.equal(response.status, 'matched_complete');
  assert.deepEqual(calls.map((call) => call.target), [
    'https://chatgpt.com/backend-api/conversation/conversation',
    'https://chatgpt.com/api/auth/session',
    'https://chatgpt.com/backend-api/conversation/conversation',
  ]);
  for (const call of calls) {
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.credentials, 'include');
    assert.equal(call.options.redirect, 'error');
  }
  assert.equal(calls[2].options.headers.Authorization, 'Bearer PRIVATE_TOKEN');
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE_TOKEN|Answer|mapping/);
});

test('endpoint failure, schema drift and absent identities degrade to unavailable evidence', async () => {
  for (const fetch of [
    async () => new Response('', { status: 403 }),
    async () => Response.json({ newSchema: true }),
    async () => { throw new Error('network failed PRIVATE_TOKEN'); },
  ]) {
    const response = await read(expected, 'Answer', { url, fetch });
    assert.equal(response.status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE_TOKEN/);
  }
  let calls = 0;
  const fetch = async () => { calls += 1; throw new Error('must not fetch'); };
  await read(expected, '', { url: 'https://example.com/c/conversation', fetch });
  await read(expected, '', { url: 'https://chatgpt.com/c/other', fetch });
  await read({ ...expected, userMessageId: '' }, '', { url, fetch });
  assert.equal((await read(null, '', { url, fetch })).status, 'unavailable');
  assert.equal(calls, 0);
});

test('navigation and cancellation invalidate a pending record read', async () => {
  const location = new URL(url);
  const sandbox = vm.createContext({ URL, location, AbortController, setTimeout, clearTimeout,
    fetch: async () => { location.href = 'https://chatgpt.com/c/other'; return Response.json(record()); } });
  vm.runInContext(await fs.readFile('tools/chrome-bridge-extension/content/conversationReconciliation.js', 'utf8'), sandbox);
  assert.equal((await sandbox.ChatGptConversationReconciliation.read(expected, 'Answer')).reason, 'page_conversation_changed');
  const controller = new AbortController();
  controller.abort();
  const cancelled = await read(expected, 'Answer', { url, signal: controller.signal, fetch: async (_url, options) => {
    assert.equal(options.signal.aborted, true);
    throw new Error('aborted');
  } });
  assert.equal(cancelled.status, 'unavailable');
});

test('DOM recovery is unchanged by default and optional evidence survives server projection', async () => {
  const sent = [];
  let fetches = 0;
  const sandbox = vm.createContext({ location: new URL(url), document: { title: 'Chat' }, URL, AbortController,
    setTimeout, clearTimeout, fetch: async () => { fetches += 1; return new Response('', { status: 403 }); } });
  for (const file of ['conversationReconciliation', 'responseRecovery']) {
    vm.runInContext(await fs.readFile(`tools/chrome-bridge-extension/content/${file}.js`, 'utf8'), sandbox);
  }
  const snapshot = { answer: 'DOM answer', messageId: 'assistant', artifacts: [] };
  const api = sandbox.ChatGptResponseRecovery.createResponseRecovery({
    readRecentAssistantSnapshots: () => [snapshot], getCurrentSession: () => ({ id: 'conversation' }),
    normalizeText: (value) => value, diagnostic() {}, send: (payload) => sent.push(payload),
  });
  await api.handleResponseRecoverLatest({ commandId: 'default' });
  assert.equal(fetches, 0);
  assert.equal(sent[0].answer, 'DOM answer');
  await api.handleResponseRecoverLatest({ commandId: 'opt-in', reconcileConversation: expected });
  assert.equal(fetches, 1);
  assert.equal(sent[1].answer, 'DOM answer');
  assert.equal(sent[1].reconciliation.status, 'unavailable');
  const bridge = new BridgeOperations({ artifacts: new Map(), sendCommand: async (type, payload) => {
    assert.equal(type, 'response.recover.latest');
    assert.deepEqual(payload.reconcileConversation, expected);
    return sent[1];
  } });
  const recovered = await bridge.recoverLatestResponse({ reconcileConversation: expected });
  assert.equal(recovered.reconciliation.status, 'unavailable');
  assert.equal(recovered.answer, 'DOM answer');
});
