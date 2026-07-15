import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverBrowserAfterScenarioFailure, turnFailureDetail } from '../scripts/e2e/scenario-recovery.js';

test('turn failure detail includes stored turn error', () => {
  assert.equal(turnFailureDetail({ turn: { status: 'failed', error: { code: 'BROWSER_BUSY', message: 'Another prompt is active' } } }, 'Project turn'), 'Project turn: failed (BROWSER_BUSY: Another prompt is active)');
});

test('failed scenario reloads a busy tab before the next scenario', async () => {
  let reads = 0;
  const calls = [];
  const api = async (_options, pathname, request = {}) => {
    calls.push({ pathname, request });
    if (pathname === '/browser/tabs/reload') return { ok: true, reloading: true };
    reads += 1;
    return {
      clients: [{
        id: 'ext-1',
        pageReady: reads > 1,
        composerReady: reads > 1,
        activeRequest: reads === 1 ? { requestId: 'stale' } : null,
        tabObservation: { generation: reads === 1 ? 'active' : 'idle' },
      }],
    };
  };
  const waitUntil = async (check) => {
    for (let index = 0; index < 3; index += 1) {
      const value = await check();
      if (value) return value;
    }
    throw new Error('not ready');
  };
  const result = await recoverBrowserAfterScenarioFailure({
    options: { tabReadyTimeoutMs: 10_000 },
    sourceClientId: 'ext-1',
    scenarioId: 'passive-workflow',
    api,
    waitUntil,
    testLog: () => {},
  });
  assert.equal(result.recovered, true);
  assert(calls.some((call) => call.pathname === '/browser/tabs/reload'));
});
