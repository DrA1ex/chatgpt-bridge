import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractiveWorkflowSurfaceRuntime } from '../src/interactive/workflowSurfaceRuntime.js';

function dangerousSurface() {
  return {
    id: 'deploy-choice:run-one',
    kind: 'deploy_choice',
    revision: 7,
    title: 'Deploy',
    summary: 'Configured deployment is ready',
    sections: [],
    actions: [{
      id: 'deploy',
      kind: 'deploy',
      label: 'Deploy',
      enabled: true,
      risk: 'external_side_effect',
      confirmation: 'dangerous',
    }],
    links: {},
  };
}

test('workflow surface preserves the surrounding TUI and double-confirms dangerous actions', async () => {
  const confirmations = [];
  const surrounding = {
    draft: 'unfinished chat prompt',
    transcriptScroll: { scroll: 19, followTail: false },
    selection: { start: 2, end: 9 },
    themeName: 'ocean',
    pointerEnabled: true,
    detailsOpen: true,
  };
  let invalidations = 0;
  let unsubscribed = 0;
  const dispatched = [];
  const runtime = {
    ...structuredClone(surrounding),
    state: { projectRoot: '/project' },
    options: { projectPath: '/fallback' },
    context: {
      async confirm(message) {
        confirmations.push(message);
        return true;
      },
    },
    invalidate() { invalidations += 1; },
    pushEntry() {},
  };
  const backend = {
    async openProject(projectPath) {
      assert.equal(projectPath, '/project');
      return { surface: dangerousSurface() };
    },
    async performAction(request) {
      dispatched.push(request);
      return { surface: { ...dangerousSurface(), revision: 8 } };
    },
    async refresh() {
      return { surface: dangerousSurface() };
    },
    snapshot() {
      return { workflowId: 'workflow-one' };
    },
    subscribe() {
      return () => { unsubscribed += 1; };
    },
  };
  const surfaceRuntime = new InteractiveWorkflowSurfaceRuntime(runtime, backend);
  await surfaceRuntime.open();
  await surfaceRuntime.activate();
  assert.equal(confirmations.length, 2);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].actionId, 'deploy');
  assert.equal(dispatched[0].surfaceRevision, 7);
  surfaceRuntime.close();
  surfaceRuntime.closeRuntime();
  for (const [key, value] of Object.entries(surrounding)) {
    assert.deepEqual(runtime[key], value, `${key} must survive the workflow overlay`);
  }
  assert.ok(invalidations > 0);
  assert.equal(unsubscribed, 1);
});

test('plan review pre-fills the advertised file action with its visible path', async () => {
  const dispatched = [];
  const surface = {
    id: 'plan-review:run-one',
    kind: 'plan_review',
    revision: 11,
    title: 'Review plan',
    summary: 'One file decision can still be revised',
    sections: [{
      kind: 'file_details',
      files: [{ id: 'file-1', path: 'README.md', change: 'updated', decision: 'archive' }],
    }],
    actions: [{
      id: 'keep-local',
      kind: 'plan',
      label: 'Keep local',
      enabled: true,
      risk: 'local_mutation',
      confirmation: 'none',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
    }],
    links: {},
  };
  const runtime = {
    state: { projectRoot: '/project' },
    options: {},
    context: { confirm: async () => true },
    invalidate() {},
    pushEntry() {},
  };
  const backend = {
    async openProject() { return { surface }; },
    async performAction(request) {
      dispatched.push(request);
      return { surface: { ...surface, revision: 12 } };
    },
    snapshot() { return { workflowId: 'workflow-one' }; },
    subscribe() { return () => {}; },
  };
  const surfaceRuntime = new InteractiveWorkflowSurfaceRuntime(runtime, backend);
  await surfaceRuntime.open();
  await surfaceRuntime.activate();
  assert.deepEqual(JSON.parse(surfaceRuntime.model().input.editor.value), { path: 'README.md' });
  await surfaceRuntime.activate();
  assert.deepEqual(dispatched[0], {
    actionId: 'keep-local',
    actionKind: 'plan',
    input: { path: 'README.md' },
    surfaceId: 'plan-review:run-one',
    surfaceRevision: 11,
    links: {},
  });
  surfaceRuntime.closeRuntime();
});


test('workflow overlay ignores navigation and duplicate activation while an action is running', async () => {
  const dispatched = [];
  let releaseAction;
  const actionBarrier = new Promise((resolve) => { releaseAction = resolve; });
  const runtime = {
    state: { projectRoot: '/project' },
    options: {},
    context: { confirm: async () => true },
    invalidate() {},
    pushEntry() {},
  };
  const backend = {
    async openProject() { return { surface: dangerousSurface() }; },
    async performAction(request) {
      dispatched.push(request);
      await actionBarrier;
      return { surface: { ...dangerousSurface(), revision: 8 } };
    },
    async refresh() { return { surface: dangerousSurface() }; },
    snapshot() { return { workflowId: 'workflow-one' }; },
    subscribe() { return () => {}; },
  };
  const surfaceRuntime = new InteractiveWorkflowSurfaceRuntime(runtime, backend);
  await surfaceRuntime.open();

  const first = surfaceRuntime.activate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(surfaceRuntime.model().busy, true);

  await surfaceRuntime.handleKey({ name: 'enter' });
  await surfaceRuntime.handleKey({ name: 'escape' });
  assert.equal(dispatched.length, 1, 'running action must not be activated again');
  assert.equal(surfaceRuntime.model().opened, true, 'Escape must not close an active workflow action');

  releaseAction();
  await first;
  assert.equal(surfaceRuntime.model().busy, false);
  assert.equal(surfaceRuntime.model().surface.revision, 8);
  surfaceRuntime.closeRuntime();
});

test('transient workflow action failure refreshes state without repeating the mutation', async () => {
  const entries = [];
  let dispatches = 0;
  let refreshes = 0;
  const runtime = {
    state: { projectRoot: '/project' },
    options: {},
    context: { confirm: async () => true },
    invalidate() {},
    pushEntry(entry) { entries.push(entry); },
  };
  const backend = {
    async openProject() { return { surface: dangerousSurface() }; },
    async performAction() {
      dispatches += 1;
      throw Object.assign(new Error('server is settling the operation'), {
        code: 'OPERATION_BUSY',
        retryable: true,
      });
    },
    async refresh() {
      refreshes += 1;
      return { surface: { ...dangerousSurface(), revision: 9 } };
    },
    snapshot() { return { workflowId: 'workflow-one' }; },
    subscribe() { return () => {}; },
  };
  const surfaceRuntime = new InteractiveWorkflowSurfaceRuntime(runtime, backend);
  await surfaceRuntime.open();
  await surfaceRuntime.activate();

  assert.equal(dispatches, 1);
  assert.equal(refreshes, 1);
  assert.equal(surfaceRuntime.model().surface.revision, 9);
  assert.match(entries.at(-1)?.body || '', /without repeating the mutation/i);
  surfaceRuntime.closeRuntime();
});
