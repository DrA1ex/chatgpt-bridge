import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkflowPipelineStatus,
  WorkflowStateEventType,
  WorkflowWatcherStatus,
  createWorkflowState,
  legacyWorkflowStatus,
  reduceWorkflowState,
  restoreWorkflowState,
} from '../src/workflow/state/workflowState.js';

function apply(state, type, data = {}, at = '2026-07-14T10:00:00.000Z') {
  const outcome = reduceWorkflowState(state, { type, data, at });
  assert.equal(outcome.accepted, true, JSON.stringify(outcome.diagnostics));
  return outcome.state;
}

test('watcher and pipeline states are independent while legacy status stays compatible', () => {
  let state = createWorkflowState({ watcherStatus: WorkflowWatcherStatus.RUNNING });
  state = apply(state, WorkflowStateEventType.PIPELINE_STARTED, {
    pipelineId: 'pipeline-1',
    status: WorkflowPipelineStatus.DOWNLOADING,
  });
  assert.equal(legacyWorkflowStatus(state), 'processing');

  state = apply(state, WorkflowStateEventType.PIPELINE_STAGE_CHANGED, {
    pipelineId: 'pipeline-1',
    status: WorkflowPipelineStatus.AWAITING_APPROVAL,
    approvalId: 'approval-1',
  });
  assert.equal(state.watcher.status, WorkflowWatcherStatus.RUNNING);
  assert.equal(legacyWorkflowStatus(state), 'awaiting-approval');

  state = apply(state, WorkflowStateEventType.PIPELINE_FAILED, {
    pipelineId: 'pipeline-1',
    code: 'verification_failed',
    message: 'ZIP identity did not match',
  });
  assert.equal(state.watcher.status, WorkflowWatcherStatus.RUNNING);
  assert.equal(state.pipeline.status, WorkflowPipelineStatus.FAILED);
  assert.equal(legacyWorkflowStatus(state), 'watching');
  assert.equal(state.lastOutcome.code, 'verification_failed');
});

test('new pipeline replaces a terminal pipeline but stale pipeline updates are rejected', () => {
  let state = createWorkflowState();
  state = apply(state, WorkflowStateEventType.PIPELINE_STARTED, { pipelineId: 'pipeline-1' });
  state = apply(state, WorkflowStateEventType.PIPELINE_COMPLETED, { pipelineId: 'pipeline-1' });
  state = apply(state, WorkflowStateEventType.PIPELINE_STARTED, {
    pipelineId: 'pipeline-2',
    status: WorkflowPipelineStatus.VERIFYING,
  });
  const stale = reduceWorkflowState(state, {
    type: WorkflowStateEventType.PIPELINE_STAGE_CHANGED,
    data: { pipelineId: 'pipeline-1', status: WorkflowPipelineStatus.APPLYING },
  });
  assert.equal(stale.accepted, false);
  assert.equal(stale.diagnostics[0].code, 'pipeline_id_mismatch');
  assert.equal(state.pipeline.id, 'pipeline-2');
});

test('legacy persisted workflow statuses restore into the separated state model', () => {
  const approval = restoreWorkflowState({ status: 'awaiting-approval', lastPipelineId: 'pipeline-approval' });
  assert.equal(approval.watcher.status, WorkflowWatcherStatus.RUNNING);
  assert.equal(approval.pipeline.status, WorkflowPipelineStatus.AWAITING_APPROVAL);
  assert.equal(legacyWorkflowStatus(approval), 'awaiting-approval');

  const stopped = restoreWorkflowState({ status: 'stopped' });
  assert.equal(stopped.watcher.status, WorkflowWatcherStatus.STOPPED);
  assert.equal(legacyWorkflowStatus(stopped), 'stopped');
});
