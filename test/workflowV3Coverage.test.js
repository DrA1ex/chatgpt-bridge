import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { WorkflowCommandCoordinator } from '../src/workflow/services/commandCoordinator.js';
import { WorkflowRecoveryCoordinator } from '../src/workflow/recovery/workflowRecoveryCoordinator.js';
import { publicWorkflowSnapshot } from '../src/workflow/state/workflowProjection.js';
import {
  WorkflowActionKind,
  WorkflowEventType,
  WorkflowLifecycle,
  WorkflowPhase,
  WorkflowRunKind,
  createWorkflowState,
  reduceWorkflowState,
} from '../src/workflow/state/workflowState.js';
import { workflowActionLabels } from '../src/workflow/ux/workflowActions.js';
import { workflowDashboard, workflowStage } from '../src/workflow/ux/workflowView.js';

function runtime(state = createWorkflowState({ lifecycle: WorkflowLifecycle.READY, subscription: { enabled: true } })) {
  return {
    id: 'workflow-v3',
    configPath: '/tmp/workflow.json',
    loadedAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    config: {
      id: 'workflow-v3', preset: 'guided-task', projectRoot: '/tmp/project', watch: { mode: 'verify' },
      automation: { restartPolicy: 'ask', session: { policy: 'current', id: '' }, maxCycles: 3, steps: [] },
      ux: { label: 'V3 workflow' }, resultProtocol: {},
    },
    workflowState: state,
  };
}

function transitionHarness() {
  let sequence = 0;
  return async (target, type, data = {}, _publishedType = '', _publishedData = {}, options = {}) => {
    const result = reduceWorkflowState(target.workflowState, {
      eventId: options.eventId || `event-${++sequence}`,
      expectedRevision: options.expectedRevision,
      type,
      data,
      at: `2026-07-18T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    });
    if (!result.accepted) throw Object.assign(new Error(result.diagnostics[0].message), { code: result.diagnostics[0].code });
    target.workflowState = result.state;
    return result.state;
  };
}

test('command coordinator persists command identity and drives guided run/action tokens through the reducer', async () => {
  const target = runtime();
  const transition = transitionHarness();
  const decisions = new Map();
  const coordinator = new WorkflowCommandCoordinator({
    transition,
    activate: async () => publicWorkflowSnapshot(target), deactivate: async () => publicWorkflowSnapshot(target),
    startGuided: async (item) => {
      await transition(item, WorkflowEventType.RUN_STARTED, { runId: 'run-guided', kind: WorkflowRunKind.GUIDED, phase: WorkflowPhase.PROMPTING });
      return publicWorkflowSnapshot(item);
    },
    runAutomation: async () => null, pauseAutomation: async () => null, resumeAutomation: async () => null,
    stopAutomation: async () => null, restartAutomation: async () => null, restoreAutomation: async () => null,
    resumeApproved: async () => null, ensureAutomation: async () => null,
    getDecision: async (id) => decisions.get(id) || null,
    setDecision: async (id, value) => decisions.set(id, structuredClone(value)),
    commit: async () => null, skipCommit: async () => null, fixChecks: async () => null,
    keepChecks: async () => null, revertChecks: async () => null, recoverSession: async () => null,
  });
  await coordinator.execute(target, { type: 'run', commandId: 'command-run', expectedRevision: 0, options: { kind: 'guided' } });
  assert.equal(target.workflowState.run.id, 'run-guided');
  assert.deepEqual(target.workflowState.seenCommandIds, ['command-run']);

  await transition(target, WorkflowEventType.ACTION_REQUIRED, {
    runId: 'run-guided', actionId: 'action-result', kind: WorkflowActionKind.INVALID_RESULT,
    reason: 'Result is ambiguous',
    choices: [{ id: 'reject', label: 'Reject result', transition: 'finish', outcome: { status: 'cancelled', code: 'rejected' } }],
    safeContinuation: 'stop',
  });
  decisions.set('action-result', { id: 'action-result', workflowId: target.id, status: 'pending' });
  await coordinator.execute(target, { type: 'act', commandId: 'command-act', actionId: 'action-result', choice: 'reject' });
  assert.equal(target.workflowState.lifecycle, WorkflowLifecycle.READY);
  assert.equal(target.workflowState.lastOutcome.code, 'rejected');
  assert.equal(decisions.get('action-result').status, 'resolved');
  await assert.rejects(() => coordinator.execute(target, { type: 'activate', commandId: 'command-act' }), /already handled/);
});

test('restart policy ask produces one recovery action and never silently relaunches automation', async () => {
  const transition = transitionHarness();
  const active = runtime();
  await transition(active, WorkflowEventType.RUN_STARTED, {
    runId: 'automation-run', kind: WorkflowRunKind.AUTOMATION, phase: WorkflowPhase.WAITING_RESPONSE,
  });
  const saved = publicWorkflowSnapshot(active);
  const target = runtime();
  let automationRestarts = 0;
  const coordinator = new WorkflowRecoveryCoordinator({
    store: { setWorkflow: async () => null }, transition,
    resetDeferredQueue: () => null, syncRefresh: () => null, processResponse: async () => null,
    ensureAutomation: async () => { automationRestarts += 1; },
  });
  const restored = await coordinator.restore(target, saved);
  assert.equal(restored.lifecycle, WorkflowLifecycle.WAITING_ACTION);
  assert.equal(restored.nextAction.kind, WorkflowActionKind.RECOVERY);
  assert.deepEqual(restored.nextAction.choices.map((choice) => choice.id), ['retry', 'stop']);
  assert.equal(automationRestarts, 0);
});

test('v3 UX renders lifecycle, phase, and nextAction directly', () => {
  const state = createWorkflowState({ lifecycle: WorkflowLifecycle.READY, subscription: { enabled: true } });
  const target = runtime(state);
  const snapshot = publicWorkflowSnapshot(target);
  assert.equal(workflowStage(snapshot).key, 'guided_ready');
  assert.equal(workflowDashboard(snapshot).action, null);
  assert.deepEqual(workflowActionLabels(snapshot), []);
});

test('workflow services keep Git aggregation exclusively in canonical v3 state', async () => {
  const files = await fs.readdir(new URL('../src/workflow/services/', import.meta.url));
  for (const file of files.filter((name) => name.endsWith('.js'))) {
    const source = await fs.readFile(new URL(`../src/workflow/services/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /workflowCommitBaseSha|workflowCommitShas|workflowCommitPaths|workflowCommitPathStates|lastWorkflowCommitMessage/, file);
  }
  const manager = await fs.readFile(new URL('../src/workflow/workflowManager.js', import.meta.url), 'utf8');
  assert.doesNotMatch(manager, /workflowCommitBaseSha|workflowCommitShas|workflowCommitPaths|workflowCommitPathStates|lastWorkflowCommitMessage/);
});
