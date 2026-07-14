import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeZip } from '../src/zipWriter.js';
import { loadWorkflowConfig } from '../src/workflow/config.js';
import { WorkflowManager } from '../src/workflow/workflowManager.js';
import { buildCommitContext, createGitCommit, extractMarkedBlock } from '../src/workflow/gitCommit.js';
import { ExtensionDeployer } from '../src/workflow/extensionDeployer.js';

const execFileAsync = promisify(execFile);

async function tempRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-bridge-workflow-test-'));
}

async function waitFor(predicate, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function makeZip(target, sourceText) {
  await writeZip(target, [
    { name: 'package.json', data: JSON.stringify({ name: 'workflow-fixture', version: '1.0.0' }, null, 2) },
    { name: 'src/index.js', data: sourceText },
  ]);
  return target;
}

async function writeConfig(target, projectRoot, overrides = {}) {
  const value = {
    version: 1,
    id: overrides.id || 'fixture-workflow',
    enabled: true,
    projectRoot,
    watch: { mode: 'auto', includeLatest: false, refreshIntervalMs: 0, ...(overrides.watch || {}) },
    artifact: { expected: 'zip', requireSingleCandidate: true },
    verification: {
      requiredFiles: ['package.json', 'src/index.js'],
      packageName: 'workflow-fixture',
      minProjectFileOverlap: 0.5,
      commands: [],
      ...(overrides.verification || {}),
    },
    apply: {
      sync: true,
      requireCleanGit: false,
      rollbackOnFailure: true,
      protectedPaths: ['.git/**', '.env*'],
      allowedWarningCodes: ['NO_REFERENCE_MANIFEST_FOR_SYNC'],
      maxChangedFiles: 100,
      maxDeletedFiles: 20,
      commands: [],
      ...(overrides.apply || {}),
    },
    remediation: { enabled: false, maxAttempts: 0, sameChat: true, ...(overrides.remediation || {}) },
    commit: { mode: 'none', required: false, ...(overrides.commit || {}) },
    extensionUpdate: { enabled: false, sourceDir: 'tools/chrome-bridge-extension', targetDir: '', reloadTabs: true, ...(overrides.extensionUpdate || {}) },
  };
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return target;
}

function createBridgeAndStore(zipByArtifact, remediationResponses = []) {
  let observedListener = null;
  const sendRequests = [];
  const fileById = new Map();
  for (const [artifactId, zipPath] of Object.entries(zipByArtifact)) {
    fileById.set(`file-${artifactId}`, zipPath);
  }
  const bridge = {
    onObservedTurn(listener) { observedListener = listener; return () => { observedListener = null; }; },
    registerObservedArtifacts(artifacts, metadata) {
      return artifacts.map((artifact) => ({ ...artifact, sourceClientId: artifact.sourceClientId || metadata.sourceClientId, sourceTurnKey: artifact.sourceTurnKey || metadata.turnKey }));
    },
    async fetchArtifact(artifactId) {
      const zipPath = zipByArtifact[artifactId];
      if (!zipPath) throw new Error(`Missing fixture artifact: ${artifactId}`);
      const stat = await fs.stat(zipPath);
      return { id: `file-${artifactId}`, name: path.basename(zipPath), size: stat.size, mime: 'application/zip' };
    },
    async sendRequest(request) {
      sendRequests.push(request);
      const response = remediationResponses.shift();
      if (!response) throw new Error('Unexpected remediation request');
      return response;
    },
    async reloadExtension() { return { accepted: true, reconnected: true }; },
    async reloadBrowserTab() { return { reloading: true }; },
    async recoverLatestResponse() { throw new Error('not expected'); },
    async deleteSession() { return { deleted: true }; },
  };
  const fileStore = {
    async getReadable(fileId) {
      const absolutePath = fileById.get(fileId);
      if (!absolutePath) return null;
      const stat = await fs.stat(absolutePath);
      return { id: fileId, absolutePath, name: path.basename(absolutePath), size: stat.size, mime: 'application/zip' };
    },
    async importLocalPath({ filePath, name, mime }) { return { id: `attachment-${Date.now()}`, absolutePath: filePath, name, mime }; },
  };
  return {
    bridge,
    fileStore,
    sendRequests,
    emitObserved(turn) {
      assert.ok(observedListener, 'observed turn listener is registered');
      observedListener(turn);
    },
  };
}

function observedTurn(artifactId, answer = '', { sourceClientId = 'client-1', sessionId = 'session-1' } = {}) {
  return {
    type: 'observed.turn.terminal',
    sourceClientId,
    sessionId,
    session: { id: sessionId, url: `https://chatgpt.com/c/${sessionId}` },
    turnKey: `turn-${artifactId}`,
    answer,
    artifacts: [{ id: artifactId, name: `${artifactId}.zip`, mime: 'application/zip', kind: 'file', phase: 'READY', downloadable: true, sourceTurnKey: `turn-${artifactId}` }],
  };
}

test('workflow config expands home paths and preserves safe defaults', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const configPath = path.join(root, 'bridge.workflow.json');
  await writeConfig(configPath, project, { extensionUpdate: { enabled: true, targetDir: '~/.local/share/chatgpt-bridge-test/extension' } });
  const config = await loadWorkflowConfig(configPath);
  assert.equal(config.watch.mode, 'auto');
  assert.equal(config.extensionUpdate.targetDir, path.join(os.homedir(), '.local/share/chatgpt-bridge-test/extension'));
  assert.equal(config.commit.mode, 'none');
});

