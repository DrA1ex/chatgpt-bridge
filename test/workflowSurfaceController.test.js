import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkflowSurfaceController,
  validateWorkflowActionInput,
} from '../src/interactive/workflowSurfaceController.js';

function surface(revision = 1, actions = null) {
  return {
    id: 'review-surface',
    kind: 'plan_review',
    revision,
    title: 'Review changes',
    summary: 'One file changed',
    sections: [],
    actions: actions || [
      {
        id: 'approve-plan',
        kind: 'approve_plan',
        label: 'Apply update',
        enabled: true,
        risk: 'project_write',
        confirmation: 'explicit',
      },
      {
        id: 'keep-local',
        kind: 'keep_local',
        label: 'Keep local file',
        enabled: true,
        inputSchema: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string' } },
        },
      },
    ],
  };
}

test('stale action refreshes the surface without repeating the mutation', async () => {
  let dispatches = 0;
  let refreshes = 0;
  const priorChat = { draft: 'unfinished prompt', scroll: 17, selection: { start: 3, end: 8 }, theme: 'ocean', pointer: true };
  const controller = new WorkflowSurfaceController({
    dispatchAction: async ({ actionId, surfaceRevision }) => {
      dispatches += 1;
      assert.equal(actionId, 'approve-plan');
      assert.equal(surfaceRevision, 1);
      throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' });
    },
    refreshSurface: async () => {
      refreshes += 1;
      return surface(2);
    },
  });
  controller.open(surface(), { returnView: priorChat });
  controller.setScroll(9);
  controller.setSearch('src/');
  controller.setEditorValue('commit-message', 'Keep this draft');
  controller.setSelectedPath('src/index.js');
  controller.setDiffMode('side-by-side');
  controller.focusAction('approve-plan');

  const result = await controller.activate();
  assert.equal(result.stale, true);
  assert.equal(dispatches, 1);
  assert.equal(refreshes, 1);
  assert.equal(controller.snapshot().surface.revision, 2);
  assert.deepEqual(controller.snapshot().navigation, {
    focusActionId: 'approve-plan',
    focusSectionId: '',
    scroll: 9,
    search: 'src/',
    editorValues: { 'commit-message': 'Keep this draft' },
    selectedPath: 'src/index.js',
    diffMode: 'side-by-side',
  });
  assert.deepEqual(controller.close().returnView, priorChat);
});

test('surface action selection maps indexes to stable action IDs and validates input', async () => {
  const dispatched = [];
  const controller = new WorkflowSurfaceController({
    dispatchAction: async (request) => {
      dispatched.push(request);
      return { accepted: true };
    },
  });
  controller.open(surface());
  await assert.rejects(
    controller.activate('keep-local', {}),
    { code: 'ACTION_INPUT_INVALID' },
  );
  controller.selectActionByIndex(1);
  await controller.activate('', { path: 'src/index.js' });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].actionId, 'keep-local');
  assert.equal(dispatched[0].surfaceRevision, 1);
  assert.deepEqual(dispatched[0].input, { path: 'src/index.js' });
  assert.deepEqual(validateWorkflowActionInput({ type: 'object', required: ['value'] }, {}), ['value is required']);
});


test('workflow actions are single-flight and transient failures reconcile without replay', async () => {
  let dispatches = 0;
  let releaseDispatch;
  const dispatchBarrier = new Promise((resolve) => { releaseDispatch = resolve; });
  let failTransient = false;
  let refreshes = 0;
  const controller = new WorkflowSurfaceController({
    dispatchAction: async () => {
      dispatches += 1;
      if (failTransient) {
        throw Object.assign(new Error('operation is settling'), {
          code: 'OPERATION_BUSY',
          retryable: true,
        });
      }
      await dispatchBarrier;
      return { accepted: true };
    },
    refreshSurface: async () => {
      refreshes += 1;
      return surface(3);
    },
  });
  controller.open(surface(2));
  controller.focusAction('approve-plan');

  const first = controller.activate();
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await controller.activate();

  assert.equal(duplicate.busy, true);
  assert.equal(dispatches, 1, 'a repeated Enter must not dispatch a second mutation');
  assert.equal(controller.snapshot().busy, true);

  releaseDispatch();
  const completed = await first;
  assert.equal(completed.ok, true);
  assert.equal(controller.snapshot().busy, false);

  failTransient = true;
  const reconciled = await controller.activate();
  assert.equal(reconciled.ok, false);
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.stale, false);
  assert.equal(reconciled.error.code, 'OPERATION_BUSY');
  assert.equal(dispatches, 2, 'reconciliation must not replay the failed mutation');
  assert.equal(refreshes, 1);
  assert.equal(controller.snapshot().surface.revision, 3);
});

test('older subscription surfaces cannot replace a newer workflow revision', () => {
  const controller = new WorkflowSurfaceController();
  controller.open(surface(5));
  controller.replaceSurface(surface(7));
  controller.replaceSurface({
    ...surface(6),
    title: 'Stale server event',
  });

  const snapshot = controller.snapshot();
  assert.equal(snapshot.surface.revision, 7);
  assert.equal(snapshot.surface.title, 'Review changes');
});
