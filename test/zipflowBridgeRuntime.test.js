import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ZipflowBridgeRuntime } from '../src/workflow/server/zipflowBridgeRuntime.js';

function setupSurface(revision = 0) {
  return {
    id: 'workflow_setup:project-1',
    kind: 'workflow_setup',
    revision,
    title: 'Workflow setup',
    summary: 'Configure the workflow',
    sections: [],
    actions: [{
      id: 'save-workflow',
      kind: 'save_workflow',
      label: 'Save workflow',
      enabled: true,
      disabledReason: null,
      risk: 'project_write',
      confirmation: 'explicit',
      inputSchema: {
        type: 'object',
        required: ['workflow'],
        properties: { workflow: { type: 'object' } },
      },
    }],
    links: {},
  };
}

function fixtureClient() {
  let workflow = null;
  let revision = 0;
  let actions = 0;
  const client = {
    hello: async () => ({
      apiVersion: '1.0',
      schemaRevision: 1,
      serverEpoch: 'epoch-1',
      capabilities: [
        'projects', 'workflow_config', 'blobs', 'archive_runs', 'check_runs',
        'semantic_surfaces', 'actions', 'plans', 'diffs', 'history', 'rollback',
        'events',
      ],
    }),
    openProject: async () => ({
      projectId: 'project-1',
      canonicalPath: '/project',
      workflowRevision: revision,
      surface: setupSurface(revision),
    }),
    getProject: async () => ({
      projectId: 'project-1',
      workflowRevision: revision,
      surface: setupSurface(revision),
    }),
    getWorkflow: async () => ({
      projectId: 'project-1',
      revision,
      workflow,
      suggestedWorkflow: workflow ? undefined : { version: 9, name: 'Project' },
    }),
    putWorkflow: async (_projectId, draft, options) => {
      assert.equal(options.ifMatch, revision);
      workflow = structuredClone(draft);
      revision += 1;
      return { projectId: 'project-1', revision, workflow };
    },
    subscribeEvents: async () => ({ close: async () => {} }),
    performAction: async () => {
      actions += 1;
      return { accepted: true };
    },
    close: async () => {},
  };
  return { client, actionCount: () => actions };
}

test('Bridge runtime configures and inspects through one durable server owner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-zipflow-runtime-'));
  const fixture = fixtureClient();
  const daemon = {
    health: () => ({ state: 'ready' }),
    ensure: async () => ({ client: fixture.client }),
    close: async () => {},
  };
  const runtime = new ZipflowBridgeRuntime({
    dataDir: root,
    daemonManager: daemon,
    fileStore: {},
    instanceId: 'bridge-test',
  });
  try {
    const opened = await runtime.openProject('/project');
    assert.equal(opened.surface.kind, 'workflow_setup');
    assert.equal(opened.suggestedWorkflow.version, 9);

    const saved = await runtime.performAction({
      actionId: 'save-workflow',
      input: { workflow: opened.suggestedWorkflow },
      surfaceRevision: 0,
    });
    assert.equal(saved.revision, 1);
    assert.equal(runtime.snapshot().workflow.name, 'Project');
    assert.equal(fixture.actionCount(), 0, 'setup is persisted with workflow PUT, not a run action');

    const durable = JSON.parse(await fs.readFile(
      path.join(root, 'workflows', 'server-state-v1.json'),
      'utf8',
    ));
    const state = Object.values(durable.workflows)[0];
    assert.equal(state.schemaVersion, 4);
    assert.equal(state.localWorkflow.projectId, 'project-1');
    assert.equal(state.localWorkflow.serverEpoch, 'epoch-1');
  } finally {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Bridge reconnects reads after an epoch change while mutations remain fail-closed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-zipflow-reconnect-'));
  const first = fixtureClient();
  const second = fixtureClient();
  let failFirst = false;
  let reopened = 0;
  const originalHello = first.client.hello;
  first.client.hello = async () => {
    if (failFirst) {
      throw Object.assign(new Error('connection lost'), {
        code: 'CONNECTION_FAILED',
        retryable: true,
      });
    }
    return await originalHello();
  };
  second.client.hello = async () => ({
    apiVersion: '1.0',
    schemaRevision: 1,
    serverEpoch: 'epoch-2',
    capabilities: [
      'projects', 'workflow_config', 'blobs', 'archive_runs', 'check_runs',
      'semantic_surfaces', 'actions', 'plans', 'diffs', 'history', 'rollback',
      'events',
    ],
  });
  const originalOpen = second.client.openProject;
  second.client.openProject = async (...args) => {
    reopened += 1;
    return await originalOpen(...args);
  };
  let ensureCalls = 0;
  let releaseReconnect;
  const reconnectBarrier = new Promise((resolve) => { releaseReconnect = resolve; });
  const daemon = {
    health: () => ({ state: ensureCalls > 1 ? 'connecting' : 'ready' }),
    async ensure() {
      ensureCalls += 1;
      if (ensureCalls === 1) return { client: first.client };
      await reconnectBarrier;
      return { client: second.client };
    },
    close: async () => {},
  };
  const runtime = new ZipflowBridgeRuntime({
    dataDir: root,
    daemonManager: daemon,
    reconnectDelaysMs: [0],
  });
  try {
    const opened = await runtime.openProject('/project');
    failFirst = true;
    const refreshing = runtime.refresh(opened.workflowId);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      runtime.saveWorkflow({ version: 9, name: 'Must not write' }, {
        workflowId: opened.workflowId,
      }),
      (error) => error?.code === 'WORKFLOW_CONNECTIVITY_DEGRADED',
    );
    releaseReconnect();
    const recovered = await refreshing;
    assert.equal(recovered.state.localWorkflow.serverEpoch, 'epoch-2');
    assert.equal(reopened, 1);
    assert.equal(recovered.connectivity.status, 'connected');
  } finally {
    releaseReconnect?.();
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
