import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MetadataStore } from '../src/metadataStore.js';
import { TurnManager } from '../src/turnManager.js';
import { CodexRpcServer } from '../src/codexRpcServer.js';

async function waitForTurnStatus(manager, turnId, expectedStatus = 'completed', { timeoutMs = 1500, intervalMs = 25 } = {}) {
  const startedAt = Date.now();
  let turn = null;
  while (Date.now() - startedAt <= timeoutMs) {
    turn = await manager.getTurn(turnId);
    if (turn?.status === expectedStatus) return turn;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`Timed out waiting for turn ${turnId} to become ${expectedStatus}; last status: ${turn?.status || 'unknown'}`);
}

function fakeBridge() {
  return {
    async listModels() { return { models: [{ label: 'GPT Test' }], current: null }; },
    async listEfforts() { return { efforts: [{ label: 'high' }], current: null }; },
    async sendRequest(request, callbacks) {
      callbacks.onThinkingUpdate?.('thinking');
      callbacks.onAnswerUpdate?.('answer');
      callbacks.onArtifactUpdate?.([]);
      return { id: request.requestId, answer: 'answer', thinking: 'thinking', artifacts: [], session: { id: 'session_test' } };
    },
    cancelActive() { return 1; },
    async fetchArtifact() { throw new Error('not used'); },
  };
}

test('MetadataStore stores threads, turns, and items', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-meta-'));
  const store = new MetadataStore(dir);
  await store.ready;
  const thread = await store.createThread({ id: 'thread_test', title: 'Test', cwd: '/tmp/project' });
  assert.equal(thread.id, 'thread_test');

  const turn = await store.createTurn({ id: 'turn_test', threadId: thread.id, input: { message: 'hello' } });
  assert.equal(turn.threadId, thread.id);

  const item = await store.createItem({ id: 'item_test', threadId: thread.id, turnId: turn.id, type: 'user_message', content: { text: 'hello' } });
  assert.equal(item.type, 'user_message');

  assert.equal((await store.listThreads()).length, 1);
  assert.equal((await store.listTurns({ threadId: thread.id })).length, 1);
  assert.equal((await store.listItems({ turnId: turn.id })).length, 1);
});

test('TurnManager creates a queued turn and completes it through the bridge', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-turn-'));
  const metadataStore = new MetadataStore(dir);
  const manager = new TurnManager({ bridge: fakeBridge(), metadataStore, resultResolver: { async resolve(_job, response) { return { type: 'text', text: response.answer }; } } });
  const thread = await manager.createThread({ title: 'Thread' });
  const { turn } = await manager.startTurn({ threadId: thread.id, input: 'hello' });
  assert.equal(turn.status, 'queued');

  const completed = await waitForTurnStatus(manager, turn.id, 'completed');
  assert.equal(completed.status, 'completed');
  const items = await manager.getItems({ turnId: turn.id });
  assert.ok(items.some((item) => item.type === 'user_message'));
  assert.ok(items.some((item) => item.type === 'agent_message'));
});

test('CodexRpcServer supports initialize and thread/create', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-rpc-'));
  const metadataStore = new MetadataStore(dir);
  const manager = new TurnManager({ bridge: fakeBridge(), metadataStore, resultResolver: { async resolve(_job, response) { return { type: 'text', text: response.answer }; } } });
  const rpc = new CodexRpcServer({ turnManager: manager, bridge: fakeBridge(), fileStore: {}, metadataStore });

  const init = await rpc.handleMessage({ id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.capabilities.threads, true);

  const created = await rpc.handleMessage({ id: 2, method: 'thread/create', params: { title: 'RPC Thread' } }, { trusted: true });
  assert.match(created.result.thread.id, /^thread_/);
});

