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
import { executeWorkflowEffect } from '../src/workflow/state/workflowEffects.js';
import { executeLocalEffect } from '../src/workflow/state/localEffects.js';

let sequence = 0;
function event(type, data = {}) {
  sequence += 1;
  return { eventId: `fault-${sequence}`, type, data, at: '2026-07-19T00:00:00.000Z' };
}

function runtime() {
  let state = createWorkflowState({ lifecycle: WorkflowLifecycle.READY });
  state = reduceWorkflowState(state, event(WorkflowEventType.RUN_STARTED, {
    runId: 'run-fault', kind: WorkflowRunKind.MANUAL, phase: WorkflowPhase.APPLYING,
  })).state;
  return { workflowState: state };
}

function reducerTransition({ failType = '', failCount = 1 } = {}) {
  let remaining = failCount;
  return async (target, type, data) => {
    if (type === failType && remaining > 0) {
      remaining -= 1;
      throw Object.assign(new Error(`Injected persistence failure for ${type}`), { code: 'INJECTED_TRANSITION_FAILURE' });
    }
    const outcome = reduceWorkflowState(target.workflowState, event(type, data));
    assert.equal(outcome.accepted, true, JSON.stringify(outcome.diagnostics));
    target.workflowState = outcome.state;
    return outcome.state;
  };
}

const workflowEffect = {
  id: 'browser-write-1',
  kind: WorkflowEffectKind.APPLY,
  safe: false,
  idempotencyKey: 'browser-write-key',
  preconditionsHash: 'project-fingerprint-1',
};

const localEffect = {
  id: 'local-write-1',
  kind: WorkflowLocalEffectKind.APPLY,
  safe: false,
  idempotencyKey: 'local-write-key',
  preconditionsHash: 'project-fingerprint-1',
};

for (const [label, executeEffect, effect, plannedType, dispatchedType, succeededType, failedType, uncertainType, collection] of [
  ['workflow', executeWorkflowEffect, workflowEffect, WorkflowEventType.EFFECT_PLANNED, WorkflowEventType.EFFECT_DISPATCHED, WorkflowEventType.EFFECT_SUCCEEDED, WorkflowEventType.EFFECT_FAILED, WorkflowEventType.EFFECT_UNCERTAIN, 'effects'],
  ['local', executeLocalEffect, localEffect, WorkflowEventType.LOCAL_EFFECT_PLANNED, WorkflowEventType.LOCAL_EFFECT_DISPATCHED, WorkflowEventType.LOCAL_EFFECT_SUCCEEDED, WorkflowEventType.LOCAL_EFFECT_FAILED, WorkflowEventType.LOCAL_EFFECT_UNCERTAIN, 'localEffects'],
]) {
  test(`${label} effect never executes when intent persistence fails`, async () => {
    const target = runtime();
    let calls = 0;
    await assert.rejects(
      executeEffect({
        transition: reducerTransition({ failType: plannedType }), target, runtime: target, effect,
        execute: async () => { calls += 1; return { ok: true }; },
      }),
      /Injected persistence failure/,
    );
    assert.equal(calls, 0);
    assert.equal(target.workflowState[collection][effect.id], undefined);
  });

  test(`${label} effect never executes when dispatch persistence fails`, async () => {
    const target = runtime();
    let calls = 0;
    await assert.rejects(
      executeEffect({
        transition: reducerTransition({ failType: dispatchedType }), runtime: target, effect,
        execute: async () => { calls += 1; return { ok: true }; },
      }),
      /Injected persistence failure/,
    );
    assert.equal(calls, 0);
    assert.equal(target.workflowState[collection][effect.id].status, WorkflowEffectStatus.PLANNED);
  });

  test(`${label} effect leaves a dispatched recovery boundary when success persistence fails`, async () => {
    const target = runtime();
    let calls = 0;
    await assert.rejects(
      executeEffect({
        transition: reducerTransition({ failType: succeededType }), runtime: target, effect,
        execute: async () => { calls += 1; return { ok: true, marker: label }; },
      }),
      (error) => error?.uncertain === true && /RESULT_COMMIT_FAILED$/.test(error?.code || ''),
    );
    assert.equal(calls, 1);
    assert.equal(target.workflowState[collection][effect.id].status, WorkflowEffectStatus.DISPATCHED);
  });

  test(`${label} effect leaves a dispatched recovery boundary when failure persistence fails`, async () => {
    const target = runtime();
    let calls = 0;
    const executionError = Object.assign(new Error(`${label} write failed`), { code: 'WRITE_FAILED' });
    await assert.rejects(
      executeEffect({
        transition: reducerTransition({ failType: failedType }), runtime: target, effect,
        execute: async () => { calls += 1; throw executionError; },
      }),
      (error) => error?.uncertain === true
        && /RESULT_COMMIT_FAILED$/.test(error?.code || '')
        && error?.executionError === executionError,
    );
    assert.equal(calls, 1);
    assert.equal(target.workflowState[collection][effect.id].status, WorkflowEffectStatus.DISPATCHED);
  });

  test(`${label} effect leaves a dispatched recovery boundary when uncertain persistence fails`, async () => {
    const target = runtime();
    let calls = 0;
    const executionError = Object.assign(new Error(`${label} outcome unknown`), { code: 'EFFECT_OUTCOME_UNKNOWN', uncertain: true });
    await assert.rejects(
      executeEffect({
        transition: reducerTransition({ failType: uncertainType }), runtime: target, effect,
        execute: async () => { calls += 1; throw executionError; },
      }),
      (error) => error?.uncertain === true
        && /RESULT_COMMIT_FAILED$/.test(error?.code || '')
        && error?.executionError === executionError,
    );
    assert.equal(calls, 1);
    assert.equal(target.workflowState[collection][effect.id].status, WorkflowEffectStatus.DISPATCHED);
  });

}
