import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserBridge } from '../src/browserBridge.js';
import { MetadataStore } from '../src/metadataStore.js';
import { TurnManager } from '../src/turnManager.js';

class FakeHub extends EventEmitter {
  constructor(response) {
    super();
    this.response = response;
    this.activeClient = { id: 'client-1' };
    this.clients = [{ id: 'client-1', ready: true }];
    this.selectedClientId = 'client-1';
    this.needsSelection = false;
    this.debugEvents = [];
  }

  sendToActive(payload) {
    setImmediate(() => {
      this.emit('client.message', {
        clientId: 'client-1',
        payload: { ...this.response, commandId: payload.commandId },
      });
    });
    return this.activeClient;
  }
}

test('recoverLatestResponse reads latest visible assistant response through command channel', async () => {
  const hub = new FakeHub({
    type: 'response.recovered',
    answer: 'Recovered answer',
    thinking: 'Recovered thinking',
    artifacts: [{ id: 'artifact-1', name: 'project.zip', mime: 'application/zip' }],
    session: { id: 'session-1', title: 'Session' },
    url: 'https://chatgpt.com/c/session-1',
    title: 'Session',
    source: 'latest-assistant-turn',
  });
  const bridge = new BrowserBridge(hub);
  const response = await bridge.recoverLatestResponse({ requestId: 'turn-1', timeoutMs: 1000 });

  assert.equal(response.answer, 'Recovered answer');
  assert.equal(response.thinking, 'Recovered thinking');
  assert.equal(response.artifacts.length, 1);
  assert.equal(response.artifacts[0].requestId, 'turn-1');
  assert.equal(response.finishReason, 'recovered');
  assert.equal(response.session.id, 'session-1');
});

test('recoverResponses lists recent assistant candidates and preserves index', async () => {
  const hub = new FakeHub({
    type: 'response.recovered.list',
    candidates: [
      { answer: 'Latest', artifacts: [], candidateIndex: 1, turnIndex: 10 },
      { answer: 'Previous', artifacts: [{ id: 'a2', name: 'result.zip' }], candidateIndex: 2, turnIndex: 8 },
    ],
    session: { id: 'session-1' },
    url: 'https://chatgpt.com/c/session-1',
    title: 'Session',
  });
  const bridge = new BrowserBridge(hub);
  const responses = await bridge.recoverResponses({ requestId: 'turn-2', limit: 2, timeoutMs: 1000 });

  assert.equal(responses.length, 2);
  assert.equal(responses[0].answer, 'Latest');
  assert.equal(responses[0].candidateIndex, 1);
  assert.equal(responses[1].artifacts[0].requestId, 'turn-2');
});

test('TurnManager can adopt a visible recovery candidate when no local turn exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-recovery-adopt-'));
  const metadataStore = new MetadataStore(dir);
  await metadataStore.ready;

  const bridge = {
    async recoverLatestResponse(options = {}) {
      assert.equal(options.index, 1);
      assert.match(options.requestId, /^turn_/);
      return {
        requestId: options.requestId,
        answer: 'Recovered visible answer',
        thinking: 'Recovered visible thinking',
        artifacts: [{ id: 'artifact-visible', name: 'result.zip', mime: 'application/zip' }],
        session: { id: 'session-visible' },
        source: 'latest-assistant-turn',
      };
    },
  };
  const resultResolver = {
    async resolve(operation, response) {
      assert.equal(operation.id, response.requestId);
      assert.equal(operation.request.output.expected, 'zip');
      assert.equal(operation.request.output.required, true);
      return { type: 'zip', fileId: 'file-visible', name: 'result.zip', size: 123, answer: response.answer, artifacts: response.artifacts };
    },
  };
  const manager = new TurnManager({ bridge, metadataStore, resultResolver });

  const turn = await manager.recoverTurnFromLatestResponse('', {
    index: 1,
    allowAdoptedTurn: true,
    cwd: dir,
    sessionId: 'session-visible',
    expectedOutput: { expected: 'zip', required: true },
    timeoutMs: 1000,
  });

  assert.equal(turn.status, 'completed');
  assert.equal(turn.output.type, 'zip');
  assert.equal(turn.output.fileId, 'file-visible');
  assert.equal(turn.input.metadata.adoptedRecovery, true);
  assert.equal(turn.input.metadata.candidateIndex, 1);

  const items = await manager.getItems({ turnId: turn.id });
  assert.ok(items.some((item) => item.type === 'user_message' && item.content.adoptedRecovery));
  assert.ok(items.some((item) => item.type === 'agent_message' && item.content.text === 'Recovered visible answer'));
});
