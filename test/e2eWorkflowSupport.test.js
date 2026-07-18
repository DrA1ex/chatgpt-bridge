import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPassivePromptBody, findWorkflowWaitOutcome, markReportInterrupted, workflowProgressFromEvents } from '../scripts/e2e-workflow-support.js';

test('passive workflow prompt body requires effort to be supplied explicitly', () => {
  assert.throws(() => buildPassivePromptBody({ message: 'x', sessionId: 's', sourceClientId: 'c' }), /effort must be passed explicitly/);
  assert.deepEqual(buildPassivePromptBody({ message: 'x', sessionId: 's', sourceClientId: 'c', effort: '' }), {
    message: 'x', sessionId: 's', sourceClientId: 'c', effort: '',
  });
  assert.deepEqual(buildPassivePromptBody({ message: 'x', sessionId: 's', sourceClientId: 'c', effort: '', timeoutMs: 60_000 }), {
    message: 'x', sessionId: 's', sourceClientId: 'c', effort: '', timeoutMs: 60_000,
  });
});

test('workflow progress summarizes which run stages actually ran', () => {
  const progress = workflowProgressFromEvents([
    { type: 'workflow.turn.observed' },
    { type: 'workflow.artifact.download.completed' },
    { type: 'workflow.action.required' },
  ], { submittedUserTurnKey: 'user-1', actions: [{ status: 'pending' }] });
  assert.equal(progress.passivePromptSubmitted, true);
  assert.equal(progress.artifactObserved, true);
  assert.equal(progress.artifactDownloaded, true);
  assert.equal(progress.actionRequired, true);
  assert.equal(progress.pendingActions, 1);
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


test('workflow waits prefer success and use committed v3 outcome for terminal failure', () => {
  const failed = { type: 'workflow.artifact.verify.failed', data: { runId: 'run-1', workflowStateRevision: 4 } };
  const workflow = {
    workflowStateRevision: 4,
    lifecycle: 'ready',
    phase: 'none',
    lastOutcome: { runId: 'run-1', status: 'failed', code: 'artifact_verification_failed', message: 'bad artifact' },
  };
  const first = findWorkflowWaitOutcome([{ type: 'workflow.loaded' }, failed], {
    predicate: (event) => event.type === 'workflow.completed',
    fatalCandidates: [failed],
    workflow,
    successOutcomeStatuses: ['completed'],
  });
  assert.equal(first.matched, null);
  assert.equal(first.fatal.data.outcomeStatus, 'failed');
  assert.equal(first.fatal.data.code, 'artifact_verification_failed');

  const completed = { type: 'workflow.completed', data: { pipelineId: 'pipeline-1', workflowStateRevision: 5 } };
  const second = findWorkflowWaitOutcome([failed, completed], {
    predicate: (event) => event.type === 'workflow.completed',
    fatalCandidates: [failed, completed],
    workflow: {
      workflowStateRevision: 5,
      lifecycle: 'ready',
      phase: 'none',
      lastOutcome: { runId: 'run-1', status: 'completed', code: 'completed' },
    },
    successOutcomeStatuses: ['completed'],
  });
  assert.equal(second.matched, completed);
  assert.equal(second.fatal, null);
});
