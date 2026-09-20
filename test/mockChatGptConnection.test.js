import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { BrowserExtensionHub } from '../src/browserExtensionHub.js';
import { config } from '../src/config.js';
import { startMockChatGptRuntime, stopMockChatGptRuntime } from '../scripts/e2e/mock-chatgpt/runtime.js';

test('local ChatGPT runtime connects through the production extension origin boundary', async (t) => {
  const server = http.createServer();
  const hub = new BrowserExtensionHub();
  hub.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let runtime;
  t.after(async () => {
    await stopMockChatGptRuntime(runtime);
    hub.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const ready = once(hub, 'client.ready');
  runtime = await startMockChatGptRuntime({
    enabled: true, bridgeUrl: `http://127.0.0.1:${server.address().port}`, bridgeToken: config.bridgeToken,
  });
  await ready;
  assert.equal(hub.clients.length, 1);
  assert.equal(hub.clients[0].compatibility.compatible, true);
});

test('a rejected mock connection rejects startup cleanly without an unhandled error event', async (t) => {
  const server = http.createServer();
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(startMockChatGptRuntime({
    enabled: true, bridgeUrl: `http://127.0.0.1:${server.address().port}`,
  }), /403/);
});
