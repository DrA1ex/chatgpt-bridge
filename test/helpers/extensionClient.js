import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { config } from '../../src/config.js';

export async function connectExtensionClient(hub, hello = {}) {
  const server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  hub.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const token = encodeURIComponent(config.bridgeToken || '');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/extension/ws?runtime=extension&token=${token}`, {
    origin: 'null',
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({
    type: 'hello',
    clientId: hello.clientId || 'test-extension',
    runtime: 'extension',
    url: hello.url || 'https://chatgpt.com/',
    title: hello.title || 'ChatGPT',
    extensionVersion: hello.extensionVersion || '1.0.20',
    clientVersion: hello.clientVersion || '3.0.20',
    extensionProtocolVersion: hello.extensionProtocolVersion ?? 3,
    ...hello,
  }));
  await once(hub, 'client.ready');
  return {
    ws,
    server,
    send(payload) { ws.send(JSON.stringify(payload)); },
    async close() {
      try { ws.close(); } catch {}
      hub.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
