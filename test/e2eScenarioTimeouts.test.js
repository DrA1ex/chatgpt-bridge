import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadScenarioWaitOptions } from '../scripts/e2e/scenarios/core.js';
import { parseArgs } from '../scripts/e2e/cli.js';

test('reload-mid-request has an absolute wall-clock limit even when the global limit is disabled', () => {
  const bounded = reloadScenarioWaitOptions({ turnMaxTimeoutMs: 0, resultIdleTimeoutMs: 300_000 });
  assert.equal(bounded.turnMaxTimeoutMs, 600_000);
});

test('reload-mid-request preserves an explicitly configured absolute limit', () => {
  const bounded = reloadScenarioWaitOptions({ turnMaxTimeoutMs: 123_456 });
  assert.equal(bounded.turnMaxTimeoutMs, 123_456);
});


test('real E2E enables absolute prompt and turn limits by default', () => {
  const options = parseArgs([]);
  assert.equal(options.promptTimeoutMs, 360_000);
  assert.equal(options.turnMaxTimeoutMs, 360_000);
});

test('real E2E still permits explicitly disabling absolute limits', () => {
  const options = parseArgs(['--prompt-timeout-ms', '0', '--turn-max-timeout-ms', '0']);
  assert.equal(options.promptTimeoutMs, 0);
  assert.equal(options.turnMaxTimeoutMs, 0);
});