test('ask workflow verifies artifact but waits for approval before modifying project', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'workflow-fixture', version: '1.0.0' }));
  await fs.writeFile(path.join(project, 'src/index.js'), 'old\n');
  const zipPath = await makeZip(path.join(root, 'update.zip'), 'new\n');
  const configPath = await writeConfig(path.join(root, 'workflow.json'), project, { watch: { mode: 'ask' } });
  const fixture = createBridgeAndStore({ update: zipPath });
  const manager = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir: path.join(root, 'data') });
  t.after(() => manager.close());
  await manager.load(configPath);
  fixture.emitObserved(observedTurn('update'));
  const approval = await waitFor(async () => (await manager.approvals())[0]);
  assert.equal(await fs.readFile(path.join(project, 'src/index.js'), 'utf8'), 'old\n');
  const result = await manager.approve(approval.id);
  assert.equal(result.status, 'applied');
  assert.equal(await fs.readFile(path.join(project, 'src/index.js'), 'utf8'), 'new\n');
});

test('auto workflow rolls back failed artifact, sends validation output, and applies remediation artifact', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'workflow-fixture', version: '1.0.0' }));
  await fs.writeFile(path.join(project, 'src/index.js'), 'original\n');
  const broken = await makeZip(path.join(root, 'broken.zip'), 'broken\n');
  const fixed = await makeZip(path.join(root, 'fixed.zip'), 'fixed\n');
  const configPath = await writeConfig(path.join(root, 'workflow.json'), project, {
    apply: { commands: ["node -e \"process.exit(require('fs').readFileSync('src/index.js','utf8').includes('fixed')?0:1)\""] },
    remediation: { enabled: true, maxAttempts: 1, sameChat: true, outputTailLines: 50 },
  });
  const fixture = createBridgeAndStore({ broken, fixed }, [observedTurn('fixed')]);
  const manager = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir: path.join(root, 'data') });
  t.after(() => manager.close());
  await manager.load(configPath);
  fixture.emitObserved(observedTurn('broken'));
  const events = await waitFor(async () => {
    const values = await manager.events('fixture-workflow', 200);
    return values.some((event) => event.type === 'workflow.completed') ? values : null;
  }, 12_000);
  assert.equal(await fs.readFile(path.join(project, 'src/index.js'), 'utf8'), 'fixed\n');
  assert.equal(fixture.sendRequests.length, 1);
  assert.equal(fixture.sendRequests[0].sessionId, 'session-1');
  assert.match(fixture.sendRequests[0].message, /VALIDATION_OUTPUT_BEGIN/);
  assert.ok(events.some((event) => event.type === 'workflow.apply.failed'));
  assert.ok(events.some((event) => event.type === 'workflow.remediation.response.completed'));
  assert.ok(events.some((event) => event.type === 'workflow.completed'));
});

test('commit marker extraction and git commit use the exact marked message', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', root]);
  await fs.writeFile(path.join(root, 'file.txt'), 'one\n');
  await execFileAsync('git', ['-C', root, 'add', '-A']);
  await execFileAsync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Initial']);
  await fs.writeFile(path.join(root, 'file.txt'), 'two\n');
  const marked = 'before\nCOMMIT_MESSAGE_BEGIN\nUpdate fixture workflow\n\nKeep the body.\nCOMMIT_MESSAGE_END\nafter';
  const message = extractMarkedBlock(marked, 'COMMIT_MESSAGE_BEGIN', 'COMMIT_MESSAGE_END');
  assert.equal(message, 'Update fixture workflow\n\nKeep the body.');
  const result = await createGitCommit({ root, message, authorName: 'Fixture', authorEmail: 'fixture@example.com' });
  assert.equal(result.committed, true);
  const log = (await execFileAsync('git', ['-C', root, 'log', '-1', '--pretty=%B'])).stdout.trim();
  assert.equal(log, message);
});

