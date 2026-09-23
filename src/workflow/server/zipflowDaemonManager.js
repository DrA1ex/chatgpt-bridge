import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  createZipflowRuntimeSecurity,
  runtimeSecurityError,
} from './zipflowRuntimeSecurity.js';

const require = createRequire(import.meta.url);
const STARTABLE_CONNECTION_CODES = new Set([
  'CONNECTION_FAILED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
]);

function daemonError(code, message, details = {}, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code, details });
}

function parseDiscovery(text, { platform, expectedSocketPath = '' } = {}) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw daemonError('ZIPFLOW_RUNTIME_INVALID', 'Workflow service discovery metadata is malformed.', {}, cause);
  }
  const socketPath = String(value?.socketPath || '');
  const localEndpoint = platform === 'win32'
    ? /^\\\\[.?]\\pipe\\[^\\/\0\r\n]+$/i.test(socketPath)
    : path.isAbsolute(socketPath) && !/[\0\r\n]/.test(socketPath);
  if (!Number.isInteger(value?.pid) || value.pid <= 0
    || !localEndpoint
    || !String(value?.apiVersion || '')
    || !String(value?.zipflowVersion || '')
    || !String(value?.serverEpoch || '')
    || !Number.isFinite(Date.parse(value?.startedAt))) {
    throw daemonError('ZIPFLOW_RUNTIME_INVALID', 'Workflow service discovery metadata is incomplete or unsafe.');
  }
  if (expectedSocketPath && socketPath !== expectedSocketPath) {
    throw daemonError('ZIPFLOW_RUNTIME_INVALID', 'Workflow service discovery endpoint does not match the managed endpoint.', {
      expectedSocketPath,
      socketPath,
    });
  }
  return { ...value, socketPath };
}

function parseRuntimeLock(text, discovery) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw daemonError('ZIPFLOW_RUNTIME_INVALID', 'Workflow service lock metadata is malformed.', {}, cause);
  }
  if (value?.version !== 1
    || !Number.isInteger(value.pid)
    || value.pid <= 0
    || value.pid !== discovery.pid
    || !String(value.ownerToken || '')
    || !Number.isFinite(Date.parse(value.createdAt))) {
    throw daemonError('ZIPFLOW_RUNTIME_INVALID', 'Workflow service lock metadata is incomplete or inconsistent.');
  }
  return value;
}

function validateToken(value) {
  const token = String(value || '').trim();
  if (token.length < 20 || /[\0\r\n]/.test(token)) {
    throw daemonError('ZIPFLOW_RUNTIME_INVALID', 'Workflow service token is malformed.');
  }
  return token;
}

export function defaultZipflowHome(platform = process.platform) {
  if (process.env.ZIPFLOW_HOME) return path.resolve(process.env.ZIPFLOW_HOME);
  if (platform === 'win32') return path.join(process.env.USERPROFILE || os.homedir(), '.zipflow');
  return path.join(os.homedir(), '.zipflow');
}

export function daemonRuntimePaths(zipflowHome = defaultZipflowHome()) {
  const runtimeRoot = path.join(path.resolve(zipflowHome), 'runtime');
  return {
    zipflowHome: path.resolve(zipflowHome),
    runtimeRoot,
    discoveryPath: path.join(runtimeRoot, 'server-v1.json'),
    tokenPath: path.join(runtimeRoot, 'server-v1.token'),
    lockPath: path.join(runtimeRoot, 'server-v1.lock'),
  };
}

export async function readZipflowDiscovery({
  zipflowHome = defaultZipflowHome(),
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  expectedSocketPath = '',
  runtimeSecurity = createZipflowRuntimeSecurity({ platform, uid }),
} = {}) {
  const paths = daemonRuntimePaths(zipflowHome);
  await runtimeSecurity.assertPrivateDirectory(paths.runtimeRoot);
  const [discoveryText, tokenText, lockText] = await Promise.all([
    runtimeSecurity.readPrivateFile(paths.discoveryPath),
    runtimeSecurity.readPrivateFile(paths.tokenPath),
    runtimeSecurity.readPrivateFile(paths.lockPath),
  ]);
  const discovery = parseDiscovery(discoveryText, { platform, expectedSocketPath });
  const lock = parseRuntimeLock(lockText, discovery);
  const token = validateToken(tokenText);
  if (runtimeSecurity.kind === 'posix') {
    const socketDirectory = path.dirname(discovery.socketPath);
    await runtimeSecurity.assertPrivateDirectory(socketDirectory);
    await runtimeSecurity.assertPrivateSocket(discovery.socketPath, 0o600, { optional: true });
  }
  return { paths, discovery, token, lock };
}

export function resolveInstalledZipflowEntrypoint({ resolveClient = () => require.resolve('zipflow/client') } = {}) {
  const clientEntry = path.resolve(resolveClient());
  return path.resolve(path.dirname(clientEntry), '..', '..', 'bin', 'zipflow.js');
}

