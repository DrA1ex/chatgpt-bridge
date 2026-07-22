import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkflowState,
  publicWorkflowState,
  reduceWorkflowState,
  WorkflowActionKind,
  WorkflowEffectKind,
  WorkflowEventType,
  WorkflowLifecycle,
  WorkflowPhase,
  WorkflowRunKind,
} from '../src/workflow/state/workflowState.js';
import { recoveryDecisionForWorkflow } from '../src/workflow/state/workflowEffects.js';

let sequence = 0;
function event(type, data = {}, options = {}) {
  return { eventId: options.eventId || `event-${++sequence}`, type, data, at: options.at || '2026-07-18T00:00:00.000Z', ...(options.expectedRevision == null ? {} : { expectedRevision: options.expectedRevision }) };
}
function apply(state, type, data = {}, options = {}) {
  const outcome = reduceWorkflowState(state, event(type, data, options));
  assert.equal(outcome.accepted, true, JSON.stringify(outcome.diagnostics));
  return outcome.state;
}
function reject(state, type, data, code, options = {}) {
  const before = structuredClone(state);
  const outcome = reduceWorkflowState(state, event(type, data, options));
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.diagnostics[0].code, code);
  assert.deepEqual(outcome.state, before);
  return outcome;
}
function running(kind = WorkflowRunKind.MANUAL, options = {}) {
  let state = createWorkflowState({ lifecycle: WorkflowLifecycle.READY, subscription: { enabled: options.observing ?? true }, retryPolicy: options.retryPolicy });
  state = apply(state, WorkflowEventType.RUN_STARTED, { runId: options.runId || 'run-1', kind, phase: options.phase || WorkflowPhase.CONTEXT_SYNC });
  return state;
}

test('v3.1 keeps one run across phases and returns to ready only after a terminal outcome', () => {
  let state = running(WorkflowRunKind.PASSIVE);
  for (const phase of [WorkflowPhase.DOWNLOADING, WorkflowPhase.VERIFYING, WorkflowPhase.PLANNING, WorkflowPhase.APPLYING, WorkflowPhase.COMMITTING]) {
    state = apply(state, WorkflowEventType.PHASE_CHANGED, { runId: 'run-1', phase });
  }
  state = apply(state, WorkflowEventType.RUN_COMPLETED, { runId: 'run-1', code: 'applied' });
  assert.equal(state.lifecycle, WorkflowLifecycle.READY);
  assert.equal(state.run.id, '');
  assert.equal(state.run.phase, WorkflowPhase.NONE);
  assert.equal(state.lastOutcome.code, 'applied');
});

test('a terminal run returns to ready even when passive observation is disabled', () => {
  let state = createWorkflowState({ lifecycle: WorkflowLifecycle.READY, subscription: { enabled: false } });
  state = apply(state, WorkflowEventType.RUN_STARTED, { runId: 'manual-run', kind: WorkflowRunKind.MANUAL, phase: WorkflowPhase.CHECKING });
  state = apply(state, WorkflowEventType.RUN_COMPLETED, { runId: 'manual-run' });
  assert.equal(state.lifecycle, WorkflowLifecycle.READY);
  assert.equal(state.subscription.enabled, false);
});

test('pause preserves the exact lifecycle and suspends a pending action', () => {
  let state = running();
  state = apply(state, WorkflowEventType.ACTION_REQUIRED, {
    runId: 'run-1', actionId: 'action-1', kind: WorkflowActionKind.APPLY, reason: 'Review',
    choices: [{ id: 'approve', transition: 'continue', phase: WorkflowPhase.APPLYING }, { id: 'stop', transition: 'stop' }],
  });
  state = apply(state, WorkflowEventType.PAUSE_REQUESTED, { runId: 'run-1', reason: 'later' });
  assert.equal(state.lifecycle, WorkflowLifecycle.RECOVERING);
  assert.equal(state.control.pauseRequested, true);
  state = apply(state, WorkflowEventType.PAUSED, { runId: 'run-1', reason: 'later' });
  assert.equal(state.lifecycle, WorkflowLifecycle.PAUSED);
  assert.equal(state.nextAction, null);
  assert.equal(state.pause.resumeLifecycle, WorkflowLifecycle.WAITING_ACTION);
  assert.equal(state.pause.suspendedAction.id, 'action-1');
  state = apply(state, WorkflowEventType.RESUMED, { runId: 'run-1' });
  assert.equal(state.lifecycle, WorkflowLifecycle.WAITING_ACTION);
  assert.equal(state.nextAction.id, 'action-1');
});


