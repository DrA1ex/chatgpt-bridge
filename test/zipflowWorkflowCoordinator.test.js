import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkflowServerStore } from '../src/workflow/server/workflowServerStore.js';
import { ZipflowWorkflowCoordinator } from '../src/workflow/server/zipflowWorkflowCoordinator.js';

async function setupStore(t, localWorkflow = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-zipflow-coordinator-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkflowServerStore(root);
  await store.set('workflow-1', { localWorkflow });
  return store;
}

function fakeClient({ epoch = 'epoch-1', surfaceRevision = 7 } = {}) {
  const calls = { open: 0, openRequests: [], project: 0, run: 0, operation: 0, surface: 0 };
  return {
    calls,
    epoch,
    async hello() { return { serverEpoch: this.epoch }; },
    async openProject(projectPath, options = {}) {
      calls.open += 1;
      calls.openRequests.push({ projectPath, ...options });
      return { projectId: 'project-1', canonicalPath: projectPath };
    },
    async getProject() {
      calls.project += 1;
      return { projectId: 'project-1', activeRunId: 'run-1' };
    },
    async getRun() {
      calls.run += 1;
      return { runId: 'run-1', operationId: 'operation-1', status: 'inspecting' };
    },
    async getOperation() {
      calls.operation += 1;
      return { operationId: 'operation-1', settlement: 'active' };
    },
    async getSurface() {
      calls.surface += 1;
      return { id: 'surface-1', kind: 'operation_progress', revision: surfaceRevision, sections: [], actions: [] };
    },
    async subscribeEvents() { return () => {}; },
  };
}

test('project-open idempotency is stable per bridge instance and unique across instances', async (t) => {
  const firstStore = await setupStore(t);
  const secondStore = await setupStore(t);
  const firstClient = fakeClient();
  const secondClient = fakeClient();
  const first = new ZipflowWorkflowCoordinator({
    client: firstClient,
    store: firstStore,
    workflowId: 'workflow-1',
    projectPath: '/tmp/project',
    instanceId: 'bridge-instance-a',
  });
  const second = new ZipflowWorkflowCoordinator({
    client: secondClient,
    store: secondStore,
    workflowId: 'workflow-1',
    projectPath: '/tmp/project',
    instanceId: 'bridge-instance-b',
  });

  await first.synchronize();
  firstClient.epoch = 'epoch-2';
  await first.synchronize();
  await second.synchronize();

  assert.equal(firstClient.calls.openRequests.length, 2);
  assert.equal(firstClient.calls.openRequests[0].idempotencyKey, firstClient.calls.openRequests[1].idempotencyKey);
  assert.equal(firstClient.calls.openRequests[0].instanceId, 'bridge-instance-a');
  assert.equal(secondClient.calls.openRequests[0].instanceId, 'bridge-instance-b');
  assert.notEqual(
    firstClient.calls.openRequests[0].idempotencyKey,
    secondClient.calls.openRequests[0].idempotencyKey,
  );
});

test('same-epoch events advance the cursor only after durable application', async (t) => {
  const store = await setupStore(t, {
    projectId: 'project-1',
    runId: 'run-1',
    operationId: 'operation-1',
    serverEpoch: 'epoch-1',
    eventCursor: 4,
    lastSurfaceRevision: 6,
  });
  const client = fakeClient();
  const observed = [];
  const coordinator = new ZipflowWorkflowCoordinator({
    client,
    store,
    workflowId: 'workflow-1',
    projectPath: '/tmp/project',
    onEvent: async (event) => {
      observed.push({ sequence: event.sequence, durableCursor: (await store.get('workflow-1')).localWorkflow.eventCursor });
    },
  });

  const synchronized = await coordinator.synchronize();
  assert.equal(synchronized.epochChanged, false);
  assert.equal(synchronized.state.localWorkflow.eventCursor, 4);
  assert.equal(client.calls.open, 0);

  assert.equal((await coordinator.applyEvent({
    type: 'operation.progress',
    serverEpoch: 'epoch-1',
    sequence: 5,
    projectId: 'project-1',
    runId: 'run-1',
    operationId: 'operation-1',
    data: { completed: 1, total: 2 },
  })).applied, true);
  assert.deepEqual(observed, [{ sequence: 5, durableCursor: 5 }]);
  assert.equal((await coordinator.applyEvent({
    type: 'operation.progress',
    serverEpoch: 'epoch-1',
    sequence: 5,
  })).duplicate, true);
  assert.equal(observed.length, 1);
});