export class ZipflowDaemonManager {
  constructor({
    zipflowHome = defaultZipflowHome(),
    platform = process.platform,
    uid = typeof process.getuid === 'function' ? process.getuid() : null,
    runtimeSecurity = createZipflowRuntimeSecurity({ platform, uid }),
    expectedSocketPath = '',
    clientFactory,
    entrypointResolver = resolveInstalledZipflowEntrypoint,
    spawn = nodeSpawn,
    executable = process.execPath,
    idleTimeoutMs = 300_000,
    startupTimeoutMs = 10_000,
    retryMs = 100,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    if (typeof clientFactory !== 'function') throw new TypeError('ZipflowDaemonManager requires a client factory.');
    this.zipflowHome = path.resolve(zipflowHome);
    this.platform = platform;
    this.uid = uid;
    this.runtimeSecurity = runtimeSecurity;
    this.expectedSocketPath = expectedSocketPath;
    this.clientFactory = clientFactory;
    this.entrypointResolver = entrypointResolver;
    this.spawn = spawn;
    this.executable = executable;
    this.idleTimeoutMs = idleTimeoutMs;
    this.startupTimeoutMs = startupTimeoutMs;
    this.retryMs = retryMs;
    this.sleep = sleep;
    this.client = null;
    this.ensurePromise = null;
    this.status = { state: 'idle', error: '', hello: null, discovery: null, managed: false };
  }

  health() {
    return structuredClone(this.status);
  }

  async #connect(discovered) {
    const client = await this.clientFactory({
      socketPath: discovered.discovery.socketPath,
      token: discovered.token,
    });
    let hello;
    try {
      hello = await client.hello();
    } catch (error) {
      await client.close?.().catch(() => {});
      throw error;
    }
    const previous = this.client;
    this.client = client;
    if (previous && previous !== client) await previous.close?.().catch(() => {});
    this.status = {
      state: 'ready',
      error: '',
      hello,
      discovery: discovered.discovery,
      managed: this.status.managed,
    };
    return { client, hello, discovery: discovered.discovery };
  }

  async discoverAndConnect() {
    const discovered = await readZipflowDiscovery({
      zipflowHome: this.zipflowHome,
      platform: this.platform,
      uid: this.uid,
      expectedSocketPath: this.expectedSocketPath,
      runtimeSecurity: this.runtimeSecurity,
    });
    return await this.#connect(discovered);
  }

  async ensure() {
    if (!this.ensurePromise) {
      this.ensurePromise = this.#ensureOnce().finally(() => {
        this.ensurePromise = null;
      });
    }
    return await this.ensurePromise;
  }

  async #ensureOnce() {
    this.status = { ...this.status, state: 'connecting', error: '' };
    try {
      return await this.discoverAndConnect();
    } catch (error) {
      if (error.code !== 'ENOENT' && !STARTABLE_CONNECTION_CODES.has(error.code)) {
        this.status = { ...this.status, state: 'degraded', error: error.message };
        throw error;
      }
      const runtime = await this.runtimeSecurity.inspectRuntime(
        daemonRuntimePaths(this.zipflowHome),
      );
      if (runtime.state === 'partial') {
        const unsafe = runtimeSecurityError(
          'ZIPFLOW_RUNTIME_INVALID',
          'Workflow service runtime state is incomplete; automatic startup was refused.',
          { present: runtime.present },
        );
        this.status = { ...this.status, state: 'degraded', error: unsafe.message };
        throw unsafe;
      }
      if (runtime.state === 'complete' && !STARTABLE_CONNECTION_CODES.has(error.code)) {
        this.status = { ...this.status, state: 'degraded', error: error.message };
        throw error;
      }
    }

    this.status = { ...this.status, state: 'starting', managed: true };
    const entrypoint = await this.entrypointResolver();
    const args = [
      entrypoint,
      'serve',
      '--idle-timeout-ms',
      String(this.idleTimeoutMs),
      ...(this.expectedSocketPath ? ['--socket', this.expectedSocketPath] : []),
    ];
    const child = this.spawn(this.executable, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ZIPFLOW_HOME: this.zipflowHome },
    });
    child.unref?.();

    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      await this.sleep(this.retryMs);
      try {
        return await this.discoverAndConnect();
      } catch (error) {
        lastError = error;
        if (!['ENOENT', 'ECONNREFUSED', 'CONNECTION_FAILED'].includes(error.code)) break;
      }
    }
    const error = daemonError(
      'ZIPFLOW_DAEMON_UNAVAILABLE',
      'The local Workflow service did not become ready.',
      {},
      lastError,
    );
    this.status = { ...this.status, state: 'degraded', error: error.message };
    throw error;
  }

  async close() {
    await this.client?.close?.();
    this.client = null;
    this.status = { ...this.status, state: 'stopped' };
  }
}
