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
    projectContext: { enabled: true, mode: 'identity', syncOnStart: true, syncAfterBind: true, fallbackFiles: ['package.json', 'README.md'], ...(overrides.projectContext || {}) },
    verification: {
      requiredFiles: ['package.json', 'src/index.js'],
      packageName: 'workflow-fixture',
      minProjectFileOverlap: 0.5,
      commands: [],
      requireProjectIdentity: false,
      identityFallbackFiles: ['package.json', 'README.md'],
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
    extensionUpdate: { enabled: false, sourceDir: 'tools/chrome-bridge-extension', targetDir: '', reloadTabs: true, backupRetention: 3, rollbackOnReloadFailure: true, ...(overrides.extensionUpdate || {}) },
    daemonRestart: { enabled: false, mode: 'none', ...(overrides.daemonRestart || {}) },
  };
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return target;
}

function createBridgeAndStore(zipByArtifact, remediationResponses = [], { contextAnswerSuffix = '' } = {}) {
  let observedListener = null;
  const sendRequests = [];
  const contextRequests = [];
  const importedFiles = [];
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
      const marker = String(request.message || '').match(/PROJECT_CONTEXT_SYNCED_bridge-project-[a-f0-9-]+/i)?.[0] || '';
      if (marker) { contextRequests.push(request); return { answer: `${marker}${contextAnswerSuffix}`, session: { id: request.sessionId || 'session-1' }, sourceClientId: request.sourceClientId || 'client-1' }; }
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
    async importLocalPath({ filePath, name, mime }) {
      const imported = { id: `attachment-${Date.now()}-${importedFiles.length}`, absolutePath: filePath, name, mime };
      importedFiles.push(imported);
      return imported;
    },
  };
  return {
    bridge,
    fileStore,
    sendRequests,
    contextRequests,
    importedFiles,
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
  const pendingState = manager.get('fixture-workflow');
  assert.equal(pendingState.watcher.status, 'running');
  assert.equal(pendingState.pipeline.status, 'awaiting_approval');
  assert.equal(pendingState.pipeline.id, approval.pipelineId);
  assert.equal(await fs.readFile(path.join(project, 'src/index.js'), 'utf8'), 'old\n');
  const result = await manager.approve(approval.id);
  assert.equal(result.status, 'applied');
  assert.equal(await fs.readFile(path.join(project, 'src/index.js'), 'utf8'), 'new\n');
});

test('ask workflow defers later observed turns without replacing the approval pipeline', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'workflow-fixture', version: '1.0.0' }));
  await fs.writeFile(path.join(project, 'src/index.js'), 'old\n');
  const firstZip = await makeZip(path.join(root, 'first.zip'), 'first\n');
  const secondZip = await makeZip(path.join(root, 'second.zip'), 'second\n');
  const configPath = await writeConfig(path.join(root, 'workflow.json'), project, { watch: { mode: 'ask' } });
  const fixture = createBridgeAndStore({ first: firstZip, second: secondZip });
  const manager = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir: path.join(root, 'data') });
  t.after(() => manager.close());
  await manager.load(configPath);

  fixture.emitObserved(observedTurn('first'));
  const firstApproval = await waitFor(async () => (await manager.approvals())[0]);
  const firstPipelineId = firstApproval.pipelineId;
  fixture.emitObserved(observedTurn('second'));

  const deferredEvents = await waitFor(async () => {
    const events = await manager.events('fixture-workflow', 200);
    return events.some((event) => event.type === 'workflow.turn.deferred') ? events : null;
  });
  assert.equal(manager.get('fixture-workflow').pipeline.id, firstPipelineId);
  assert.equal(manager.get('fixture-workflow').pipeline.status, 'awaiting_approval');
  assert.ok(deferredEvents.some((event) => event.type === 'workflow.turn.deferred' && event.data.turnKey === 'turn-second'));

  const applied = await manager.approve(firstApproval.id);
  assert.equal(applied.status, 'applied');
  assert.equal(await fs.readFile(path.join(project, 'src/index.js'), 'utf8'), 'first\n');

  const secondApproval = await waitFor(async () => {
    const approvals = await manager.approvals();
    return approvals.find((approval) => approval.id !== firstApproval.id) || null;
  });
  assert.notEqual(secondApproval.pipelineId, firstPipelineId);
  assert.equal(manager.get('fixture-workflow').pipeline.id, secondApproval.pipelineId);
  await manager.reject(secondApproval.id, 'fixture cleanup');
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
  const pipelineIds = new Set(events
    .filter((event) => event.data?.pipelineId)
    .map((event) => event.data.pipelineId));
  assert.equal(pipelineIds.size, 1, 'remediation should continue the original pipeline');
  assert.equal(manager.get('fixture-workflow').pipeline.status, 'completed');
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
  const deployer = new ExtensionDeployer({ dataDir: path.join(root, 'data'), bridge: { async reloadExtension(options) { calls.push(options); return { reconnected: { extensionVersion: '9.9.9' } }; } } });
  const result = await deployer.deploy({ id: 'extension-fixture', extensionUpdate: { enabled: true, sourceDir: source, targetDir: target, reloadTabs: true, reconnectTimeoutMs: 12345, backupRetention: 3, rollbackOnReloadFailure: true } }, { sourceClientId: 'client-1' });
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
  assert.equal(first.get('fixture-workflow').watcher.status, 'running');
  assert.equal(first.get('fixture-workflow').pipeline.status, 'awaiting_approval');
  await first.close();

  const second = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir });
  t.after(() => second.close());
  const restored = await second.restore();
  assert.equal(restored.length, 1);
  assert.equal(second.get('fixture-workflow').watcher.status, 'running');
  assert.equal(second.get('fixture-workflow').pipeline.status, 'awaiting_approval');
  assert.equal((await second.approvals()).length, 1);
  await second.reject(approval.id, 'not this revision');
  assert.equal(second.get('fixture-workflow').watcher.status, 'running');
  assert.equal(second.get('fixture-workflow').pipeline.status, 'rejected');
  assert.equal(await fs.readFile(path.join(project, 'src/index.js'), 'utf8'), 'old\n');
});