test('extension deployer copies into stable directory and requests one reload', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const target = path.join(root, 'stable');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ version: '9.9.9' }));
  await fs.writeFile(path.join(source, 'content.js'), 'new');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'stale.js'), 'stale');
  const calls = [];
  const deployer = new ExtensionDeployer({ bridge: { async reloadExtension(options) { calls.push(options); return { reconnected: { extensionVersion: '9.9.9' } }; } } });
  const result = await deployer.deploy({ extensionUpdate: { enabled: true, sourceDir: source, targetDir: target, reloadTabs: true, reconnectTimeoutMs: 12345 } }, { sourceClientId: 'client-1' });
  assert.equal(result.updated, true);
  assert.equal(await fs.readFile(path.join(target, 'content.js'), 'utf8'), 'new');
  assert.equal(await fs.stat(path.join(target, 'stale.js')).catch(() => null), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].expectedVersion, '9.9.9');
});

test('workflow store serializes concurrent state writes', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { WorkflowStore } = await import('../src/workflow/store.js');
  const store = new WorkflowStore(root);
  await Promise.all(Array.from({ length: 40 }, (_, index) => store.appendEvent({ id: `event-${index}`, workflowId: 'fixture', type: 'test', time: new Date().toISOString(), data: { index } })));
  const events = await store.listEvents({ workflowId: 'fixture', limit: 100 });
  assert.equal(events.length, 40);
  const disk = JSON.parse(await fs.readFile(path.join(root, 'workflows/state.json'), 'utf8'));
  assert.equal(disk.events.length, 40);
});

test('positive passive refresh intervals are clamped to a safe minimum', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const configPath = await writeConfig(path.join(root, 'workflow.json'), project, {
    watch: { mode: 'verify', refreshIntervalMs: 250 },
  });
  const config = await loadWorkflowConfig(configPath);
  assert.equal(config.watch.refreshIntervalMs, 30_000);
});

test('the same verified ZIP is not applied twice to one workflow', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'workflow-fixture', version: '1.0.0' }));
  await fs.writeFile(path.join(project, 'src/index.js'), 'old\n');
  const zipPath = await makeZip(path.join(root, 'same.zip'), 'new\n');
  const configPath = await writeConfig(path.join(root, 'workflow.json'), project);
  const fixture = createBridgeAndStore({ first: zipPath, second: zipPath });
  const manager = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir: path.join(root, 'data') });
  t.after(() => manager.close());
  await manager.load(configPath);

  fixture.emitObserved(observedTurn('first'));
  await waitFor(async () => (await manager.events('fixture-workflow', 200)).some((event) => event.type === 'workflow.completed'));
  fixture.emitObserved(observedTurn('second'));
  const events = await waitFor(async () => {
    const values = await manager.events('fixture-workflow', 200);
    return values.some((event) => event.type === 'workflow.artifact.duplicate') ? values : null;
  });

  assert.equal(await fs.readFile(path.join(project, 'src/index.js'), 'utf8'), 'new\n');
  assert.equal(events.filter((event) => event.type === 'workflow.apply.completed').length, 1);
  assert.equal(events.filter((event) => event.type === 'workflow.artifact.duplicate').length, 1);
});

test('pending approvals survive restart and rejection resumes watching', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'workflow-fixture', version: '1.0.0' }));
  await fs.writeFile(path.join(project, 'src/index.js'), 'old\n');
  const zipPath = await makeZip(path.join(root, 'approval.zip'), 'new\n');
  const configPath = await writeConfig(path.join(root, 'workflow.json'), project, { watch: { mode: 'ask' } });
  const fixture = createBridgeAndStore({ approval: zipPath });
  const dataDir = path.join(root, 'data');

  const first = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir });
  await first.load(configPath);
  fixture.emitObserved(observedTurn('approval'));
  const approval = await waitFor(async () => (await first.approvals())[0]);
  assert.equal(first.get('fixture-workflow').status, 'awaiting-approval');
  await first.close();

  const second = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir });
  t.after(() => second.close());
  const restored = await second.restore();
  assert.equal(restored.length, 1);
  assert.equal(second.get('fixture-workflow').status, 'awaiting-approval');
  assert.equal((await second.approvals()).length, 1);
  await second.reject(approval.id, 'not this revision');
  assert.equal(second.get('fixture-workflow').status, 'watching');
  assert.equal(await fs.readFile(path.join(project, 'src/index.js'), 'utf8'), 'old\n');
});

