import test from 'node:test';
import assert from 'node:assert/strict';
import { abortableDelay, createE2eInterruptionController, createE2eSignalCoordinator, isE2eInterruption, ownedBridgeSpawnOptions } from '../scripts/e2e/interruption.js';
import { markReportInterrupted } from '../scripts/e2e-workflow-support.js';
import { stopInterruptedBridgeWork } from '../scripts/e2e/interrupted-cleanup.js';

test('the first E2E signal starts cleanup, immediate process-group duplicates are ignored, and a later signal forces shutdown', async () => {
  const interruption = createE2eInterruptionController();
  const calls = [];
  let now = 1_000;
  const handleSignal = createE2eSignalCoordinator({
    interruption,
    now: () => now,
    forceAfterMs: 750,
    onGraceful: (signal) => calls.push(`graceful:${signal}`),
    onDuplicate: (signal) => calls.push(`duplicate:${signal}`),
    onForce: (signal) => calls.push(`forced:${signal}`),
  });
  const waiting = abortableDelay(60_000, interruption.signal);

  assert.equal(handleSignal('SIGINT'), 'graceful');
  await assert.rejects(waiting, (error) => isE2eInterruption(error) && error.signal === 'SIGINT');
  now += 10;
  assert.equal(handleSignal('SIGINT'), 'duplicate');
  now += 800;
  assert.equal(handleSignal('SIGINT'), 'forced');
  assert.deepEqual(calls, ['graceful:SIGINT', 'duplicate:SIGINT', 'forced:SIGINT']);
});

test('owned E2E bridge is isolated from terminal signals on POSIX', () => {
  const posix = ownedBridgeSpawnOptions({ cwd: '/tmp', stdio: ['ignore', 'pipe', 'pipe'] }, 'darwin');
  const windows = ownedBridgeSpawnOptions({ cwd: 'C:/tmp' }, 'win32');
  assert.equal(posix.detached, true);
  assert.equal(windows.detached, false);
  assert.equal(posix.cwd, '/tmp');
});

test('interrupted E2E report finalization is idempotent', () => {
  const report = { status: 'running', scenarios: [{ id: 'reasoning', status: 'running' }] };
  const timeline = [];
  markReportInterrupted(report, timeline, 'SIGINT', '2026-07-19T12:00:00.000Z');
  markReportInterrupted(report, timeline, 'SIGINT', '2026-07-19T12:00:01.000Z');
  assert.equal(report.status, 'interrupted');
  assert.equal(report.scenarios[0].status, 'interrupted');
  assert.equal(timeline.filter((item) => item.type === 'run.interrupted').length, 1);
});


test('graceful E2E cleanup cancels canonical requests and every running turn before final diagnostics', async () => {
  const calls = [];
  let healthPoll = 0;
  const result = await stopInterruptedBridgeWork({
    options: { baseUrl: 'http://127.0.0.1:1' },
    signalName: 'SIGINT',
    sleep: async () => {},
    api: async (_options, route, request = {}) => {
      calls.push({ route, request });
      if (route === '/browser/stop') return { cancelled: 2 };
      if (route === '/turns?status=running&limit=100') return { turns: [{ id: 'turn-1' }, { id: 'turn-2' }] };
      if (route === '/turns/turn-1/interrupt') return { turn: { status: 'interrupted' } };
      if (route === '/turns/turn-2/interrupt') return { turn: { status: 'cancelled' } };
      if (route === '/health') return { activeRequests: healthPoll++ === 0 ? [{ requestId: 'settling' }] : [] };
      throw new Error(`Unexpected route: ${route}`);
    },
  });

  assert.equal(result.browserCancelled, 2);
  assert.equal(result.settled, true);
  assert.deepEqual(result.interruptedTurns, [
    { turnId: 'turn-1', status: 'interrupted' },
    { turnId: 'turn-2', status: 'cancelled' },
  ]);
  assert.deepEqual(calls.slice(0, 4).map((entry) => entry.route), [
    '/browser/stop',
    '/turns?status=running&limit=100',
    '/turns/turn-1/interrupt',
    '/turns/turn-2/interrupt',
  ]);
  assert.equal(calls.every((entry) => entry.request.ignoreRunAbort === true), true);
});