test('pause remains pending until dispatched effects settle', () => {
  let state = running();
  state = apply(state, WorkflowEventType.EFFECT_PLANNED, {
    runId: 'run-1', effectId: 'effect-1', kind: WorkflowEffectKind.PROMPT,
    idempotencyKey: 'prompt-key', preconditionsHash: 'guards-1',
  });
  state = apply(state, WorkflowEventType.EFFECT_DISPATCHED, { effectId: 'effect-1' });
  state = apply(state, WorkflowEventType.PAUSE_REQUESTED, { runId: 'run-1', reason: 'later' });
  reject(state, WorkflowEventType.PAUSED, { runId: 'run-1' }, 'workflow_pause_barrier_pending');
  state = apply(state, WorkflowEventType.EFFECT_FAILED, { effectId: 'effect-1', attempt: 1, error: 'cancelled at pause barrier' });
  state = apply(state, WorkflowEventType.PAUSED, { runId: 'run-1' });
  assert.equal(state.lifecycle, WorkflowLifecycle.PAUSED);
  assert.equal(state.control.pauseRequested, false);
});


test('binding changes increment the epoch and discard queued turns from the previous session', () => {
  let state = createWorkflowState({
    lifecycle: WorkflowLifecycle.READY,
    subscription: { enabled: true },
    binding: { clientId: 'client-1', sessionId: 'session-1', epoch: 1 },
  });
  state = apply(state, WorkflowEventType.INPUT_ENQUEUED, {
    inputId: 'i1', deduplicationKey: 'turn-1', bindingEpoch: 1,
    source: { clientId: 'client-1', sessionId: 'session-1' },
  });
  state = apply(state, WorkflowEventType.INPUT_ENQUEUED, {
    inputId: 'i2', deduplicationKey: 'turn-2', bindingEpoch: 1,
    source: { clientId: 'client-1', sessionId: 'session-1' },
  });
  state = apply(state, WorkflowEventType.RUN_STARTED, {
    runId: 'run-1', inputId: 'i1', kind: WorkflowRunKind.PASSIVE,
    source: { clientId: 'client-1', sessionId: 'session-1' },
  });
  state = apply(state, WorkflowEventType.BINDING_CHANGED, {
    clientId: 'client-2', sessionId: 'session-2', reason: 'session-handoff',
  });
  assert.equal(state.binding.epoch, 2);
  assert.deepEqual(state.run.source, { clientId: 'client-2', sessionId: 'session-2' });
  assert.equal(state.run.references.bindingEpoch, 2);
  assert.equal(state.inputs.length, 0);
  assert.ok(state.inputHistory.includes('turn-2'));
  reject(state, WorkflowEventType.INPUT_ENQUEUED, {
    inputId: 'stale', deduplicationKey: 'turn-stale', bindingEpoch: 1,
  }, 'input_binding_stale');
});

test('persisted input queue is FIFO, bounded, and deduplicated', () => {
  let state = createWorkflowState({ lifecycle: WorkflowLifecycle.READY, subscription: { enabled: true }, queueLimit: 2 });
  state = apply(state, WorkflowEventType.INPUT_ENQUEUED, { inputId: 'i1', deduplicationKey: 'turn-1', payload: { turnKey: 'turn-1' } });
  state = apply(state, WorkflowEventType.INPUT_ENQUEUED, { inputId: 'i2', deduplicationKey: 'turn-2', payload: { turnKey: 'turn-2' } });
  reject(state, WorkflowEventType.INPUT_ENQUEUED, { inputId: 'i3', deduplicationKey: 'turn-3' }, 'input_queue_full');
  reject(state, WorkflowEventType.RUN_STARTED, { runId: 'run-2', inputId: 'i2' }, 'input_order_mismatch');
  state = apply(state, WorkflowEventType.RUN_STARTED, { runId: 'run-1', inputId: 'i1', kind: WorkflowRunKind.PASSIVE });
  assert.equal(state.inputs[0].id, 'i2');
  assert.equal(state.run.references.inputPayload.turnKey, 'turn-1');
  assert.ok(state.inputHistory.includes('turn-1'));
});

test('action tokens, typed choices, expiry, and safe defaults are deterministic', () => {
  let state = running();
  state = apply(state, WorkflowEventType.ACTION_REQUIRED, {
    runId: 'run-1', actionId: 'action-1', kind: WorkflowActionKind.APPLY, reason: 'Review', expiresAt: '2026-07-18T00:01:00.000Z', defaultOnExpiry: 'stop',
    choices: [{ id: 'approve', transition: 'continue', phase: WorkflowPhase.APPLYING }, { id: 'stop', transition: 'stop' }],
  });
  reject(state, WorkflowEventType.ACTION_RESOLVED, { actionId: 'stale', choice: 'approve' }, 'action_id_mismatch');
  reject(state, WorkflowEventType.ACTION_RESOLVED, { actionId: 'action-1', choice: 'other' }, 'action_choice_invalid');
  reject(state, WorkflowEventType.ACTION_RESOLVED, { actionId: 'action-1', choice: 'approve' }, 'action_expired', { at: '2026-07-18T00:02:00.000Z' });
  state = apply(state, WorkflowEventType.ACTION_EXPIRED, { actionId: 'action-1' }, { at: '2026-07-18T00:02:00.000Z' });
  assert.equal(state.lifecycle, WorkflowLifecycle.STOPPED);
  assert.equal(state.lastOutcome.status, 'cancelled');
});

