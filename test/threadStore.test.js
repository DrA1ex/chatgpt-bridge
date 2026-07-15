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
  assert.deepEqual(reasoning.map((item) => item.content.logicalId), ['snapshot-thinking', 'phase-b']);
  assert.deepEqual(reasoning.map((item) => item.content.text), ['First visible phase', 'Second visible phase']);
  assert.ok(reasoning.every((item) => item.status === 'completed'));
  assert.deepEqual(message.content.blocks, responseBlocks);
  assert.equal(message.content.codeBlocks[0].code, 'const x = 1;');
  assert.deepEqual(message.content.codeBlockDiagnostics, codeBlockDiagnostics);
  assert.deepEqual(message.content.parserAudit, parserAudit);
  assert.equal(message.content.format, 'markdown');
});
