import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalTerminalFailure,
  canonicalTransitionPath,
  turnProgressSignature,
  turnWaitState,
} from '../scripts/e2e/request-state-wait.js';

test('canonical snapshots drive E2E wait stages for E2E wait stages', () => {
  const waitState = turnWaitState({
    canonical: {
      state: {
        revision: 7,
        lifecycle: 'artifact_settling',
        displayPhase: 'artifact_settling',
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
        displayPhase: 'failed',
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

test('progress signatures ignore revision and transport chatter without semantic progress', () => {
  const base = { turn: { status: 'running', updatedAt: 'same' } };
  const first = turnProgressSignature(base, [{ type: 'request.deadline.scheduled', sequence: 2 }], { phase: 'generating' }, { source: 'canonical', revision: 2, lifecycle: 'generating' });
  const second = turnProgressSignature(base, [{ type: 'request.deadline.scheduled', sequence: 3 }], { phase: 'generating' }, { source: 'canonical', revision: 3, lifecycle: 'generating' });
  assert.equal(first, second);
  const progressed = turnProgressSignature(base, [], { phase: 'generating', answerLength: 1 }, { source: 'canonical', revision: 4, lifecycle: 'generating' });
  assert.notEqual(second, progressed);
});
