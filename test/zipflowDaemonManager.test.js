import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  daemonRuntimePaths,
  readZipflowDiscovery,
  ZipflowDaemonManager,
} from '../src/workflow/server/zipflowDaemonManager.js';

const uid = typeof process.getuid === 'function' ? process.getuid() : null;

async function runtimeFixture(root, { socketPath = '', token = 't'.repeat(43) } = {}) {
  const paths = daemonRuntimePaths(root);
  const socketDirectory = path.join(root, 'socket');
  await mkdir(paths.runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(paths.runtimeRoot, 0o700);
  await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
  await chmod(socketDirectory, 0o700);
  const endpoint = socketPath || path.join(socketDirectory, 'api-v1.sock');
  const discovery = {
    pid: process.pid,
    socketPath: endpoint,
    apiVersion: '1.0',
    zipflowVersion: '1.9.0',
    serverEpoch: 'epoch-1',
    startedAt: new Date().toISOString(),
  };
  const lock = {
    version: 1,
    pid: discovery.pid,
    ownerToken: 'fixture-owner-token',
    createdAt: discovery.startedAt,
  };
  await writeFile(paths.discoveryPath, `${JSON.stringify(discovery)}\n`, { mode: 0o600 });
  await writeFile(paths.tokenPath, `${token}\n`, { mode: 0o600 });
  await writeFile(paths.lockPath, `${JSON.stringify(lock)}\n`, { mode: 0o600 });
  await chmod(paths.discoveryPath, 0o600);
  await chmod(paths.tokenPath, 0o600);
  await chmod(paths.lockPath, 0o600);
  return { paths, discovery, token, lock };
}

test('daemon discovery validates private runtime metadata and authenticates hello', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-zipflow-daemon-'));
  try {
    const fixture = await runtimeFixture(root);
    const calls = [];
    const manager = new ZipflowDaemonManager({
      zipflowHome: root,
      uid,
      clientFactory: async (options) => {
        calls.push(options);
        return {
          async hello() {
            return { apiVersion: '1.0', schemaRevision: 1, serverEpoch: 'epoch-1', capabilities: [] };
          },
          async close() {},
        };
      },
    });
    const connected = await manager.ensure();
    assert.equal(connected.discovery.socketPath, fixture.discovery.socketPath);
    assert.deepEqual(calls, [{ socketPath: fixture.discovery.socketPath, token: fixture.token }]);
    assert.equal(manager.health().state, 'ready');
    await manager.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('daemon discovery rejects symlinked token files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-zipflow-symlink-'));
  try {
    const fixture = await runtimeFixture(root);
    const external = path.join(root, 'external-token');
    await writeFile(external, 'x'.repeat(43), { mode: 0o600 });
    await rm(fixture.paths.tokenPath);
    await symlink(external, fixture.paths.tokenPath);
    await assert.rejects(
      readZipflowDiscovery({ zipflowHome: root, uid }),
      (error) => error.code === 'ZIPFLOW_RUNTIME_INVALID',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('daemon manager starts the installed server only when runtime discovery is absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-zipflow-start-'));
  try {
    const child = new EventEmitter();
    child.unref = () => {};
    const spawnCalls = [];
    let created = false;
    const manager = new ZipflowDaemonManager({
      zipflowHome: root,
      uid,
      entrypointResolver: async () => '/package/bin/zipflow.js',
      spawn(executable, args, options) {
        spawnCalls.push({ executable, args, options });
        return child;
      },
      sleep: async () => {
        if (!created) {
          created = true;
          await runtimeFixture(root);
        }
      },
      clientFactory: async () => ({
        async hello() {
          return { apiVersion: '1.0', schemaRevision: 1, serverEpoch: 'epoch-1', capabilities: [] };
        },
      }),
    });
    const connected = await manager.ensure();
    assert.equal(connected.discovery.serverEpoch, 'epoch-1');
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(spawnCalls[0].args.slice(0, 4), [
      '/package/bin/zipflow.js',
      'serve',
      '--idle-timeout-ms',
      '300000',
    ]);
    assert.equal(spawnCalls[0].options.detached, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('daemon manager delegates complete but unreachable runtime recovery to zipflow serve', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-zipflow-reconnect-'));
  try {
    await runtimeFixture(root);
    let clients = 0;
    let spawned = 0;
    const child = new EventEmitter();
    child.unref = () => {};
    const manager = new ZipflowDaemonManager({
      zipflowHome: root,
      uid,
      entrypointResolver: async () => '/package/bin/zipflow.js',
      spawn() {
        spawned += 1;
        return child;
      },
      sleep: async () => {},
      clientFactory: async () => {
        clients += 1;
        return {
          async hello() {
            if (clients === 1) {
              throw Object.assign(new Error('endpoint unavailable'), {
                code: 'CONNECTION_FAILED',
                retryable: true,
              });
            }
            return {
              apiVersion: '1.0',
              schemaRevision: 1,
              serverEpoch: 'epoch-2',
              capabilities: [],
            };
          },
          async close() {},
        };
      },
    });
    const connected = await manager.ensure();
    assert.equal(connected.hello.serverEpoch, 'epoch-2');
    assert.equal(spawned, 1);
    assert.equal(clients, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('daemon manager never starts over malformed or unsafe existing runtime state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-zipflow-unsafe-'));
  try {
    const fixture = await runtimeFixture(root);
    await chmod(fixture.paths.discoveryPath, 0o644);
    let spawned = false;
    const manager = new ZipflowDaemonManager({
      zipflowHome: root,
      uid,
      clientFactory: async () => ({}),
      spawn() {
        spawned = true;
        return new EventEmitter();
      },
    });
    await assert.rejects(
      manager.ensure(),
      (error) => error.code === 'ZIPFLOW_RUNTIME_INVALID',
    );
    assert.equal(spawned, false);
    assert.equal(manager.health().state, 'degraded');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('daemon manager refuses automatic startup over partial runtime state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-zipflow-partial-'));
  try {
    const paths = daemonRuntimePaths(root);
    await mkdir(paths.runtimeRoot, { recursive: true, mode: 0o700 });
    await chmod(paths.runtimeRoot, 0o700);
    await writeFile(paths.tokenPath, 't'.repeat(43), { mode: 0o600 });
    await chmod(paths.tokenPath, 0o600);
    let spawned = false;
    const manager = new ZipflowDaemonManager({
      zipflowHome: root,
      uid,
      clientFactory: async () => ({}),
      spawn() {
        spawned = true;
        return new EventEmitter();
      },
    });
    await assert.rejects(
      manager.ensure(),
      (error) => error.code === 'ZIPFLOW_RUNTIME_INVALID',
    );
    assert.equal(spawned, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Windows named-pipe startup fails closed until a DACL security adapter is installed', async () => {
  const manager = new ZipflowDaemonManager({
    zipflowHome: 'C:\\Users\\fixture\\.zipflow',
    platform: 'win32',
    uid: null,
    clientFactory: async () => ({}),
  });
  await assert.rejects(
    manager.ensure(),
    (error) => error.code === 'ZIPFLOW_WINDOWS_SECURITY_UNAVAILABLE',
  );
});
