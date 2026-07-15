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
