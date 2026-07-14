import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  replayRequestTrace,
  requestTraceFromDiagnostics,
  sanitizeRequestTrace,
} from '../src/bridge/replay/requestTrace.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/request-replay', import.meta.url));

for (const name of [
  'explicit-ui-error.json',
  'required-zip-settle.json',
  'stale-observation.json',
  'conversation-changed.json',
]) {
  test(`replays canonical request trace: ${name}`, async () => {
    const trace = JSON.parse(await fs.readFile(path.join(FIXTURE_DIR, name), 'utf8'));
    const result = replayRequestTrace(trace);
    assert.equal(result.requestId, trace.requestId);
    assert.ok(result.outcomes.length >= 2);
    assert.equal(result.state.lifecycle, trace.expected.lifecycle);
    assert.equal(result.state.terminal?.code || '', trace.expected.terminalCode || '');
  });
}

test('diagnostic traces are bounded and redact sensitive fields before persistence', () => {
  const trace = requestTraceFromDiagnostics({
    state: {
      requestId: 'request-sensitive',
      lifecycle: 'failed',
      compatibilityPhase: 'failed',
      artifact: { status: 'not_expected' },
      terminal: { code: 'failed' },
    },
    history: [{
      event: {
        type: 'observation.updated',
        occurredAt: 10,
        data: {
          authorization: 'Bearer secret',
          sourceHtml: '<main>private DOM</main>',
          message: 'x'.repeat(25_000),
        },
      },
    }],
  });
  assert.equal(trace.events[0].event.data.authorization, '[redacted]');
  assert.equal(trace.events[0].event.data.sourceHtml, '[redacted]');
  assert.match(trace.events[0].event.data.message, /\[truncated\]$/);
  assert.deepEqual(sanitizeRequestTrace(trace), trace);
});
