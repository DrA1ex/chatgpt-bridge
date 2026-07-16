import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatWorkflowDashboard,
  resolveWorkflowApproval,
  workflowDashboard,
  workflowHasBlockingAction,
  workflowHistoryFromEvents,
  workflowStage,
} from '../src/workflow/ux/workflowView.js';

function workflow(overrides = {}) {
  return {
    id: 'repair',
    projectRoot: '/tmp/project',
    configPath: '/tmp/project/bridge.workflow.json',
    sessionPolicy: 'current',
    restartPolicy: 'ask',
    automationInterrupted: false,
    automation: { id: '', status: 'idle', cycle: 0, maxCycles: 0, evidence: {} },
    pipeline: { id: '', status: 'idle' },
    ...overrides,
  };
}

test('workflow dashboard makes the next session and actions explicit while idle', () => {
  const view = workflowDashboard(workflow(), { currentSessionId: 'c/current' });
  assert.equal(view.stage.label, 'Idle');
  assert.equal(view.nextSession, 'c/current');
  assert.deepEqual(view.actions, ['/workflow run', '/session new', '/workflow history']);
  assert.match(formatWorkflowDashboard(workflow(), { currentSessionId: 'c/current' }), /Next run: c\/current/);
});

test('active workflow exposes immutable bound session instead of current interactive session', () => {
  const item = workflow({
    automation: {
      id: 'automation_1',
      status: 'waiting_turn',
      cycle: 2,
      maxCycles: 5,
      evidence: { sessionId: 'c/bound', sessionPolicy: 'current' },
    },
  });
  const view = workflowDashboard(item, { currentSessionId: 'c/new' });
  assert.equal(view.boundSessionId, 'c/bound');
  assert.equal(view.stage.label, 'Waiting for ChatGPT');
  assert.deepEqual(view.actions, ['/workflow stop', '/workflow show']);
  assert.equal(workflowHasBlockingAction(item), false, 'waiting for ChatGPT is not a blocking local action');
});

test('validation and apply stages require graceful shutdown confirmation', () => {
  assert.equal(workflowHasBlockingAction(workflow({ automation: { status: 'validating' } })), true);
  assert.equal(workflowHasBlockingAction(workflow({ automation: { status: 'applying' } })), true);
  assert.equal(workflowHasBlockingAction(workflow({ pipeline: { status: 'verifying' } })), true);
});

test('interrupted workflow presents only resume or discard', () => {
  const item = workflow({ automationInterrupted: true, automation: { id: 'automation_1', status: 'waiting_turn', cycle: 1, maxCycles: 5 } });
  const view = workflowDashboard(item, { currentSessionId: 'c/new' });
  assert.equal(workflowStage(item).label, 'Interrupted');
  assert.deepEqual(view.actions, ['/workflow resume', '/workflow discard']);
});

test('approval resolution is scoped to the current workflow and does not require ids for one approval', () => {
  const approval = resolveWorkflowApproval([
    { id: 'approval_a', workflowId: 'repair', status: 'pending' },
    { id: 'approval_b', workflowId: 'other', status: 'pending' },
  ], 'repair');
  assert.equal(approval.id, 'approval_a');
});

test('workflow history groups automation events into user-facing runs', () => {
  const history = workflowHistoryFromEvents([
    { time: '2026-01-01T00:00:00Z', type: 'workflow.automation.started', data: { automationId: 'automation_1', maxCycles: 5 } },
    { time: '2026-01-01T00:01:00Z', type: 'workflow.automation.validation.completed', data: { automationId: 'automation_1', cycle: 1 } },
    { time: '2026-01-01T00:02:00Z', type: 'workflow.automation.completed', data: { automationId: 'automation_1', cycle: 2 } },
  ]);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'succeeded');
  assert.equal(history[0].cycle, 2);
});