test('failed durable event commit does not publish or advance the cursor', async (t) => {
  const realStore = await setupStore(t, {
    projectId: 'project-1',
    serverEpoch: 'epoch-1',
    eventCursor: 0,
  });
  let fail = true;
  const store = {
    get: (...args) => realStore.get(...args),
    set: (...args) => realStore.set(...args),
    update: async (...args) => {
      if (fail) throw Object.assign(new Error('disk unavailable'), { code: 'EIO' });
      return await realStore.update(...args);
    },
  };
  let published = 0;
  const coordinator = new ZipflowWorkflowCoordinator({
    client: fakeClient(),
    store,
    workflowId: 'workflow-1',
    onEvent: () => { published += 1; },
  });
  const event = {
    type: 'operation.progress',
    serverEpoch: 'epoch-1',
    sequence: 1,
    projectId: 'project-1',
  };
  await assert.rejects(coordinator.applyEvent(event), { code: 'EIO' });
  assert.equal((await realStore.get('workflow-1')).localWorkflow.eventCursor, 0);
  assert.equal(published, 0);

  fail = false;
  await coordinator.applyEvent(event);
  assert.equal((await realStore.get('workflow-1')).localWorkflow.eventCursor, 1);
  assert.equal(published, 1);
});

test('changed epoch reopens the project and stream gap performs full resync', async (t) => {
  const store = await setupStore(t, {
    projectId: 'project-1',
    runId: 'run-old',
    operationId: 'operation-old',
    serverEpoch: 'epoch-old',
    eventCursor: 42,
    lastSurfaceRevision: 3,
  });
  const client = fakeClient({ epoch: 'epoch-new', surfaceRevision: 9 });
  const coordinator = new ZipflowWorkflowCoordinator({
    client,
    store,
    workflowId: 'workflow-1',
    projectPath: '/tmp/canonical-project',
  });

  const changed = await coordinator.synchronize();
  assert.equal(changed.epochChanged, true);
  assert.equal(changed.state.localWorkflow.serverEpoch, 'epoch-new');
  assert.equal(changed.state.localWorkflow.eventCursor, 0);
  assert.equal(changed.state.localWorkflow.lastSurfaceRevision, 9);
  assert.equal(client.calls.open, 1);

  const readsBeforeGap = client.calls.project;
  const gap = await coordinator.applyEvent({
    type: 'stream.gap',
    serverEpoch: 'epoch-new',
    sequence: 8,
    projectId: 'project-1',
    data: { retainedFrom: 6 },
  });
  assert.equal(gap.resynchronized, true);
  assert.equal((await store.get('workflow-1')).localWorkflow.eventCursor, 8);
  assert.ok(client.calls.project > readsBeforeGap);
  assert.equal(client.calls.open, 1);
});


test('concurrent refresh cannot roll back a durably applied event cursor or surface revision', async (t) => {
  const store = await setupStore(t, {
    projectId: 'project-1',
    runId: 'run-1',
    operationId: 'operation-1',
    serverEpoch: 'epoch-1',
    eventCursor: 4,
    lastSurfaceRevision: 6,
  });
  const client = fakeClient({ surfaceRevision: 7 });
  let releaseSurface;
  let surfaceReadStarted;
  const surfaceRead = new Promise((resolve) => { surfaceReadStarted = resolve; });
  const surfaceBarrier = new Promise((resolve) => { releaseSurface = resolve; });
  const originalGetSurface = client.getSurface;
  client.getSurface = async (...args) => {
    surfaceReadStarted();
    await surfaceBarrier;
    return await originalGetSurface(...args);
  };
  const coordinator = new ZipflowWorkflowCoordinator({
    client,
    store,
    workflowId: 'workflow-1',
    projectPath: '/tmp/project',
  });

  const refreshing = coordinator.synchronize({ reason: 'concurrent_refresh' });
  await surfaceRead;

  const eventSurface = {
    id: 'surface-1',
    kind: 'operation_progress',
    revision: 9,
    sections: [],
    actions: [],
  };
  await coordinator.applyEvent({
    type: 'surface.changed',
    serverEpoch: 'epoch-1',
    sequence: 5,
    projectId: 'project-1',
    runId: 'run-1',
    operationId: 'operation-1',
    revision: 9,
    data: { surface: eventSurface },
  });
  assert.equal((await store.get('workflow-1')).localWorkflow.eventCursor, 5);
  assert.equal((await store.get('workflow-1')).localWorkflow.lastSurfaceRevision, 9);

  releaseSurface();
  const refreshed = await refreshing;
  assert.equal(refreshed.state.localWorkflow.eventCursor, 5);
  assert.equal(refreshed.state.localWorkflow.lastSurfaceRevision, 9);
  assert.equal((await store.get('workflow-1')).localWorkflow.eventCursor, 5);
  assert.equal((await store.get('workflow-1')).localWorkflow.lastSurfaceRevision, 9);
});
