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


test('EventBus keeps compact request timelines without noisy dom.poll progress', () => {
  const bus = new EventBus({ limit: 10, timelineLimit: 10 });
  bus.emitUser({ type: 'request.progress', requestId: 'req-1', data: { phase: 'generating', meaningful: false, reason: 'dom.poll', answerLength: 0 } });
  bus.emitUser({ type: 'prompt.accepted', requestId: 'req-1', data: { clientId: 'client-a' } });
  bus.emitUser({ type: 'assistant.progress.snapshot', requestId: 'req-1', data: { text: 'Inspecting uploaded ZIP', progressLength: 24, sourceClientId: 'client-a' } });
  bus.emitUser({ type: 'request.done', requestId: 'req-1', data: { answerLength: 120, artifactCount: 1, sourceClientId: 'client-a' } });

  const timeline = bus.requestTimeline('req-1');
  assert.equal(timeline.some((event) => event.type === 'request.progress'), false);
  assert.deepEqual(timeline.map((event) => event.type), ['prompt.accepted', 'assistant.progress.snapshot', 'request.done']);
  assert.equal(timeline.at(-1).data.answerLength, 120);
  assert.equal(timeline.at(-1).data.artifactCount, 1);
});

test('EventBus deduplicates consecutive compact timeline events', () => {
  const bus = new EventBus({ limit: 10, timelineLimit: 10 });
  bus.emitUser({ type: 'assistant.progress.snapshot', requestId: 'req-2', data: { progressLength: 10, sourceClientId: 'client-a' } });
  bus.emitUser({ type: 'assistant.progress.snapshot', requestId: 'req-2', data: { progressLength: 10, sourceClientId: 'client-a' } });

  const timeline = bus.requestTimeline('req-2');
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].repeat, 2);
});


test('compact timeline keeps progress text and item metadata', () => {
  const bus = new EventBus({ limit: 20, timelineLimit: 10 });
  bus.emitUser({ type: 'assistant.progress.snapshot', requestId: 'req-progress', data: { text: 'Inspecting uploaded ZIP', kind: 'action_status', itemCount: 1 } });
  const timeline = bus.requestTimeline('req-progress');
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].data.text, 'Inspecting uploaded ZIP');
  assert.equal(timeline[0].data.kind, 'action_status');
  assert.equal(timeline[0].data.itemCount, 1);
});

test('EventBus emits transient live events without retaining full streaming payloads', () => {
  const bus = new EventBus({ limit: 10 });
  const seen = [];
  bus.on('event', (event) => seen.push(event));
  const emitted = bus.emitTransient({ type: 'watch.turn.snapshot', data: { answer: 'x'.repeat(20_000) } });
  assert.equal(emitted.type, 'watch.turn.snapshot');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].data.answer.length, 20_000);
  assert.equal(bus.recentEvents(10).length, 0);
});
