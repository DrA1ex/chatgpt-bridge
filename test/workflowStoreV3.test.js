import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkflowStore } from '../src/workflow/store.js';

async function temporaryStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-store-v3-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, dir: path.join(root, 'workflows'), file: path.join(root, 'workflows', 'state.json') };
}

test('first v3 startup archives a v2 runtime snapshot and starts empty', async (t) => {
  const target = await temporaryStore(t);
  await fs.mkdir(target.dir, { recursive: true });
  await fs.writeFile(target.file, JSON.stringify({ schemaVersion: 2, workflows: { old: { watcher: { status: 'running' } } } }));
  const store = new WorkflowStore(target.root);
  assert.deepEqual(await store.listWorkflows(), []);
  const files = await fs.readdir(target.dir);
  assert.equal(files.some((name) => name.startsWith('state.v2-') && name.endsWith('.json')), true);
  const current = JSON.parse(await fs.readFile(target.file, 'utf8'));
  assert.equal(current.schemaVersion, 3);
  assert.deepEqual(current.workflows, {});
});

test('corrupt runtime data is archived instead of silently overwritten', async (t) => {
  const target = await temporaryStore(t);
  await fs.mkdir(target.dir, { recursive: true });
  await fs.writeFile(target.file, '{invalid');
  const store = new WorkflowStore(target.root);
  await store.ready;
  const files = await fs.readdir(target.dir);
  assert.equal(files.some((name) => name.startsWith('state.corrupt-') && name.endsWith('.json')), true);
});

test('transition, decision, artifact, and workflow snapshot commit atomically', async (t) => {
  const target = await temporaryStore(t);
  const store = new WorkflowStore(target.root);
  const workflow = { id: 'workflow-1', execution: { schemaVersion: 3, revision: 4, git: { baseSha: 'base', checkpointShas: ['checkpoint'], ownedPaths: ['src/index.js'], pathStates: { 'src/index.js': { sha256: 'abc' } }, lastCommitMessage: 'fix: checkpoint' } } };
  await store.commitTransition('workflow-1', workflow, {
    workflowId: 'workflow-1', eventId: 'event-4', accepted: true, revision: 4,
  }, {
    decisions: { action: { id: 'action', status: 'pending' } },
    artifacts: { artifact: { id: 'artifact', status: 'verified' } },
  });
  assert.deepEqual(await store.getWorkflow('workflow-1'), workflow);
  assert.equal((await store.getDecision('action')).status, 'pending');
  assert.equal((await store.getArtifact('artifact')).status, 'verified');
  assert.equal((await store.listTransitions({ workflowId: 'workflow-1' }))[0].eventId, 'event-4');
  const disk = JSON.parse(await fs.readFile(target.file, 'utf8'));
  assert.equal(disk.workflows['workflow-1'].execution.revision, 4);
  assert.deepEqual(disk.workflows['workflow-1'].execution.git, workflow.execution.git);
  assert.equal(disk.decisions.action.status, 'pending');
  assert.equal(disk.artifacts.artifact.status, 'verified');
});
