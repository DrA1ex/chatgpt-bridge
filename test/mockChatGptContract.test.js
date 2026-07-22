import test from 'node:test';
import assert from 'node:assert/strict';
import '../tools/chrome-bridge-extension/shared/commandManifest.js';
import { REAL_E2E_SCENARIOS, expandScenarioSelectors } from '../scripts/e2e-scenarios.js';
import { LOCAL_E2E_COMMAND_TYPES, LOCAL_E2E_LIVE_ONLY_BOUNDARIES } from '../scripts/e2e/mock-chatgpt/contract.js';

test('local ChatGPT protocol participant covers every shared command-manifest command', () => {
  const manifestTypes = globalThis.ChatGptBridgeCommandManifest.commandTypes().slice().sort();
  assert.deepEqual([...LOCAL_E2E_COMMAND_TYPES].sort(), manifestTypes);
});

test('local ChatGPT E2E default selects the complete registered scenario matrix', () => {
  assert.deepEqual(expandScenarioSelectors([]), REAL_E2E_SCENARIOS.map((scenario) => scenario.id));
});

test('remaining live-only boundaries are platform/product concerns, not canonical lifecycle gaps', () => {
  assert.ok(LOCAL_E2E_LIVE_ONLY_BOUNDARIES.length >= 3);
  assert.ok(LOCAL_E2E_LIVE_ONLY_BOUNDARIES.every((item) => typeof item === 'string' && item.length > 20));
});
