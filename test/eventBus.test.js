import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/eventBus.js';

test('EventBus stores recent user/debug events and truncates sensitive payloads', () => {
  const bus = new EventBus({ limit: 2 });
  const seen = [];
  bus.on('event', (event) => seen.push(event));
  const first = bus.emitUser({ type: 'request.started', requestId: 'r1', data: { ok: true } });
  bus.emitUser({ type: 'answer.delta', requestId: 'r2', data: { delta: 'hello' } });
  bus.emitUser({ type: 'answer.delta', requestId: 'r3', data: { delta: 'world' } });
  const debug = bus.emitDebug({ type: 'artifact.chunk', data: { contentBase64: 'x'.repeat(1000), nested: { rawDom: '<div>secret</div>' } } });

  assert.equal(first.channel, 'event');
  assert.equal(seen.length, 3);
  assert.equal(bus.recentEvents(10).length, 2);
  assert.equal(bus.recentEvents(1)[0].requestId, 'r3');
  assert.equal(debug.channel, 'debug');
  assert.equal(debug.data.contentBase64, '<1000 chars>');
  assert.equal(debug.data.nested.rawDom, '<17 chars>');
  assert.equal(bus.recentDebugEvents(10).length, 1);
});

