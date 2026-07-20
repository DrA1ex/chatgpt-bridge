import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { classifyTurnObservation } from '../src/bridge/observation/turnEvidence.js';
import { tabObservationToCanonicalEvent } from '../src/bridge/adapters/tabObservationAdapter.js';
import { createInitialRequestState } from '../src/bridge/state/requestPolicy.js';
import { SubmissionState } from '../src/bridge/state/requestEvents.js';

function observation(overrides = {}) {
  return {
    revision: 4,
    observedAt: 100,
    stableForMs: 1_500,
    conversationId: 'conversation-1',
    activeRequest: {
      requestId: 'request-1',
      responseEpoch: 0,
      submittedUserTurnKey: 'user-1',
      assistantTurnKey: 'assistant-1',
    },
    turn: { key: 'assistant-1', userKey: 'user-1', userPrompt: 'hello' },
    generation: { state: 'stopped' },
    blocker: { state: 'none' },
    output: { state: 'final', answer: 'done' },
    artifacts: [],
    ...overrides,
  };
}

test('active and passive observation paths share one DOM terminal-evidence classifier', async () => {
  const item = observation();
  const common = classifyTurnObservation(item);
  assert.equal(common.terminalCandidate, true);
  const state = createInitialRequestState({ requestId: 'request-1', resumed: true, responseEpoch: 0, submittedUserTurnKey: 'user-1' });
  state.submission = SubmissionState.SUBMITTED;
  const event = tabObservationToCanonicalEvent('request-1', 'client-1', { observation: item }, state, 100);
  assert.equal(event.data.completionCandidate, true);
  assert.equal(event.data.completionEvidence.semanticSignature, common.semanticSignature);

  const adapter = await fs.readFile(new URL('../src/bridge/adapters/tabObservationAdapter.js', import.meta.url), 'utf8');
  const router = await fs.readFile(new URL('../src/bridge/coordinator/bridgeClientEventRouter.js', import.meta.url), 'utf8');
  const passiveRouter = await fs.readFile(new URL('../src/bridge/coordinator/passiveObservationRouter.js', import.meta.url), 'utf8');
  assert.match(adapter, /classifyTurnObservation\(observation\)/);
  assert.match(passiveRouter, /classifyTurnObservation\(observation\)/);
  assert.doesNotMatch(router, /stableForMs\)\s*>=\s*1_500/);
});


test('shared terminal evidence rejects stopped-looking output while streaming DOM evidence remains', () => {
  const result = classifyTurnObservation({
    stableForMs: 5_000,
    turn: { key: 'assistant-streaming', userKey: 'user-1' },
    generation: { state: 'stopped', streamingVisible: true },
    output: { state: 'final', answer: 'CON', finalMessage: true },
    blocker: { state: 'none' },
    artifacts: [],
  });
  assert.equal(result.streamingVisible, true);
  assert.equal(result.generationStopped, false);
  assert.equal(result.terminalCandidate, false);
});
