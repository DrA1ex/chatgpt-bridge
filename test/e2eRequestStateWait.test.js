import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalTerminalFailure,
  canonicalTransitionPath,
  turnProgressSignature,
  turnWaitState,
} from '../scripts/e2e/request-state-wait.js';

test('canonical snapshots replace legacy phase inference for E2E wait stages', () => {
  const waitState = turnWaitState({
    canonical: {
      state: {
        revision: 7,
        lifecycle: 'artifact_settling',
        compatibilityPhase: 'artifact_settle',
        generation: 'stopped',
        terminal: null,
      },
      history: [],
    },
    active: { phase: 'generating', currentGenerationActive: true },
  });
  assert.equal(waitState.source, 'canonical');
  assert.equal(waitState.stage, 'pipeline');
  assert.equal(waitState.generationActive, false);
  assert.equal(waitState.revision, 7);
});

test('canonical terminal failures expose the transition that made success impossible', () => {
  const waitState = turnWaitState({
    canonical: {
      state: {
        revision: 4,
        lifecycle: 'failed',
        compatibilityPhase: 'failed',
        generation: 'stopped',
        terminal: { code: 'conversation_changed', message: 'Conversation changed' },
      },
      history: [
        { revision: 3, event: { type: 'prompt.accepted' }, lifecycle: 'preparing' },
        { revision: 4, event: { type: 'source.conversation_changed' }, lifecycle: 'failed', terminal: { code: 'conversation_changed' } },
      ],
    },
  });
  const failure = canonicalTerminalFailure(waitState);
  assert.equal(failure.code, 'conversation_changed');
  assert.match(failure.path, /source\.conversation_changed->failed\(conversation_changed\)/);
  assert.equal(canonicalTransitionPath(waitState).split(' | ').length, 2);
});

test('progress signatures include canonical revision changes even when legacy fields are unchanged', () => {
  const base = { turn: { status: 'running', updatedAt: 'same' } };
  const first = turnProgressSignature(base, [], { phase: 'generating' }, { source: 'canonical', revision: 2, lifecycle: 'generating' });
  const second = turnProgressSignature(base, [], { phase: 'generating' }, { source: 'canonical', revision: 3, lifecycle: 'generating' });
  assert.notEqual(first, second);
});