test('paused automation and pending attention survive manager restart', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'workflow-fixture', version: '1.0.0' }));
  await fs.writeFile(path.join(project, 'src/index.js'), 'old\n');
  const configPath = await writeConfig(path.join(root, 'workflow.json'), project);
  const fixture = createBridgeAndStore({});
  const first = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir });
  await first.load(configPath);
  const saved = first.get('fixture-workflow');
  await first.store.setWorkflow('fixture-workflow', {
    ...saved,
    automationInterrupted: true,
    automation: {
      ...saved.automation,
      id: 'automation-paused',
      status: 'waiting_turn',
      cycle: 2,
      maxCycles: 8,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    attention: {
      required: true,
      key: 'fixture-workflow:no-progress:2',
      kind: 'no-progress',
      title: 'Workflow is not making progress',
      message: 'The same failures remained.',
    },
  });
  await first.close();

  const notifications = [];
  const second = new WorkflowManager({
    bridge: fixture.bridge,
    fileStore: fixture.fileStore,
    dataDir,
    notificationService: {
      async notify(value) { notifications.push(value); return { notified: true }; },
      acknowledge() {},
      invalidateConfig() {},
    },
  });
  t.after(() => second.close());
  await second.restore();
  const restored = second.get('fixture-workflow');
  assert.equal(restored.automationInterrupted, true);
  assert.equal(restored.automation.status, 'waiting_turn');
  assert.equal(restored.attention.kind, 'no-progress');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].key, 'fixture-workflow:no-progress:2');
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
    lastPipelineId: pipelineId,
    pipeline: {
      ...first.get('fixture-workflow').pipeline,
      id: pipelineId,
      status: 'applying',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  await first.close();

  const second = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir });
  t.after(() => second.close());
  await second.restore();
  assert.equal(await fs.readFile(path.join(project, 'src/index.js'), 'utf8'), 'original\n');
  const events = await second.events('fixture-workflow', 50);
  assert.ok(events.some((event) => event.type === 'workflow.interrupted.rollback.completed'));
});

