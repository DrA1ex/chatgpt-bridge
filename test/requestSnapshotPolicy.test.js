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
    submittedUserTurnKey: 'submitted-user',
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
    { turnKey: 'final-turn', userTurnKey: 'submitted-user', turnIndex: 12, answer: 'final answer', artifacts: [], hasFinalMessage: true },
    { turnKey: 'artifact-turn', userTurnKey: 'submitted-user', turnIndex: 13, answer: '', artifacts: [{ id: 'zip-1' }], hasFinalMessage: false },
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


test('terminal observation rejects partial output while the DOM streaming marker remains visible', async () => {
  const policy = await loadPolicy();
  const evidence = policy.terminalObservationEvidence({
    sawGenerating: true,
    snapshot: {
      phase: 'ASSISTANT_FINAL_STREAMING',
      answer: 'CON',
      artifacts: [],
      hasFinalMessage: true,
      streamingVisible: true,
    },
    signals: {
      stopButtonVisible: false,
      hasActiveTool: false,
      conversationMatches: true,
    },
    generating: false,
    generationIdleForMs: 10_000,
    terminalSettleMs: 1_500,
  });
  assert.equal(evidence.streamingVisible, true);
  assert.equal(evidence.candidateVisible, false);
  assert.equal(evidence.eligible, false);
});

test('recovery cannot treat an older response as new after history shifts DOM indices', async () => {
  const policy = await loadPolicy();
  const request = { submittedUserTurnKey: 'current-user', submittedUserTurnIndex: 2, baselineTurnKeys: ['old-answer'] };
  for (const candidate of [
    { turnKey: 'old-answer', turnIndex: 20, userTurnKey: 'old-user', answer: 'Old answer' },
    { turnKey: 'loaded-history', turnIndex: 18, userTurnKey: 'older-user', answer: 'History loaded after baseline' },
    { turnKey: 'unproven-answer', turnIndex: 21, answer: 'No user boundary' },
  ]) {
    const result = policy.resolveRequestSnapshot(request, { answer: '', reason: 'submitted_user_turn_not_found' }, [candidate]);
    assert.equal(result.source, 'empty', candidate.turnKey);
  }
});

test('recovery follows the exact user boundary after reindexing and rejects a later unrelated answer', async () => {
  const policy = await loadPolicy();
  const request = { submittedUserTurnKey: 'current-user', submittedUserTurnIndex: 20 };
  const candidate = { turnKey: 'current-answer', turnIndex: 1, userTurnKey: 'current-user', answer: 'Current answer' };
  const result = policy.resolveRequestSnapshot(request, {}, [
    { turnKey: 'unrelated-answer', turnIndex: 40, userTurnKey: 'next-user', answer: 'Other answer' },
    candidate,
  ]);
  assert.equal(result.snapshot.turnKey, 'current-answer');
});
