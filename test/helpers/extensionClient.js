import http from 'node:http';
import { once } from 'node:events';
import WebSocket from '../../src/runtime/ws.js';
import { config } from '../../src/config.js';
import { EXPECTED_EXTENSION_ORIGIN } from '../../src/bridge/hub/connectionPolicy.js';
import { ExtensionMessageType, createExtensionEnvelope } from '../../src/bridge/protocol/v5.js';
import { readBundledExtensionInfo } from '../../src/extensionStartup.js';

export async function connectExtensionClient(hub, hello = {}, options = {}) {
  const bundledExtension = await readBundledExtensionInfo();
  const ownsServer = !options.server;
  const server = options.server || http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  if (ownsServer) {
    hub.attach(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  const address = server.address();
  const token = encodeURIComponent(config.bridgeToken || '');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/extension/ws?runtime=extension&token=${token}`, {
    origin: options.origin || EXPECTED_EXTENSION_ORIGIN,
  });
  try {
    await once(ws, 'open');
  } catch (error) {
    try { ws.terminate?.(); } catch {}
    if (ownsServer) {
      hub.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    throw error;
  }
  let sequence = 0;
  const sourceClientId = hello.sourceClientId || hello.clientId || 'test-extension';
  const source = () => ({
    clientId: sourceClientId,
    tabId: hello.browserTabId ?? 1,
    backgroundEpoch: 'test-background-epoch',
    contentEpoch: 'test-content-epoch',
    sequence: ++sequence,
  });
  const { sourceClientId: _sourceClientId, ...helloOverrides } = hello;
  const helloPayload = {
    type: 'hello',
    clientId: hello.clientId || 'test-extension',
    runtime: 'extension',
    url: hello.url || 'https://chatgpt.com/',
    title: hello.title || 'ChatGPT',
    extensionVersion: hello.extensionVersion || bundledExtension.version,
    extensionBundleId: hello.extensionBundleId || bundledExtension.bundleId,
    clientVersion: hello.clientVersion || bundledExtension.contentVersion,
    extensionProtocolVersion: hello.extensionProtocolVersion ?? 5,
    ...helloOverrides,
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
  try {
    await Promise.all([ready, helloAck]);
  } catch (error) {
    try { ws.terminate?.(); } catch {}
    if (ownsServer) {
      hub.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    throw error;
  }
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
      if (!ownsServer) return;
      hub.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
