import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.js';
import { FileStore } from '../src/fileStore.js';
import { MetadataStore } from '../src/metadataStore.js';
import { ResultResolver } from '../src/resultResolver.js';
import { TurnManager } from '../src/turnManager.js';
import { ProjectService } from '../src/projectService.js';
import { JobManager } from '../src/jobManager.js';
import { EventBus } from '../src/eventBus.js';
import { writeZip } from '../src/zipWriter.js';
import { config } from '../src/config.js';


function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

class FakeBridge extends EventEmitter {
  constructor(fileStore) {
    super();
    this.fileStore = fileStore;
    this.artifacts = [];
    this.pollingClients = new Map();
    this.pollingPayloads = [];
  }
  health() { return { ok: true, transport: 'fake', clients: Array.from(this.pollingClients.values()), selectedClientId: '', needsSelection: false, pendingRequests: 0, pendingCommands: 0, activeClient: Array.from(this.pollingClients.values())[0] || null, artifacts: this.artifacts.length }; }
  listKnownArtifacts() { return this.artifacts; }
  debugEvents() { return []; }
  selectClient(id) { return { id }; }
  clearSelectedClient() {}
  cancelActive() { return 0; }
  async listSessions() { return [{ id: 'session_1', title: 'Test Session' }]; }
  async newSession() { return { id: 'session_new', title: 'New' }; }
  async selectSession(id) { return { id, title: id }; }
  async listModels() { return { models: [{ label: 'GPT Test' }], current: null }; }
  async listEfforts() { return { efforts: [{ label: 'high' }], current: null }; }
  async clearComposerAttachments() { return { removed: 0 }; }
  isLocalRequest() { return true; }
  validateBridgeToken(token) { return token === config.bridgeToken; }
  registerPollingClient(hello) { const client = { id: hello.clientId || 'poll-client', transport: 'polling', ready: true, url: hello.url || '', title: hello.title || '' }; this.pollingClients.set(client.id, client); return client; }
  async pollClient(clientId) { return { commands: [{ type: 'noop', clientId }], serverTime: Date.now() }; }
  receivePollingPayload(clientId, payload) { this.pollingPayloads.push({ clientId, payload }); }
  async sendRequest(request, callbacks = {}) {
    callbacks.onEvent?.({ type: 'prompt.accepted', requestId: request.requestId });
    callbacks.onThinkingUpdate?.('thinking');
    callbacks.onAnswerUpdate?.('answer');
    callbacks.onArtifactUpdate?.(this.artifacts);
    return { id: request.requestId || 'response_1', answer: 'answer', thinking: 'thinking', artifacts: this.artifacts, session: { id: 'session_1' } };
  }
  async fetchArtifact(id) {
    const artifact = this.artifacts.find((item) => item.id === id);
    if (!artifact) throw new Error(`artifact not found: ${id}`);
    return await this.fileStore.putArtifact({ artifactId: id, name: artifact.name, mime: artifact.mime, contentBase64: artifact.contentBase64 });
  }
  async close() {}
}