test('effect protocol persists intent, dispatch attempt, typed result, and replay guards', () => {
  let state = running();
  state = apply(state, WorkflowEventType.EFFECT_PLANNED, { runId: 'run-1', effectId: 'check-1', kind: WorkflowEffectKind.CHECKS, safe: true, idempotencyKey: 'checks:key', preconditionsHash: 'pre:1' });
  state = apply(state, WorkflowEventType.EFFECT_DISPATCHED, { effectId: 'check-1' });
  assert.equal(state.effects['check-1'].attempt, 1);
  reject(state, WorkflowEventType.EFFECT_SUCCEEDED, { effectId: 'check-1', attempt: 2 }, 'effect_attempt_mismatch');
  state = apply(state, WorkflowEventType.EFFECT_SUCCEEDED, { effectId: 'check-1', attempt: 1, result: { ok: true } });
  reject(state, WorkflowEventType.EFFECT_DISPATCHED, { effectId: 'check-1' }, 'effect_not_planned');
});

test('recovery retries safe effects but never guesses after an uncertain write by default', () => {
  let safe = running(WorkflowRunKind.MANUAL, { retryPolicy: { safeLimit: 3 } });
  safe = apply(safe, WorkflowEventType.EFFECT_PLANNED, { runId: 'run-1', effectId: 'download-1', kind: WorkflowEffectKind.DOWNLOAD, safe: true, idempotencyKey: 'd1', preconditionsHash: 'p1' });
  safe = apply(safe, WorkflowEventType.EFFECT_DISPATCHED, { effectId: 'download-1' });
  assert.deepEqual(recoveryDecisionForWorkflow(safe), { automatic: true, effectIds: ['download-1'] });

  let unsafe = running();
  unsafe = apply(unsafe, WorkflowEventType.EFFECT_PLANNED, { runId: 'run-1', effectId: 'apply-1', kind: WorkflowEffectKind.APPLY, safe: false, idempotencyKey: 'a1', preconditionsHash: 'p1' });
  unsafe = apply(unsafe, WorkflowEventType.EFFECT_DISPATCHED, { effectId: 'apply-1' });
  unsafe = apply(unsafe, WorkflowEventType.EFFECT_UNCERTAIN, { effectId: 'apply-1', attempt: 1, error: 'crash after write' });
  const decision = recoveryDecisionForWorkflow(unsafe);
  assert.equal(decision.automatic, false);
  assert.equal(decision.action.kind, WorkflowActionKind.RECOVERY);
});

test('unsafe writes retry only after reconciliation proves the prior attempt did not start', () => {
  let state = running(WorkflowRunKind.MANUAL, { retryPolicy: { apply: 'if_unconfirmed' } });
  state = apply(state, WorkflowEventType.EFFECT_PLANNED, { runId: 'run-1', effectId: 'apply-1', kind: WorkflowEffectKind.APPLY, safe: false, idempotencyKey: 'a1', preconditionsHash: 'p1' });
  state = apply(state, WorkflowEventType.EFFECT_DISPATCHED, { effectId: 'apply-1' });
  state = apply(state, WorkflowEventType.EFFECT_UNCERTAIN, { effectId: 'apply-1', attempt: 1 });
  state = apply(state, WorkflowEventType.RECOVERY_STARTED, { runId: 'run-1' });
  reject(state, WorkflowEventType.EFFECT_RETRY_PLANNED, { effectId: 'apply-1', idempotencyKey: 'different', preconditionsHash: 'p1', reconciliation: 'proved_not_started' }, 'effect_retry_guard_mismatch');
  reject(state, WorkflowEventType.EFFECT_RETRY_PLANNED, { effectId: 'apply-1', idempotencyKey: 'a1', preconditionsHash: 'p1' }, 'effect_retry_policy_denied');
  state = apply(state, WorkflowEventType.EFFECT_RETRY_PLANNED, { effectId: 'apply-1', idempotencyKey: 'a1', preconditionsHash: 'p1', reconciliation: 'proved_not_started' });
  assert.equal(state.effects['apply-1'].status, 'planned');
  assert.equal(state.effects['apply-1'].reconciliation, 'proved_not_started');
});

