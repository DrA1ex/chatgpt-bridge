import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPassivePromptBody, findWorkflowWaitOutcome, markReportInterrupted, workflowProgressFromEvents } from '../scripts/e2e-workflow-support.js';

test('passive workflow prompt body requires effort to be supplied explicitly', () => {
  assert.throws(() => buildPassivePromptBody({ message: 'x', sessionId: 's', sourceClientId: 'c' }), /effort must be passed explicitly/);
  assert.deepEqual(buildPassivePromptBody({ message: 'x', sessionId: 's', sourceClientId: 'c', effort: '' }), {
    message: 'x', sessionId: 's', sourceClientId: 'c', effort: '',
  });
});

test('workflow progress summarizes which pipeline stages actually ran', () => {
  const progress = workflowProgressFromEvents([
    { type: 'workflow.turn.observed' },
    { type: 'workflow.artifact.download.completed' },
    { type: 'workflow.approval.required' },
  ], { submittedUserTurnKey: 'user-1', approvals: [{ status: 'pending' }] });
  assert.equal(progress.passivePromptSubmitted, true);
  assert.equal(progress.artifactObserved, true);
  assert.equal(progress.artifactDownloaded, true);
  assert.equal(progress.approvalCreated, true);
  assert.equal(progress.pendingApprovals, 1);
  assert.equal(progress.applyStarted, false);
});

test('interrupted E2E reports mark running scenarios and the run itself', () => {
  const report = { status: 'running', scenarios: [{ id: 'a', status: 'running' }, { id: 'b', status: 'passed' }] };
  const timeline = [];
  markReportInterrupted(report, timeline, 'SIGTERM', '2026-07-14T00:00:00.000Z');
  assert.equal(report.status, 'interrupted');
  assert.equal(report.scenarios[0].status, 'interrupted');
  assert.equal(report.scenarios[1].status, 'passed');
  assert.equal(timeline[0].type, 'run.interrupted');
});


test('workflow waits prefer success and fail immediately on a new terminal event', () => {
  const failed = { type: 'workflow.context.sync.failed', data: { message: 'bad acknowledgement' } };
  const first = findWorkflowWaitOutcome([{ type: 'workflow.loaded' }, failed], {
    predicate: (event) => event.type === 'workflow.context.sync.completed',
    fatalTypes: ['workflow.context.sync.failed'],
    fatalCandidates: [failed],
  });
  assert.equal(first.matched, null);
  assert.equal(first.fatal, failed);

  const completed = { type: 'workflow.context.sync.completed' };
  const second = findWorkflowWaitOutcome([failed, completed], {
    predicate: (event) => event.type === 'workflow.context.sync.completed',
    fatalTypes: ['workflow.context.sync.failed'],
    fatalCandidates: [failed, completed],
  });
  assert.equal(second.matched, completed);
  assert.equal(second.fatal, null);
});
