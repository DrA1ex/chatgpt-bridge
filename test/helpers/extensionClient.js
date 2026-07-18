import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { config } from '../../src/config.js';
import { ExtensionMessageKind, createExtensionEnvelope, extensionKindForPayload } from '../../src/bridge/protocol/v4.js';

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
  let sequence = 0;
  const source = () => ({
    clientId: hello.clientId || 'test-extension',
    tabId: hello.browserTabId ?? 1,
    backgroundEpoch: 'test-background-epoch',
    contentEpoch: 'test-content-epoch',
    sequence: ++sequence,
  });
  const helloPayload = {
    type: 'hello',
    clientId: hello.clientId || 'test-extension',
    runtime: 'extension',
    url: hello.url || 'https://chatgpt.com/',
    title: hello.title || 'ChatGPT',
    extensionVersion: hello.extensionVersion || '2.0.3',
    clientVersion: hello.clientVersion || '4.0.3',
    extensionProtocolVersion: hello.extensionProtocolVersion ?? 4,
    ...hello,
  };
  const helloRequestId = String(hello.activeRequest?.requestId || '');
  const helloRequest = helloRequestId ? {
    requestId: helloRequestId,
    leaseId: hello.activeRequest.leaseId || 'test-lease',
    ownerServerInstanceId: hello.activeRequest.ownerServerInstanceId || hub.serverInstanceId,
  } : null;
  ws.send(JSON.stringify(createExtensionEnvelope(ExtensionMessageKind.TRANSPORT_HELLO, helloPayload, { source: source(), request: helloRequest })));
  await once(hub, 'client.ready');
  return {
    ws,
    server,
    send(payload) {
      const requestId = String(payload?.requestId || '');
      const request = requestId && hello.activeRequest?.requestId === requestId ? {
        requestId,
        leaseId: hello.activeRequest.leaseId || 'test-lease',
        ownerServerInstanceId: hello.activeRequest.ownerServerInstanceId || hub.serverInstanceId,
      } : null;
      ws.send(JSON.stringify(createExtensionEnvelope(extensionKindForPayload(payload), payload, { source: source(), request })));
    },
    async close() {
      try { ws.close(); } catch {}
      hub.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