test('commit failures do not trigger artifact remediation after tests passed', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'workflow-fixture', version: '1.0.0' }));
  await fs.writeFile(path.join(project, 'src/index.js'), 'old\n');
  const zipPath = await makeZip(path.join(root, 'commit-warning.zip'), 'new\n');
  const configPath = await writeConfig(path.join(root, 'workflow.json'), project, {
    remediation: { enabled: true, maxAttempts: 2, sameChat: true },
    commit: { mode: 'block', required: true },
  });
  const fixture = createBridgeAndStore({ update: zipPath });
  const manager = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir: path.join(root, 'data') });
  t.after(() => manager.close());
  await manager.load(configPath);
  fixture.emitObserved(observedTurn('update', 'No commit marker was provided.'));
  const events = await waitFor(async () => {
    const values = await manager.events('fixture-workflow', 200);
    return values.some((event) => event.type === 'workflow.completed_with_warnings') ? values : null;
  });

  assert.equal(await fs.readFile(path.join(project, 'src/index.js'), 'utf8'), 'new\n');
  assert.equal(fixture.sendRequests.length, 0);
  assert.ok(events.some((event) => event.type === 'workflow.commit.failed'));
  assert.equal(events.some((event) => event.type === 'workflow.remediation.prompt.started'), false);
  assert.equal(manager.get('fixture-workflow').status, 'watching');
});

test('observed turns arriving during an active pipeline are queued instead of dropped', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'workflow-fixture', version: '1.0.0' }));
  await fs.writeFile(path.join(project, 'src/index.js'), 'initial\n');
  const firstZip = await makeZip(path.join(root, 'first.zip'), 'first\n');
  const secondZip = await makeZip(path.join(root, 'second.zip'), 'second\n');
  const configPath = await writeConfig(path.join(root, 'workflow.json'), project, {
    apply: { commands: ["node -e \"setTimeout(() => process.exit(0), 150)\""] },
  });
  const fixture = createBridgeAndStore({ first: firstZip, second: secondZip });
  const manager = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir: path.join(root, 'data') });
  t.after(() => manager.close());
  await manager.load(configPath);

  fixture.emitObserved(observedTurn('first'));
  fixture.emitObserved(observedTurn('second'));
  const events = await waitFor(async () => {
    const values = await manager.events('fixture-workflow', 300);
    return values.filter((event) => event.type === 'workflow.completed').length === 2 ? values : null;
  }, 12_000);

  assert.equal(await fs.readFile(path.join(project, 'src/index.js'), 'utf8'), 'second\n');
  assert.equal(events.filter((event) => event.type === 'workflow.turn.observed').length, 2);
  assert.equal(events.filter((event) => event.type === 'workflow.apply.completed').length, 2);
});

test('only one loaded workflow may manage a project root', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const firstConfig = await writeConfig(path.join(root, 'first.json'), project, { id: 'first-workflow', watch: { mode: 'verify' } });
  const secondConfig = await writeConfig(path.join(root, 'second.json'), project, { id: 'second-workflow', watch: { mode: 'verify' } });
  const fixture = createBridgeAndStore({});
  const manager = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir: path.join(root, 'data') });
  t.after(() => manager.close());
  await manager.load(firstConfig);
  await assert.rejects(manager.load(secondConfig), /already managed by workflow first-workflow/);
});

test('temporary commit-chat context includes untracked file contents within the byte budget', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', root]);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'one\n');
  await execFileAsync('git', ['-C', root, 'add', '-A']);
  await execFileAsync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Initial']);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'two\n');
  await fs.writeFile(path.join(root, 'new-file.txt'), 'new implementation detail\n');
  const target = path.join(root, 'context.txt');
  const result = await buildCommitContext(root, target, { maxBytes: 64 * 1024 });
  const content = await fs.readFile(target, 'utf8');
  assert.match(content, /# Tracked diff/);
  assert.match(content, /new-file\.txt/);
  assert.match(content, /new implementation detail/);
  assert.equal(result.untrackedFiles, 1);
  assert.equal(result.truncated, false);
});

