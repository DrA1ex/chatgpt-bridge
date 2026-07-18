import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { offerWorkflowContinuation, resolveInteractiveStartup, selectStartupWorkflow } from '../src/interactive/startupWorkflow.js';

function workflow(overrides = {}) {
  return {
    id: 'apply-1',
    preset: 'apply-changes',
    projectRoot: '/workspace/project',
    lifecycle: 'ready',
    execution: { observing: true },
    run: { id: '', phase: 'none' },
    nextAction: null,
    ...overrides,
  };
}

test('interactive startup uses an existing workflow project before stale persisted state', () => {
  const selected = selectStartupWorkflow([workflow()], { focusedWorkflowId: '' });
  assert.equal(selected.id, 'apply-1');
  const startup = resolveInteractiveStartup({
    workflows: [workflow()],
    state: { projectRoot: '/tmp/stale-project' },
    cwd: '/current/project',
  });
  assert.equal(startup.projectRoot, path.resolve('/workspace/project'));
});

test('interactive startup uses the launch directory when no workflow or explicit project exists', () => {
  const startup = resolveInteractiveStartup({
    workflows: [],
    state: { projectRoot: '/tmp/stale-project' },
    cwd: '/current/project',
  });
  assert.equal(startup.projectRoot, path.resolve('/current/project'));
});

test('explicit --project still overrides workflow and current-directory defaults', () => {
  const startup = resolveInteractiveStartup({
    projectPath: '/explicit/project',
    workflows: [workflow()],
    state: { projectRoot: '/tmp/stale-project' },
    cwd: '/current/project',
  });
  assert.equal(startup.projectRoot, path.resolve('/explicit/project'));
});

test('startup immediately offers to continue the saved workflow', async () => {
  const calls = [];
  const runtime = {
    state: { projectRoot: '/tmp/stale-project', focusedWorkflowId: '' },
    options: { workflowManager: { list: () => [workflow()] } },
    workflowWizard: {
      opened: false,
      async open(options) { calls.push(['open', options]); },
      async openForWorkflow(id) { calls.push(['openForWorkflow', id]); },
    },
    async saveState() { calls.push(['save']); },
  };
  const selected = await offerWorkflowContinuation(runtime);
  assert.equal(selected.id, 'apply-1');
  assert.equal(runtime.state.projectRoot, path.resolve('/workspace/project'));
  assert.equal(runtime.state.focusedWorkflowId, 'apply-1');
  assert.deepEqual(calls, [['save'], ['open', { view: 'active' }]]);
});

test('startup opens the pending decision screen when the saved workflow needs attention', async () => {
  const calls = [];
  const pending = workflow({ lifecycle: 'waiting_action', run: { id: 'run-1', phase: 'checking' }, nextAction: { id: 'action-1', kind: 'failed_checks', choices: [] } });
  const runtime = {
    state: {},
    options: { workflowManager: { list: () => [pending] } },
    workflowWizard: {
      opened: false,
      async open(options) { calls.push(['open', options]); },
      async openForWorkflow(id) { calls.push(['openForWorkflow', id]); },
    },
    async saveState() {},
  };
  await offerWorkflowContinuation(runtime);
  assert.deepEqual(calls, [['openForWorkflow', 'apply-1']]);
});
