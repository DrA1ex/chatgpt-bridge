#!/usr/bin/env node
import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import process from 'node:process';
import { streamObservedTurns } from '../../../src/http/observedTurnStream.js';
import { ObservedTurnJournal } from '../../../src/bridge/observedTurns/observedTurnJournal.js';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}

const port = Number(argValue('--port', '0')) || 0;
const artifactPath = argValue('--artifact');
const sessionId = argValue('--session', 'session-test');
const clientId = argValue('--client', 'client-test');
const token = argValue('--token');
if (!port || !artifactPath) throw new Error('workflowPrimaryProcess requires --port and --artifact');

const journal = new ObservedTurnJournal({ limit: 200 });
const bridge = {
  onObservedTurnEnvelope: (listener) => journal.onEnvelope(listener),
  listObservedTurns: (options) => journal.list(options),
  observedTurnStreamState: (options) => journal.classifyCursor(options),
};
function publish(turn) { journal.publish(turn); }

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (!token) return next();
  const auth = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
  if (auth !== token) return res.status(401).json({ detail: 'Unauthorized' });
  return next();
});
app.get('/health', (_req, res) => res.json({ ok: true, observedSequence: journal.metadata().latestSequence, observedStreamEpoch: journal.streamEpoch }));
app.get('/browser/observed-turns/stream', (req, res) => streamObservedTurns(req, res, bridge));
app.post('/browser/passive-prompt', (req, res) => {
  const submittedUserTurnKey = 'user-passive-1';
  res.json({ ok: true, result: { submittedUserTurnKey } });
  setTimeout(() => publish({
    type: 'observed.turn.terminal',
    turnKey: 'assistant-passive-1',
    submittedUserTurnKey,
    answer: 'Artifact ready',
    session: { id: sessionId, url: `https://chatgpt.com/c/${sessionId}` },
    sessionId,
    sourceClientId: clientId,
    artifacts: [{
      id: 'artifact-remote-1',
      name: 'project.zip',
      mime: 'application/zip',
      phase: 'READY',
      state: 'READY',
      downloadable: true,
      downloadActionPresent: true,
      actionLabel: 'Download project ZIP',
      sourceClientId: clientId,
      sourceTurnKey: 'assistant-passive-1',
      sessionId,
    }],
  }), 100);
});
app.get('/artifacts/:id/download', async (_req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="project.zip"');
  res.end(await fs.readFile(artifactPath));
});

const server = http.createServer(app);
server.listen(port, '127.0.0.1', () => console.log(`[workflow-primary] READY http://127.0.0.1:${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
