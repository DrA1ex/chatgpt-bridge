import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl, token, timeoutMs = 30_000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      });
      if (response.ok) {
        const health = await response.json();
        if (health.ok) return health;
      }
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Workflow worker did not become ready at ${baseUrl}: ${lastError?.message || 'timeout'}`);
}

export async function startWorkflowWorker(options, {
  workflowPath,
  dataDir,
  diagnosticDir,
  scope = 'workflow-multi-bridge',
  testLog = () => {},
} = {}) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const apiToken = `worker-${randomUUID()}`;
  await fs.mkdir(diagnosticDir, { recursive: true });
  const stdoutPath = path.join(diagnosticDir, 'workflow-worker.stdout.log');
  const stderrPath = path.join(diagnosticDir, 'workflow-worker.stderr.log');
  const child = spawn(process.execPath, [
    'scripts/workflow-worker.js',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--data-dir', dataDir,
    '--workflow', workflowPath,
    '--upstream-url', options.baseUrl,
    '--upstream-token', options.apiToken || '',
    '--api-token', apiToken,
  ], { cwd: REPO_ROOT, env: { ...process.env, BRIDGE_DISABLE_NOTIFICATIONS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => fs.appendFile(stdoutPath, chunk).catch(() => null));
  child.stderr.on('data', (chunk) => fs.appendFile(stderrPath, chunk).catch(() => null));
  const exitPromise = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const health = await waitForHealth(baseUrl, apiToken, 30_000).catch(async (error) => {
    child.kill('SIGTERM');
    const exit = await Promise.race([exitPromise, new Promise((resolve) => setTimeout(() => resolve(null), 2_000))]);
    throw new Error(`${error.message}; workerExit=${JSON.stringify(exit)}`);
  });
  testLog('ok', scope, 'Independent workflow worker connected to the primary bridge observed-turn stream', {
    baseUrl,
    upstream: options.baseUrl,
    workflowCount: health.workflows?.length || 0,
  });
  return {
    baseUrl,
    apiToken,
    health,
    options: { ...options, baseUrl, apiToken },
    async stop() {
      child.kill('SIGTERM');
      let timer = null;
      try {
        return await Promise.race([
          exitPromise,
          new Promise((resolve) => {
            timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, signal: 'SIGKILL' }); }, 5_000);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
