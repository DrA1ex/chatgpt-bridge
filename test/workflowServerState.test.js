import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WORKFLOW_SERVER_BACKEND,
  WORKFLOW_SERVER_STATE_SCHEMA_VERSION,
  normalizeWorkflowServerState,
  patchWorkflowServerState,
} from '../src/workflow/server/workflowServerState.js';
import {
  WORKFLOW_SERVER_STORE_SCHEMA_VERSION,
  WorkflowServerStore,
} from '../src/workflow/server/workflowServerStore.js';

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-workflow-server-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('workflow server v4 normalization persists only opaque local correlation', () => {
  const normalized = normalizeWorkflowServerState({
    schemaVersion: 4,
    localWorkflow: {
      backend: WORKFLOW_SERVER_BACKEND,
      projectId: ' project-1 ',
      runId: 'run-1',
      operationId: 'operation-1',
      seriesId: 'series-1',
      blobId: 'sha256:abc',
      archiveSha256: 'abc',
      serverEpoch: 'epoch-1',
      eventCursor: 18,
      lastSurfaceRevision: 7,
      plan: { files: ['must-not-persist.js'] },
      git: { head: 'must-not-persist' },
      checkOutput: 'must-not-persist',
    },
    surface: { title: 'must-not-persist' },
  });

  assert.deepEqual(normalized, {
    schemaVersion: WORKFLOW_SERVER_STATE_SCHEMA_VERSION,
    localWorkflow: {
      backend: WORKFLOW_SERVER_BACKEND,
      projectId: 'project-1',
      runId: 'run-1',
      operationId: 'operation-1',
      seriesId: 'series-1',
      blobId: 'sha256:abc',
      archiveSha256: 'abc',
      serverEpoch: 'epoch-1',
      eventCursor: 18,
      lastSurfaceRevision: 7,
    },
  });
  assert.deepEqual(
    patchWorkflowServerState(normalized, { eventCursor: 19 }).localWorkflow,
    { ...normalized.localWorkflow, eventCursor: 19 },
  );
  assert.throws(
    () => normalizeWorkflowServerState({ schemaVersion: 3 }),
    { code: 'WORKFLOW_SERVER_STATE_INCOMPATIBLE' },
  );
  assert.throws(
    () => normalizeWorkflowServerState({ localWorkflow: { backend: 'legacy' } }),
    { code: 'WORKFLOW_SERVER_BACKEND_UNSUPPORTED' },
  );
});

test('workflow server store writes v4 state atomically in a separate file', async (t) => {
  const root = await tempRoot(t);
  const store = new WorkflowServerStore(root);
  const first = await store.set('workflow-1', {
    localWorkflow: {
      projectId: 'project-1',
      serverEpoch: 'epoch-1',
      eventCursor: 2,
      plan: { ignored: true },
    },
  });
  assert.equal(first.localWorkflow.eventCursor, 2);

  await Promise.all([
    store.update('workflow-1', (state) => patchWorkflowServerState(state, {
      eventCursor: state.localWorkflow.eventCursor + 1,
    })),
    store.update('workflow-1', (state) => patchWorkflowServerState(state, {
      eventCursor: state.localWorkflow.eventCursor + 1,
    })),
  ]);
  await store.close();

  const file = path.join(root, 'workflows', 'server-state-v1.json');
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(disk.schemaVersion, WORKFLOW_SERVER_STORE_SCHEMA_VERSION);
  assert.equal(disk.workflows['workflow-1'].localWorkflow.eventCursor, 4);
  assert.equal('plan' in disk.workflows['workflow-1'].localWorkflow, false);
  assert.equal(await fs.stat(path.join(root, 'workflows', 'state.json')).catch(() => null), null);

  const restored = new WorkflowServerStore(root);
  assert.equal((await restored.get('workflow-1')).localWorkflow.eventCursor, 4);
});

test('incompatible workflow server store is rejected without overwriting it', async (t) => {
  const root = await tempRoot(t);
  const directory = path.join(root, 'workflows');
  const file = path.join(directory, 'server-state-v1.json');
  await fs.mkdir(directory, { recursive: true });
  const original = '{"schemaVersion":99,"workflows":{"legacy":{"secret":"preserve"}}}\n';
  await fs.writeFile(file, original, 'utf8');

  const store = new WorkflowServerStore(root);
  await assert.rejects(store.ready, { code: 'WORKFLOW_SERVER_STORE_INCOMPATIBLE' });
  assert.equal(await fs.readFile(file, 'utf8'), original);
});
