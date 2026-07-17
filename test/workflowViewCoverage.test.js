import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatWorkflowDashboard,
  formatWorkflowHistory,
  resolveWorkflowApproval,
  selectWorkflow,
  workflowDashboard,
  workflowHistoryFromEvents,
  workflowListLines,
  workflowNextActions,
  workflowStage,
} from '../src/workflow/ux/workflowView.js';

function workflow(overrides = {}) {
  return {
    id: 'workflow-1',
    label: 'Fix project checks',
    projectRoot: '/tmp/project',
    configPath: '/tmp/workflow.json',
    automation: { id: '', status: 'idle', cycle: 0, maxCycles: 0, evidence: {} },
    pipeline: { status: 'idle' },
    workflowCommitShas: [],
    ...overrides,
  };
}

test('plain-language stage labels cover every workflow and pipeline state', () => {
  const automation = {
    validating: 'Running project checks', waiting_turn: 'Waiting for ChatGPT',
    awaiting_approval: 'Waiting for your decision', applying: 'Applying changes',
    completed: 'Completed', failed: 'Stopped with an error', stopped: 'Stopped',
  };
  for (const [status, label] of Object.entries(automation)) {
    assert.equal(workflowStage(workflow({ automation: { status } })).label, label);
  }
  const pipeline = {
    observed: 'Checking the ChatGPT response', downloading: 'Downloading returned files',
    verifying: 'Checking returned files', planning: 'Preparing changes', applying: 'Applying changes',
    remediating: 'Requesting a corrected result', recovering: 'Starting a new ChatGPT chat',
    rolling_back: 'Restoring the previous project state', completed: 'Last update completed',
    failed: 'Last update stopped with an error', rejected: 'Last update was rejected',
  };
  for (const [status, label] of Object.entries(pipeline)) {
    assert.equal(workflowStage(workflow({ pipeline: { status } })).label, label);
  }
  assert.equal(workflowStage(workflow({ attention: { required: true } })).label, 'Waiting for your decision');
  assert.equal(workflowStage(workflow({ automationInterrupted: true })).label, 'Paused');

  const deferred = workflow({
    preset: 'apply-changes',
    watcher: { status: 'running' },
    pipeline: { status: 'failed', terminal: { code: 'artifact_materialization_deferred', message: 'Preview timed out' } },
    lastError: '',
    attention: null,
  });
  assert.equal(workflowStage(deferred).label, 'Watching the ChatGPT tab · waiting for another result');
  assert.deepEqual(workflowDashboard(deferred).actions, [
    'Continue chatting in the selected ChatGPT browser tab. Bridge is watching for new completed responses and result packages.',
    'Open /workflow to inspect, pause, or stop this workflow',
  ]);
  assert.equal(workflowDashboard(deferred).error, '');
});

test('workflow selection and approval resolution reject ambiguous or unknown choices', () => {
  const first = workflow({ id: 'first' });
  const second = workflow({ id: 'second' });
  assert.equal(selectWorkflow([], ''), null);
  assert.equal(selectWorkflow([first], ''), first);
  assert.equal(selectWorkflow([first, second], 'second'), second);
  assert.throws(() => selectWorkflow([first, second], ''), /Multiple workflows/);
  assert.throws(() => selectWorkflow([first], 'missing'), /Unknown workflow/);

  const approvals = [
    { id: 'a1', workflowId: 'first', status: 'pending' },
    { id: 'a2', workflowId: 'first', status: 'pending' },
    { id: 'done', workflowId: 'first', status: 'approved' },
  ];
  assert.equal(resolveWorkflowApproval(approvals, 'first', 'a2').id, 'a2');
  assert.throws(() => resolveWorkflowApproval(approvals, 'first'), /Multiple approvals/);
  assert.throws(() => resolveWorkflowApproval(approvals, 'other'), /No pending approval/);
  assert.throws(() => resolveWorkflowApproval(approvals, 'first', 'missing'), /Unknown pending/);
});

test('dashboard presents approvals, sync, checkpoints, errors, and actionable state', () => {
  const item = workflow({
    contextSyncFingerprint: 'sha256',
    workflowCommitShas: ['one', 'two'],
    lastError: 'Tests failed',
    attention: { required: true, kind: 'checks-failed' },
    pipeline: { status: 'awaiting_approval' },
  });
  const approval = {
    id: 'approval-1', workflowId: item.id, status: 'pending',
    plan: { counts: { create: 1, update: 2, delete: 3 }, policyReasons: ['manual review required'] },
  };
  const view = workflowDashboard(item, { approvals: [approval], currentSessionId: 'session-current' });
  assert.equal(view.projectSync, 'Up to date');
  assert.equal(view.checkpointCount, 2);
  assert.equal(view.error, 'Tests failed');
  assert.equal(view.approval, approval);
  assert.deepEqual(workflowNextActions(item), ['Open /workflow to choose what happens next']);

  const output = formatWorkflowDashboard(item, { approvals: [approval], currentSessionId: 'session-current' });
  assert.match(output, /WORKFLOW · Fix project checks/);
  assert.match(output, /2 checkpoints/);
  assert.match(output, /create 1 · update 2 · delete 3/);
  assert.match(output, /manual review required/);
});

test('workflow lists and run history cover success, failure, stop, interruption, sorting, and limits', () => {
  assert.deepEqual(workflowListLines([]), ['No workflows are loaded.']);
  assert.match(workflowListLines([workflow({ automation: { status: 'validating', cycle: 2, maxCycles: 8 } })])[0], /cycle 2\/8/);

  const events = [
    { time: '2026-07-17T00:00:00Z', type: 'workflow.automation.started', data: { automationId: 'success', maxCycles: 5 } },
    { time: '2026-07-17T00:01:00Z', type: 'workflow.automation.completed', data: { automationId: 'success', cycle: 2 } },
    { time: '2026-07-17T01:00:00Z', type: 'workflow.automation.started', data: { automationId: 'failure', maxCycles: 5 } },
    { time: '2026-07-17T01:01:00Z', type: 'workflow.automation.failed', data: { automationId: 'failure', cycle: 3, message: 'Checks still fail' } },
    { time: '2026-07-17T02:00:00Z', type: 'workflow.automation.started', data: { automationId: 'stopped' } },
    { time: '2026-07-17T02:01:00Z', type: 'workflow.automation.stopped', data: { automationId: 'stopped', reason: 'User stopped it' } },
    { time: '2026-07-17T03:00:00Z', type: 'workflow.automation.started', data: { automationId: 'interrupted' } },
    { time: '2026-07-17T03:01:00Z', type: 'workflow.automation.interrupted', data: { automationId: 'interrupted' } },
    { time: '2026-07-17T04:00:00Z', type: 'unrelated.event', data: { automationId: 'ignored' } },
  ];
  const history = workflowHistoryFromEvents(events, 3);
  assert.deepEqual(history.map((item) => item.status), ['interrupted', 'stopped', 'failed']);
  assert.equal(history[2].error, 'Checks still fail');
  assert.match(formatWorkflowHistory(history), /Recent workflow runs/);
  assert.match(formatWorkflowHistory(history), /User stopped it/);
  assert.equal(formatWorkflowHistory([]), 'No workflow runs have been recorded.');
});
