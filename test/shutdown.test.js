import test from 'node:test';
import assert from 'node:assert/strict';
import { shutdownBridgeResources } from '../src/shutdown.js';

test('interactive shutdown does not wait for preserved workflow queues and forces lingering HTTP connections closed', async () => {
  const calls = [];
  const server = {
    close(callback) { this.callback = callback; calls.push(['server.close']); },
    closeIdleConnections() { calls.push(['server.closeIdleConnections']); },
    closeAllConnections() { calls.push(['server.closeAllConnections']); this.callback?.(); },
  };
  const result = await shutdownBridgeResources({
    workflowManager: {
      async close(options) { calls.push(['workflow.close', options]); return { drained: false, pending: 2, preserved: true }; },
    },
    bridge: { async close(options) { calls.push(['bridge.close', options]); } },
    hub: { close() { calls.push(['hub.close']); } },
    codexRpcServer: { close() { calls.push(['codex.close']); } },
    server,
    preserveActiveWork: true,
    serverTimeoutMs: 10,
    log(message) { calls.push(['log', message]); },
  });

  assert.deepEqual(calls.find((item) => item[0] === 'workflow.close')[1], { timeoutMs: 0, cancelActiveTurns: false });
  assert.deepEqual(calls.find((item) => item[0] === 'bridge.close')[1], { cancelPending: false });
  assert.equal(calls.some((item) => item[0] === 'server.closeAllConnections'), true);
  assert.equal(result.server.closed, true);
});