test('restore rolls back an interrupted apply from its persisted safe manifest', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'workflow-fixture', version: '1.0.0' }));
  await fs.writeFile(path.join(project, 'src/index.js'), 'original\n');
  const configPath = await writeConfig(path.join(root, 'workflow.json'), project, { watch: { mode: 'verify' } });
  const fixture = createBridgeAndStore({});

  const first = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir });
  await first.load(configPath);
  const pipelineId = 'pipeline_interrupted_fixture';
  const rollbackRoot = path.join(dataDir, 'workflows', 'fixture-workflow', 'pipelines', pipelineId, 'rollback');
  const backupPath = path.join(rollbackRoot, 'src/index.js');
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.copyFile(path.join(project, 'src/index.js'), backupPath);
  await fs.writeFile(path.join(rollbackRoot, 'manifest.json'), JSON.stringify([
    { path: 'src/index.js', exists: true, type: 'file', backupPath },
  ], null, 2));
  await fs.writeFile(path.join(project, 'src/index.js'), 'partially-applied\n');
  await first.store.setWorkflow('fixture-workflow', {
    ...first.get('fixture-workflow'),
    status: 'processing',
    lastPipelineId: pipelineId,
  });
  await first.close();

  const second = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir });
  t.after(() => second.close());
  await second.restore();
  assert.equal(await fs.readFile(path.join(project, 'src/index.js'), 'utf8'), 'original\n');
  assert.equal(second.get('fixture-workflow').status, 'watching');
  const events = await second.events('fixture-workflow', 50);
  assert.ok(events.some((event) => event.type === 'workflow.interrupted.rollback.completed'));
});

test('automatic commit skips pre-existing Git changes instead of committing unrelated work', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'workflow-fixture', version: '1.0.0' }));
  await fs.writeFile(path.join(project, 'src/index.js'), 'old\n');
  await fs.writeFile(path.join(project, 'notes.txt'), 'clean\n');
  await execFileAsync('git', ['init', project]);
  await execFileAsync('git', ['-C', project, 'add', '-A']);
  await execFileAsync('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Initial']);
  await fs.writeFile(path.join(project, 'notes.txt'), 'local work\n');

  const zipPath = await makeZip(path.join(root, 'update.zip'), 'new\n');
  const configPath = await writeConfig(path.join(root, 'workflow.json'), project, {
    watch: { mode: 'ask' },
    apply: { sync: false },
    commit: { mode: 'block', required: false },
  });
  const fixture = createBridgeAndStore({ update: zipPath });
  const manager = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir: path.join(root, 'data') });
  t.after(() => manager.close());
  await manager.load(configPath);
  fixture.emitObserved(observedTurn('update', 'COMMIT_MESSAGE_BEGIN\nUpdate project\nCOMMIT_MESSAGE_END'));
  const approval = await waitFor(async () => (await manager.approvals())[0]);
  const result = await manager.approve(approval.id);

  assert.equal(result.status, 'applied');
  assert.equal(result.commit.reason, 'preexisting-changes');
  assert.equal(await fs.readFile(path.join(project, 'src/index.js'), 'utf8'), 'new\n');
  assert.equal(await fs.readFile(path.join(project, 'notes.txt'), 'utf8'), 'local work\n');
  const count = (await execFileAsync('git', ['-C', project, 'rev-list', '--count', 'HEAD'])).stdout.trim();
  assert.equal(count, '1');
});


test('workflow binds to the first verified artifact source and ignores other conversations', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'workflow-fixture', version: '1.0.0' }));
  await fs.writeFile(path.join(project, 'src/index.js'), 'original\n');
  const first = await makeZip(path.join(root, 'first.zip'), 'first\n');
  const other = await makeZip(path.join(root, 'other.zip'), 'other\n');
  const configPath = await writeConfig(path.join(root, 'workflow.json'), project, {
    watch: { mode: 'auto', bindOnFirstVerifiedArtifact: true }
  });
  const fixture = createBridgeAndStore({ first, other });
  const manager = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir: path.join(root, 'data') });
  t.after(() => manager.close());
  await manager.load(configPath);
  fixture.emitObserved(observedTurn('first'));
  await waitFor(async () => (await manager.events('fixture-workflow', 200)).some((event) => event.type === 'workflow.completed'));
  const bound = manager.get('fixture-workflow');
  assert.equal(bound.boundSourceClientId, 'client-1');
  assert.equal(bound.boundSessionId, 'session-1');

  fixture.emitObserved(observedTurn('other', '', { sourceClientId: 'client-2', sessionId: 'session-2' }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(await fs.readFile(path.join(project, 'src/index.js'), 'utf8'), 'first\n');
  const events = await manager.events('fixture-workflow', 300);
  assert.equal(events.some((event) => event.type === 'workflow.turn.observed' && event.data.turnKey === 'turn-other'), false);
});
