import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

async function loadPolicy() {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestSnapshotPolicy.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: 'requestSnapshotPolicy.js' });
  return context.ChatGptRequestSnapshotPolicy;
}

test('request snapshot policy recovers the latest meaningful assistant turn after the submitted user turn', async () => {
  const policy = await loadPolicy();
  const request = {
    submittedUserTurnIndex: 10,
    assistantTurnKey: 'reasoning-turn',
    baselineTurnKeys: ['old-turn'],
  };
  const resolved = policy.resolveRequestSnapshot(request, {
    turnKey: 'reasoning-turn',
    turnIndex: 11,
    answer: '',
    artifacts: [],
    hasFinalMessage: false,
  }, [
    { turnKey: 'old-turn', turnIndex: 8, answer: 'stale', artifacts: [], hasFinalMessage: true },
    { turnKey: 'reasoning-turn', turnIndex: 11, answer: '', artifacts: [], hasFinalMessage: false },
    { turnKey: 'final-turn', turnIndex: 12, answer: 'final answer', artifacts: [], hasFinalMessage: true },
    { turnKey: 'artifact-turn', turnIndex: 13, answer: '', artifacts: [{ id: 'zip-1' }], hasFinalMessage: false },
  ]);
  assert.equal(resolved.source, 'recent_assistant_turn');
  assert.equal(resolved.snapshot.turnKey, 'artifact-turn');
  assert.equal(resolved.snapshot.artifacts.length, 1);
});

test('request snapshot policy never recovers output from mutable request-local fragments', async () => {
  const policy = await loadPolicy();
  const resolved = policy.resolveRequestSnapshot({
    lastAnswer: 'legacy cached answer must be ignored',
    assistantTurnKey: 'final-turn',
    assistantTurnIndex: 12,
    artifacts: [{ id: 'legacy-artifact' }],
  }, {
    answer: '',
    artifacts: [],
    hasFinalMessage: false,
    reason: 'assistant_turn_missing',
  }, []);
  assert.equal(resolved.source, 'empty');
  assert.equal(resolved.snapshot.answer, '');
  assert.deepEqual(resolved.snapshot.artifacts, []);
});

test('terminal observation accepts stable quiescent output without an action bar', async () => {
  const policy = await loadPolicy();
  const evidence = policy.terminalObservationEvidence({
    request: {},
    sawGenerating: true,
    snapshot: { answer: 'done', artifacts: [], hasFinalMessage: true },
    signals: {
      actionBarVisible: false,
      regenerateButtonVisible: false,
      stopButtonVisible: false,
      hasActiveTool: false,
      continueButtonVisible: false,
      needsConfirmation: false,
      hasError: false,
      conversationMatches: true,
    },
    generating: false,
    generationIdleForMs: 3_000,
    terminalSettleMs: 1_500,
    networkDone: false,
  });
  assert.equal(evidence.eligible, true);
  assert.equal(evidence.confidence, 'medium');
  assert.equal(evidence.quietAfterGeneration, true);
});

test('terminal observation does not treat an empty placeholder as completion', async () => {
  const policy = await loadPolicy();
  const evidence = policy.terminalObservationEvidence({
    request: {},
    sawGenerating: true,
    snapshot: { answer: '', artifacts: [], hasFinalMessage: false },
    signals: { conversationMatches: true },
    generating: false,
    generationIdleForMs: 10_000,
    terminalSettleMs: 1_500,
  });
  assert.equal(evidence.candidateVisible, false);
  assert.equal(evidence.eligible, false);
});
