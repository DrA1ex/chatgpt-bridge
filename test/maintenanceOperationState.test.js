import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAINTENANCE_STATE_STORAGE_KEY,
  createMaintenanceOperationStore,
} from '../tools/chrome-bridge-extension/background/maintenanceOperations.js';
import { createExtensionReloadCoordinator } from '../tools/chrome-bridge-extension/background/extensionReloadCoordinator.js';

function memoryStorage({ failPending = false } = {}) {
  const values = new Map();
  return {
    values,
    async get(key) { return { [key]: values.get(key) }; },
    async set(patch) {
      if (failPending && Object.hasOwn(patch, 'bridgePendingExtensionReload')) throw new Error('pending storage unavailable');
      for (const [key, value] of Object.entries(patch || {})) values.set(key, structuredClone(value));
    },
    async remove(key) { values.delete(key); },
  };
}

test('maintenance operations require durable storage and recover dispatched work from typed proof', async () => {
  assert.throws(
    () => createMaintenanceOperationStore(null),
    (error) => error?.code === 'MAINTENANCE_STORAGE_UNAVAILABLE',
  );

  const storage = memoryStorage();
  const first = createMaintenanceOperationStore(storage);
  const planned = await first.plan('extension.reload', {
    idempotencyKey: 'reload-v2.2.0',
    preconditions: { expectedVersion: '2.2.0' },
  });
  const operationId = planned.state.active.operationId;
  await first.dispatch(operationId);

  const restarted = createMaintenanceOperationStore(storage);
  const recovered = await restarted.recover(async (operation) => ({
    outcome: 'succeeded',
    result: { expectedVersion: operation.preconditions.expectedVersion, verified: true },
  }));
  assert.equal(recovered.state.active.status, 'succeeded');
  assert.equal(recovered.state.active.result.verified, true);
  assert.ok(recovered.state.active.dispatchedAt > 0);
  assert.ok(recovered.state.active.settledAt >= recovered.state.active.dispatchedAt);
});

test('extension reload fails closed when pending intent cannot be persisted', async (t) => {
  const previousChrome = globalThis.chrome;
  t.after(() => {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  });

  const storage = memoryStorage({ failPending: true });
  let reloads = 0;
  globalThis.chrome = {
    storage: { local: storage },
    runtime: { reload() { reloads += 1; } },
    tabs: { async query() { return []; } },
  };
  const maintenanceOperations = createMaintenanceOperationStore(storage);
  const coordinator = createExtensionReloadCoordinator({
    backgroundState: { async read() { return { lease: null }; } },
    maintenanceOperations,
    safeBridgeServerUrl: (value) => String(value || ''),
    async readLaunchedTab() { return null; },
    async rememberLaunchedTab() {},
    async navigateTab() {},
    async reloadTab() {},
    launchTokenPattern: /^bridge-[a-z0-9_-]+$/i,
  });

  await assert.rejects(
    coordinator.scheduleExtensionReload({ expectedVersion: '2.2.0', sourceTabId: 77, commandId: 'reload-command' }),
    /pending storage unavailable/,
  );
  assert.equal(reloads, 0);
  const persisted = storage.values.get(MAINTENANCE_STATE_STORAGE_KEY);
  assert.equal(persisted.active.status, 'failed');
  assert.equal(persisted.active.error.code, 'MAINTENANCE_PENDING_WRITE_FAILED');
});


test('extension reload waits for the exact terminal command result ACK before restarting runtime', async (t) => {
  const previousChrome = globalThis.chrome;
  t.after(() => {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  });

  const storage = memoryStorage();
  globalThis.chrome = {
    storage: { local: storage },
    tabs: { async query() { return []; } },
  };
  const runtime = {
    lease: null,
    commands: { 'reload-command': { commandId: 'reload-command', status: 'dispatched' } },
    outbox: [],
  };
  let reloads = 0;
  const coordinator = createExtensionReloadCoordinator({
    backgroundState: { async read() { return runtime; } },
    maintenanceOperations: createMaintenanceOperationStore(storage),
    safeBridgeServerUrl: (value) => String(value || ''),
    async readLaunchedTab() { return null; },
    async rememberLaunchedTab() {},
    async navigateTab() {},
    async reloadTab() {},
    launchTokenPattern: /^bridge-[a-z0-9_-]+$/i,
    reloadRuntime() { reloads += 1; },
    ackTimeoutMs: 1_000,
  });

  const scheduled = await coordinator.scheduleExtensionReload({
    expectedVersion: '2.3.0',
    sourceTabId: 77,
    commandId: 'reload-command',
    reloadTabs: false,
  });
  assert.equal(scheduled.scheduled, true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(reloads, 0, 'A dispatched command is not enough to restart the extension');

  runtime.commands['reload-command'] = { commandId: 'reload-command', status: 'succeeded' };
  runtime.outbox = [{ messageType: 'command.result', commandId: 'reload-command' }];
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(reloads, 0, 'A durable but unacknowledged terminal result must survive before reload');

  runtime.outbox = [];
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(reloads, 1);
});

test('maintenance state migrates once from the legacy Protocol 5 storage key', async () => {
  const storage = memoryStorage();
  const legacyKey = 'chatgptBridgeV5:maintenance';
  storage.values.set(legacyKey, {
    schemaVersion: 2,
    revision: 7,
    active: null,
    history: [{ operationId: 'legacy-operation', status: 'succeeded' }],
    journal: [],
    updatedAt: 123,
  });

  const store = createMaintenanceOperationStore(storage);
  const migrated = await store.read();
  assert.equal(migrated.revision, 7);
  assert.equal(migrated.history[0].operationId, 'legacy-operation');
  assert.deepEqual(storage.values.get(MAINTENANCE_STATE_STORAGE_KEY), migrated);
  assert.equal(storage.values.has(legacyKey), false);
});
