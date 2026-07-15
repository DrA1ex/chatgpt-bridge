import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { openPublicTurnEventStream } from '../scripts/e2e/public-turn-stream.js';
import { REASONING_PROGRESS_PERCENTAGES, validatePublicReasoningStream } from '../scripts/e2e/reasoning-support.js';
import { streamTurnEvents } from '../src/http/publicTurnStream.js';

function record(event, type, data, sequence, receivedAtMs) {
  return {
    event,
    sequence,
    receivedAtMs,
    receivedAt: new Date(receivedAtMs).toISOString(),
    data: event === 'event' ? { type, time: new Date(receivedAtMs).toISOString(), data } : data,
  };
}

test('public reasoning stream requires ordered live checkpoints and completion wrappers', () => {
  const records = [record('ready', '', { listening: true }, 1, 1_000)];
  let sequence = 1;
  for (const percentage of REASONING_PROGRESS_PERCENTAGES) {
    records.push(record('event', 'item/progress/snapshot', {
      logicalId: `progress-${percentage}`,
      kind: 'progress',
      text: `${percentage}%`,
      revision: 1,
      status: 'in_progress',
    }, ++sequence, 2_000 + percentage * 100));
  }
  for (const percentage of REASONING_PROGRESS_PERCENTAGES) {
    records.push(record('event', 'item/progress/completed', {
      logicalId: `progress-${percentage}`,
      kind: 'progress',
      text: `${percentage}%`,
      revision: 1,
      status: 'completed',
    }, ++sequence, 13_500 + percentage));
  }
  records.push(record('event', 'item/agentMessage/completed', { text: 'final' }, ++sequence, 15_000));
  records.push(record('event', 'turn/completed', {}, ++sequence, 15_100));
  records.push(record('done', '', {}, ++sequence, 15_200));

  const result = validatePublicReasoningStream(records);
  assert.deepEqual(result.failures, []);
  assert.equal(result.firstByPercentage['0'].sequence < result.firstByPercentage['100'].sequence, true);
  assert.equal(result.spreadMs >= 500, true);
});

test('public reasoning stream rejects checkpoints replayed as one late batch', () => {
  const records = [record('ready', '', { listening: true }, 1, 1_000)];
  let sequence = 1;
  const text = REASONING_PROGRESS_PERCENTAGES.map((value) => `${value}%`).join('\n');
  records.push(record('event', 'item/progress/snapshot', { logicalId: 'all', text }, ++sequence, 5_000));
  records.push(record('event', 'item/progress/completed', { logicalId: 'all', text }, ++sequence, 5_001));
  records.push(record('event', 'item/agentMessage/completed', {}, ++sequence, 5_002));
  records.push(record('event', 'turn/completed', {}, ++sequence, 5_003));
  const result = validatePublicReasoningStream(records);
  assert.match(result.failures.join('\n'), /not delivered as a later stream update|late batch|distinct receive times/);
});

test('turn SSE can subscribe before the turn exists and receives live terminal events', async () => {
  class FakeTurnManager extends EventEmitter {
    async getTurnEvents() { return []; }
    async getTurn() { return null; }
  }
  const manager = new FakeTurnManager();
  const app = express();
  app.get('/turns/:id/events', (req, res) => streamTurnEvents(req, res, manager, req.params.id, { allowMissing: true }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const capture = openPublicTurnEventStream({ baseUrl, apiToken: '' }, 'turn-precreated');
  try {
    await capture.waitReady();
    manager.emit('turn:turn-precreated', { type: 'item/progress/snapshot', data: { logicalId: 'p0', text: '0%' } });
    manager.emit('turn:turn-precreated', { type: 'turn/completed', data: {} });
    await capture.waitDone();
    assert.deepEqual(capture.records.map((item) => item.event), ['ready', 'event', 'event', 'done']);
  } finally {
    capture.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
