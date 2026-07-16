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
    this.browserCalls = [];
    this.sessionDeletionCalls = [];
    this.requests = [];
  }
  health() { return { ok: true, transport: 'extension', clients: [], selectedClientId: '', needsSelection: false, pendingRequests: 1, pendingCommands: 0, activeClient: null, activeRequests: [{ requestId: 'active-health-request', accepted: true, done: false }], artifacts: this.artifacts.length }; }
  listKnownArtifacts() { return this.artifacts; }
  debugEvents() { return []; }
  selectClient(id) { return { id }; }
  clearSelectedClient() {}
  cancelActive() { return 0; }
  async listSessions() { return [{ id: 'session_1', title: 'Test Session' }]; }
  async newSession() { return { id: 'session_new', title: 'New' }; }
  async selectSession(id) { return { id, title: id }; }
  async deleteSession(sessionId, expectedUrl, options = {}) {
    this.sessionDeletionCalls.push({ sessionId, expectedUrl, options });
    return { deleted: true, deletedSessionId: sessionId, beforeUrl: expectedUrl, afterUrl: 'https://chatgpt.com/' };
  }
  async openBrowserTab(options = {}) {
    this.browserCalls.push({ type: 'open', options });
    return {
      tabId: 42,
      launchToken: options.launchToken || 'generated-token',
      requestedUrl: options.url || 'https://chatgpt.com/',
      client: { id: 'opened-client', launchToken: options.launchToken || 'generated-token' },
    };
  }
  async closeBrowserTab(options = {}) {
    this.browserCalls.push({ type: 'close', options });
    return { closing: true, tabId: 42 };
  }
  async reloadBrowserTab(options = {}) {
    this.browserCalls.push({ type: 'reload-tab', options });
    return { reloading: true, tabId: 42 };
  }
  async reloadExtension(options = {}) {
    this.browserCalls.push({ type: 'reload-extension', options });
    return { accepted: { accepted: true }, reconnected: { extensionVersion: options.expectedVersion || '1.0.13' } };
  }
  async listModels() { return { models: [{ label: 'GPT Test' }], current: null }; }
  async listEfforts() { return { efforts: [{ label: 'high' }], current: null }; }
  async clearComposerAttachments() { return { removed: 0 }; }
  isLocalRequest() { return true; }
  validateBridgeToken(token) { return token === config.bridgeToken; }
  async sendRequest(request, callbacks = {}) {
    this.requests.push(request);
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

async function waitForApiTurn(fx, turnId, expectedStatus = 'completed', { timeoutMs = 1500, intervalMs = 25 } = {}) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt <= timeoutMs) {
    last = await fx.request(`/turns/${turnId}`);
    if (last.response.status === 200 && last.body?.turn?.status === expectedStatus) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`Timed out waiting for turn ${turnId} to become ${expectedStatus}; last status: ${last?.body?.turn?.status || last?.response?.status || 'unknown'}`);
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
  const app = createApp(bridge, fileStore, eventBus, turnManager, projectService);
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



