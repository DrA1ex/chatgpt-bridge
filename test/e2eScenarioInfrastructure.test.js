import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenarioInfrastructureGate } from '../scripts/e2e/scenario-infrastructure.js';

test('browser infrastructure failure blocks dependent scenarios without multiplying root failures', () => {
  const gate = createScenarioInfrastructureGate();
  assert.equal(gate.blockedScenario('conversation'), null);
  assert.equal(gate.recordRecovery('reload-mid-request', { recovered: true }), null);
  const root = gate.recordRecovery('reload-mid-request', {
    recovered: false,
    reason: 'protocol hello did not arrive',
  });
  assert.deepEqual(root, {
    scenarioId: 'reload-mid-request',
    message: 'protocol hello did not arrive',
  });
  assert.deepEqual(gate.blockedScenario('response-markdown'), {
    id: 'response-markdown',
    blockedBy: 'reload-mid-request',
    reason: 'protocol hello did not arrive',
  });
  assert.equal(gate.recordRecovery('response-markdown', {
    recovered: false,
    reason: 'secondary failure',
  }), root);
  assert.equal(gate.current(), root);
});