async function startFixture() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-api-data-'));
  const fileStore = new FileStore(dataRoot);
  const metadataStore = new MetadataStore(dataRoot);
  await metadataStore.ready;
  const eventBus = new EventBus();
  const bridge = new FakeBridge(fileStore);
  const projectService = new ProjectService({ fileStore, metadataStore, eventBus, rootDir: dataRoot });
  const resultResolver = new ResultResolver({ bridge, fileStore, metadataStore, eventBus });
  const turnManager = new TurnManager({ bridge, metadataStore, resultResolver, eventBus, projectService });
  const jobManager = new JobManager({ bridge, fileStore, metadataStore, resultResolver, eventBus });
  const app = createApp(bridge, fileStore, eventBus, jobManager, turnManager, projectService);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    dataRoot,
    fileStore,
    metadataStore,
    eventBus,
    bridge,
    projectService,
    turnManager,
    jobManager,
    baseUrl,
    async request(pathname, options = {}) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        ...options,
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${config.apiToken}`, ...(options.headers || {}) },
      });
      const type = response.headers.get('content-type') || '';
      const body = type.includes('application/json') ? await response.json() : await response.text();
      return { response, body };
    },
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}



test('Setup page exposes extension diagnostics and legacy userscript polling endpoints are disabled', async () => {
  const fx = await startFixture();
  try {
    const setup = await fetch(`${fx.baseUrl}/setup`);
    assert.equal(setup.status, 200);
    const setupHtml = await setup.text();
    assert.match(setupHtml, /ChatGPT Bridge setup/);
    assert.match(setupHtml, /Extension WebSocket/);
    assert.doesNotMatch(setupHtml, /Tampermonkey/i);

    const status = await fetch(`${fx.baseUrl}/setup/status`);
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.bridgeTokenConfigured, true);
    assert.equal(statusBody.userscriptTransport, undefined);

    const authOk = await fetch(`${fx.baseUrl}/tm/auth/check?token=${encodeURIComponent(config.bridgeToken)}&runtime=extension`);
    assert.equal(authOk.status, 200);
    assert.equal((await authOk.json()).bridgeTokenAccepted, true);

    const authBad = await fetch(`${fx.baseUrl}/tm/auth/check?token=wrong-token&runtime=extension`);
    assert.equal(authBad.status, 403);
    assert.match((await authBad.json()).detail, /Invalid BRIDGE_TOKEN/);

    const diagnostics = await fetch(`${fx.baseUrl}/diagnostics`);
    assert.equal(diagnostics.status, 200);
    const diagnosticsHtml = await diagnostics.text();
    assert.match(diagnosticsHtml, /ChatGPT Bridge diagnostics/);
    assert.match(diagnosticsHtml, /extension/i);
    const diagnosticsScript = diagnosticsHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(diagnosticsScript);
    new vm.Script(diagnosticsScript);
    assert.doesNotMatch(diagnosticsScript, /log\.textContent \? '\n/);

    const userscript = await fetch(`${fx.baseUrl}/userscripts/chatgpt-bridge.user.js`);
    assert.equal(userscript.status, 410);
    assert.match(await userscript.text(), /userscript runtime is no longer supported/i);

    const token = encodeURIComponent(config.bridgeToken);
    const hello = await fetch(`${fx.baseUrl}/tm/hello?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'poll-client-api', url: 'https://chatgpt.com/' }),
    });
    assert.equal(hello.status, 410);
    assert.match((await hello.json()).error, /Userscript polling is no longer supported/);

    const poll = await fetch(`${fx.baseUrl}/tm/poll?token=${token}&clientId=poll-client-api`);
    assert.equal(poll.status, 410);
    assert.match((await poll.json()).error, /Userscript polling is no longer supported/);

    const events = await fetch(`${fx.baseUrl}/tm/events?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'poll-client-api', payloads: [
        { type: 'page.status', url: 'https://chatgpt.com/c/1' },
        { type: 'diagnostic', name: 'ui.test.ok' },
      ] }),
    });
    assert.equal(events.status, 410);
    assert.match((await events.json()).error, /Userscript polling is no longer supported/);

    const diagStream = await fetch(`${fx.baseUrl}/setup/debug/stream?limit=1`);
    assert.equal(diagStream.status, 200);
    diagStream.body?.cancel?.();
    assert.equal(fx.bridge.pollingPayloads.length, 0);
  } finally {
    await fx.close();
  }
});

test('HTTP API exposes capabilities, files, threads, and completed turns', async () => {
  const fx = await startFixture();
  try {
    const capabilities = await fx.request('/capabilities');
    assert.equal(capabilities.response.status, 200);
    assert.equal(capabilities.body.capabilities.threads, true);
    assert.equal(capabilities.body.capabilities.projectPackaging, true);

    const upload = await fx.request('/files', { method: 'POST', body: JSON.stringify({ name: 'note.txt', content: 'hello' }) });
    assert.equal(upload.response.status, 201);
    assert.match(upload.body.file.id, /^file_/);

    const created = await fx.request('/threads', { method: 'POST', body: JSON.stringify({ title: 'API Thread', cwd: fx.dataRoot }) });
    assert.equal(created.response.status, 201);
    const threadId = created.body.thread.id;

    const turnStarted = await fx.request('/turns', { method: 'POST', body: JSON.stringify({ threadId, input: 'hello' }) });
    assert.equal(turnStarted.response.status, 202);
    const turnId = turnStarted.body.turn.id;

    await new Promise((resolve) => setTimeout(resolve, 120));
    const turn = await fx.request(`/turns/${turnId}`);
    assert.equal(turn.response.status, 200);
    assert.equal(turn.body.turn.status, 'completed');
    assert.ok(turn.body.items.some((item) => item.type === 'user_message'));
    assert.ok(turn.body.items.some((item) => item.type === 'agent_message'));
  } finally {
    await fx.close();
  }
});

test('Project API scans, packs, and applies a result zip through HTTP', async () => {
  const fx = await startFixture();
  try {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-api-project-'));
    await fs.writeFile(path.join(projectRoot, 'package.json'), '{"type":"module"}');
    await fs.mkdir(path.join(projectRoot, 'src'));
    await fs.writeFile(path.join(projectRoot, 'src', 'index.js'), 'export const value = 1;\n');
    await fs.writeFile(path.join(projectRoot, '.gitignore'), 'node_modules\n.env\n');

    const scan = await fx.request('/projects/scan', { method: 'POST', body: JSON.stringify({ cwd: projectRoot }) });
    assert.equal(scan.response.status, 200);
    assert.ok(scan.body.scan.files.some((file) => file.path === 'src/index.js'));

    const pack = await fx.request('/projects/pack', { method: 'POST', body: JSON.stringify({ cwd: projectRoot, threadId: 'thread_api' }) });
    assert.equal(pack.response.status, 200);
    assert.match(pack.body.pack.file.id, /^file_/);

    const resultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-api-result-'));
    const resultZip = path.join(resultDir, 'result.zip');
    await writeZip(resultZip, [{ name: 'project/src/index.js', data: Buffer.from('export const value = 2;\n') }]);
    const uploadedResult = await fx.fileStore.importLocalPath({ filePath: resultZip, name: 'result.zip', mime: 'application/zip' });

    const dryRun = await fx.request('/projects/apply-zip', { method: 'POST', body: JSON.stringify({ cwd: projectRoot, fileId: uploadedResult.id, dryRun: true }) });
    assert.equal(dryRun.response.status, 200);
    assert.equal(dryRun.body.plan.filesToWrite, 1);

    const rejected = await fx.request('/projects/apply-zip', { method: 'POST', body: JSON.stringify({ cwd: projectRoot, fileId: uploadedResult.id }) });
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.body.requiresConfirmation, true);

    const applied = await fx.request('/projects/apply-zip', { method: 'POST', body: JSON.stringify({ cwd: projectRoot, fileId: uploadedResult.id, force: true }) });
    assert.equal(applied.response.status, 200);
    assert.equal(applied.body.applied, true);
    assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'index.js'), 'utf8'), 'export const value = 2;\n');
  } finally {
    await fx.close();
  }
});



test('Project apply API requires confirmation when local files changed after snapshot', async () => {
  const fx = await startFixture();
  try {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-api-local-change-project-'));
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'app.js'), 'snapshot');

    const resultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-api-local-change-result-'));
    const resultZip = path.join(resultDir, 'result.zip');
    await writeZip(resultZip, [{ name: 'project/src/app.js', data: Buffer.from('remote') }]);
    const uploadedResult = await fx.fileStore.importLocalPath({ filePath: resultZip, name: 'result.zip', mime: 'application/zip' });

    const referenceManifest = { files: [{ path: 'src/app.js', sha256: sha256Text('snapshot') }] };
    await fs.writeFile(path.join(projectRoot, 'src', 'app.js'), 'local edit');

    const rejected = await fx.request('/projects/apply-zip', {
      method: 'POST',
      body: JSON.stringify({ cwd: projectRoot, fileId: uploadedResult.id, sync: true, referenceManifest }),
    });
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.body.requiresConfirmation, true);
    assert.equal(rejected.body.hasLocalChangesAfterSnapshot, true);

    const applied = await fx.request('/projects/apply-zip', {
      method: 'POST',
      body: JSON.stringify({ cwd: projectRoot, fileId: uploadedResult.id, sync: true, referenceManifest, force: true }),
    });
    assert.equal(applied.response.status, 200);
    assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'app.js'), 'utf8'), 'remote');
  } finally {
    await fx.close();
  }
});

test('Project apply API supports sync deletion and selected conflict paths', async () => {
  const fx = await startFixture();
  try {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-api-sync-project-'));
    await fs.mkdir(path.join(projectRoot, 'src'));
    await fs.writeFile(path.join(projectRoot, 'src', 'skip.js'), 'local');
    await fs.writeFile(path.join(projectRoot, 'src', 'apply.js'), 'old');
    await fs.writeFile(path.join(projectRoot, 'src', 'delete.js'), 'delete');
    await fs.writeFile(path.join(projectRoot, '.env'), 'secret');

    const resultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-api-sync-result-'));
    const resultZip = path.join(resultDir, 'result.zip');
    await writeZip(resultZip, [
      { name: 'project/src/skip.js', data: Buffer.from('remote') },
      { name: 'project/src/apply.js', data: Buffer.from('applied') },
      { name: 'project/src/new.js', data: Buffer.from('new') },
    ]);
    const uploadedResult = await fx.fileStore.importLocalPath({ filePath: resultZip, name: 'result.zip', mime: 'application/zip' });
    const referenceManifest = { files: [{ path: 'src/skip.js' }, { path: 'src/apply.js' }, { path: 'src/delete.js' }] };

    const dryRun = await fx.request('/projects/apply-zip', {
      method: 'POST',
      body: JSON.stringify({ cwd: projectRoot, fileId: uploadedResult.id, dryRun: true, sync: true, referenceManifest }),
    });
    assert.equal(dryRun.response.status, 200);
    assert.equal(dryRun.body.plan.filesToDelete, 1);
    assert.equal(dryRun.body.plan.filesToOverwrite, 2);

    const applied = await fx.request('/projects/apply-zip', {
      method: 'POST',
      body: JSON.stringify({ cwd: projectRoot, fileId: uploadedResult.id, force: true, sync: true, referenceManifest, selectedConflictPaths: ['src/apply.js'] }),
    });
    assert.equal(applied.response.status, 200);
    assert.equal(applied.body.result.deleted.length, 1);
    assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'skip.js'), 'utf8'), 'local');
    assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'apply.js'), 'utf8'), 'applied');
    assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'new.js'), 'utf8'), 'new');
    await assert.rejects(fs.stat(path.join(projectRoot, 'src', 'delete.js')), /ENOENT/);
    assert.equal(await fs.readFile(path.join(projectRoot, '.env'), 'utf8'), 'secret');
  } finally {
    await fx.close();
  }
});

test('Chat, sessions, models, efforts, artifacts and OpenAI-compatible routes work as public API blackbox', async () => {
  const fx = await startFixture();
  try {
    const sessions = await fx.request('/sessions');
    assert.equal(sessions.response.status, 200);
    assert.equal(sessions.body.sessions.length, 1);

    const newSession = await fx.request('/sessions/new', { method: 'POST', body: JSON.stringify({}) });
    assert.equal(newSession.response.status, 200);
    assert.equal(newSession.body.session.id, 'session_new');

    const selected = await fx.request('/sessions/select', { method: 'POST', body: JSON.stringify({ sessionId: 'session_1' }) });
    assert.equal(selected.response.status, 200);

    const models = await fx.request('/models');
    assert.equal(models.response.status, 200);
    assert.equal(models.body.models[0].label, 'GPT Test');

    const efforts = await fx.request('/efforts');
    assert.equal(efforts.response.status, 200);
    assert.equal(efforts.body.efforts[0].label, 'high');

    const chat = await fx.request('/chat', { method: 'POST', body: JSON.stringify({ message: 'hello' }) });
    assert.equal(chat.response.status, 200);
    assert.equal(chat.body.response, 'answer');
    assert.equal(chat.body.thinking, 'thinking');

    const completion = await fx.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(completion.response.status, 200);
    assert.equal(completion.body.choices[0].message.content, 'answer');

    fx.bridge.artifacts = [{ id: 'artifact_zip', name: 'out.zip', mime: 'application/zip', contentBase64: Buffer.from('zipdata').toString('base64') }];
    const artifacts = await fx.request('/artifacts');
    assert.equal(artifacts.response.status, 200);
    assert.equal(artifacts.body.artifacts[0].id, 'artifact_zip');

    const download = await fetch(`${fx.baseUrl}/artifacts/artifact_zip/download`, { headers: { Authorization: `Bearer ${config.apiToken}` } });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'zipdata');
  } finally {
    await fx.close();
  }
});

test('Job API queues a zip job, resolves artifact result, supports idempotency and result download', async () => {
  const fx = await startFixture();
  try {
    const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-job-artifact-'));
    const artifactZip = path.join(artifactDir, 'artifact.zip');
    await writeZip(artifactZip, [{ name: 'project/app.js', data: Buffer.from('console.log(1);\n') }]);
    const artifactContent = await fs.readFile(artifactZip);
    fx.bridge.artifacts = [{ id: 'artifact_job_zip', name: 'updated-project.zip', mime: 'application/zip', kind: 'file', contentBase64: artifactContent.toString('base64') }];

    const create = await fx.request('/jobs', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'job-key-1' },
      body: JSON.stringify({ message: 'make changes', output: { expected: 'zip', required: true } }),
    });
    assert.equal(create.response.status, 202);
    const jobId = create.body.job.id;

    const reused = await fx.request('/jobs', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'job-key-1' },
      body: JSON.stringify({ message: 'make changes again', output: { expected: 'zip', required: true } }),
    });
    assert.equal(reused.response.status, 200);
    assert.equal(reused.body.reused, true);
    assert.equal(reused.body.job.id, jobId);

    await new Promise((resolve) => setTimeout(resolve, 180));
    const job = await fx.request(`/jobs/${jobId}`);
    assert.equal(job.response.status, 200);
    assert.equal(job.body.job.status, 'done');
    assert.equal(job.body.job.result.type, 'zip');

    const events = await fx.request(`/jobs/${jobId}/events`);
    assert.equal(events.response.status, 200);
    assert.equal(events.body.events.some((event) => event.type === 'result.ready'), true);

    const result = await fx.request(`/jobs/${jobId}/result`);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.result.type, 'zip');

    const download = await fetch(`${fx.baseUrl}/jobs/${jobId}/result/download`, { headers: { Authorization: `Bearer ${config.apiToken}` } });
    assert.equal(download.status, 200);
    const downloaded = Buffer.from(await download.arrayBuffer());
    assert.deepEqual(downloaded, artifactContent);

    const jobs = await fx.request('/jobs');
    assert.equal(jobs.response.status, 200);
    assert.equal(jobs.body.jobs.some((item) => item.id === jobId), true);
  } finally {
    await fx.close();
  }
});

test('Job API reports a clear failure when required zip artifact is missing', async () => {
  const fx = await startFixture();
  try {
    fx.bridge.artifacts = [];
    const create = await fx.request('/jobs', {
      method: 'POST',
      body: JSON.stringify({ message: 'make changes', output: { expected: 'zip', required: true } }),
    });
    assert.equal(create.response.status, 202);
    const jobId = create.body.job.id;
    await new Promise((resolve) => setTimeout(resolve, 180));
    const job = await fx.request(`/jobs/${jobId}`);
    assert.equal(job.response.status, 200);
    assert.equal(job.body.job.status, 'failed');
    assert.equal(job.body.job.error.code, 'EXPECTED_ZIP_ARTIFACT_NOT_FOUND');
  } finally {
    await fx.close();
  }
});
