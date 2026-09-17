import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeMonotonicText } from '../src/progressText.js';
import { mergeProgressRecords } from '../src/bridge/requestState.js';

test('monotonic reasoning text never shrinks on a stale prefix', () => {
  const full = 'BEGIN-4 | eta eta eta eta eta | MID-4 | theta theta theta theta theta | END-4';
  assert.equal(mergeMonotonicText(full, 'BEGIN-4 | eta eta eta eta eta | MID-4 |'), full);
});

test('monotonic reasoning text extends snapshots and merges suffix-prefix overlap', () => {
  assert.equal(mergeMonotonicText('BEGIN-', 'BEGIN-3 | epsilon'), 'BEGIN-3 | epsilon');
  assert.equal(mergeMonotonicText('alpha beta gamma', 'gamma delta'), 'alpha beta gamma delta');
});

test('progress record merge preserves longer reasoning even when the stale record has a newer revision', () => {
  const full = {
    id: 'reasoning-4', kind: 'thinking', text: 'BEGIN-4 | eta | MID-4 | theta theta | END-4',
    revision: 4, state: 'active', active: true,
  };
  const staleFinal = {
    ...full, text: 'BEGIN-4 | eta | MID-4 |', revision: 5, state: 'completed', active: false,
  };
  const [merged] = mergeProgressRecords([full], [staleFinal]);
  assert.equal(merged.text, full.text);
  assert.equal(merged.revision, 5);
  assert.equal(merged.state, 'completed');
  assert.equal(merged.active, false);
});