test('CodexRpcServer reconciles historical artifacts only from the thread session tab', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-rpc-reconcile-'));
  const metadataStore = new MetadataStore(dir);
  await metadataStore.ready;
  const thread = await metadataStore.createThread({ id: 'thread_images', title: 'Images', sessionId: 'session-images' });
  const calls = [];
  const bridge = {
    health() {
      return {
        selectedClientId: '',
        clients: [
          { id: 'tab-other', compatible: true, session: { id: 'session-other' } },
          { id: 'tab-images', compatible: true, session: { id: 'session-images' } },
        ],
      };
    },
    async recoverResponses(options) {
      calls.push(options);
      return [{ turnKey: 'assistant-image', artifacts: [{ id: 'image-one', kind: 'image' }] }];
    },
  };
  const rpc = new CodexRpcServer({
    turnManager: { getThread: (id) => metadataStore.getThread(id), on() {} },
    bridge,
    fileStore: {},
    metadataStore,
  });

  const response = await rpc.handleMessage({
    id: 1,
    method: 'thread/reconcile',
    params: { threadId: thread.id, limit: 7, timeoutMs: 9_000 },
  }, { trusted: true });

  assert.equal(response.result.available, true);
  assert.equal(response.result.sourceClientId, 'tab-images');
  assert.deepEqual(response.result.candidates[0].artifacts.map((artifact) => artifact.id), ['image-one']);
  assert.deepEqual(calls, [{ sourceClientId: 'tab-images', limit: 7, timeoutMs: 9_000 }]);
});

test('TurnManager stores final answer from done response even without answer snapshots', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-turn-final-answer-'));
  const metadataStore = new MetadataStore(dir);
  const bridge = {
    async sendRequest(request, callbacks) {
      callbacks.onArtifactUpdate?.([]);
      return { id: request.requestId, requestId: request.requestId, answer: 'final only answer', thinking: '', artifacts: [], session: { id: 'session_final' } };
    },
    cancelActive() { return 1; },
  };
  const manager = new TurnManager({ bridge, metadataStore, resultResolver: { async resolve(_job, response) { return { type: 'text', text: response.answer, answer: response.answer }; } } });
  const thread = await manager.createThread({ title: 'Thread' });
  const { turn } = await manager.startTurn({ threadId: thread.id, input: 'hello' });

  const completed = await waitForTurnStatus(manager, turn.id, 'completed');
  assert.equal(completed.status, 'completed');
  const items = await manager.getItems({ turnId: turn.id });
  const message = items.find((item) => item.type === 'agent_message');
  assert.equal(message?.content?.text, 'final only answer');
});

