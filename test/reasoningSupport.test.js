import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCompleteReasoningAttempt } from '../scripts/e2e/reasoning-support.js';

function attempt({ id, missing = [], score = 0 }) {
  return {
    turnId: id,
    snapshot: { turn: { status: 'completed' } },
    finalValidation: { failures: [] },
    missingPercentages: missing,
    coverage: { sufficient: missing.length === 0, score },
  };
}

test('reasoning retry accepts a complete later attempt after a partial first attempt', () => {
  const selected = selectCompleteReasoningAttempt([
    attempt({ id: 'first', missing: [100], score: 10 }),
    attempt({ id: 'second', missing: [], score: 20 }),
  ]);
  assert.equal(selected?.turnId, 'second');
});

test('reasoning retry returns null when every attempt is partial', () => {
  assert.equal(selectCompleteReasoningAttempt([
    attempt({ id: 'first', missing: [100], score: 10 }),
    attempt({ id: 'second', missing: [90, 100], score: 20 }),
  ]), null);
});
