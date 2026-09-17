import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileStore } from '../src/fileStore.js';
import { handleCommand } from '../src/interactive/runtime.js';
import { startServerArchiveWorkflow } from '../src/interactive/serverWorkflowCommands.js';
import { writeZip } from '../src/zipWriter.js';

async function writeResultZip(zipPath, producer) {
  await writeZip(zipPath, [{
    name: '.zipflow/result.json',
    data: JSON.stringify({
      version: 1,
      status: 'changed',
      summary: 'Explicit result.',
      commitMessage: 'Apply explicit result',
      files: ['src/index.js'],
      producer,
    }),
  }, {
    name: 'src/index.js',
    data: 'export const explicit = true;\n',
  }]);
}

function contextFixture(root, uploads) {
  const state = {
    projectRoot: path.join(root, 'project'),
    projectId: 'project-current',
  };
  return {
    state,
    fileStore: new FileStore(path.join(root, 'data')),
    zipflowWorkflowRuntime: {
      async openProject(projectRoot) {
        assert.equal(projectRoot, state.projectRoot);
        return { workflowId: 'workflow-authoritative' };
      },
      async uploadAndStartArchiveRun(request) {
        uploads.push(request);
        return { run: { runId: 'run-explicit' } };
      },
    },
    async openWorkflowSurface() {},
  };
}

test('explicit ZIP uses the workflow identity returned by the server', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-explicit-result-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const zipPath = path.join(root, 'result.zip');
  await writeResultZip(zipPath, {
    name: 'chatgpt-bridge',
    workflowId: 'workflow-authoritative',
    requestId: 'request-explicit',
    projectId: 'project-current',
  });
  const uploads = [];
  const originalLog = console.log;
  console.log = () => {};
  try {
    await startServerArchiveWorkflow(contextFixture(root, uploads), { explicitPath: zipPath });
  } finally {
    console.log = originalLog;
  }
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0].correlation, {
    workflowId: 'workflow-authoritative',
    requestId: 'request-explicit',
    projectId: 'project-current',
  });
});

test('explicit ZIP with a self-claimed foreign workflow is rejected before import or mutation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-explicit-mismatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const zipPath = path.join(root, 'result.zip');
  await writeResultZip(zipPath, {
    name: 'chatgpt-bridge',
    workflowId: 'workflow-foreign',
    requestId: 'request-explicit',
    projectId: 'project-current',
  });
  const uploads = [];
  const context = contextFixture(root, uploads);
  await assert.rejects(
    () => startServerArchiveWorkflow(context, { explicitPath: zipPath }),
    (error) => error?.code === 'RESULT_PROTOCOL_INVALID'
      && /producer\.workflowId mismatch/.test(error.message),
  );
  assert.equal(uploads.length, 0);
  await context.fileStore.ready;
  assert.deepEqual(context.fileStore.index.files, {});
});

test('/apply --plan starts server review without dispatching an advertised action', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-apply-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const zipPath = path.join(root, 'result.zip');
  await writeResultZip(zipPath, {
    name: 'chatgpt-bridge',
    workflowId: 'workflow-authoritative',
    requestId: 'request-plan',
    projectId: 'project-current',
  });
  const uploads = [];
  let actions = 0;
  const context = contextFixture(root, uploads);
  context.workflowManager = { list: () => [] };
  context.zipflowWorkflowRuntime.performAction = async () => {
    actions += 1;
    throw new Error('must not dispatch an action');
  };
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.equal(await handleCommand(`/apply ${zipPath} --plan`, context), true);
  } finally {
    console.log = originalLog;
  }
  assert.equal(uploads.length, 1);
  assert.equal(actions, 0);
});

test('/apply bootstraps the default server workflow for a selected ZIP when none is configured', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-apply-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const zipPath = path.join(root, 'result.zip');
  await writeResultZip(zipPath, {
    name: 'chatgpt-bridge',
    workflowId: 'workflow-authoritative',
    requestId: 'request-selected',
    projectId: 'project-current',
  });
  const fileStore = new FileStore(path.join(root, 'data'));
  const artifact = await fileStore.importLocalPath({ filePath: zipPath, name: 'result.zip' });
  const state = {
    projectRoot: path.join(root, 'project'),
    projectId: 'project-current',
    selectedResult: {
      turnId: 'turn-selected',
      projectId: 'project-current',
      projectRoot: path.join(root, 'project'),
      sourceRequestId: 'request-selected',
      fileId: artifact.id,
      name: artifact.name,
      size: artifact.size,
      sha256: artifact.sha256,
    },
  };
  const uploads = [];
  const configured = [];
  let surfaceOpens = 0;
  const context = {
    state,
    fileStore,
    workflowManager: { list: () => [] },
    zipflowWorkflowRuntime: {
      async openProject(projectRoot) {
        assert.equal(projectRoot, state.projectRoot);
        return {
          workflowId: 'workflow-authoritative',
          workflow: null,
          suggestedWorkflow: { version: 9, name: 'Project' },
        };
      },
      async configurePreset(preset, options, workflowId) {
        configured.push({ preset, options, workflowId });
      },
      snapshot(workflowId) {
        return {
          workflowId,
          workflow: { version: 9, name: 'Project' },
          suggestedWorkflow: null,
        };
      },
      async uploadAndStartArchiveRun(request) {
        assert.equal(configured.length, 1, 'workflow must be configured before the archive run');
        uploads.push(request);
        return { run: { runId: 'run-selected' } };
      },
    },
    async openWorkflowSurface() {
      surfaceOpens += 1;
    },
  };
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.equal(await handleCommand('/apply', context), true);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(configured, [{
    preset: 'apply-changes',
    options: {},
    workflowId: 'workflow-authoritative',
  }]);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].fileId, artifact.id);
  assert.equal(uploads[0].correlation.workflowId, 'workflow-authoritative');
  assert.equal(uploads[0].correlation.requestId, 'request-selected');
  assert.equal(surfaceOpens, 1);
});

test('workflow service failure is command-scoped and ordinary ChatGPT use remains available', async () => {
  const state = {
    projectRoot: '/project',
    projectId: 'project-current',
    pendingAttachments: [],
    responseHistory: [],
  };
  const requests = [];
  const context = {
    state,
    fileStore: {},
    workflowManager: { list: () => [] },
    zipflowWorkflowRuntime: {
      async openProject() {
        throw Object.assign(new Error('service unavailable'), { code: 'ECONNREFUSED' });
      },
    },
    bridge: {
      async sendRequest(request) {
        requests.push(request);
        return {
          requestId: 'request-chat',
          answer: 'Chat is still available.',
          artifacts: [],
          session: { id: 'session-chat' },
        };
      },
    },
    createConsoleStream: () => ({
      status() {},
      onThinkingUpdate() {},
      onProgressUpdate() {},
      onAnswerUpdate() {},
      onArtifactUpdate() {},
      finish() {},
    }),
  };
  await assert.rejects(
    () => handleCommand('/apply', context),
    { code: 'ECONNREFUSED' },
  );
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.equal(await handleCommand('/chat continue normally', context), true);
  } finally {
    console.log = originalLog;
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].message, 'continue normally');
  assert.equal(state.responseHistory.at(-1).text, 'Chat is still available.');
});
