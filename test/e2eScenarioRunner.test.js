import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenarioRunner } from '../scripts/e2e/scenario-runner.js';

test('scenario runner records one browser root failure and blocks dependent scenarios', async () => {
  const report = { scenarios: [] };
  const scenarioFailures = [];
  const client = {
    id: 'ext-before-reload',
    browserTabId: 42,
    launchToken: 'bridge-run',
    ready: true,
    pageReady: true,
    composerReady: true,
    chatMainReady: true,
  };
  const events = [];
  let dependentRan = false;
  const runtime = createScenarioRunner({
    options: { scenarioIds: ['reload-mid-request', 'response-markdown'], tabReadyTimeoutMs: 100 },
    report,
    scenarioFailures,
    definitionFor: (id) => ({ id, name: id }),
    getClient: () => client,
    getLaunchToken: () => 'bridge-run',
    clientSnapshot: async () => ({ clients: [client] }),
    api: async (_options, pathname) => {
      assert.equal(pathname, '/browser/clients');
      return { clients: [] };
    },
    waitUntil: async () => { throw new Error('protocol hello did not arrive'); },
    testLog: () => {},
    logEvent: (type, data) => events.push({ type, ...data }),
    checkpoint: async () => {},
    checkpointWarning: () => {},
  });

  const root = await runtime.run('reload-mid-request', async () => {
    throw new Error('Reloaded turn ended as failed');
  });
  const blocked = await runtime.run('response-markdown', async () => {
    dependentRan = true;
  });

  assert.equal(root.status, 'failed');
  assert.equal(blocked.status, 'blocked');
  assert.equal(dependentRan, false);
  assert.equal(scenarioFailures.length, 1);
  assert.deepEqual(report.browserInfrastructureFailure, {
    scenarioId: 'reload-mid-request',
    message: 'protocol hello did not arrive',
  });
  assert.deepEqual(report.blockedScenarios, [{
    id: 'response-markdown',
    blockedBy: 'reload-mid-request',
    reason: 'protocol hello did not arrive',
  }]);
  assert(events.some((event) => event.type === 'scenario.finished' && event.id === 'response-markdown' && event.status === 'blocked'));
});
