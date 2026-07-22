import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { config } from '../../src/config.js';
import { ExtensionMessageType, createExtensionEnvelope } from '../../src/bridge/protocol/v5.js';

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
    extensionVersion: hello.extensionVersion || '2.3.1',
    clientVersion: hello.clientVersion || '4.3.1',
    extensionProtocolVersion: hello.extensionProtocolVersion ?? 5,
    ...hello,
  };
  const helloRequestId = String(hello.activeRequest?.requestId || '');
  const helloRequest = helloRequestId ? {
    requestId: helloRequestId,
    leaseId: hello.activeRequest.leaseId || 'test-lease',
    ownerServerInstanceId: hello.activeRequest.ownerServerInstanceId || hub.serverInstanceId,
  } : null;
  const ready = once(hub, 'client.ready');
  const helloEnvelope = createExtensionEnvelope(ExtensionMessageType.TRANSPORT_HELLO, helloPayload, { source: source(), request: helloRequest });
  const helloAck = new Promise((resolve, reject) => {
    const onMessage = (data) => {
      let value = null;
      try { value = JSON.parse(String(data)); } catch { return; }
      if (value.messageType !== ExtensionMessageType.TRANSPORT_ACK || value.body?.ackMessageId !== helloEnvelope.messageId) return;
      ws.off('message', onMessage);
      if (value.body?.accepted === false) reject(new Error(`Extension test handshake rejected: ${value.body?.reason || 'unknown'}`));
      else resolve(value.body);
    };
    ws.on('message', onMessage);
  });
  ws.send(JSON.stringify(helloEnvelope));
  await Promise.all([ready, helloAck]);
  return {
    ws,
    server,
    send(payload, options = {}) {
      const requestId = String(payload?.requestId || '');
      const request = options.request || (requestId && hello.activeRequest?.requestId === requestId ? {
        requestId,
        leaseId: hello.activeRequest.leaseId || 'test-lease',
        ownerServerInstanceId: hello.activeRequest.ownerServerInstanceId || hub.serverInstanceId,
      } : null);
      const messageType = ({
        hello: ExtensionMessageType.TRANSPORT_HELLO,
        pong: ExtensionMessageType.TRANSPORT_PONG,
        diagnostic: ExtensionMessageType.TRANSPORT_DIAGNOSTIC,
        'tab.observation': ExtensionMessageType.TAB_OBSERVATION,
        'command.accepted': ExtensionMessageType.COMMAND_ACCEPTED,
        'command.progress': ExtensionMessageType.COMMAND_PROGRESS,
        'command.result': ExtensionMessageType.COMMAND_RESULT,
        'command.error': ExtensionMessageType.COMMAND_REJECTED,
        'command.rejected': ExtensionMessageType.COMMAND_REJECTED,
        'request.effect.started': ExtensionMessageType.EFFECT_STARTED,
        'request.effect.succeeded': ExtensionMessageType.EFFECT_SUCCEEDED,
        'request.effect.failed': ExtensionMessageType.EFFECT_FAILED,
        'request.effect.uncertain': ExtensionMessageType.EFFECT_UNCERTAIN,
        'request.effect.cancelled': ExtensionMessageType.EFFECT_CANCELLED,
        'lease.released': ExtensionMessageType.LEASE_RELEASED,
        'lease.quarantined': ExtensionMessageType.LEASE_QUARANTINED,
      })[String(payload?.type || '')];
      if (!messageType) throw new Error(`Test helper requires an explicit Protocol 5 message mapping for ${payload?.type || 'unknown'}`);
      ws.send(JSON.stringify(createExtensionEnvelope(messageType, payload, {
        source: source(), request,
        commandId: payload?.commandId || null,
        effectId: payload?.effectId || null,
      })));
    },
    async close() {
      try { ws.close(); } catch {}
      hub.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
