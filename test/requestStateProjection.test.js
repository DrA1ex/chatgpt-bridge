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
  KNOWN_LEGACY_REQUEST_PHASES,
  compatibilityPhaseForState,
  projectLegacyPhase,
} from '../src/bridge/state/requestProjection.js';
import { createInitialRequestState } from '../src/bridge/state/requestPolicy.js';

const CURRENT_PHASES = [
  'artifact_settle',
  'assistant_final_streaming',
  'assistant_reasoning',
  'attachments_uploading',
  'cancelled',
  'completed',
  'continuation_wait',
  'created',
  'failed',
  'final_snapshot_ready',
  'finalizing',
  'generating',
  'needs_confirmation',
  'needs_continue',
  'post_stop_settle',
  'prompt_accepted_by_content_script',
  'prompt_delivered_to_extension',
  'prompt_submitted',
  'reattached',
  'resumed',
  'steer_available',
  'steer_submitted',
  'tool_running',
  'waiting_for_assistant_output',
  'waiting_for_assistant_turn',
  'waiting_for_user_turn',
];

test('every current legacy request phase has a canonical projection', () => {
  assert.deepEqual([...KNOWN_LEGACY_REQUEST_PHASES].sort(), [...CURRENT_PHASES].sort());
  for (const phase of CURRENT_PHASES) {
    const projected = projectLegacyPhase(phase);
    assert.equal(projected.known, true, phase);
    assert.equal(projected.diagnostic, null, phase);
  }
});

test('legacy phase projection keeps lifecycle dimensions orthogonal', () => {
  assert.deepEqual(projectLegacyPhase('assistant_reasoning').patch, {
    lifecycle: RequestLifecycle.GENERATING,
    generation: GenerationState.ACTIVE,
    output: OutputState.REASONING,
  });
  assert.deepEqual(projectLegacyPhase('needs_confirmation').patch, {
    blocker: RequestBlocker.CONFIRMATION,
  });
  assert.deepEqual(projectLegacyPhase('prompt_accepted_by_content_script').patch, {
    lifecycle: RequestLifecycle.PREPARING,
    submission: SubmissionState.ACCEPTED,
  });
});

test('payload evidence can refine a legacy phase projection', () => {
  const projected = projectLegacyPhase('waiting_for_assistant_turn', {
    generating: true,
    answerLength: 20,
    artifactCount: 1,
  });
  assert.equal(projected.patch.generation, GenerationState.ACTIVE);
  assert.equal(projected.patch.output, OutputState.STREAMING);
  assert.equal(projected.patch.artifactStatus, 'ready');
});

test('unknown legacy phases remain observable instead of silently mutating lifecycle', () => {
  const projected = projectLegacyPhase('brand_new_chatgpt_state');
  assert.equal(projected.known, false);
  assert.deepEqual(projected.patch, {});
  assert.equal(projected.diagnostic.code, 'unknown_legacy_phase');
});

test('canonical state produces a compatibility phase for existing diagnostics', () => {
  const state = createInitialRequestState({ requestId: 'req-1', at: 1 });
  assert.equal(compatibilityPhaseForState(state), 'created');
  assert.equal(compatibilityPhaseForState({
    ...state,
    lifecycle: RequestLifecycle.GENERATING,
    output: OutputState.REASONING,
    generation: GenerationState.ACTIVE,
  }), 'assistant_reasoning');
  assert.equal(compatibilityPhaseForState({
    ...state,
    lifecycle: RequestLifecycle.GENERATING,
    blocker: RequestBlocker.CONFIRMATION,
  }), 'needs_confirmation');
});
