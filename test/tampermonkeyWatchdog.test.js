import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

process.env.FORCED_SNAPSHOT_AFTER_MS = process.env.FORCED_SNAPSHOT_AFTER_MS || '60000';
process.env.REQUEST_WATCHDOG_INTERVAL_MS = process.env.REQUEST_WATCHDOG_INTERVAL_MS || '1000';

const { TampermonkeyBridge } = await import('../src/tampermonkeyBridge.js');

class FakeHub extends EventEmitter {
  constructor() {
    super();
    this.activeClient = { id: 'client-1', ready: true, url: 'https://chatgpt.com/source' };
    this.sent = [];
    this.readyClients = new Map([
      ['client-1', { id: 'client-1', ready: true, url: 'https://chatgpt.com/source', activeRequest: null }],
      ['client-2', { id: 'client-2', ready: true, url: 'https://chatgpt.com/other', activeRequest: null }],
    ]);
  }
  get clients() { return Array.from(this.readyClients.values()); }
  get selectedClientId() { return ''; }
  get needsSelection() { return false; }
  get debugEvents() { return []; }
  sendToActiveWithDelivery(payload) {
    this.sent.push({ clientId: this.activeClient.id, payload });
    return { client: this.activeClient, delivered: Promise.resolve() };
  }
  sendToActive(payload) {
    this.sent.push({ clientId: this.activeClient.id, payload });
    return this.activeClient;
  }
  sendToClient(clientId, payload) {
    this.sent.push({ clientId, payload });
    return this.readyClients.get(clientId) || { id: clientId, ready: true };
  }
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('forced snapshots are requested from the source client, not the active client', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);
  const events = [];

  const requestPromise = bridge.sendRequest({ message: 'long project task' }, { onEvent: (event) => events.push(event) });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'request.progress', requestId: prompt.requestId, phase: 'generating', meaningful: true, assistantTurnKey: 'assistant-source', sawGenerating: true, stopButtonVisible: true } });

  hub.activeClient = { id: 'client-2', ready: true, url: 'https://chatgpt.com/other' };
  const snapshotPromise = bridge.requestForcedSnapshot(prompt.requestId, { reason: 'test' });
  await nextTick();

  const command = hub.sent.find((entry) => entry.payload.type === 'response.snapshot.request');
  assert.ok(command, 'response.snapshot.request should be sent');
  assert.equal(command.clientId, 'client-1');
  assert.equal(command.payload.turnKey, 'assistant-source');

  hub.emit('client.message', { clientId: 'client-2', payload: { type: 'request.snapshot', commandId: command.payload.commandId, requestId: prompt.requestId, answer: 'wrong active tab', terminal: true } });
  await nextTick();
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'request.snapshot', commandId: command.payload.commandId, requestId: prompt.requestId, answer: 'right source tab', artifacts: [], turnKey: 'assistant-source', terminal: true } });

  const snapshot = await snapshotPromise;
  assert.equal(snapshot.answer, 'right source tab');
  const result = await requestPromise;
  assert.equal(result.answer, 'right source tab');
  assert.equal(result.finishReason, 'forced_snapshot');
  assert.ok(events.some((event) => event.type === 'forced_snapshot.requested'));
  assert.ok(events.some((event) => event.type === 'forced_snapshot.received'));
});

test('weak heartbeats do not count as meaningful request progress', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);

  const requestPromise = bridge.sendRequest({ message: 'heartbeat only' });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  const before = bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId)?.lastMeaningfulProgressAt;
  assert.ok(before);

  await new Promise((resolve) => setTimeout(resolve, 15));
  hub.emit('client.activity', {
    clientId: 'client-1',
    client: { id: 'client-1', ready: true, activeRequest: { requestId: prompt.requestId, phase: 'generating', sawGenerating: true } },
    payload: { type: 'pong', activeRequest: { requestId: prompt.requestId, phase: 'generating', sawGenerating: true } },
  });
  const afterHeartbeat = bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId);
  assert.equal(afterHeartbeat.lastMeaningfulProgressAt, before);
  assert.ok(afterHeartbeat.lastHeartbeatAt >= before);

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'done', requestId: prompt.requestId, answer: 'ok' } });
  const result = await requestPromise;
  assert.equal(result.answer, 'ok');
});

test('extension implements source-bound forced snapshot command', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /response\.snapshot\.request/);
  assert.match(source, /handleResponseSnapshotRequest/);
  assert.match(source, /readAssistantSnapshotByTurnKey/);
  assert.match(source, /No active request in this tab and no assistantTurnKey/);
});
