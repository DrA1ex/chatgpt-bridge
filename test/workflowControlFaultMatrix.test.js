import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkflowState,
  reduceWorkflowState,
  WorkflowEffectKind,
  WorkflowEffectStatus,
  WorkflowEventType,
  WorkflowLifecycle,
  WorkflowLocalEffectKind,
  WorkflowPhase,
  WorkflowRunKind,
} from '../src/workflow/state/workflowState.js';

let id = 0;
function event(type, data = {}) {
  id += 1;
  return { eventId: `control-matrix-${id}`, type, data, at: '2026-07-19T01:00:00.000Z' };
}
function apply(state, type, data = {}) {
  const result = reduceWorkflowState(state, event(type, data));
  assert.equal(result.accepted, true, JSON.stringify(result.diagnostics));
  return result.state;
}
function reject(state, type, data, code) {
  const result = reduceWorkflowState(state, event(type, data));
  assert.equal(result.accepted, false);
  assert.equal(result.diagnostics[0].code, code);
  return result.state;
}
function running() {
  let state = createWorkflowState({ lifecycle: WorkflowLifecycle.READY });
  return apply(state, WorkflowEventType.RUN_STARTED, {
    runId: 'run-control', kind: WorkflowRunKind.MANUAL, phase: WorkflowPhase.APPLYING,
  });
}

function addBrowserEffect(state, status) {
  state = apply(state, WorkflowEventType.EFFECT_PLANNED, {
    runId: 'run-control', effectId: 'browser-1', kind: WorkflowEffectKind.APPLY,
    idempotencyKey: 'browser-key', preconditionsHash: 'guards', safe: false,
  });
  if (status !== WorkflowEffectStatus.PLANNED) state = apply(state, WorkflowEventType.EFFECT_DISPATCHED, { effectId: 'browser-1' });
  if (status === WorkflowEffectStatus.SUCCEEDED) state = apply(state, WorkflowEventType.EFFECT_SUCCEEDED, { effectId: 'browser-1', attempt: 1 });
  if (status === WorkflowEffectStatus.FAILED) state = apply(state, WorkflowEventType.EFFECT_FAILED, { effectId: 'browser-1', attempt: 1 });
  if (status === WorkflowEffectStatus.UNCERTAIN) state = apply(state, WorkflowEventType.EFFECT_UNCERTAIN, { effectId: 'browser-1', attempt: 1 });
  if (status === WorkflowEffectStatus.CANCELLED) state = apply(state, WorkflowEventType.EFFECT_CANCELLED, { effectId: 'browser-1', reconciliation: 'proved_not_started' });
  return state;
}

function addLocalEffect(state, status) {
  state = apply(state, WorkflowEventType.LOCAL_EFFECT_PLANNED, {
    runId: 'run-control', localEffectId: 'local-1', kind: WorkflowLocalEffectKind.APPLY,
    idempotencyKey: 'local-key', preconditionsHash: 'guards', safe: false,
  });
  if (status !== WorkflowEffectStatus.PLANNED) state = apply(state, WorkflowEventType.LOCAL_EFFECT_DISPATCHED, { localEffectId: 'local-1' });
  if (status === WorkflowEffectStatus.SUCCEEDED) state = apply(state, WorkflowEventType.LOCAL_EFFECT_SUCCEEDED, { localEffectId: 'local-1', attempt: 1 });
  if (status === WorkflowEffectStatus.FAILED) state = apply(state, WorkflowEventType.LOCAL_EFFECT_FAILED, { localEffectId: 'local-1', attempt: 1 });
  if (status === WorkflowEffectStatus.UNCERTAIN) state = apply(state, WorkflowEventType.LOCAL_EFFECT_UNCERTAIN, { localEffectId: 'local-1', attempt: 1 });
  if (status === WorkflowEffectStatus.CANCELLED) state = apply(state, WorkflowEventType.LOCAL_EFFECT_CANCELLED, { localEffectId: 'local-1', reconciliation: 'proved_not_started' });
  return state;
}

for (const control of ['pause', 'stop']) {
  const requested = control === 'pause' ? WorkflowEventType.PAUSE_REQUESTED : WorkflowEventType.STOP_REQUESTED;
  const completed = control === 'pause' ? WorkflowEventType.PAUSED : WorkflowEventType.STOPPED;
  const barrierCode = control === 'pause' ? 'workflow_pause_barrier_pending' : 'workflow_stop_barrier_pending';

  for (const [owner, add] of [['browser', addBrowserEffect], ['local', addLocalEffect]]) {
    for (const status of [WorkflowEffectStatus.DISPATCHED, WorkflowEffectStatus.UNCERTAIN]) {
      test(`${control} remains behind the settlement barrier for ${owner} ${status} effects`, () => {
        let state = add(running(), status);
        state = apply(state, requested, { runId: 'run-control', reason: `${control} requested` });
        const unchanged = reject(state, completed, { runId: 'run-control' }, barrierCode);
        assert.equal(unchanged.lifecycle, control === 'pause' ? WorkflowLifecycle.RECOVERING : WorkflowLifecycle.RUNNING);
        assert.equal(unchanged.control[`${control}Requested`], true);
      });
    }

    for (const status of [WorkflowEffectStatus.SUCCEEDED, WorkflowEffectStatus.FAILED, WorkflowEffectStatus.CANCELLED]) {
      test(`${control} may complete after ${owner} effect settles as ${status}`, () => {
        let state = add(running(), status);
        state = apply(state, requested, { runId: 'run-control', reason: `${control} requested` });
        state = apply(state, completed, { runId: 'run-control' });
        assert.equal(state.lifecycle, control === 'pause' ? WorkflowLifecycle.PAUSED : WorkflowLifecycle.STOPPED);
      });
    }
  }

  test(`${control} cancels planned effects and blocks every new effect intent`, () => {
    let state = addBrowserEffect(running(), WorkflowEffectStatus.PLANNED);
    state = apply(state, WorkflowEventType.LOCAL_EFFECT_PLANNED, {
      runId: 'run-control', localEffectId: 'local-1', kind: WorkflowLocalEffectKind.APPLY,
      idempotencyKey: 'local-key', preconditionsHash: 'guards', safe: false,
    });
    state = apply(state, requested, { runId: 'run-control' });
    assert.equal(state.effects['browser-1'].status, WorkflowEffectStatus.CANCELLED);
    assert.equal(state.localEffects['local-1'].status, WorkflowEffectStatus.CANCELLED);
    reject(state, WorkflowEventType.EFFECT_PLANNED, {
      runId: 'run-control', effectId: 'late-browser', kind: WorkflowEffectKind.PROMPT,
      idempotencyKey: 'late-browser', preconditionsHash: 'guards',
    }, 'effect_blocked_by_control');
    reject(state, WorkflowEventType.LOCAL_EFFECT_PLANNED, {
      runId: 'run-control', localEffectId: 'late-local', kind: WorkflowLocalEffectKind.CHECKS,
      idempotencyKey: 'late-local', preconditionsHash: 'guards',
    }, 'local_effect_blocked_by_control');
    state = apply(state, completed, { runId: 'run-control' });
    assert.equal(state.lifecycle, control === 'pause' ? WorkflowLifecycle.PAUSED : WorkflowLifecycle.STOPPED);
  });
}
