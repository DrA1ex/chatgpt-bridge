import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestResultAccumulator } from '../src/bridge/coordinator/requestResultAccumulator.js';

function state() {
  return {
    thinking: '',
    answer: '',
    progressText: '',
    progressItems: [],
    progressItemsSignature: '',
    reasoningHistory: [],
    artifacts: [],
  };
}

test('request result accumulator ignores stale shorter thinking snapshots', () => {
  const accumulator = new RequestResultAccumulator();
  const runtime = state();
  const full = 'BEGIN-4 | eta eta eta eta eta | MID-4 | theta theta theta theta theta | END-4';

  assert.equal(accumulator.thinkingSnapshot(runtime, full)?.text, full);
  assert.equal(accumulator.thinkingSnapshot(runtime, 'BEGIN-4 | eta eta eta eta eta | MID-4 |'), null);
  assert.equal(runtime.thinking, full);
});

test('request result accumulator keeps completed reasoning monotonic across progress revisions', () => {
  const accumulator = new RequestResultAccumulator();
  const runtime = state();
  const full = { id: 'r4', kind: 'thinking', text: 'BEGIN-4 | eta | MID-4 | theta | END-4', revision: 4, state: 'active', active: true };
  const stale = { ...full, text: 'BEGIN-4 | eta | MID-4 |', revision: 5, state: 'completed', active: false };

  accumulator.progressSnapshot(runtime, { items: [full] });
  accumulator.progressSnapshot(runtime, { items: [stale] });
  assert.equal(runtime.reasoningHistory[0].text, full.text);
  assert.equal(runtime.reasoningHistory[0].state, 'completed');
});
