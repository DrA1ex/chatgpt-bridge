import test from 'node:test';
import assert from 'node:assert/strict';
import { REAL_E2E_SCENARIOS, expandScenarioSelectors, formatScenarioList, scenarioDefinition } from '../scripts/e2e-scenarios.js';

test('real E2E scenario registry has stable unique ids', () => {
  const ids = REAL_E2E_SCENARIOS.map((scenario) => scenario.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(expandScenarioSelectors([]), ids);
  assert.deepEqual(expandScenarioSelectors(['all']), ids);
  assert.equal(scenarioDefinition('response_markdown')?.id, 'response-markdown');
  assert.equal(scenarioDefinition('reasoning_lifecycle')?.id, 'reasoning-lifecycle');
});

test('real E2E scenario selectors preserve registry order and expand groups', () => {
  assert.deepEqual(expandScenarioSelectors(['model-effort']), ['model-effort']);
  assert.deepEqual(expandScenarioSelectors(['parser,model']), ['response-markdown', 'reasoning-lifecycle', 'model-effort']);
  assert.deepEqual(expandScenarioSelectors(['response-parser']), ['response-markdown', 'reasoning-lifecycle']);
  assert.deepEqual(expandScenarioSelectors(['response']), ['response-markdown']);
  assert.deepEqual(expandScenarioSelectors(['reasoning']), ['reasoning-lifecycle']);
  assert.deepEqual(expandScenarioSelectors(['artifacts']), ['multiple-files', 'zip-artifact']);
  assert.deepEqual(expandScenarioSelectors(['project']), ['project-context', 'project-no-context']);
  assert.deepEqual(expandScenarioSelectors(['workflow']), ['passive-workflow']);
  assert.deepEqual(expandScenarioSelectors(['zip', 'files', 'zip']), ['multiple-files', 'zip-artifact']);
});

test('real E2E scenario selector rejects unknown ids without silently running all', () => {
  assert.throws(() => expandScenarioSelectors(['does-not-exist']), /Unknown E2E scenario/);
  const listing = formatScenarioList();
  assert.match(listing, /response-markdown/);
  assert.match(listing, /reasoning-lifecycle/);
  assert.match(listing, /model-effort/);
  assert.match(listing, /project-context/);
  assert.match(listing, /passive-workflow/);
});
