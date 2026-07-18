import test from 'node:test';
import assert from 'node:assert/strict';
import { findOwnedBrowserClient, recoverBrowserAfterScenarioFailure, turnFailureDetail } from '../scripts/e2e/scenario-recovery.js';

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
        ready: true,
        pageReady: true,
        composerReady: true,
        chatMainReady: true,
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


test('failed scenario recognizes object-shaped tab observation generation state', async () => {
  let reads = 0;
  const calls = [];
  const api = async (_options, pathname, request = {}) => {
    calls.push({ pathname, request });
    if (pathname === '/browser/tabs/reload') return { ok: true, reloading: true };
    reads += 1;
    return {
      clients: [{
        id: 'ext-object-state',
        ready: true,
        pageReady: true,
        composerReady: true,
        chatMainReady: true,
        activeRequest: null,
        tabObservation: {
          generation: { state: reads === 1 ? 'active' : 'stopped' },
          output: { state: reads === 1 ? 'streaming' : 'final' },
        },
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
    sourceClientId: 'ext-object-state',
    scenarioId: 'passive-workflow',
    api,
    waitUntil,
    testLog: () => {},
  });
  assert.equal(result.recovered, true);
  assert.equal(calls.some((call) => call.pathname === '/browser/tabs/reload'), true);
});

test('failed scenario adopts a reconnected content client by stable browser tab identity', async () => {
  let reads = 0;
  const api = async (_options, pathname) => {
    assert.equal(pathname, '/browser/clients');
    reads += 1;
    return {
      clients: reads === 1 ? [] : [{
        id: 'ext-reconnected',
        browserTabId: 42,
        launchToken: 'bridge-real-e2e-run',
        ready: true,
        pageReady: true,
        composerReady: true,
        chatMainReady: true,
        activeRequest: null,
        tabObservation: { generation: { state: 'stopped' }, output: { state: 'final' } },
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
    sourceClientId: 'ext-before-reload',
    clientIdentity: {
      clientId: 'ext-before-reload',
      browserTabId: 42,
      launchToken: 'bridge-real-e2e-run',
    },
    scenarioId: 'reload-mid-request',
    api,
    waitUntil,
    testLog: () => {},
  });
  assert.equal(result.recovered, true);
  assert.equal(result.reason, 'client-reconnected');
  assert.equal(result.client.id, 'ext-reconnected');
});


test('stable browser ownership does not adopt a reused tab with a different launch token', () => {
  const client = findOwnedBrowserClient([{
    id: 'ext-unrelated',
    browserTabId: 42,
    launchToken: 'another-e2e-run',
  }], {
    clientId: 'ext-before-reload',
    browserTabId: 42,
    launchToken: 'bridge-real-e2e-run',
  });
  assert.equal(client, null);
});
