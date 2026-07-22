import test from 'node:test';
import assert from 'node:assert/strict';
import { reasoningSnapshotsFromEvents } from '../scripts/e2e/parser-observation.js';

test('reasoning observation falls back to canonical progress and answer events when DOM snapshots are unavailable', () => {
  const events = [
    { type: 'assistant.progress.snapshot', data: { text: '0%', observationRevision: 10, assistantTurnKey: 'assistant-1', items: [{ id: 'reasoning-main', logicalId: 'reasoning-main', kind: 'thinking', text: '0%', state: 'active', active: true, visible: true, revision: 1 }] } },
    { type: 'assistant.progress.snapshot', data: { text: '100%', observationRevision: 11, assistantTurnKey: 'assistant-1', items: [{ id: 'reasoning-main', logicalId: 'reasoning-main', kind: 'thinking', text: '100%', state: 'completed', active: false, visible: true, revision: 2 }] } },
    { type: 'answer.snapshot', data: { text: 'TEST_BEGIN\nanswer\nTEST_FINISH', observationRevision: 12, assistantTurnKey: 'assistant-1' } },
  ];
  const snapshots = reasoningSnapshotsFromEvents(events);
  assert.equal(snapshots.length, 3);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.phase), ['reasoning', 'reasoning', 'final']);
  assert.equal(snapshots[1].progressItems[0].text, '100%');
  assert.equal(snapshots[2].answer, 'TEST_BEGIN\nanswer\nTEST_FINISH');
  assert.equal(snapshots[2].progressItems[0].state, 'completed');
});

test('real DOM snapshots remain authoritative when present', () => {
  const dom = { phase: 'reasoning', progressItems: [{ text: 'DOM' }] };
  assert.deepEqual(reasoningSnapshotsFromEvents([
    { type: 'assistant.progress.snapshot', data: { items: [{ text: 'event' }] } },
    { type: 'assistant.dom.snapshot', data: dom },
  ]), [dom]);
});
