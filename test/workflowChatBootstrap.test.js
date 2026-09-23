import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bootstrapWorkflowChat, openFreshWorkflowChatTab } from '../src/workflow/session/bootstrap.js';

function fixtureWorkflow(root) {
  return {
    id: 'workflow-bootstrap-fixture',
    preset: 'guided-task',
    projectRoot: root,
    resultProtocol: { manifest: '.zipflow/result.json' },
  };
}

test('workflow new-chat bootstrap opens a dedicated fresh tab before sending the first prompt', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-workflow-bootstrap-'));
  const calls = [];
  const bridge = {
    async newSession() { throw new Error('sessions.new must not be used for workflow bootstrap'); },
    async openBrowserTab(options) {
      calls.push(['openBrowserTab', options]);
      return {
        launchToken: options.launchToken,
        openedBy: 'extension',
        client: {
          id: 'ext-shared:tab:202',
          browserTabId: 202,
          url: 'https://chatgpt.com/',
          session: { id: 'new' },
        },
      };
    },
    async sendRequest(options) {
      calls.push(['sendRequest', options]);
      return {
        answer: 'Ready.',
        sourceClientId: 'ext-shared:tab:202',
        session: { id: 'conversation-202', url: 'https://chatgpt.com/c/conversation-202' },
      };
    },
  };
  const imported = [];
  const fileStore = {
    async importLocalPath(options) {
      imported.push(options);
      return { id: `file-${imported.length}`, name: options.name };
    },
  };
  const uploaded = [];
  const projectService = {
    async markSnapshotUploaded(options) { uploaded.push(options); },
  };
  const pack = {
    file: { id: 'project-snapshot-file' },
    project: { id: 'project-fixture' },
    snapshotId: 'snapshot-fixture',
    sha256: 'sha-fixture',
  };

  try {
    const result = await bootstrapWorkflowChat({
      workflow: fixtureWorkflow(dataDir),
      bridge,
      fileStore,
      projectService,
      projectPack: pack,
      dataDir,
      sourceClientId: 'selected-control-tab',
    });

    assert.equal(calls[0][0], 'openBrowserTab');
    assert.equal(calls[0][1].sourceClientId, 'selected-control-tab');
    assert.equal(calls[0][1].url, 'https://chatgpt.com/');
    assert.equal(calls[0][1].active, true);
    assert.match(calls[0][1].launchToken, /^bridge-workflow-/);

    assert.equal(calls[1][0], 'sendRequest');
    assert.equal(calls[1][1].sourceClientId, 'ext-shared:tab:202');
    assert.equal(calls[1][1].sessionId, '');
    assert.equal(calls[1][1].newSession, false);
    assert.equal(calls[1][1].autoOpenTab, false);
    assert.deepEqual(calls[1][1].attachments, ['project-snapshot-file', 'file-1']);

    assert.equal(result.sessionId, 'conversation-202');
    assert.equal(result.sourceClientId, 'ext-shared:tab:202');
    assert.equal(result.browserTabId, 202);
    assert.equal(uploaded[0].threadId, 'conversation-202');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('fresh workflow tab proof rejects an existing conversation', async () => {
  const bridge = {
    async openBrowserTab() {
      return {
        client: {
          id: 'existing-tab',
          url: 'https://chatgpt.com/c/existing-conversation',
          session: { id: 'existing-conversation' },
        },
      };
    },
  };
  await assert.rejects(
    openFreshWorkflowChatTab({ bridge, sourceClientId: 'control-tab' }),
    /not a fresh ChatGPT chat/,
  );
});

test('workflow bootstrap refuses to pin the pseudo-session new', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-workflow-pseudo-session-'));
  const bridge = {
    async openBrowserTab(options) {
      return { launchToken: options.launchToken, client: { id: 'fresh-tab', url: 'https://chatgpt.com/', session: { id: 'new' } } };
    },
    async sendRequest() { return { answer: 'Ready.', sourceClientId: 'fresh-tab', session: { id: 'new' }, url: 'https://chatgpt.com/' }; },
  };
  const fileStore = { async importLocalPath() { return { id: 'instructions' }; } };
  const projectService = { async markSnapshotUploaded() { throw new Error('must not mark pseudo-session'); } };
  const projectPack = { file: { id: 'project-file' }, project: { id: 'project' }, snapshotId: 'snapshot', sha256: 'sha' };
  try {
    await assert.rejects(
      bootstrapWorkflowChat({
        workflow: fixtureWorkflow(dataDir), bridge, fileStore, projectService, projectPack, dataDir,
      }),
      /did not create a concrete conversation/,
    );
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
