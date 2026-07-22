import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RemoteBrowserBridge } from '../src/workflow/remoteBrowserBridge.js';

function sseEvent(event, payload, id = '') {
  return `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function waitFor(check, timeoutMs = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for remote bridge test condition');
}

test('fresh latest-mode cursor skips retained turns that predate workflow binding', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-latest-cursor-'));
  const cursorPath = path.join(root, 'cursor.json');
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(new URL(url));
    const body = [
      sseEvent('ready', { serverInstanceId: 'server-1', streamEpoch: 'stream-1', retainedFromSequence: 1, latestSequence: 5 }),
      sseEvent('observed_turn', { streamEpoch: 'stream-1', sequence: 1, turn: { turnKey: 'stale-turn' } }, 'stream-1:1'),
      sseEvent('observed_turn', { streamEpoch: 'stream-1', sequence: 6, turn: { turnKey: 'new-turn' } }, 'stream-1:6'),
    ].join('');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const bridge = new RemoteBrowserBridge({
    baseUrl: 'http://upstream.invalid',
    fetchImpl,
    cursorPath,
    reconnectDelayMs: 100,
    initialCursorMode: 'latest',
  });
  const received = [];
  const unsubscribe = bridge.onObservedTurn(async (turn) => { received.push(turn.turnKey); });
  try {
    await waitFor(() => received.length === 1);
    assert.deepEqual(received, ['new-turn']);
    assert.equal(requests[0].searchParams.get('after'), '0');
    assert.equal(bridge.health().lastSequence, 6);
    const persisted = JSON.parse(await fs.readFile(cursorPath, 'utf8'));
    assert.equal(persisted.lastSequence, 6);
  } finally {
    unsubscribe();
    await bridge.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('latest-mode cursor preserves a persisted worker cursor instead of jumping to the current tail', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-restored-cursor-'));
  const cursorPath = path.join(root, 'cursor.json');
  await fs.writeFile(cursorPath, `${JSON.stringify({
    upstreamServerInstanceId: 'server-1',
    streamEpoch: 'stream-1',
    lastSequence: 3,
    lastEnqueuedEventId: 'stream-1:3',
    blocked: false,
    streamGap: null,
    connectionState: 'disconnected',
  }, null, 2)}\n`);
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(new URL(url));
    const body = [
      sseEvent('ready', { serverInstanceId: 'server-1', streamEpoch: 'stream-1', retainedFromSequence: 1, latestSequence: 8 }),
      sseEvent('observed_turn', { streamEpoch: 'stream-1', sequence: 4, turn: { turnKey: 'resumed-turn' } }, 'stream-1:4'),
    ].join('');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const bridge = new RemoteBrowserBridge({
    baseUrl: 'http://upstream.invalid',
    fetchImpl,
    cursorPath,
    reconnectDelayMs: 100,
    initialCursorMode: 'latest',
  });
  const received = [];
  const unsubscribe = bridge.onObservedTurn(async (turn) => { received.push(turn.turnKey); });
  try {
    await waitFor(() => received.length === 1);
    assert.deepEqual(received, ['resumed-turn']);
    assert.equal(requests[0].searchParams.get('after'), '3');
    assert.equal(bridge.health().cursorWasRestored, true);
    assert.equal(bridge.health().lastSequence, 4);
  } finally {
    unsubscribe();
    await bridge.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
