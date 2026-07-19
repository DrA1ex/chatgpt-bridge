import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadScenarioWaitOptions } from '../scripts/e2e/scenarios/core.js';

test('reload-mid-request has an absolute wall-clock limit even when the global limit is disabled', () => {
  const bounded = reloadScenarioWaitOptions({ turnMaxTimeoutMs: 0, resultIdleTimeoutMs: 300_000 });
  assert.equal(bounded.turnMaxTimeoutMs, 600_000);
});

test('reload-mid-request preserves an explicitly configured absolute limit', () => {
  const bounded = reloadScenarioWaitOptions({ turnMaxTimeoutMs: 123_456 });
  assert.equal(bounded.turnMaxTimeoutMs, 123_456);
});
