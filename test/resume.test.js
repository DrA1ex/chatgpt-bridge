import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TampermonkeyBridge } from '../src/tampermonkeyBridge.js';

class ResumeHub extends EventEmitter {
  constructor({ activeRequest = null, activeClientId = 'client-1', clients = null } = {}) {
    super();
    this.activeClientId = activeClientId;
    this._clients = clients || [{ id: 'client-1', ready: true, selected: true, activeRequest }];
    this.selectedClientId = activeClientId;
    this.needsSelection = false;
    this.debugEvents = [];
    this.sent = [];
  }

  get clients() { return this._clients; }
  get activeClient() {
    return this._clients.find((client) => client.id === this.activeClientId) || null;
  }

  sendToActive(payload) {
    const client = this.activeClient;
    if (!client) throw new Error('no active client');
    return this.sendToClient(client.id, payload);
  }

  sendToClient(clientId, payload) {
    const client = this._clients.find((candidate) => candidate.id === clientId);
    if (!client) throw new Error(`unknown client ${clientId}`);
    this.sent.push({ clientId, payload });
    if (payload.type === 'request.resume') {
      setImmediate(() => {
        this.emit('client.message', {
          clientId,
          payload: { type: 'request.resumed', commandId: payload.commandId, activeRequest: client.activeRequest, session: { id: 'session-1' } },
        });
        this.emit('client.message', { clientId, payload: { type: 'answer.snapshot', requestId: client.activeRequest.requestId, text: 'partial answer' } });
        this.emit('client.message', { clientId, payload: { type: 'done', requestId: client.activeRequest.requestId, answer: 'final answer', artifacts: [], session: { id: 'session-1' } } });
      });
      return client;
    }
    throw new Error(`unexpected payload: ${payload.type}`);
  }
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

test('resumeActiveRequest finds a single running prompt outside the selected tab', async () => {
  const hub = new ResumeHub({
    activeClientId: 'client-1',
    clients: [
      { id: 'client-1', ready: true, selected: true, activeRequest: null },
      { id: 'client-2', ready: true, selected: false, activeRequest: { requestId: 'turn-remote', promptPreview: 'remote work' } },
    ],
  });
  const bridge = new TampermonkeyBridge(hub);

  const response = await bridge.resumeActiveRequest({}, { timeoutMs: 1000 });

  assert.equal(response.requestId, 'turn-remote');
  assert.equal(response.sourceClientId, 'client-2');
  assert.equal(hub.sent.find((entry) => entry.payload.type === 'request.resume')?.clientId, 'client-2');
});


test('resumeActiveRequest fails clearly when selected tab has no running prompt', async () => {
  const hub = new ResumeHub({ activeRequest: null });
  const bridge = new TampermonkeyBridge(hub);
  await assert.rejects(() => bridge.resumeActiveRequest({}, { timeoutMs: 1000 }), /No active ChatGPT prompt/);
});

test('resumeActiveRequest follows an already tracked request instead of creating a second tracker', async () => {
  const hub = new ResumeHub({ activeRequest: { requestId: 'turn-shared', promptPreview: 'shared work' } });
  const bridge = new TampermonkeyBridge(hub);
  const followerEvents = [];
  const followerSnapshots = [];

  const owner = bridge.resumeActiveRequest({}, { expectedRequestId: 'turn-shared', timeoutMs: 1000 });
  const follower = bridge.resumeActiveRequest({
    onEvent: (event) => followerEvents.push(event.type),
    onAnswerUpdate: (text) => followerSnapshots.push(text),
  }, { expectedRequestId: 'turn-shared', timeoutMs: 1000 });

  const [ownerResponse, followerResponse] = await Promise.all([owner, follower]);
  assert.equal(ownerResponse.answer, 'final answer');
  assert.equal(followerResponse.answer, 'final answer');
  assert.equal(hub.sent.filter((entry) => entry.payload.type === 'request.resume').length, 1);
  assert.ok(followerEvents.includes('request.resumed'));
  assert.ok(followerEvents.includes('request.done'));
  assert.deepEqual(followerSnapshots, ['partial answer']);
});
