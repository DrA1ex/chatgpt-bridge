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

test('exported reconciler fails closed with absent expected identities', () => {
  for (const value of [null, undefined]) {
    assert.deepEqual(reconcile(record(), value), {
      source: 'conversation-record', version: 1, status: 'unavailable', reason: 'missing_identity',
      conversationId: '', userMessageId: '', assistantMessageId: '',
    });
  }
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
  assert.equal(cancelled.reason, 'cancelled');
});

for (const first of ['cancelled', 'timeout']) {
  test(`pending reconciliation reports ${first} when it aborts first`, async () => {
    let expire;
    let cleared = false;
    const controller = new AbortController();
    const sandbox = vm.createContext({ URL, AbortController,
      setTimeout(callback, ms) { assert.equal(ms, 4000); expire = callback; return 1; },
      clearTimeout(timer) { assert.equal(timer, 1); cleared = true; },
      fetch: async (_url, { signal }) => {
        if (first === 'cancelled') { controller.abort('caller reason'); expire(); }
        else { expire(); controller.abort('caller reason'); }
        signal.throwIfAborted();
      },
    });
    vm.runInContext(await fs.readFile('tools/chrome-bridge-extension/content/conversationReconciliation.js', 'utf8'), sandbox);
    const result = await sandbox.ChatGptConversationReconciliation.read(expected, 'Answer', { url, signal: controller.signal });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, first);
    assert.equal(cleared, true);
  });
}

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

  const differentAssistant = { ...expected, assistantMessageId: 'expected-assistant' };
  await api.handleResponseRecoverLatest({ commandId: 'mismatch', reconcileConversation: differentAssistant });
  assert.equal(fetches, 1, 'local identity mismatch must not fetch the record');
  assert.deepEqual(JSON.parse(JSON.stringify(sent[2].reconciliation)), {
    source: 'conversation-record', version: 1, status: 'mismatch', reason: 'observed_assistant_identity',
    ...differentAssistant,
  });
});

test('history import projects only visible text on the selected branch', async () => {
  const data = record();
  data.mapping['user-node'].message.content = { content_type: 'multimodal_text', parts: ['Question', { asset_pointer: 'private' }] };
  data.mapping.root.message = { id: 'hidden', author: { role: 'user' }, metadata: { is_visually_hidden_from_conversation: true }, content: { content_type: 'text', parts: ['hidden'] } };
  data.mapping.alternate = { parent: 'user-node', message: { id: 'alternate', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['alternate'] } } };
  const expectedMessages = [{ id: 'user', role: 'user', text: 'Question' }, { id: 'assistant', role: 'assistant', text: 'Answer' }];
  const { readHistory, projectHistory } = globalThis.ChatGptConversationReconciliation;
  assert.deepEqual(projectHistory(data, 'conversation'), expectedMessages);
  const history = await readHistory('conversation', { url, fetch: async () => Response.json(data) });
  assert.deepEqual(history.messages, expectedMessages);
  assert.equal(projectHistory(data, 'wrong'), null);
  data.mapping.root.parent = 'assistant-node';
  assert.equal(projectHistory(data, 'conversation'), null);
});

test('history read retries cookie-only 404 with local authorization without navigating', async () => {
  const { readHistory } = globalThis.ChatGptConversationReconciliation;
  const calls = [];
  const result = await readHistory('conversation', {
    url: 'https://chatgpt.com/c/another-chat',
    fetch: async (target, options) => {
      calls.push({ target, options });
      if (calls.length === 1) return new Response('', { status: 404 });
      if (calls.length === 2) return Response.json({ accessToken: 'PRIVATE_TOKEN' });
      return Response.json(record());
    },
  });
  assert.equal(result.status, 'available');
  assert.equal(result.initialStatus, 404);
  assert.equal(result.authRetry, true);
  assert.equal(calls[2].options.headers.Authorization, 'Bearer PRIVATE_TOKEN');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|mapping/);
  assert.equal(calls[0].target, 'https://chatgpt.com/backend-api/conversation/conversation');
});

test('history recovery accepts a generating chat and falls back to its visible messages on 404', async () => {
  const sent = [];
  const diagnostics = [];
  const sandbox = vm.createContext({
    location: new URL(url), document: { title: 'Chat' }, URL, AbortController, setTimeout, clearTimeout,
    fetch: async (target) => target.endsWith('/api/auth/session')
      ? Response.json({ accessToken: 'PRIVATE_TOKEN' }) : new Response('', { status: 404 }),
  });
  for (const file of ['conversationReconciliation', 'responseRecovery']) {
    vm.runInContext(await fs.readFile(`tools/chrome-bridge-extension/content/${file}.js`, 'utf8'), sandbox);
  }
  const api = sandbox.ChatGptResponseRecovery.createResponseRecovery({
    getCurrentSession: () => ({ id: 'conversation' }), isGenerating: () => true,
    readVisibleHistory: () => [{ id: 'user', role: 'user', text: 'Question' }],
    diagnostic: (name, data) => diagnostics.push({ name, data }),
    send: (payload) => sent.push(payload),
  });
  await api.handleResponseRecoverList({ commandId: 'import', historySessionId: 'conversation' });
  assert.equal(sent[0].history.status, 'available');
  assert.equal(sent[0].history.source, 'visible-dom');
  assert.equal(sent[0].history.partial, true);
  assert.equal(sent[0].sourceGenerating, true);
  assert.equal(sent[0].history.messages[0].text, 'Question');
  assert.equal(diagnostics[0].data.reason, 'http_404');
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_TOKEN|Question/);
});

test('history timeout retains the HTTP stage and status', async () => {
  const sandbox = vm.createContext({ URL, AbortController,
    setTimeout(callback, ms) { assert.equal(ms, 10000); sandbox.expire = callback; return 1; },
    clearTimeout() {},
    fetch: async (target, options) => {
      if (target.endsWith('/conversation')) return new Response('', { status: 404 });
      sandbox.expire();
      options.signal.throwIfAborted();
    },
  });
  vm.runInContext(await fs.readFile('tools/chrome-bridge-extension/content/conversationReconciliation.js', 'utf8'), sandbox);
  const result = await sandbox.ChatGptConversationReconciliation.readHistory('conversation', { url });
  assert.equal(result.reason, 'timeout');
  assert.equal(result.initialStatus, 404);
  assert.equal(result.stage, 'auth_session');
  assert.equal(typeof result.elapsedMs, 'number');
});

test('canonical history excludes intermediate non-final assistant messages', () => {
  const data = record();
  data.mapping['assistant-node'].message.end_turn = false;
  assert.deepEqual(globalThis.ChatGptConversationReconciliation.projectHistory(data, 'conversation'), [
    { id: 'user', role: 'user', text: 'Question' },
  ]);
});