test('TurnManager preserves structured response blocks and multiple reasoning phases from bridge progress', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-turn-structured-'));
  const metadataStore = new MetadataStore(dir);
  const phaseA = { id: 'phase-a', key: 'phase-a', kind: 'thinking', text: 'First visible phase', revision: 2, state: 'completed', active: false, visible: false };
  const phaseBActive = { id: 'phase-b', key: 'phase-b', kind: 'thinking', text: 'Second visible phase', revision: 1, state: 'active', active: true, visible: true };
  const phaseBDone = { ...phaseBActive, revision: 2, state: 'completed', active: false, visible: false };
  const responseBlocks = [
    { index: 0, type: 'paragraph', text: 'Use `x`.', inlineCode: ['x'], markdown: 'Use `x`.' },
    { index: 1, type: 'code_block', language: 'javascript', code: 'const x = 1;', markdown: '```javascript\nconst x = 1;\n```' },
  ];
  const codeBlockDiagnostics = [{ index: 1, language: 'javascript', source: 'preceding-sibling', domContext: '<div>JavaScript</div>' }];
  const parserAudit = { version: 1, coverage: { visibleTextLeaves: 4, contentLeaves: 3, interfaceLeaves: 1, unknownLeaves: 0, unknownVisualElements: 0, duplicateLeaves: 0, classifiedLeaves: 4, coveragePercent: 100 }, unknownItems: [] };
  const bridge = {
    async sendRequest(request, callbacks) {
      callbacks.onThinkingUpdate?.('First visible phase', { type: 'thinking.snapshot' });
      callbacks.onProgressUpdate?.('', { type: 'assistant.progress.snapshot', items: [phaseA, phaseBActive] });
      callbacks.onThinkingUpdate?.('', { type: 'thinking.snapshot' });
      callbacks.onProgressUpdate?.('', { type: 'assistant.progress.snapshot', items: [phaseA, phaseBDone] });
      return {
        id: request.requestId,
        requestId: request.requestId,
        answer: 'Use `x`.\n\n```javascript\nconst x = 1;\n```',
        thinking: '',
        reasoningHistory: [phaseA, phaseBDone],
        progressItems: [phaseA, phaseBDone],
        responseBlocks,
        codeBlocks: [{ index: 1, language: 'javascript', code: 'const x = 1;', markdown: '```javascript\nconst x = 1;\n```' }],
        codeBlockDiagnostics,
        parserAudit,
        artifacts: [],
        session: { id: 'session_structured' },
        format: 'markdown',
      };
    },
    cancelActive() { return 1; },
  };
  const manager = new TurnManager({ bridge, metadataStore, resultResolver: { async resolve(_job, response) { return { type: 'text', text: response.answer }; } } });
  const thread = await manager.createThread({ title: 'Structured Thread' });
  const { turn } = await manager.startTurn({ threadId: thread.id, input: 'show structured output' });
  await waitForTurnStatus(manager, turn.id, 'completed');
  const items = await manager.getItems({ turnId: turn.id });
  const reasoning = items.filter((item) => item.type === 'reasoning');
  const message = items.find((item) => item.type === 'agent_message');
  assert.deepEqual(reasoning.map((item) => item.content.logicalId), ['phase-a', 'phase-b']);
  assert.deepEqual(reasoning.map((item) => item.content.text), ['First visible phase', 'Second visible phase']);
  assert.ok(reasoning.every((item) => item.status === 'completed'));
  assert.deepEqual(message.content.blocks, responseBlocks);
  assert.equal(message.content.codeBlocks[0].code, 'const x = 1;');
  assert.deepEqual(message.content.codeBlockDiagnostics, codeBlockDiagnostics);
  assert.deepEqual(message.content.parserAudit, parserAudit);
  assert.equal(message.content.format, 'markdown');
});

test('TurnManager serializes rapid answer snapshots into one agent message', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-turn-answer-race-'));
  const metadataStore = new MetadataStore(dir);
  await metadataStore.ready;
  const createItem = metadataStore.createItem.bind(metadataStore);
  metadataStore.createItem = async (input) => {
    if (input?.type === 'agent_message') await new Promise((resolve) => setTimeout(resolve, 20));
    return await createItem(input);
  };
  const bridge = {
    async sendRequest(request, callbacks) {
      callbacks.onAnswerUpdate?.('MODEL');
      callbacks.onAnswerUpdate?.('MODEL_EFFORT');
      callbacks.onAnswerUpdate?.('MODEL_EFFORT_OK');
      return {
        id: request.requestId,
        requestId: request.requestId,
        answer: 'MODEL_EFFORT_OK',
        thinking: '',
        artifacts: [],
        session: { id: 'session_answer_race' },
      };
    },
    cancelActive() { return 1; },
  };
  const manager = new TurnManager({
    bridge,
    metadataStore,
    resultResolver: { async resolve(_job, response) { return { type: 'text', text: response.answer }; } },
  });
  const thread = await manager.createThread({ title: 'Answer race' });
  const { turn } = await manager.startTurn({ threadId: thread.id, input: 'answer exactly' });
  await waitForTurnStatus(manager, turn.id, 'completed');
  const messages = (await manager.getItems({ turnId: turn.id })).filter((item) => item.type === 'agent_message');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].status, 'completed');
  assert.equal(messages[0].content.text, 'MODEL_EFFORT_OK');
});

