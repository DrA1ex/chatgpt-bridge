import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MetadataStore } from '../src/metadataStore.js';
import { TurnManager } from '../src/turnManager.js';
import { CodexRpcServer } from '../src/codexRpcServer.js';

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

  await new Promise((resolve) => setTimeout(resolve, 80));
  const completed = await manager.getTurn(turn.id);
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
