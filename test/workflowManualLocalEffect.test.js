import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowManualOperations } from '../src/workflow/manualOperations.js';
import {
  WorkflowEffectStatus,
  WorkflowLifecycle,
  createWorkflowState,
  reduceWorkflowState,
} from '../src/workflow/state/workflowState.js';

function runtime() {
  return {
    id: 'workflow-manual-effect',
    config: {
      id: 'workflow-manual-effect',
      projectRoot: '/tmp/project',
      verification: { commands: [] },
    },
    workflowState: createWorkflowState({
      lifecycle: WorkflowLifecycle.READY,
      project: { root: '/tmp/project', fingerprintSha256: 'project-fingerprint' },
      subscription: { enabled: true },
    }),
  };
}

function transitionHarness() {
  let sequence = 0;
  return async (target, type, data = {}) => {
    sequence += 1;
    const outcome = reduceWorkflowState(target.workflowState, {
      eventId: `manual-event-${sequence}`,
      type,
      data,
      at: `2026-07-20T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    });
    if (!outcome.accepted) {
      throw Object.assign(new Error(outcome.diagnostics.at(-1)?.message || outcome.reason || 'transition rejected'), {
        code: outcome.diagnostics.at(-1)?.code || 'WORKFLOW_STATE_TRANSITION_REJECTED',
      });
    }
    target.workflowState = outcome.state;
    return outcome.state;
  };
}

test('manual artifact verification is a canonical LocalEffect and settles its owned run', async () => {
  const target = runtime();
  const transition = transitionHarness();
  const events = [];
  const operations = new WorkflowManualOperations({
    bridge: {},
    fileStore: {
      async getReadable(id) {
        assert.equal(id, 'file-result');
        return { id, absolutePath: '/tmp/result.zip', name: 'result.zip', size: 123, sha256: 'artifact-sha' };
      },
    },
    verifier: {
      async verify({ pipelineId }) {
        assert.match(pipelineId, /^verify_/);
        return { ok: true, reasons: [], zip: { sha256: 'verified-sha', entries: 3 }, overlapScore: 1 };
      },
    },
    enqueue: async (_workflowId, operation) => operation(),
    event: async (_workflowId, type, data) => events.push({ type, data }),
    transition,
  });

  const result = await operations.verify(target, { fileId: 'file-result' });

  assert.equal(result.ok, true);
  assert.equal(target.workflowState.lifecycle, WorkflowLifecycle.READY);
  assert.equal(target.workflowState.lastOutcome.code, 'manual_verification_passed');
  const effects = Object.values(target.workflowState.localEffects);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].kind, 'verify');
  assert.equal(effects[0].status, WorkflowEffectStatus.SUCCEEDED);
  assert.equal(effects[0].references.fileId, 'file-result');
  assert.deepEqual(events.map((item) => item.type), [
    'workflow.manual.verify.started',
    'workflow.manual.verify.completed',
  ]);
});

test('manual artifact verification cannot overlap another workflow run', async () => {
  const target = runtime();
  target.workflowState = {
    ...target.workflowState,
    lifecycle: WorkflowLifecycle.RUNNING,
    run: { id: 'existing-run', kind: 'guided', phase: 'prompting', cycle: 0, maxCycles: 1, startedAt: '', references: {} },
  };
  const operations = new WorkflowManualOperations({
    enqueue: async (_workflowId, operation) => operation(),
  });
  await assert.rejects(
    () => operations.verify(target, { fileId: 'file-result' }),
    (error) => error?.code === 'WORKFLOW_MANUAL_VERIFY_NOT_READY',
  );
});