test('automatic commit includes only workflow-owned files and preserves unrelated local work', async (t) => {
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
  await execFileAsync('git', ['-C', project, 'config', 'user.name', 'Fixture']);
  await execFileAsync('git', ['-C', project, 'config', 'user.email', 'fixture@example.com']);
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
  assert.equal(result.commit.committed, true);
  assert.deepEqual(result.commit.paths.sort(), ['package.json', 'src/index.js']);
  assert.equal(await fs.readFile(path.join(project, 'src/index.js'), 'utf8'), 'new\n');
  assert.equal(await fs.readFile(path.join(project, 'notes.txt'), 'utf8'), 'local work\n');
  const count = (await execFileAsync('git', ['-C', project, 'rev-list', '--count', 'HEAD'])).stdout.trim();
  assert.equal(count, '2');
  const status = (await execFileAsync('git', ['-C', project, 'status', '--porcelain'])).stdout;
  assert.match(status, /notes\.txt/);
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

test('workflow creates a stable project identity and rejects a mismatched artifact identity', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'workflow-fixture', version: '1.0.0' }));
  await fs.writeFile(path.join(project, 'README.md'), '# Fixture\n');
  await fs.writeFile(path.join(project, 'src/index.js'), 'old\n');
  const zipPath = path.join(root, 'foreign.zip');
  await writeZip(zipPath, [
    { name: 'package.json', data: JSON.stringify({ name: 'workflow-fixture', version: '1.0.0' }) },
    { name: 'README.md', data: '# Fixture\n' },
    { name: 'src/index.js', data: 'new\n' },
    { name: '.bridge/PROJECT_ID.json', data: JSON.stringify({ version: 1, projectId: 'bridge-project-foreign' }) },
  ]);
  const configPath = await writeConfig(path.join(root, 'workflow.json'), project, { projectContext: { enabled: false }, verification: { requireProjectIdentity: true } });
  const fixture = createBridgeAndStore({ foreign: zipPath });
  const manager = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir: path.join(root, 'data') });
  t.after(() => manager.close());
  const loaded = await manager.load(configPath);
  assert.match(loaded.projectId, /^bridge-project-/);
  const identity = JSON.parse(await fs.readFile(path.join(project, '.bridge/PROJECT_ID.json'), 'utf8'));
  assert.equal(identity.projectId, loaded.projectId);
  fixture.emitObserved(observedTurn('foreign'));
  const failed = await waitFor(async () => {
    const events = await manager.events('fixture-workflow', 100);
    return events.find((event) => event.type === 'workflow.artifact.verify.failed') || null;
  });
  assert.equal(failed.data.identityStatus, 'mismatch');
  assert.match(failed.data.reasons.join('\n'), /project identity mismatch/);
  assert.equal(await fs.readFile(path.join(project, 'src/index.js'), 'utf8'), 'old\n');
});

test('extension deployment restores the archived previous directory when the new service worker cannot reconnect', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const target = path.join(root, 'stable');
  await fs.mkdir(source);
  await fs.mkdir(target);
  await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ version: '2.0.0' }));
  await fs.writeFile(path.join(source, 'content.js'), 'new');
  await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify({ version: '1.0.0' }));
  await fs.writeFile(path.join(target, 'content.js'), 'old');
  const calls = [];
  const bridge = {
    async reloadExtension(options) {
      calls.push(options.expectedVersion);
      if (options.expectedVersion === '2.0.0') throw new Error('new worker did not reconnect');
      return { reconnected: { extensionVersion: options.expectedVersion } };
    },
  };
  const deployer = new ExtensionDeployer({ bridge, dataDir: path.join(root, 'data') });
  const workflow = { id: 'rollback-extension', extensionUpdate: { enabled: true, sourceDir: source, targetDir: target, reloadTabs: true, reconnectTimeoutMs: 500, backupRetention: 3, rollbackOnReloadFailure: true } };
  const backup = await deployer.prepareBackup(workflow, { pipelineId: 'pipeline-1' });
  assert.equal(backup.manifestVersion, '1.0.0');
  await assert.rejects(() => deployer.deploy(workflow, { sourceClientId: 'client-1', pipelineId: 'pipeline-1', backup }), /did not reconnect/);
  assert.equal(await fs.readFile(path.join(target, 'content.js'), 'utf8'), 'old');
  assert.deepEqual(calls, ['2.0.0', '1.0.0']);
  assert.ok((await fs.stat(backup.archivePath)).isFile());
});

test('successful self-update requests a supervisor restart only after workflow terminal state is persisted', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'workflow-fixture', version: '2.0.0' }));
  await fs.writeFile(path.join(project, 'README.md'), '# Fixture\n');
  await fs.writeFile(path.join(project, 'src/index.js'), 'old\n');
  const zipPath = await makeZip(path.join(root, 'update.zip'), 'new\n');
  const configPath = await writeConfig(path.join(root, 'workflow.json'), project, {
    projectContext: { enabled: false },
    daemonRestart: { enabled: true, mode: 'exit', delayMs: 250, exitCode: 75, required: true },
  });
  const fixture = createBridgeAndStore({ update: zipPath });
  const restartRequests = [];
  const dataDir = path.join(root, 'data');
  const manager = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir, restartHandler: async (request) => { restartRequests.push(request); } });
  t.after(() => manager.close());
  await manager.load(configPath);
  fixture.emitObserved(observedTurn('update'));
  await waitFor(async () => restartRequests[0]);
  assert.equal(restartRequests[0].mode, 'exit');
  assert.equal(restartRequests[0].exitCode, 75);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, 'workflows/state.json'), 'utf8'));
  assert.equal(state.workflows['fixture-workflow'].watcher.status, 'running');
  assert.equal(state.workflows['fixture-workflow'].pipeline.status, 'completed');
  const intent = JSON.parse(await fs.readFile(path.join(dataDir, 'workflows/restart-request.json'), 'utf8'));
  assert.equal(intent.workflowId, 'fixture-workflow');
  assert.equal(intent.expectedPackageVersion, '1.0.0');
});

