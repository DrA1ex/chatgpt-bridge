import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GenerationState,
  OutputState,
  RequestBlocker,
  RequestLifecycle,
  SubmissionState,
} from '../src/bridge/state/requestEvents.js';
import {
  compactCanonicalRequestState,
  displayPhaseForState,
} from '../src/bridge/state/requestView.js';
import { createInitialRequestState } from '../src/bridge/state/requestPolicy.js';

test('canonical request view derives readable phases without mutating state', () => {
  const state = createInitialRequestState({ requestId: 'req-1', at: 1 });
  assert.equal(displayPhaseForState(state), 'created');
  assert.equal(displayPhaseForState({
    ...state,
    lifecycle: RequestLifecycle.GENERATING,
    output: OutputState.REASONING,
    generation: GenerationState.ACTIVE,
  }), 'reasoning');
  assert.equal(displayPhaseForState({
    ...state,
    lifecycle: RequestLifecycle.GENERATING,
    blocker: RequestBlocker.CONFIRMATION,
  }), 'needs_confirmation');
  assert.equal(displayPhaseForState({
    ...state,
    lifecycle: RequestLifecycle.PREPARING,
    submission: SubmissionState.ACCEPTED,
  }), 'accepted');
});

test('compact canonical request view keeps orthogonal state dimensions', () => {
  const state = {
    ...createInitialRequestState({ requestId: 'req-compact', at: 1 }),
    revision: 8,
    lifecycle: RequestLifecycle.GENERATING,
    generation: GenerationState.ACTIVE,
    blocker: RequestBlocker.CONTINUE,
    output: OutputState.STREAMING,
  };
  const view = compactCanonicalRequestState(state);
  assert.equal(view.requestId, 'req-compact');
  assert.equal(view.revision, 8);
  assert.equal(view.displayPhase, 'needs_continue');
  assert.equal(view.generation, GenerationState.ACTIVE);
  assert.equal(view.output, OutputState.STREAMING);
  assert.equal(view.blocker, RequestBlocker.CONTINUE);
});
