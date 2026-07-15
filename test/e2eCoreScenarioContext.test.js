import test from 'node:test';
import assert from 'node:assert/strict';
import { runCoreScenarios } from '../scripts/e2e/scenarios/core.js';

test('core E2E scenarios require an explicit effort selector dependency', async () => {
  await assert.rejects(
    runCoreScenarios({ scenario: async () => null }),
    /require effortFor/,
  );
});

test('core E2E scenario registration accepts the runner effort selector', async () => {
  const registered = [];
  await runCoreScenarios({
    effortFor: () => '',
    scenario: async (id) => { registered.push(id); },
  });
  assert(registered.includes('conversation'));
  assert(registered.includes('model-effort'));
});
