import test from 'node:test';
import assert from 'node:assert/strict';
import { TampermonkeyHub } from '../src/tampermonkeyHub.js';

test('hub exposes server instance identity and preserves active request ownership/current generation', () => {
  const hub = new TampermonkeyHub(null, { serverInstanceId: 'server-current' });
  hub.registerPollingClient({
    clientId: 'tab-a',
    url: 'https://chatgpt.com/c/session-a',
    activeRequest: {
      requestId: 'turn-a',
      ownerServerInstanceId: 'server-other',
      sawGenerating: true,
      generating: false,
      stopButtonVisible: false,
    },
  });
  const client = hub.clients.find((item) => item.id === 'tab-a');
  assert.equal(hub.serverInstanceId, 'server-current');
  assert.equal(client.serverInstanceId, 'server-current');
  assert.equal(client.activeRequest.ownerServerInstanceId, 'server-other');
  assert.equal(client.activeRequest.sawGenerating, true);
  assert.equal(client.activeRequest.generating, false);
  assert.equal(client.activeRequest.stopButtonVisible, false);
  hub.close();
});