test('project identity context is synchronized in verify, ask, and auto modes', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const mode of ['verify', 'ask', 'auto']) {
    const project = path.join(root, `project-${mode}`);
    await fs.mkdir(path.join(project, 'src'), { recursive: true });
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'workflow-fixture', version: '1.0.0' }));
    await fs.writeFile(path.join(project, 'README.md'), `# ${mode}\n`);
    await fs.writeFile(path.join(project, 'src/index.js'), 'old\n');
    const configPath = await writeConfig(path.join(root, `workflow-${mode}.json`), project, {
      id: `workflow-${mode}`,
      watch: { mode, clientId: 'client-1', sessionId: 'session-1' },
      projectContext: { enabled: true, syncOnStart: true, syncAfterBind: true },
    });
    const fixture = createBridgeAndStore({}, [], { contextAnswerSuffix: mode === 'ask' ? '.' : '' });
    const manager = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir: path.join(root, `data-${mode}`) });
    await manager.load(configPath);
    await waitFor(() => fixture.contextRequests.length === 1);
    const identity = JSON.parse(await fs.readFile(path.join(project, '.bridge/PROJECT_ID.json'), 'utf8'));
    assert.match(identity.projectId, /^bridge-project-/);
    assert.match(fixture.contextRequests[0].message, new RegExp(identity.projectId));
    assert.equal(fixture.importedFiles.length, 1);
    const archive = fixture.importedFiles[0];
    assert.match(archive.name, /^project-context-/);
    assert.ok((await fs.stat(archive.absolutePath)).isFile());
    const events = await manager.events(`workflow-${mode}`, 50);
    assert.ok(events.some((event) => event.type === 'workflow.context.sync.completed'));
    manager.close();
  }
});

test('a persisted daemon restart intent is acknowledged after manager restoration', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'workflow-fixture', version: '3.0.0' }));
  await fs.writeFile(path.join(project, 'README.md'), '# Fixture\n');
  await fs.writeFile(path.join(project, 'src/index.js'), 'old\n');
  const configPath = await writeConfig(path.join(root, 'workflow.json'), project, { projectContext: { enabled: false } });
  const dataDir = path.join(root, 'data');
  const fixture = createBridgeAndStore({});
  const first = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir });
  await first.load(configPath);
  first.close();
  const intentPath = path.join(dataDir, 'workflows', 'restart-request.json');
  await fs.mkdir(path.dirname(intentPath), { recursive: true });
  await fs.writeFile(intentPath, `${JSON.stringify({
    workflowId: 'fixture-workflow',
    pipelineId: 'pipeline-restart',
    projectRoot: project,
    expectedPackageVersion: '3.0.0',
    requestedAt: new Date().toISOString(),
  }, null, 2)}\n`);

  const second = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir });
  t.after(() => second.close());
  await second.restore();
  const events = await second.events('fixture-workflow', 100);
  const completed = events.find((event) => event.type === 'workflow.daemon.restart.completed');
  assert.ok(completed);
  assert.equal(completed.data.versionMatched, true);
  assert.equal(completed.data.actualPackageVersion, '3.0.0');
  await assert.rejects(() => fs.stat(intentPath), /ENOENT/);
});

test('failed approval apply keeps the approval pending for retry', async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'workflow-fixture', version: '1.0.0' }));
  await fs.writeFile(path.join(project, 'src/index.js'), 'old\n');
  await execFileAsync('git', ['init'], { cwd: project });
  await execFileAsync('git', ['add', '.'], { cwd: project });
  await execFileAsync('git', ['-c', 'user.name=Bridge Test', '-c', 'user.email=bridge@example.test', 'commit', '-m', 'Initial'], { cwd: project });
  const zipPath = await makeZip(path.join(root, 'approval-retry.zip'), 'new\n');
  const configPath = await writeConfig(path.join(root, 'workflow.json'), project, { watch: { mode: 'ask' }, commit: { mode: 'block', required: false } });
  const fixture = createBridgeAndStore({ approvalRetry: zipPath });
  const manager = new WorkflowManager({ bridge: fixture.bridge, fileStore: fixture.fileStore, dataDir: path.join(root, 'data') });
  t.after(() => manager.close());
  await manager.load(configPath);
  fixture.emitObserved(observedTurn('approvalRetry'));
  const approval = await waitFor(async () => (await manager.approvals())[0]);
  await fs.writeFile(path.join(project, 'src/index.js'), 'user edit\n');
  await assert.rejects(() => manager.approve(approval.id), /overlap existing local edits/);
  const pending = await manager.approvals();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, approval.id);
  assert.match(pending[0].lastError, /overlap existing local edits/);
  assert.equal(manager.get('fixture-workflow').pipeline.status, 'awaiting_approval');
});