test('Setup page exposes extension-only diagnostics and authentication', async () => {
  const fx = await startFixture();
  try {
    const setup = await fetch(`${fx.baseUrl}/setup`);
    assert.equal(setup.status, 200);
    const setupHtml = await setup.text();
    assert.match(setupHtml, /Connect ChatGPT Bridge/);
    assert.match(setupHtml, /Download extension/);
    assert.match(setupHtml, /Advanced & diagnostics/);
    assert.match(setupHtml, /Chrome|Chromium|extension/i);

    const status = await fetch(`${fx.baseUrl}/setup/status`);
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.equal(statusBody.bridgeTokenConfigured, true);
    assert.equal(statusBody.extensionCompatibility.recommendedExtensionVersion, '1.0.13');
    const packageJson = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'));
    assert.equal(statusBody.bridgeVersion, packageJson.version);

    const health = await fetch(`${fx.baseUrl}/health`, { headers: { authorization: `Bearer ${config.apiToken}` } });
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.deepEqual(healthBody.activeRequests, [{ requestId: 'active-health-request', accepted: true, done: false }]);

    const authOk = await fetch(`${fx.baseUrl}/extension/auth/check?token=${encodeURIComponent(config.bridgeToken)}&runtime=extension`);
    assert.equal(authOk.status, 200);
    assert.equal((await authOk.json()).bridgeTokenAccepted, true);

    const authBad = await fetch(`${fx.baseUrl}/extension/auth/check?token=wrong-token&runtime=extension`);
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
    assert.match(diagnosticsScript, /fetchJson\('\/diagnostics\/state'\)/);
    assert.match(diagnosticsScript, /downloadBundle\('compact'\)/);
    assert.match(diagnosticsScript, /\/diagnostics\/bundle\?mode=/);
    assert.doesNotMatch(diagnosticsScript, /fetch\('\/debug\/events/);
    assert.doesNotMatch(diagnosticsScript, /fetch\('\/events/);

    const diagnosticsState = await fetch(`${fx.baseUrl}/diagnostics/state`);
    assert.equal(diagnosticsState.status, 200);
    const diagnosticsStateBody = await diagnosticsState.json();
    assert.equal(diagnosticsStateBody.ok, true);
    assert.equal(diagnosticsStateBody.apiTokenConfigured, true);

    const diagnosticsEvents = await fetch(`${fx.baseUrl}/diagnostics/events?limit=5`);
    assert.equal(diagnosticsEvents.status, 200);
    assert.deepEqual((await diagnosticsEvents.json()).events, []);

    const diagnosticsDebugEvents = await fetch(`${fx.baseUrl}/diagnostics/debug-events?limit=5`);
    assert.equal(diagnosticsDebugEvents.status, 200);
    assert.equal((await diagnosticsDebugEvents.json()).ok, true);

    const diagnosticsBundle = await fetch(`${fx.baseUrl}/diagnostics/bundle?mode=compact`);
    assert.equal(diagnosticsBundle.status, 200);
    assert.match(diagnosticsBundle.headers.get('content-disposition') || '', /bridge-debug-compact-.*\.json/);
    const diagnosticsBundleBody = await diagnosticsBundle.json();
    assert.equal(diagnosticsBundleBody.diagnostics.ok, true);
    assert.ok(!diagnosticsBundleBody.diagnostics.health?.clients, 'compact bundle should not include full nested health clients');

    const protectedHealth = await fetch(`${fx.baseUrl}/health`);
    assert.equal(protectedHealth.status, 401);
    assert.match((await protectedHealth.json()).detail, /API_TOKEN/);

    const diagStream = await fetch(`${fx.baseUrl}/setup/debug/stream?limit=1`);
    assert.equal(diagStream.status, 200);
    diagStream.body?.cancel?.();
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

    const turn = await waitForApiTurn(fx, turnId, 'completed');
    assert.equal(turn.response.status, 200);
    assert.ok(turn.body.items.some((item) => item.type === 'user_message'));
    assert.ok(turn.body.items.some((item) => item.type === 'agent_message'));

    const removedJobs = await fx.request('/jobs');
    assert.equal(removedJobs.response.status, 404);

    const removedProjectJobs = await fx.request('/project-jobs');
    assert.equal(removedProjectJobs.response.status, 404);
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

    const streamResponse = await fetch(`${fx.baseUrl}/chat?stream=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${config.apiToken}` },
      body: JSON.stringify({ message: 'stream this' }),
    });
    assert.equal(streamResponse.status, 200);
    const streamText = await streamResponse.text();
    assert.match(streamText, /event: event/);
    assert.match(streamText, /\"type\":\"prompt.accepted\"/);
    assert.match(streamText, /\"type\":\"request.result\"/);
    assert.doesNotMatch(streamText, /event: (thinking|message|artifacts|done)/);

    const targetedChat = await fx.request('/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'target this tab', sourceClientId: 'e2e-client', autoOpenTab: true, output: { expected: 'file', required: true } }),
    });
    assert.equal(targetedChat.response.status, 200);
    assert.equal(fx.bridge.requests.at(-1).sourceClientId, 'e2e-client');
    assert.equal(fx.bridge.requests.at(-1).autoOpenTab, true);
    assert.deepEqual(fx.bridge.requests.at(-1).output, { expected: 'file', required: true });

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

test('real-browser E2E control endpoints preserve source identity and require URL-bound cleanup', async () => {
  const fx = await startFixture();
  try {
    const missingUrl = await fx.request('/sessions/delete', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-e2e' }),
    });
    assert.equal(missingUrl.response.status, 400);
    assert.match(missingUrl.body.detail || missingUrl.body.error || '', /expectedUrl/i);

    const opened = await fx.request('/browser/tabs/open', {
      method: 'POST',
      body: JSON.stringify({
        url: 'https://chatgpt.com/',
        active: true,
        launchToken: 'launch-e2e',
        bridgeServerUrl: '',
        sourceClientId: 'bootstrap-client',
        allowIncompatibleClient: true,
      }),
    });
    assert.equal(opened.response.status, 201);
    assert.equal(opened.body.client.id, 'opened-client');
    assert.equal(opened.body.selectedClient.id, 'opened-client');
    assert.deepEqual(fx.bridge.browserCalls[0], {
      type: 'open',
      options: {
        url: 'https://chatgpt.com/',
        active: true,
        launchToken: 'launch-e2e',
        bridgeServerUrl: '',
        sourceClientId: 'bootstrap-client',
        timeoutMs: 30_000,
        allowIncompatibleClient: true,
      },
    });

    const extensionReload = await fx.request('/browser/extension/reload', {
      method: 'POST',
      body: JSON.stringify({ sourceClientId: 'bootstrap-client', expectedVersion: '1.0.13', reloadTabs: true, timeoutMs: 25_000 }),
    });
    assert.equal(extensionReload.response.status, 200);
    assert.equal(extensionReload.body.reconnected.extensionVersion, '1.0.13');
    assert.deepEqual(fx.bridge.browserCalls[1], {
      type: 'reload-extension',
      options: { sourceClientId: 'bootstrap-client', expectedVersion: '1.0.13', reloadTabs: true, timeoutMs: 25_000 },
    });

    const tabReload = await fx.request('/browser/tabs/reload', {
      method: 'POST',
      body: JSON.stringify({ sourceClientId: 'opened-client', reason: 'test recovery', timeoutMs: 9_000 }),
    });
    assert.equal(tabReload.response.status, 200);
    assert.equal(tabReload.body.reloading, true);
    assert.deepEqual(fx.bridge.browserCalls[2], {
      type: 'reload-tab',
      options: { sourceClientId: 'opened-client', reason: 'test recovery', timeoutMs: 9_000 },
    });

    const deleted = await fx.request('/sessions/delete', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'session-e2e',
        expectedUrl: 'https://chatgpt.com/c/session-e2e',
        sourceClientId: 'opened-client',
      }),
    });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.body.deletedSessionId, 'session-e2e');
    assert.deepEqual(fx.bridge.sessionDeletionCalls[0], {
      sessionId: 'session-e2e',
      expectedUrl: 'https://chatgpt.com/c/session-e2e',
      options: { sourceClientId: 'opened-client', timeoutMs: 30_000 },
    });

    const closed = await fx.request('/browser/tabs/close', {
      method: 'POST',
      body: JSON.stringify({
        sourceClientId: 'opened-client',
        expectedLaunchToken: 'launch-e2e',
        expectedUrl: 'https://chatgpt.com/',
      }),
    });
    assert.equal(closed.response.status, 200);
    assert.equal(closed.body.closing, true);
    assert.deepEqual(fx.bridge.browserCalls[3], {
      type: 'close',
      options: {
        sourceClientId: 'opened-client',
        expectedLaunchToken: 'launch-e2e',
        expectedUrl: 'https://chatgpt.com/',
        timeoutMs: 10_000,
      },
    });
  } finally {
    await fx.close();
  }
});
