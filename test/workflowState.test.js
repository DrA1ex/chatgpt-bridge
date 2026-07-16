import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkflowPipelineStatus,
  WorkflowStateEventType,
  WorkflowWatcherStatus,
  createWorkflowState,
  reduceWorkflowState,
  restoreWorkflowState,
} from '../src/workflow/state/workflowState.js';

function apply(state, type, data = {}, at = '2026-07-14T10:00:00.000Z') {
  const outcome = reduceWorkflowState(state, { type, data, at });
  assert.equal(outcome.accepted, true, JSON.stringify(outcome.diagnostics));
  return outcome.state;
}

test('watcher and pipeline states remain independent through terminal outcomes', () => {
  let state = createWorkflowState({ watcherStatus: WorkflowWatcherStatus.RUNNING });
  state = apply(state, WorkflowStateEventType.PIPELINE_STARTED, {
    pipelineId: 'pipeline-1', status: WorkflowPipelineStatus.DOWNLOADING,
  });
  assert.equal(state.watcher.status, WorkflowWatcherStatus.RUNNING);
  assert.equal(state.pipeline.status, WorkflowPipelineStatus.DOWNLOADING);

  state = apply(state, WorkflowStateEventType.PIPELINE_STAGE_CHANGED, {
    pipelineId: 'pipeline-1', status: WorkflowPipelineStatus.AWAITING_APPROVAL, approvalId: 'approval-1',
  });
  assert.equal(state.watcher.status, WorkflowWatcherStatus.RUNNING);
  assert.equal(state.pipeline.status, WorkflowPipelineStatus.AWAITING_APPROVAL);

  state = apply(state, WorkflowStateEventType.PIPELINE_FAILED, {
    pipelineId: 'pipeline-1', code: 'verification_failed', message: 'ZIP identity did not match',
  });
  assert.equal(state.watcher.status, WorkflowWatcherStatus.RUNNING);
  assert.equal(state.pipeline.status, WorkflowPipelineStatus.FAILED);
  assert.equal(state.lastOutcome.code, 'verification_failed');
});

test('new pipeline replaces a terminal pipeline but stale pipeline updates are rejected', () => {
  let state = createWorkflowState();
  state = apply(state, WorkflowStateEventType.PIPELINE_STARTED, { pipelineId: 'pipeline-1' });
  state = apply(state, WorkflowStateEventType.PIPELINE_COMPLETED, { pipelineId: 'pipeline-1' });
  state = apply(state, WorkflowStateEventType.PIPELINE_STARTED, {
    pipelineId: 'pipeline-2', status: WorkflowPipelineStatus.VERIFYING,
  });
  const stale = reduceWorkflowState(state, {
    type: WorkflowStateEventType.PIPELINE_STAGE_CHANGED,
    data: { pipelineId: 'pipeline-1', status: WorkflowPipelineStatus.APPLYING },
  });
  assert.equal(stale.accepted, false);
  assert.equal(stale.diagnostics[0].code, 'pipeline_id_mismatch');
  assert.equal(state.pipeline.id, 'pipeline-2');
});

test('a new pipeline cannot replace an active approval pipeline', () => {
  let state = createWorkflowState();
  state = apply(state, WorkflowStateEventType.PIPELINE_STARTED, { pipelineId: 'pipeline-1' });
  state = apply(state, WorkflowStateEventType.PIPELINE_STAGE_CHANGED, {
    pipelineId: 'pipeline-1', status: WorkflowPipelineStatus.AWAITING_APPROVAL, approvalId: 'approval-1',
  });
  const replacement = reduceWorkflowState(state, {
    type: WorkflowStateEventType.PIPELINE_STARTED,
    data: { pipelineId: 'pipeline-2' },
  });
  assert.equal(replacement.accepted, false);
  assert.equal(replacement.diagnostics[0].code, 'pipeline_already_active');
  assert.equal(state.pipeline.id, 'pipeline-1');
  assert.equal(state.pipeline.status, WorkflowPipelineStatus.AWAITING_APPROVAL);
});

