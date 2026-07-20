import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowNotificationService, notificationsDisabledByEnvironment } from '../src/workflow/attention/notificationService.js';

function enabledConfig() {
  return { enabled: true, terminalBell: true, desktop: true, reminderIntervalMs: 0 };
}

test('explicit test notification suppression prevents terminal bell and native notification commands', async () => {
  let writes = 0;
  let runs = 0;
  const service = new WorkflowNotificationService({
    env: { BRIDGE_DISABLE_NOTIFICATIONS: '1' },
    output: { isTTY: true, write() { writes += 1; } },
    async run() { runs += 1; },
  });
  const result = await service.notify({ key: 'test', title: 'Test', body: 'Body', config: enabledConfig() });
  assert.deepEqual(result, { notified: false, reason: 'test_environment' });
  assert.equal(writes, 0);
  assert.equal(runs, 0);
});

test('node test workers suppress notifications automatically', async () => {
  assert.equal(notificationsDisabledByEnvironment({ NODE_TEST_CONTEXT: 'child-v8' }), true);
  let writes = 0;
  let runs = 0;
  const service = new WorkflowNotificationService({
    env: { NODE_TEST_CONTEXT: 'child-v8' },
    output: { isTTY: true, write() { writes += 1; } },
    async run() { runs += 1; },
  });
  const result = await service.notify({ key: 'node-test', title: 'Test', body: 'Body', config: enabledConfig() });
  assert.equal(result.reason, 'test_environment');
  assert.equal(writes, 0);
  assert.equal(runs, 0);
});
