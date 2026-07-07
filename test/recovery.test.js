import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TampermonkeyBridge } from '../src/tampermonkeyBridge.js';

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
  const bridge = new TampermonkeyBridge(hub);
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
  const bridge = new TampermonkeyBridge(hub);
  const responses = await bridge.recoverResponses({ requestId: 'turn-2', limit: 2, timeoutMs: 1000 });

  assert.equal(responses.length, 2);
  assert.equal(responses[0].answer, 'Latest');
  assert.equal(responses[0].candidateIndex, 1);
  assert.equal(responses[1].artifacts[0].requestId, 'turn-2');
});