test('structured workflow snapshots restore without status-only compatibility inference', () => {
  const original = createWorkflowState({
    watcherStatus: WorkflowWatcherStatus.STOPPED,
    pipelineStatus: WorkflowPipelineStatus.AWAITING_APPROVAL,
    pipelineId: 'pipeline-approval',
    approvalId: 'approval-1',
    revision: 7,
  });
  const restored = restoreWorkflowState(original);
  assert.equal(restored.watcher.status, WorkflowWatcherStatus.STOPPED);
  assert.equal(restored.pipeline.status, WorkflowPipelineStatus.AWAITING_APPROVAL);
  assert.equal(restored.pipeline.id, 'pipeline-approval');
  assert.equal(restored.revision, 7);
  assert.throws(() => restoreWorkflowState({ status: 'watching' }), /structured watcher\/pipeline snapshot/);
});

test('automation lifecycle is independent from passive watcher and artifact pipeline state', () => {
  let state = createWorkflowState({ watcherStatus: WorkflowWatcherStatus.RUNNING });
  state = apply(state, WorkflowStateEventType.AUTOMATION_STARTED, {
    automationId: 'automation-1',
    status: 'validating',
    cycle: 1,
    maxCycles: 3,
  });
  assert.equal(state.watcher.status, WorkflowWatcherStatus.RUNNING);
  assert.equal(state.pipeline.status, WorkflowPipelineStatus.IDLE);
  assert.equal(state.automation.status, 'validating');

  state = apply(state, WorkflowStateEventType.PIPELINE_STARTED, {
    pipelineId: 'pipeline-automation', status: WorkflowPipelineStatus.APPLYING,
  });
  state = apply(state, WorkflowStateEventType.AUTOMATION_STAGE_CHANGED, {
    automationId: 'automation-1', status: 'applying', cycle: 1, turnId: 'turn-1',
  });
  assert.equal(state.pipeline.status, WorkflowPipelineStatus.APPLYING);
  assert.equal(state.automation.status, 'applying');

  state = apply(state, WorkflowStateEventType.PIPELINE_COMPLETED, { pipelineId: 'pipeline-automation' });
  state = apply(state, WorkflowStateEventType.AUTOMATION_STAGE_CHANGED, {
    automationId: 'automation-1', status: 'validating', cycle: 2,
  });
  state = apply(state, WorkflowStateEventType.AUTOMATION_COMPLETED, {
    automationId: 'automation-1', evidence: { cycle: 2 },
  });
  assert.equal(state.watcher.status, WorkflowWatcherStatus.RUNNING);
  assert.equal(state.pipeline.status, WorkflowPipelineStatus.COMPLETED);
  assert.equal(state.automation.status, 'completed');
  assert.equal(state.automation.cycle, 2);
});

test('active automation cannot be replaced and restores from structured snapshots', () => {
  let state = createWorkflowState();
  state = apply(state, WorkflowStateEventType.AUTOMATION_STARTED, {
    automationId: 'automation-1', status: 'waiting_turn', cycle: 2, maxCycles: 5, threadId: 'thread-1',
  });
  const replacement = reduceWorkflowState(state, {
    type: WorkflowStateEventType.AUTOMATION_STARTED,
    data: { automationId: 'automation-2', status: 'validating' },
  });
  assert.equal(replacement.accepted, false);
  assert.equal(replacement.diagnostics[0].code, 'automation_already_active');

  const restored = restoreWorkflowState(state);
  assert.equal(restored.automation.id, 'automation-1');
  assert.equal(restored.automation.status, 'waiting_turn');
  assert.equal(restored.automation.cycle, 2);
  assert.equal(restored.automation.threadId, 'thread-1');
});

test('workflow state restore preserves the public snapshot revision field', () => {
  const restored = restoreWorkflowState({
    watcher: { status: 'running', updatedAt: '2026-07-16T00:00:00.000Z' },
    pipeline: { id: '', status: 'idle', revision: 0, updatedAt: '2026-07-16T00:00:00.000Z', approvalId: '', terminal: null, evidence: {} },
    automation: { id: '', status: 'idle', revision: 0, cycle: 0, maxCycles: 0, updatedAt: '2026-07-16T00:00:00.000Z', evidence: {} },
    workflowStateRevision: 17,
  });
  assert.equal(restored.revision, 17);
});