test('attaching an existing chat imports its history once and sends follow-ups to the same session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-existing-chat-'));
  const metadataStore = new MetadataStore(dir);
  const calls = [];
  const bridge = {
    ...fakeBridge(),
    health: () => ({ clients: [{ id: 'tab', session: { id: 'new' }, activeRequest: { requestId: 'running-other-chat' } }] }),
    async listSessions(options) {
      assert.equal(options.sourceClientId, 'tab');
      return [{ id: 'new' }, { id: 'session_test', title: 'Existing chat' }];
    },
    async selectSession(id, options) { calls.push(['select', id, options.sourceClientId]); },
    async readConversationHistory(id, options) {
      calls.push(['history', id, options.sourceClientId]);
      return { status: 'available', source: 'conversation-record', messages: [{ id: 'u1', role: 'user', text: 'Earlier question' }, { id: 'a1', role: 'assistant', text: 'Earlier answer' }] };
    },
    async sendRequest(request, callbacks) {
      calls.push(['send', request.sessionId]);
      return fakeBridge().sendRequest(request, callbacks);
    },
  };
  const manager = new TurnManager({ bridge, metadataStore, resultResolver: { async resolve(_job, response) { return { type: 'text', text: response.answer }; } } });
  const rpc = new CodexRpcServer({ turnManager: manager, bridge, metadataStore, fileStore: {} });
  const call = (method, params) => rpc.handleMessage({ id: 1, method, params }, { trusted: true });
  const list = await call('thread/existing/list', { sourceClientId: 'tab' });
  assert.deepEqual(list.result.chats, [{ id: 'session_test', title: 'Existing chat' }]);
  const params = { sessionId: 'session_test', sourceClientId: 'tab' };
  const attached = await call('thread/attach', params);
  const threadId = attached.result.thread.id;
  assert.equal(attached.result.thread.sessionId, 'session_test');
  assert.equal(attached.result.thread.metadata.importedMessages, undefined);
  const reused = await call('thread/attach', params);
  assert.equal(reused.result.thread.id, threadId);
  assert.equal(reused.result.reused, true);
  assert.ok((await call('thread/attach', { ...params, sessionId: 'missing' })).error);
  const before = await call('thread/get', { threadId, includeItems: true });
  assert.deepEqual(before.result.items.map(item => item.content.text), ['Earlier question', 'Earlier answer']);
  assert.deepEqual(before.result.turns, []);
  assert.ok((await call('turn/start', { threadId, message: 'wrong', newSession: true })).error);
  const started = await call('turn/start', { threadId, message: 'Follow up', sourceClientId: 'tab' });
  await waitForTurnStatus(manager, started.result.turn.id);
  const after = await call('thread/get', { threadId, includeItems: true });
  assert.deepEqual(after.result.items.filter(item => ['user_message', 'agent_message'].includes(item.type)).map(item => item.content.text), ['Earlier question', 'Earlier answer', 'Follow up', 'answer']);
  assert.deepEqual(calls, [['history', 'session_test', 'tab'], ['send', 'session_test']]);
});

test('history fallback navigates only an idle tab and refreshes only the imported prefix', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-existing-fallback-'));
  const metadataStore = new MetadataStore(dir);
  let current = 'other';
  let generating = true;
  let activeRequest = { requestId: 'busy' };
  let reads = 0;
  let navigations = 0;
  const bridge = {
    ...fakeBridge(),
    health: () => ({ clients: [{ id: 'tab', session: { id: current }, activeRequest }] }),
    async listSessions() { return [{ id: 'session_test', title: 'Branch' }]; },
    async readConversationHistory() {
      reads++;
      if (current !== 'session_test') return { status: 'unavailable', reason: 'http_404', sourceGenerating: generating };
      return { status: 'available', source: 'visible-dom', partial: true, reason: 'http_404',
        messages: [{ id: 'u1', role: 'user', text: `Question ${reads}` }] };
    },
    async selectSession(id, options) {
      assert.equal(options.onlyIfIdle, true);
      navigations++;
      current = id;
    },
  };
  const manager = new TurnManager({ bridge, metadataStore, resultResolver: { async resolve(_job, response) { return { type: 'text', text: response.answer }; } } });
  const rpc = new CodexRpcServer({ turnManager: manager, bridge, metadataStore, fileStore: {} });
  const call = (method, params) => rpc.handleMessage({ id: 1, method, params }, { trusted: true });
  const params = { sessionId: 'session_test', sourceClientId: 'tab' };
  assert.match((await call('thread/attach', params)).error.message, /http_404/);
  assert.equal(navigations, 0);
  assert.equal((await metadataStore.listThreads()).length, 0);
  generating = false;
  activeRequest = null;
  const attached = await call('thread/attach', params);
  const threadId = attached.result.thread.id;
  assert.equal(navigations, 1);
  assert.equal(attached.result.thread.metadata.importedHistory.partial, true);
  assert.equal((await call('thread/attach', { ...params, refreshHistory: true })).result.refreshed, true);
  const before = await call('thread/get', { threadId, includeItems: true });
  assert.deepEqual(before.result.items.map(item => item.content.text), ['Question 4']);
  const started = await call('turn/start', { threadId, message: 'Continue', sourceClientId: 'tab' });
  await waitForTurnStatus(manager, started.result.turn.id);
  const refreshed = await call('thread/attach', { ...params, refreshHistory: true });
  assert.match(refreshed.error.message, /Cannot safely align/);
  assert.equal(reads, 5);
  assert.equal(navigations, 1);
});

