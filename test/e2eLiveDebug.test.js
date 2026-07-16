import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../scripts/e2e/cli.js';
import { shouldLogLiveDebugEvent, startLiveDebugTrace } from '../scripts/e2e/live-debug.js';

test('real E2E verbose diagnostics are opt-in', () => {
  assert.equal(parseArgs([]).verbose, false);
  assert.equal(parseArgs(['--verbose']).verbose, true);
});

test('default live output hides only known high-frequency diagnostics', () => {
  const progress = { data: { name: 'request.progress' } };
  assert.equal(shouldLogLiveDebugEvent(progress, ['info', 'browser', 'progress', {}], false), false);
  assert.equal(shouldLogLiveDebugEvent(progress, ['info', 'browser', 'progress', {}], true), true);
  assert.equal(shouldLogLiveDebugEvent(progress, ['warn', 'browser', 'warning', {}], false), true);
  assert.equal(shouldLogLiveDebugEvent({ data: { name: 'unknown.important' } }, ['info', 'browser', 'unknown', {}], false), true);
});


test('quiet live output still archives the complete raw browser stream', async () => {
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-live-debug-'));
  const previousFetch = globalThis.fetch;
  const event = { type: 'diagnostic', data: { name: 'request.progress', requestId: 'request-1', phase: 'thinking' } };
  const logs = [];
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify(event)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  try {
    const trace = await startLiveDebugTrace({
      apiToken: '',
      baseUrl: 'http://127.0.0.1:1',
      reportDir,
      verbose: false,
    }, (...args) => logs.push(args));
    await trace.stop();

    const raw = await fs.readFile(trace.rawPath, 'utf8');
    assert.match(raw, /"name":"request\.progress"/);
    assert.equal(logs.some(([, , message]) => message === 'Browser request progress updated'), false);
  } finally {
    globalThis.fetch = previousFetch;
    await fs.rm(reportDir, { recursive: true, force: true });
  }
});
