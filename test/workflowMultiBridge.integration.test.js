import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeZip } from '../src/zipWriter.js';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(check, timeoutMs = 15_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw last || new Error(`Timed out after ${timeoutMs}ms`);
}

function auth(token) { return token ? { Authorization: `Bearer ${token}` } : {}; }
async function json(baseUrl, pathname, token, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: { ...auth(token), ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) throw new Error(`${pathname} failed (${response.status}): ${await response.text()}`);
  return await response.json();
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3_000)),
  ]);
}

test('independent workflow worker consumes one primary bridge observed-turn stream and applies the ZIP', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-multi-bridge-'));
  const projectDir = path.join(root, 'project');
  const dataDir = path.join(root, 'worker-data');
  const artifactPath = path.join(root, 'project.zip');
  const identity = { version: 1, projectId: `project-${randomUUID()}`, projectName: 'multi-bridge', packageName: 'multi-bridge-fixture' };
  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
  await fs.mkdir(path.join(projectDir, '.bridge'), { recursive: true });
  await fs.writeFile(path.join(projectDir, 'src/index.js'), 'export const value = "BEFORE";\n');
  await fs.writeFile(path.join(projectDir, 'package.json'), `${JSON.stringify({ name: identity.packageName, version: '1.0.0', type: 'module' }, null, 2)}\n`);
  await fs.writeFile(path.join(projectDir, '.bridge/PROJECT_ID.json'), `${JSON.stringify(identity, null, 2)}\n`);
  await fs.writeFile(path.join(projectDir, 'README.md'), '# Multi bridge fixture\n');
  await writeZip(artifactPath, [
    { name: 'src/index.js', data: 'export const value = "AFTER_REMOTE_WORKER";\n' },
    { name: 'package.json', data: `${JSON.stringify({ name: identity.packageName, version: '1.0.0', type: 'module' }, null, 2)}\n` },
    { name: '.bridge/PROJECT_ID.json', data: `${JSON.stringify(identity, null, 2)}\n` },
    { name: 'README.md', data: '# Multi bridge fixture\n' },
  ]);
  const sessionId = 'session-multi-bridge';
  const clientId = 'client-multi-bridge';
  const workflowId = 'workflow-multi-bridge-test';
  const workflowPath = path.join(root, 'workflow.json');
  await fs.writeFile(workflowPath, `${JSON.stringify({
    version: 1,
    id: workflowId,
    enabled: true,
    projectRoot: projectDir,
    watch: { mode: 'auto', clientId, sessionId, includeLatest: false, bindOnFirstVerifiedArtifact: false, refreshIntervalMs: 0 },
    artifact: { expected: 'zip', requireSingleCandidate: true },
    projectContext: { enabled: false, mode: 'identity', syncOnStart: false, syncAfterBind: false, fallbackFiles: ['package.json', 'README.md'] },
    verification: { requiredFiles: ['package.json', 'src/index.js', '.bridge/PROJECT_ID.json'], packageName: identity.packageName, minProjectFileOverlap: 0.4, requireProjectIdentity: true, identityFallbackFiles: ['package.json', 'README.md'], commands: [] },
    apply: { sync: true, requireCleanGit: false, rollbackOnFailure: true, protectedPaths: ['.git/**'], allowedWarningCodes: ['NO_REFERENCE_MANIFEST_FOR_SYNC'], maxChangedFiles: 20, maxDeletedFiles: 5, commands: [] },
    remediation: { enabled: false, maxAttempts: 0, sameChat: true, outputTailLines: 50 },
    commit: { mode: 'none', required: false },
    extensionUpdate: { enabled: false },
    daemonRestart: { enabled: false, mode: 'none' },
  }, null, 2)}\n`);

  const primaryPort = await freePort();
  const workerPort = await freePort();
  const primaryToken = `primary-${randomUUID()}`;
  const workerToken = `worker-${randomUUID()}`;
  const primary = spawn(process.execPath, [
    'scripts/e2e/fixtures/workflow-primary-process.js', '--port', String(primaryPort), '--artifact', artifactPath,
    '--session', sessionId, '--client', clientId, '--token', primaryToken,
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  const worker = spawn(process.execPath, [
    'scripts/workflow-worker.js', '--port', String(workerPort), '--data-dir', dataDir, '--workflow', workflowPath,
    '--upstream-url', `http://127.0.0.1:${primaryPort}`, '--upstream-token', primaryToken, '--api-token', workerToken,
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let primaryLog = '';
  let workerLog = '';
  primary.stdout.on('data', (chunk) => { primaryLog += chunk; });
  primary.stderr.on('data', (chunk) => { primaryLog += chunk; });
  worker.stdout.on('data', (chunk) => { workerLog += chunk; });
  worker.stderr.on('data', (chunk) => { workerLog += chunk; });

  try {
    const primaryUrl = `http://127.0.0.1:${primaryPort}`;
    const workerUrl = `http://127.0.0.1:${workerPort}`;
    await waitFor(() => json(primaryUrl, '/health', primaryToken).then((value) => value.ok));
    await waitFor(() => json(workerUrl, '/health', workerToken).then((value) => value.ok), 20_000);
    const submitted = await json(primaryUrl, '/browser/passive-prompt', primaryToken, { method: 'POST', body: { message: 'create zip' } });
    assert.equal(submitted.result.submittedUserTurnKey, 'user-passive-1');
    const terminal = await waitFor(async () => {
      const result = await json(workerUrl, `/workflows/${workflowId}/events?limit=500`, workerToken);
      return result.events.find((event) => event.type === 'workflow.completed') ? result : null;
    }, 20_000);
    const types = terminal.events.map((event) => event.type);
    for (const expected of ['workflow.turn.observed', 'workflow.artifact.download.completed', 'workflow.artifact.verify.completed', 'workflow.apply.completed', 'workflow.completed']) assert(types.includes(expected), `Missing ${expected}`);
    assert.equal(await fs.readFile(path.join(projectDir, 'src/index.js'), 'utf8'), 'export const value = "AFTER_REMOTE_WORKER";\n');
    const health = await json(workerUrl, '/health', workerToken);
    assert.equal(health.bridge.transport, 'remote-observed-turn-sse');
    assert.equal(health.bridge.lastSequence, 1);
  } catch (error) {
    error.message += `\nPRIMARY LOG:\n${primaryLog}\nWORKER LOG:\n${workerLog}`;
    throw error;
  } finally {
    await Promise.all([stop(worker), stop(primary)]);
    await fs.rm(root, { recursive: true, force: true });
  }
});