test('loops on different browser clients progress independently and stop only their own request', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-parallel-loops-'));
  const metadataStore = new MetadataStore(dir);
  const calls = [];
  const aborted = [];
  const bridge = {
    ...fakeBridge(),
    async sendRequest(request, _callbacks, { signal }) {
      return await new Promise((resolve, reject) => {
        const finish = answer => {
          signal.removeEventListener('abort', abort);
          resolve({ id: request.requestId, answer, artifacts: [], session: { id: request.sessionId } });
        };
        const abort = () => {
          aborted.push(request.sourceClientId);
          reject(Object.assign(new Error(String(signal.reason || 'cancelled')), { name: 'AbortError' }));
        };
        calls.push({ request, finish });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    },
  };
  const manager = new TurnManager({ bridge, metadataStore, resultResolver: { async resolve(_job, response) { return { type: 'text', text: response.answer }; } } });
  const rpc = new CodexRpcServer({ turnManager: manager, bridge, metadataStore, fileStore: {} });
  const call = (method, params) => rpc.handleMessage({ id: 1, method, params }, { trusted: true });
  const a = await manager.createThread({ sessionId: 'session-a' });
  const b = await manager.createThread({ sessionId: 'session-b' });
  const until = async predicate => {
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Timed out waiting for independent loop progress');
  };
  const marker = entry => entry.request.message.match(/BRIDGEDONE-[a-f0-9]+/)[0];
  const loopStatus = async threadId => (await call('loop/get', { threadId })).result.loop.status;
  try {
    const first = await call('loop/start', { threadId: a.id, sourceClientId: 'tab-a', message: 'Continue A' });
    const second = await call('loop/start', { threadId: b.id, sourceClientId: 'tab-b', message: 'Continue B' });
    assert.ok(first.result?.turn.id);
    assert.ok(second.result?.turn.id);
    await until(() => calls.length === 2);
    const firstA = calls.find(entry => entry.request.sourceClientId === 'tab-a');
    const firstB = calls.find(entry => entry.request.sourceClientId === 'tab-b');
    assert.equal(firstA.request.sessionId, 'session-a');
    assert.equal(firstB.request.sessionId, 'session-b');
    assert.notEqual(marker(firstA), marker(firstB));
    firstA.finish('Work remains');
    await until(() => calls.length === 3);
    const nextA = calls[2];
    assert.equal(nextA.request.sourceClientId, 'tab-a');
    assert.equal(nextA.request.sessionId, 'session-a');
    assert.equal(nextA.request.message, firstA.request.message);
    // Duplicate notification from the completed turn must not enqueue a third A turn.
    manager.emit('notification', { method: 'turn/completed', params: { turnId: first.result.turn.id } });
    firstB.finish('Done\n' + marker(firstB));
    await until(async () => await loopStatus(b.id) === 'completed');
    assert.equal(await loopStatus(a.id), 'running');
    const stopped = await call('loop/stop', { threadId: a.id });
    assert.equal(stopped.result.loop.status, 'stopped');
    await until(() => aborted.length === 1);
    assert.deepEqual(aborted, ['tab-a']);
    assert.equal(calls.length, 3);
    assert.equal(await loopStatus(b.id), 'completed');
  } finally {
    await call('loop/stop', { threadId: a.id });
    await call('loop/stop', { threadId: b.id });
  }
});

test('canonical refresh replaces obsolete six-message DOM import, retains local items and shows external turns', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-canonical-history-'));
  const metadataStore = new MetadataStore(dir);
  const old = Array.from({ length: 6 }, (_, index) => ({
    id: 'visible:' + index, role: index % 2 ? 'assistant' : 'user', text: 'Obsolete ' + index,
  }));
  const canonical = Array.from({ length: 45 }, (_, index) => ({
    id: 'remote-' + index, role: index % 2 ? 'assistant' : 'user', text: 'Historical ' + index,
  }));
  canonical.push({ id: 'local-u', role: 'user', text: 'Follow up' },
    { id: 'local-a', role: 'assistant', text: 'Updated final answer' },
    { id: 'external-u', role: 'user', text: 'External question' },
    { id: 'external-a', role: 'assistant', text: 'External final answer' });
  let record = false;
  let live = false;
  const bridge = {
    ...fakeBridge(),
    health: () => ({ clients: [{ id: 'tab', session: { id: 'session_test' } }] }),
    async listSessions() { return [{ id: 'session_test', title: 'Existing chat' }]; },
    async readConversationHistory() {
      if (!record) return { status: 'available', source: 'visible-dom', partial: true, messages: old };
      return { status: 'available', source: 'conversation-record', partial: live, messages: live ? canonical.slice(0, -1) : canonical,
        ...(live ? { live: { generating: true, messages: [
          { id: 'external-u', role: 'user', text: 'External question' },
          { id: 'external-a', role: 'assistant', text: 'Interim answer' },
        ] } } : {}) };
    },
  };
  const manager = new TurnManager({ bridge, metadataStore, resultResolver: { async resolve(_job, response) { return { type: 'text', text: response.answer }; } } });
  const rpc = new CodexRpcServer({ turnManager: manager, bridge, metadataStore, fileStore: {} });
  const call = (method, params) => rpc.handleMessage({ id: 1, method, params }, { trusted: true });
  const attached = await call('thread/attach', { sessionId: 'session_test', sourceClientId: 'tab' });
  const threadId = attached.result.thread.id;
  const started = await call('turn/start', { threadId, message: 'Follow up', sourceClientId: 'tab' });
  await waitForTurnStatus(manager, started.result.turn.id);
  const original = await manager.getItems({ turnId: started.result.turn.id });
  record = true;
  live = true;
  assert.ok((await call('thread/history/refresh', { threadId, background: true })).result?.refreshed);
  const during = (await call('thread/get', { threadId, includeItems: true })).result;
  assert.equal(during.historyLive.generating, true);
  assert.equal(during.items.find(item => item.content?.text === 'Interim answer')?.status, 'in_progress');
  live = false;
  assert.ok((await call('thread/history/refresh', { threadId })).result?.refreshed);
  const after = (await call('thread/get', { threadId, includeItems: true })).result;
  const messages = after.items.filter(item => ['user_message', 'agent_message'].includes(item.type));
  assert.equal(messages.length, 49);
  assert.deepEqual(messages.map(item => item.content.text), canonical.map(message => message.text));
  assert.equal(after.historyLive, null);
  assert.equal(messages.find(item => item.content.text === 'Updated final answer').turnId, started.result.turn.id);
  assert.deepEqual(await manager.getItems({ turnId: started.result.turn.id }), original);
});


