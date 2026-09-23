import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const bridgeRepo = path.resolve(process.cwd());
const gptcRepo = path.resolve(
  process.env.GPTC_FULL_POWER_REPO || path.join(bridgeRepo, '..', 'gptc-full-power-bridge'),
);
const fullPowerServer = path.join(gptcRepo, 'wake_router', 'full_power_bridge_server.py');
let gptcAvailable = true;
try {
  await fs.access(fullPowerServer);
} catch {
  gptcAvailable = false;
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (lastError) throw lastError;
  throw new Error(`timed out after ${timeoutMs}ms`);
}

async function requestJson(url, { method = 'GET', token, ownerToken, body } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (ownerToken) headers['x-full-power-owner-token'] = ownerToken;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  return { response, value };
}

function startProcess(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.once('error', () => {});
  return child;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    await new Promise((resolve) => {
      execFile(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', `taskkill /PID ${child.pid} /T /F`],
        { windowsHide: true },
        () => resolve(),
      );
    });
  } else {
    child.kill('SIGKILL');
  }
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
}

test('direct Manager-to-Bridge execution works across the real Node and Python processes', {
  skip: !gptcAvailable,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'full-power-cross-repo-'));
  const dbPath = path.join(root, 'bridge.sqlite3');
  const jobRoot = path.join(root, 'jobs');
  const dataDir = path.join(root, 'node-data');
  const envFile = path.join(root, '.env');
  const adapterPort = await freePort();
  const nodePort = await freePort();
  const bridgeToken = 'integration-bridge-token-1234567890';
  const ownerToken = 'integration-owner-token-1234567890';
  const capabilitySecret = 'integration-capability-secret-1234567890';
  const apiToken = 'integration-api-token-1234567890';
  const python = process.env.PYTHON_EXECUTABLE || 'python';
  const baseEnv = { ...process.env, PYTHONPATH: gptcRepo };
  const adapter = startProcess(python, [
    '-u', '-m', 'wake_router.full_power_bridge_server',
    '--db', dbPath,
    '--root', jobRoot,
    '--host', '127.0.0.1',
    '--port', String(adapterPort),
    '--bridge-token', bridgeToken,
    '--owner-token', ownerToken,
    '--capability-secret', capabilitySecret,
  ], { cwd: gptcRepo, env: baseEnv });

  const nodeEnv = {
    ...process.env,
    ENV_FILE: envFile,
    DATA_DIR: dataDir,
    ZIPFLOW_HOME: path.join(root, 'zipflow'),
    HOST: '127.0.0.1',
    PORT: String(nodePort),
    PUBLIC_BASE_URL: `http://127.0.0.1:${nodePort}`,
    API_TOKEN: apiToken,
    BRIDGE_TOKEN: 'integration-browser-token-1234567890',
    FULL_POWER_BRIDGE_URL: `http://127.0.0.1:${adapterPort}`,
    FULL_POWER_BRIDGE_TOKEN: bridgeToken,
    FULL_POWER_OWNER_TOKEN: ownerToken,
    FULL_POWER_REQUEST_TIMEOUT_MS: '5000',
    BRIDGE_DISABLE_NOTIFICATIONS: '1',
  };
  const startNode = () => startProcess(process.execPath, ['src/index.js', '--server'], {
    cwd: bridgeRepo,
    env: nodeEnv,
  });
  let node = startNode();
  const nodeUrl = `http://127.0.0.1:${nodePort}`;
  const auth = { token: apiToken };
  try {
    await waitFor(async () => {
      const { response, value } = await requestJson(`${nodeUrl}/v1/full-power/health`, auth);
      return response.ok && value.ok && value.controller_required === false ? value : null;
    });

    const payload = 'print("DIRECT_BRIDGE_CROSS_REPO_OK")\n';
    const payloadHash = (await import('node:crypto')).createHash('sha256').update(payload).digest('hex');
    const context = {
      job_id: `cross-repo-${Date.now()}`,
      project: 'BRIDGE-INTEGRATION',
      requestor_role: 'MANAGER',
      requestor_chat: 'manager-chat-cross-repo',
      manager_lease_id: 'lease-cross-repo-1',
      manager_epoch: 'epoch-cross-repo-1',
      project_control_revision: 'revision-cross-repo-1',
      target_machine: 'OWNER-PC-INTEGRATION',
      command_scope: 'READ_ONLY',
      payload_hash: payloadHash,
      payload_type: '.py',
      timeout_seconds: 30,
      ttl_seconds: 30,
    };
    const capabilityResult = await requestJson(`${nodeUrl}/v1/full-power/capabilities`, {
      ...auth,
      method: 'POST',
      body: context,
    });
    assert.equal(capabilityResult.response.status, 201);
    assert.equal(capabilityResult.value.protocol_version, 1);
    assert.equal(capabilityResult.value.bindings.job_id, context.job_id);

    const submitted = await requestJson(`${nodeUrl}/v1/full-power/jobs`, {
      ...auth,
      method: 'POST',
      body: { ...context, capability: capabilityResult.value.capability, payload },
    });
    assert.equal(submitted.response.status, 201);
    assert.equal(submitted.value.direct_bridge, true);
    assert.equal(submitted.value.state, 'AUTHORIZED');

    const terminal = await waitFor(async () => {
      const result = await requestJson(`${nodeUrl}/v1/full-power/jobs/${encodeURIComponent(context.job_id)}`, auth);
      if (!result.response.ok) return null;
      return ['SUCCEEDED', 'FAILED', 'FAILED_BEFORE_EXECUTION', 'UNCERTAIN_AFTER_EXECUTION', 'NEEDS_OWNER'].includes(result.value.state)
        ? result.value
        : null;
    });
    assert.equal(terminal.state, 'SUCCEEDED');
    assert.equal(terminal.exit_code, 0);
    assert.equal(terminal.payload_hash, payloadHash);
    assert.match(terminal.stdout_summary, /DIRECT_BRIDGE_CROSS_REPO_OK/);
    assert.equal(terminal.result_proof.execution_started, true);
    assert.equal(terminal.result_proof.cleanup_verified, true);

    await stopProcess(node);
    node = startNode();
    const recovered = await waitFor(async () => {
      const result = await requestJson(`${nodeUrl}/v1/full-power/jobs/${encodeURIComponent(context.job_id)}`, auth);
      return result.response.ok && result.value.state === 'SUCCEEDED' ? result.value : null;
    });
    assert.equal(recovered.job_id, context.job_id);
    assert.equal(recovered.exit_code, 0);
    assert.equal(recovered.payload_hash, payloadHash);
  } finally {
    await stopProcess(node);
    await stopProcess(adapter);
    await fs.rm(root, { recursive: true, force: true });
  }
});