test('unsafe effects reject an always retry policy at planning time', () => {
  let state = running();
  reject(state, WorkflowEventType.EFFECT_PLANNED, {
    runId: 'run-1', effectId: 'apply-always', kind: WorkflowEffectKind.APPLY, safe: false,
    policy: 'always', idempotencyKey: 'a1', preconditionsHash: 'p1',
  }, 'effect_retry_policy_invalid');
});

test('duplicate events and stale revisions are rejected without mutation', () => {
  const state = createWorkflowState({ lifecycle: WorkflowLifecycle.STOPPED });
  const acceptedEvent = event(WorkflowEventType.ACTIVATED, { subscriptionEnabled: true }, { eventId: 'same', expectedRevision: 0 });
  const accepted = reduceWorkflowState(state, acceptedEvent);
  assert.equal(accepted.accepted, true);
  reject(accepted.state, WorkflowEventType.ACTIVATED, {}, 'event_duplicate', { eventId: 'same' });
  reject(accepted.state, WorkflowEventType.COMMAND_ACCEPTED, { commandId: 'c1' }, 'revision_mismatch', { expectedRevision: 0 });
});

test('late results after stop and terminal runs never mutate state', () => {
  let state = running();
  state = apply(state, WorkflowEventType.EFFECT_PLANNED, { runId: 'run-1', effectId: 'apply-1', kind: WorkflowEffectKind.APPLY, safe: false, idempotencyKey: 'a1', preconditionsHash: 'p1' });
  state = apply(state, WorkflowEventType.EFFECT_DISPATCHED, { effectId: 'apply-1' });
  state = apply(state, WorkflowEventType.STOP_REQUESTED, { runId: 'run-1', reason: 'user stop' });
  reject(state, WorkflowEventType.STOPPED, { runId: 'run-1', reason: 'user stop' }, 'workflow_stop_barrier_pending');
  state = apply(state, WorkflowEventType.EFFECT_UNCERTAIN, { effectId: 'apply-1', attempt: 1, error: 'outcome unknown' });
  reject(state, WorkflowEventType.STOPPED, { runId: 'run-1', reason: 'user stop' }, 'workflow_stop_barrier_pending');
  state = apply(state, WorkflowEventType.EFFECT_CANCELLED, { effectId: 'apply-1', reconciliation: 'proved_not_started' });
  state = apply(state, WorkflowEventType.STOPPED, { runId: 'run-1', reason: 'user stop' });
  reject(state, WorkflowEventType.EFFECT_SUCCEEDED, { effectId: 'apply-1', attempt: 1 }, 'effect_stale');
  reject(state, WorkflowEventType.RUN_COMPLETED, { runId: 'run-1' }, 'run_result_not_allowed');
});

test('public snapshot is pure v3 and exposes no legacy state surfaces', () => {
  const snapshot = publicWorkflowState(createWorkflowState({ lifecycle: WorkflowLifecycle.READY, subscription: { enabled: true } }));
  for (const key of ['watcher', 'pipeline', 'automation', 'pendingCommit', 'pendingCheckFailure', 'pendingSessionRecovery', 'attention']) assert.equal(key in snapshot, false, key);
});

test('workflow Git aggregation is canonical, persisted across terminal runs, and never stored on runtime helpers', () => {
  let state = createWorkflowState({
    lifecycle: WorkflowLifecycle.READY,
    git: { baseSha: 'base-sha' },
  });
  state = apply(state, WorkflowEventType.RUN_STARTED, {
    runId: 'git-run',
    kind: WorkflowRunKind.AUTOMATION,
    phase: WorkflowPhase.COMMITTING,
  });
  state = apply(state, WorkflowEventType.GIT_STATE_UPDATED, {
    runId: 'git-run',
    mode: 'merge',
    git: {
      checkpointShas: ['checkpoint-1'],
      ownedPaths: ['src/b.js', 'src/a.js'],
      pathStates: { 'src/a.js': { sha256: 'a' } },
      lastCommitMessage: 'Update workflow files',
    },
  });
  state = apply(state, WorkflowEventType.RUN_COMPLETED, { runId: 'git-run' });
  const snapshot = publicWorkflowState(state);
  assert.deepEqual(snapshot.git, {
    baseSha: 'base-sha',
    checkpointShas: ['checkpoint-1'],
    ownedPaths: ['src/a.js', 'src/b.js'],
    pathStates: { 'src/a.js': { sha256: 'a' } },
    lastCommitMessage: 'Update workflow files',
  });
  assert.equal(snapshot.lifecycle, WorkflowLifecycle.READY);
});
