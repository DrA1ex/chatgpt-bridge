import test from 'node:test';
import assert from 'node:assert/strict';
import { commandSuggestions } from '../src/interactive/commands.js';

test('server-backed workflow suggestions match the commands the runtime actually executes', () => {
  const context = { zipflowWorkflowRuntime: {}, state: {} };
  const values = commandSuggestions('/workflow ', context).map((item) => item.value);
  assert.deepEqual(values, [
    'open', 'history', 'plan', 'diff', 'report', 'checks', 'fix', 'preset', 'legacy', 'migrate',
  ]);
  assert.deepEqual(
    commandSuggestions('/workflow preset ', context).map((item) => item.value),
    ['apply-changes', 'fix-until-pass', 'guided-task'],
  );
});

test('server-backed apply suggestions expose review modes but not unsupported --force', () => {
  const serverValues = commandSuggestions('/apply ', { zipflowWorkflowRuntime: {}, state: {} })
    .map((item) => item.value);
  assert.deepEqual(serverValues, ['--plan', '--interactive']);

  const legacyValues = commandSuggestions('/apply ', { state: {} }).map((item) => item.value);
  assert.ok(legacyValues.includes('--force'));
});
