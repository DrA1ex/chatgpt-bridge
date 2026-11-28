import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteBrowserBridge } from '../src/workflow/remoteBrowserBridge.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('connection timeouts remove their waiter instead of accumulating stale callbacks', async (t) => {
  const bridge = new RemoteBrowserBridge({ baseUrl: 'http://127.0.0.1:1' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = bridge.waitUntilConnected(5);
  const rejected = assert.rejects(pending, /Timed out/);
  t.mock.timers.tick(5);
  await rejected;
  assert.equal(bridge.readyWaiters.length, 0);
  await bridge.close();
});

test('close promptly rejects outstanding and future connection waits', async () => {
  const bridge = new RemoteBrowserBridge({ baseUrl: 'http://127.0.0.1:1' });
  const pending = bridge.waitUntilConnected(30_000);
  const rejected = assert.rejects(pending, /closed/);
  await bridge.close();
  await rejected;
  await assert.rejects(bridge.waitUntilConnected(), /closed/);
  assert.equal(bridge.readyWaiters.length, 0);
});

test('unsubscribing before cursor hydration completes cannot dereference a discarded controller', async () => {
  let restore;
  let fetches = 0;
  const bridge = new RemoteBrowserBridge({ baseUrl: 'http://127.0.0.1:1', fetchImpl() { fetches += 1; } });
  bridge.cursorReady = new Promise((resolve) => { restore = resolve; });
  const unsubscribe = bridge.onObservedTurn(() => {});
  unsubscribe();
  restore();
  await bridge.streamTask;
  assert.equal(fetches, 0);
  await bridge.close();
});

test('a stream gap cancels and unlocks the old reader before blocking', async () => {
  let cancelled = 0;
  let released = 0;
  const data = new TextEncoder().encode('event: stream.gap\ndata: {"streamEpoch":"epoch-1","retainedFromSequence":10,"afterSequence":1}\n\n');
  const reader = { read: async () => ({ value: data, done: false }),
    cancel: async () => { cancelled += 1; }, releaseLock: () => { released += 1; } };
  const bridge = new RemoteBrowserBridge({ baseUrl: 'http://127.0.0.1:1',
    fetchImpl: async () => ({ ok: true, body: { getReader: () => reader } }) });
  bridge.onObservedTurn(() => {});
  await bridge.streamTask;
  assert.equal(bridge.blocked, true);
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
  await bridge.close();
});

test('data returned by a reader after unsubscribe cannot advance the durable cursor', async () => {
  let deliver;
  let reads = 0;
  const reader = {
    read: () => { reads += 1; return new Promise((resolve) => { deliver = resolve; }); },
    cancel: async () => {}, releaseLock() {},
  };
  const bridge = new RemoteBrowserBridge({ baseUrl: 'http://127.0.0.1:1',
    fetchImpl: async () => ({ ok: true, body: { getReader: () => reader } }) });
  const unsubscribe = bridge.onObservedTurn(() => { throw new Error('stale delivery'); });
  await flush();
  assert.equal(reads, 1);
  unsubscribe();
  deliver({ value: new TextEncoder().encode('event: observed_turn\ndata: {"streamEpoch":"epoch-1","sequence":1,"turn":{"id":"stale"}}\n\n'), done: false });
  await bridge.streamTask;
  assert.equal(bridge.lastSequence, 0);
  await bridge.close();
});
