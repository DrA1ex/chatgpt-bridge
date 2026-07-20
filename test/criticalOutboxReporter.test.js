import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundStateStore, CommandStatus } from '../tools/chrome-bridge-extension/background/stateV4.js';
import { createUnreportedCriticalReporter } from '../tools/chrome-bridge-extension/background/unreportedCriticalReporter.js';

function memoryStorage() {
  const values = new Map();
  return {
    async get(key) { return { [key]: values.get(key) }; },
    async set(patch) { for (const [key, value] of Object.entries(patch || {})) values.set(key, structuredClone(value)); },
    async remove(key) { values.delete(key); },
  };
}

test('durable reporter replays the full terminal command result and marks it reported', async () => {
  const store = new BackgroundStateStore(memoryStorage(), 'background-reporter');
  const tabId = 71;
  const contentEpoch = 'content-reporter';
  await store.transition(tabId, { type: 'content.attached', contentEpoch });
  await store.transition(tabId, {
    type: 'command.registered',
    scope: 'standalone',
    commandId: 'artifact-result-command',
    commandType: 'artifact.fetch',
    causationId: 'server-command-1',
    contentEpoch,
  });
  await store.transition(tabId, { type: 'command.dispatched', commandId: 'artifact-result-command', contentEpoch });
  await store.transition(tabId, {
    type: 'command.succeeded',
    commandId: 'artifact-result-command',
    resultType: 'artifact.fetch.completed',
    resultPayload: {
      type: 'command.result',
      commandId: 'artifact-result-command',
      resultType: 'artifact.fetch.completed',
      artifact: { id: 'artifact-1', name: 'result.zip', sha256: 'abc123' },
      diagnostics: { captureId: 'capture-1', downloadId: 88 },
    },
    contentEpoch,
  });

  const sent = [];
  const reporter = createUnreportedCriticalReporter({
    backgroundState: store,
    async sendProtocolPayload(_state, payload, options) { sent.push({ payload, options }); },
  });
  const outcome = await reporter.flush({ tabId, contentEpoch, ws: { readyState: 1 } });
  assert.equal(outcome.flushed, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.artifact.name, 'result.zip');
  assert.equal(sent[0].payload.diagnostics.downloadId, 88);
  assert.equal(sent[0].options.critical, true);
  const runtime = await store.read(tabId);
  assert.ok(runtime.commands['artifact-result-command'].reportedAt > 0);
});

test('an oversized terminal result becomes uncertain instead of a false successful command', async () => {
  const store = new BackgroundStateStore(memoryStorage(), 'background-large-result');
  const tabId = 72;
  const contentEpoch = 'content-large-result';
  await store.transition(tabId, { type: 'content.attached', contentEpoch });
  await store.transition(tabId, {
    type: 'command.registered', scope: 'standalone', commandId: 'large-result', commandType: 'artifact.fetch', contentEpoch,
  });
  await store.transition(tabId, { type: 'command.dispatched', commandId: 'large-result', contentEpoch });
  const settled = await store.transition(tabId, {
    type: 'command.succeeded', commandId: 'large-result', resultPayload: { bytes: 'x'.repeat(600 * 1024) }, contentEpoch,
  });
  assert.equal(settled.accepted, true);
  assert.equal(settled.state.commands['large-result'].status, CommandStatus.UNCERTAIN);
  assert.equal(settled.state.commands['large-result'].error.code, 'COMMAND_RESULT_PERSISTENCE_LIMIT');
});

test('durable reporter reruns when a terminal release becomes reportable during an active flush', async () => {
  let releaseVisible = false;
  let releaseReported = false;
  let firstReadResolve;
  let readCount = 0;
  const sent = [];
  const reported = [];
  const backgroundState = {
    async read() {
      readCount += 1;
      if (readCount === 1) {
        return await new Promise((resolve) => { firstReadResolve = resolve; });
      }
      return {
        tabId: 73,
        contentEpoch: 'content-release-race',
        outbox: [],
        commandOrder: releaseVisible ? ['release-command'] : [],
        commands: releaseVisible ? {
          'release-command': {
            commandId: 'release-command',
            commandType: 'request.release',
            scope: 'request',
            status: 'succeeded',
            requestId: 'request-release',
            leaseId: 'lease-release',
            ownerServerInstanceId: 'server-release',
            responseEpoch: 0,
            resultType: 'request.release.completed',
            resultPayload: {
              type: 'command.result',
              commandId: 'release-command',
              requestId: 'request-release',
              resultType: 'request.release.completed',
            },
            reportedAt: releaseReported ? Date.now() : 0,
          },
        } : {},
        effectOrder: [],
        effects: {},
      };
    },
    async transition(_tabId, event) {
      reported.push(event);
      if (event.type === 'command.reported' && event.commandId === 'release-command') releaseReported = true;
      return { accepted: true };
    },
  };
  const reporter = createUnreportedCriticalReporter({
    backgroundState,
    async sendProtocolPayload(_state, payload) { sent.push(payload); },
  });
  const state = { tabId: 73, contentEpoch: 'content-release-race', ws: { readyState: 1 } };
  const firstFlush = reporter.flush(state);
  while (!firstReadResolve) await new Promise((resolve) => setImmediate(resolve));
  releaseVisible = true;
  const coalescedFlush = reporter.flush(state);
  firstReadResolve({ tabId: 73, contentEpoch: 'content-release-race', outbox: [], commandOrder: [], commands: {}, effectOrder: [], effects: {} });

  const [firstOutcome, secondOutcome] = await Promise.all([firstFlush, coalescedFlush]);
  assert.equal(firstOutcome.flushed, 1);
  assert.deepEqual(secondOutcome, firstOutcome);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].resultType, 'request.release.completed');
  assert.equal(reported.some((event) => event.type === 'command.reported' && event.commandId === 'release-command'), true);
});
