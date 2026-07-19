import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowRemoteTransportService } from '../src/workflow/services/remoteTransportService.js';
import {
  WorkflowActionKind,
  WorkflowEventType,
  WorkflowLifecycle,
  WorkflowPhase,
  WorkflowRunKind,
  createWorkflowState,
  reduceWorkflowState,
} from '../src/workflow/state/workflowState.js';

function activeRuntime() {
  let state = createWorkflowState({ workflowId: 'workflow-remote', enabled: true, lifecycle: WorkflowLifecycle.READY });
  state = reduceWorkflowState(state, {
    type: WorkflowEventType.RUN_STARTED,
    eventId: 'run-started',
    data: { runId: 'run-remote', kind: WorkflowRunKind.AUTOMATION, phase: WorkflowPhase.CHECKING },
  }).state;
  return {
    id: 'workflow-remote',
    workflowState: state,
    configPath: '/tmp/workflow.json',
    loadedAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    config: { preset: 'fix-until-pass', projectRoot: '/tmp/project', watch: { mode: 'passive' }, automation: { session: { policy: 'current', id: '' }, restartPolicy: 'ask', steps: [], maxCycles: 3, noProgressLimit: 2 }, ux: {}, resultProtocol: {}, commit: { policy: {} } },
  };
}

function runtimeCoordinator() {
  return {
    enqueue(_id, operation) { return operation(); },
    async transition(runtime, type, data) {
      const outcome = reduceWorkflowState(runtime.workflowState, {
        type,
        eventId: `${type}:${runtime.workflowState.revision + 1}`,
        data,
      });
      assert.equal(outcome.accepted, true, outcome.reason);
      runtime.workflowState = outcome.state;
      return outcome.state;
    },
  };
}

test('remote stream gap becomes a canonical recovery action and explicit resync resumes the same run', async () => {
  const runtime = activeRuntime();
  let resyncCalls = 0;
  let ensureCalls = 0;
  const bridge = {
    async resyncFromRetained() { resyncCalls += 1; return true; },
    health() { return { streamEpoch: 'stream-new' }; },
  };
  const service = new WorkflowRemoteTransportService({
    bridge,
    workflows: new Map([[runtime.id, runtime]]),
    runtimeCoordinator: runtimeCoordinator(),
    ensureAutomation: async () => { ensureCalls += 1; },
  });

  const [snapshot] = await service.handleGap({ streamEpoch: 'stream-new', afterSequence: 5, retainedFromSequence: 12 });
  assert.equal(snapshot.lifecycle, WorkflowLifecycle.WAITING_ACTION);
  assert.equal(snapshot.nextAction.kind, WorkflowActionKind.REMOTE_TRANSPORT);
  assert.deepEqual(snapshot.nextAction.choices.map((choice) => choice.id), ['resync', 'stop']);
  assert.equal(runtime.workflowState.run.id, 'run-remote');

  runtime.workflowState = reduceWorkflowState(runtime.workflowState, {
    type: WorkflowEventType.ACTION_RESOLVED,
    eventId: 'remote-action-resolved',
    data: { runId: 'run-remote', actionId: runtime.workflowState.nextAction.id, choice: 'resync' },
  }).state;
  const resumed = await service.resync(runtime);
  assert.equal(resyncCalls, 1);
  assert.equal(ensureCalls, 1);
  assert.equal(resumed.lifecycle, WorkflowLifecycle.RUNNING);
  assert.equal(resumed.run.id, 'run-remote');
});
