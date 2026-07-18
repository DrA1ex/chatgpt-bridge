import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserClientCoordinator } from '../src/bridge/coordinator/browserClientCoordinator.js';

function clientSnapshot(releasing) {
  return {
    id: 'client-release',
    ready: true,
    compatible: true,
    selected: true,
    focused: true,
    url: 'https://chatgpt.com/c/session-release',
    session: { id: 'session-release', url: 'https://chatgpt.com/c/session-release' },
    activeRequest: releasing ? { requestId: 'request-old' } : null,
    releasingRequestId: releasing ? 'request-old' : '',
  };
}

test('prompt selection waits on the explicit browser release barrier instead of reporting a false busy tab', async () => {
  let releasing = true;
  let waitCalls = 0;
  const hub = {
    serverInstanceId: 'server-test',
    get clients() { return [clientSnapshot(releasing)]; },
    get activeClient() { return clientSnapshot(releasing); },
    async waitForClientRelease(clientId, requestId) {
      waitCalls += 1;
      assert.equal(clientId, 'client-release');
      assert.equal(requestId, 'request-old');
      releasing = false;
      return { released: true, clientId, requestId };
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
