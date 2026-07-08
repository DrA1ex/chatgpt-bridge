import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TampermonkeyBridge } from '../src/tampermonkeyBridge.js';

class ResumeHub extends EventEmitter {
  constructor({ activeRequest = null } = {}) {
    super();
    this.activeClient = { id: 'client-1', activeRequest };
    this.clients = [{ id: 'client-1', ready: true, selected: true, activeRequest }];
    this.selectedClientId = 'client-1';
    this.needsSelection = false;
    this.debugEvents = [];
  }

  sendToActive(payload) {
    if (payload.type === 'request.resume') {
      setImmediate(() => {
        this.emit('client.message', {
          clientId: 'client-1',
          payload: { type: 'request.resumed', commandId: payload.commandId, activeRequest: this.activeClient.activeRequest, session: { id: 'session-1' } },
        });
        this.emit('client.message', { clientId: 'client-1', payload: { type: 'answer.snapshot', requestId: this.activeClient.activeRequest.requestId, text: 'partial answer' } });
        this.emit('client.message', { clientId: 'client-1', payload: { type: 'done', requestId: this.activeClient.activeRequest.requestId, answer: 'final answer', artifacts: [], session: { id: 'session-1' } } });
      });
      return this.activeClient;
    }
    throw new Error(`unexpected payload: ${payload.type}`);
  }

  sendToClient() {}
}

test('resumeActiveRequest attaches to browser activeRequest without sending a new prompt', async () => {
  const hub = new ResumeHub({ activeRequest: { requestId: 'turn-123', promptPreview: 'continue work' } });
  const bridge = new TampermonkeyBridge(hub);
  const events = [];
  const snapshots = [];

  const response = await bridge.resumeActiveRequest({
    onEvent: (event) => events.push(event.type),
    onAnswerUpdate: (text) => snapshots.push(text),
  }, { expectedRequestId: 'turn-123', timeoutMs: 1000 });

  assert.equal(response.requestId, 'turn-123');
  assert.equal(response.answer, 'final answer');
  assert.deepEqual(snapshots, ['partial answer']);
  assert.ok(events.includes('request.resumed'));
  assert.ok(events.includes('request.done'));
});

test('resumeActiveRequest fails clearly when selected tab has no running prompt', async () => {
  const hub = new ResumeHub({ activeRequest: null });
  const bridge = new TampermonkeyBridge(hub);
  await assert.rejects(() => bridge.resumeActiveRequest({}, { timeoutMs: 1000 }), /No active ChatGPT prompt/);
});