test('background history refresh skips local turns and release barriers but resumes when idle', async () => {
  const { ExistingChatConnector } = await import('../src/turn/existingChatConnector.js');
  const thread = { id: 'thread', sessionId: 'session', metadata: { importedChat: true } };
  let local = [{ status: 'running' }];
  const client = { id: 'tab', session: { id: 'session' }, releasePending: false };
  let reads = 0;
  const connector = new ExistingChatConnector({
    bridge: {
      health: () => ({ clients: [client] }),
      async readConversationHistory() {
        reads++;
        return { source: 'conversation-record', status: 'available', messages: [] };
      },
    },
    metadataStore: {
      async getThread() { return thread; },
      async listTurns() { return local; },
      async updateThread(_id, patch) { return Object.assign(thread, patch); },
    },
  });
  const refresh = () => connector.refresh({ threadId: thread.id, background: true });
  assert.equal((await refresh()).refreshed, false);
  assert.equal(reads, 0);
  local = [{ status: 'completed' }];
  client.releasePending = true;
  assert.equal((await refresh()).refreshed, false);
  assert.equal(reads, 0);
  client.releasePending = false;
  assert.equal((await refresh()).refreshed, true);
  assert.equal(reads, 1);
});


test('unsent local prompts remain red candidates until dismissed or explicitly retried', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-unsent-history-'));
  const metadataStore = new MetadataStore(dir);
  const remote = [{ id: 'existing-u', role: 'user', text: 'Continue' }, { id: 'existing-a', role: 'assistant', text: 'Old answer' }];
  const bridge = {
    ...fakeBridge(),
    health: () => ({ clients: [{ id: 'tab', session: { id: 'session_test' } }] }),
    async listSessions() { return [{ id: 'session_test', title: 'Existing chat' }]; },
    async readConversationHistory() { return { status: 'available', source: 'conversation-record', messages: remote }; },
    async sendRequest() { throw new Error('Browser disconnected before submit could be confirmed'); },
  };
  const manager = new TurnManager({ bridge, metadataStore, resultResolver: { async resolve(_job, response) { return { type: 'text', text: response.answer }; } } });
  const rpc = new CodexRpcServer({ turnManager: manager, bridge, metadataStore, fileStore: {} });
  const call = (method, params) => rpc.handleMessage({ id: 1, method, params }, { trusted: true });
  const threadId = (await call('thread/attach', { sessionId: 'session_test', sourceClientId: 'tab' })).result.thread.id;
  const start = () => call('turn/start', { threadId, message: 'Continue', model: 'GPT Test', effort: 'high', sourceClientId: 'tab' });
  const first = (await start()).result.turn;
  await waitForTurnStatus(manager, first.id, 'failed');
  const view = async () => (await call('thread/get', { threadId, includeItems: true })).result.items;
  const user = items => items.find(item => item.turnId === first.id && item.type === 'user_message');
  assert.equal(user(await view()).delivery.state, 'unconfirmed');
  assert.equal((await view()).filter(item => item.type === 'user_message').length, 2);
  assert.match((await call('thread/history/retry', { threadId, turnId: first.id })).error.message, /Confirm before retrying/);
  const next = (await call('thread/history/retry', { threadId, turnId: first.id, confirmUncertain: true })).result.turn;
  await waitForTurnStatus(manager, next.id, 'failed');
  assert.equal(next.input.message, first.input.message);
  assert.equal(next.input.model, first.input.model);
  assert.equal(next.input.effort, first.input.effort);
  assert.equal(next.input.sessionId, first.input.sessionId);
  assert.equal(user(await view()), undefined);
  assert.equal((await manager.getTurn(first.id)).status, 'failed');
  assert.equal((await manager.getItems({ turnId: first.id })).find(item => item.type === 'user_message').content.historyDismissed, true);
  assert.ok((await call('thread/history/dismiss', { threadId, turnId: next.id })).result.dismissed);
  await call('thread/history/refresh', { threadId });
  assert.deepEqual((await view()).filter(item => item.type === 'user_message').map(item => item.content.text), ['Continue']);
  assert.match((await call('thread/history/retry', { threadId, turnId: next.id, confirmUncertain: true })).error.message, /no longer/);
});
