import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserClientCoordinator } from '../src/bridge/coordinator/browserClientCoordinator.js';

function clientSnapshot() {
  return {
    id: 'client-release',
    ready: true,
    compatible: true,
    selected: true,
    focused: true,
    url: 'https://chatgpt.com/c/session-release',
    session: { id: 'session-release', url: 'https://chatgpt.com/c/session-release' },
    activeRequest: null,
  };
}

test('prompt selection waits on the canonical release coordinator instead of Hub-owned state', async () => {
  let releasing = true;
  let waitCalls = 0;
  const hub = {
    serverInstanceId: 'server-test',
    get clients() { return [clientSnapshot()]; },
    get activeClient() { return clientSnapshot(); },
  };
  const releaseCoordinator = {
    isReleasePending(clientId) {
      assert.equal(clientId, 'client-release');
      return releasing;
    },
    async waitForReleaseBarrier(clientId) {
      waitCalls += 1;
      assert.equal(clientId, 'client-release');
      releasing = false;
    },
  };
  const events = [];
  const lifecycle = {
    emitRequestEvent(_state, event) { events.push(event); },
  };
  const coordinator = new BrowserClientCoordinator({
    hub,
    pending: new Map(),
    lifecycle,
    runtimeOptions: { autoOpenTab: false },
    sendCommand: async () => ({}),
    releaseCoordinator,
  });
  const state = { requestId: 'request-new' };

  const resolved = await coordinator.resolvePromptClient(state, { sessionId: 'session-release' });

  assert.equal(waitCalls, 1);
  assert.equal(resolved.client.id, 'client-release');
  assert.equal(resolved.reason, 'session_match');
  assert.deepEqual(events.map((event) => event.type), [
    'client.release.wait_started',
    'client.release.wait_completed',
  ]);
});
