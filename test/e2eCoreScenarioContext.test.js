import test from 'node:test';
import assert from 'node:assert/strict';
import { runCoreScenarios } from '../scripts/e2e/scenarios/core.js';
import {
  CORE_SCENARIO_REQUIRED_FUNCTIONS,
  CORE_SCENARIO_REQUIRED_VALUES,
  createCoreScenarioContextFactory,
} from '../scripts/e2e/core-scenario-context.js';

function validStaticContext() {
  const context = {};
  for (const name of CORE_SCENARIO_REQUIRED_FUNCTIONS) context[name] = () => null;
  for (const name of CORE_SCENARIO_REQUIRED_VALUES) context[name] = {};
  context.options = { scenarioIds: [] };
  context.marker = 'BRIDGE_E2E_TEST';
  context.workDir = '/tmp/bridge-e2e-test';
  context.runId = 'test-run';
  context.effortState = { expectedUiEffort: '' };
  context.FAST_EFFORT = 'instant';
  context.DEFAULT_REASONING_EFFORT = 'high';
  context.REASONING_PROGRESS_PERCENTAGES = [0, 10, 100];
  return context;
}

test('core E2E scenarios require an explicit effort selector dependency', async () => {
  await assert.rejects(
    runCoreScenarios({ scenario: async () => null }),
    /require effortFor/,
  );
});

test('core scenario context factory rejects a missing effort selector before browser startup', () => {
  const context = validStaticContext();
  delete context.effortFor;
  assert.throws(
    () => createCoreScenarioContextFactory(context),
    /missing function dependencies: effortFor/,
  );
});

test('core scenario context factory always carries effortFor into the runtime context', async () => {
  const context = validStaticContext();
  const effortFor = () => '';
  const registered = [];
  context.effortFor = effortFor;
  context.scenario = async (id) => { registered.push(id); };

  const buildContext = createCoreScenarioContextFactory(context);
  const runtimeContext = buildContext({
    sessionId: 'session-1',
    sessionUrl: 'https://chatgpt.com/c/session-1',
    testClient: { id: 'client-1' },
  });

  assert.equal(runtimeContext.effortFor, effortFor);
  await runCoreScenarios(runtimeContext);
  assert(registered.includes('conversation'));
  assert(registered.includes('model-effort'));
});

test('core scenario context factory rejects incomplete runtime identity', () => {
  const buildContext = createCoreScenarioContextFactory(validStaticContext());
  assert.throws(
    () => buildContext({ sessionId: 'session-1', sessionUrl: '', testClient: null }),
    /missing runtime values: sessionUrl, testClient.id/,
  );
});
