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
