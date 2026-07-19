import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { FileStore } from '../src/fileStore.js';
import { RemoteBrowserBridge } from '../src/workflow/remoteBrowserBridge.js';
import { initSse, writeNamedSse } from '../src/http/eventStreams.js';

test('RemoteBrowserBridge consumes observed turns and imports upstream artifacts', async () => {
  const app = express();
  app.use(express.json());
  const clients = new Set();
  app.get('/browser/observed-turns/stream', (_req, res) => {
    initSse(res);
    clients.add(res);
    writeNamedSse(res, 'ready', { listening: true });
    res.on('close', () => clients.delete(res));
  });
  app.post('/browser/passive-prompt', (req, res) => res.json({ ok: true, result: { submittedUserTurnKey: 'user-1', message: req.body.message } }));
  app.get('/artifacts/:id/download', (req, res) => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="project.zip"');
    res.end(Buffer.from('PK\x03\x04remote-artifact', 'binary'));
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-workflow-bridge-'));
  const fileStore = new FileStore(root);
  const bridge = new RemoteBrowserBridge({ baseUrl: `http://127.0.0.1:${server.address().port}`, fileStore });
  let observed = null;
  const unsubscribe = bridge.onObservedTurn((turn) => { observed = turn; });
  try {
    await bridge.waitUntilConnected();
    for (const res of clients) {
      res.write('id: 1\n');
      writeNamedSse(res, 'observed_turn', { sequence: 1, turn: { turnKey: 'assistant-1', answer: 'done', artifacts: [] } });
    }
    for (let index = 0; index < 50 && !observed; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(observed?.turnKey, 'assistant-1');
    const prompt = await bridge.submitPassivePrompt({ message: 'hello' });
    assert.equal(prompt.submittedUserTurnKey, 'user-1');
    const artifact = await bridge.fetchArtifact('artifact-1');
    assert.equal(artifact.name, 'project.zip');
    const readable = await fileStore.getReadable(artifact.id);
    assert.equal((await fs.readFile(readable.absolutePath)).subarray(0, 4).toString('binary'), 'PK\x03\x04');
  } finally {
    unsubscribe();
    await bridge.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('RemoteBrowserBridge persists upstream identity and blocks on a retained-stream gap until explicit resync', async () => {
  const app = express();
  let streamRequests = 0;
  const requestedCursors = [];
  app.get('/browser/observed-turns/stream', (req, res) => {
    streamRequests += 1;
    requestedCursors.push({ after: Number(req.query.after) || 0, epoch: String(req.query.epoch || '') });
    initSse(res);
    writeNamedSse(res, 'ready', {
      listening: true,
      serverInstanceId: 'upstream-server-2',
      streamEpoch: 'stream-2',
      retainedFromSequence: 12,
      latestSequence: 20,
    });
    if (streamRequests === 1) {
      writeNamedSse(res, 'stream.gap', {
        status: 'gap',
        serverInstanceId: 'upstream-server-2',
        streamEpoch: 'stream-2',
        afterSequence: 3,
        retainedFromSequence: 12,
        latestSequence: 20,
      });
      res.end();
      return;
    }
    res.on('close', () => {});
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-workflow-gap-'));
  const cursorPath = path.join(root, 'cursor.json');
  const bridge = new RemoteBrowserBridge({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    cursorPath,
    reconnectDelayMs: 100,
  });
  let gap = null;
  const unsubscribeGap = bridge.onStreamGap((value) => { gap = value; });
  const unsubscribeTurn = bridge.onObservedTurn(async () => {});
  try {
    for (let index = 0; index < 100 && !gap; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(gap?.retainedFromSequence, 12);
    assert.equal(bridge.health().blocked, true);
    assert.equal(bridge.health().upstreamServerInstanceId, 'upstream-server-2');
    const persisted = JSON.parse(await fs.readFile(cursorPath, 'utf8'));
    assert.equal(persisted.blocked, true);
    assert.equal(persisted.upstreamServerInstanceId, 'upstream-server-2');
    assert.equal(await bridge.resyncFromRetained(), true);
    for (let index = 0; index < 100 && streamRequests < 2; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(streamRequests >= 2);
    assert.deepEqual(requestedCursors[1], { after: 11, epoch: 'stream-2' });
    assert.equal(bridge.health().blocked, false);
  } finally {
    unsubscribeTurn();
    unsubscribeGap();
    await bridge.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('RemoteBrowserBridge advances its durable cursor only after every listener durably accepts the turn', async () => {
  const app = express();
  let requests = 0;
  app.get('/browser/observed-turns/stream', (_req, res) => {
    requests += 1;
    initSse(res);
    writeNamedSse(res, 'ready', { serverInstanceId: 'server-durable', streamEpoch: 'stream-durable' });
    res.write('id: stream-durable:1\n');
    writeNamedSse(res, 'observed_turn', {
      streamEpoch: 'stream-durable', sequence: 1,
      turn: { turnKey: 'assistant-durable', answer: 'done', artifacts: [] },
    });
    res.end();
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-workflow-durable-cursor-'));
  const cursorPath = path.join(root, 'cursor.json');
  const bridge = new RemoteBrowserBridge({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    cursorPath,
    reconnectDelayMs: 100,
  });
  let deliveries = 0;
  const unsubscribe = bridge.onObservedTurn(async () => {
    deliveries += 1;
    if (deliveries === 1) throw new Error('durable enqueue failed');
  });
  try {
    for (let index = 0; index < 300 && deliveries < 2; index += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(requests >= 2, 'failed enqueue must reconnect and request the same cursor again');
    assert.equal(deliveries, 2);
    for (let index = 0; index < 100 && bridge.health().lastSequence !== 1; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(bridge.health().lastSequence, 1);
    assert.equal(bridge.health().lastEnqueuedEventId, 'stream-durable:1');
    const persisted = JSON.parse(await fs.readFile(cursorPath, 'utf8'));
    assert.equal(persisted.lastSequence, 1);
    assert.equal(persisted.lastEnqueuedEventId, 'stream-durable:1');
  } finally {
    unsubscribe();
    await bridge.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('RemoteBrowserBridge accepts a restarted upstream sequence only after a new stream epoch', async () => {
  const app = express();
  let requests = 0;
  app.get('/browser/observed-turns/stream', (_req, res) => {
    requests += 1;
    const epoch = requests === 1 ? 'stream-before-restart' : 'stream-after-restart';
    const sequence = requests === 1 ? 7 : 1;
    initSse(res);
    writeNamedSse(res, 'ready', { serverInstanceId: `server-${requests}`, streamEpoch: epoch });
    res.write(`id: ${epoch}:${sequence}\n`);
    writeNamedSse(res, 'observed_turn', {
      streamEpoch: epoch, sequence,
      turn: { turnKey: `assistant-${sequence}-${requests}`, answer: epoch, artifacts: [] },
    });
    res.end();
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bridge = new RemoteBrowserBridge({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    reconnectDelayMs: 100,
  });
  const received = [];
  const unsubscribe = bridge.onObservedTurn(async (turn, cursor) => { received.push({ turn, cursor }); });
  try {
    for (let index = 0; index < 100 && received.length < 2; index += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received.length, 2);
    assert.deepEqual(received.map((entry) => [entry.cursor.streamEpoch, entry.cursor.sequence]), [
      ['stream-before-restart', 7],
      ['stream-after-restart', 1],
    ]);
    assert.equal(bridge.health().streamEpoch, 'stream-after-restart');
    assert.equal(bridge.health().lastSequence, 1);
    assert.equal(received[1].cursor.serverInstanceId, 'server-2');
  } finally {
    unsubscribe();
    await bridge.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
