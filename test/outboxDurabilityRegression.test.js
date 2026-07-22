import test from 'node:test';
import assert from 'node:assert/strict';
import { createProtocolOutbox } from '../tools/chrome-bridge-extension/background/outboxV5.js';

const previousWebSocket = globalThis.WebSocket;

test('critical outbox flush failure does not invalidate an already persisted terminal result and can be retried', async () => {
  globalThis.WebSocket = { OPEN: 1 };
  try {
    const envelope = {
      protocolVersion: 5,
      messageId: 'terminal-persisted',
      messageType: 'effect.succeeded',
      sentAt: 1,
      source: { clientId: 'client', tabId: 9, backgroundEpoch: 'background', contentEpoch: 'content', sequence: 0 },
      request: { requestId: 'request', leaseId: 'lease', ownerServerInstanceId: 'server', responseEpoch: 0 },
      commandId: 'command', effectId: 'effect', causationId: 'command',
      body: { requestId: 'request', effectId: 'effect', effectType: 'page.ready.initial' },
    };
    let failSequencePersistence = true;
    let sequence = 0;
    let storedEnvelope = structuredClone(envelope);
    const backgroundState = {
      async read() {
        return {
          contentEpoch: 'content',
          lease: envelope.request,
          transport: { outboundSequence: sequence },
          outbox: storedEnvelope ? [structuredClone(storedEnvelope)] : [],
        };
      },
      async transition(_tabId, event) {
        if (event.type === 'transport.outbound.next') {
          if (failSequencePersistence) {
            failSequencePersistence = false;
            const error = new Error('QUOTA_BYTES exceeded while resequencing');
            error.code = 'BACKGROUND_STATE_PERSIST_FAILED';
            throw error;
          }
          sequence += 1;
          return {
            accepted: true,
            state: { contentEpoch: 'content', lease: envelope.request, transport: { outboundSequence: sequence }, outbox: [storedEnvelope] },
          };
        }
        if (event.type === 'outbox.resequenced') {
          storedEnvelope = structuredClone(event.envelope);
          return {
            accepted: true,
            state: { contentEpoch: 'content', lease: envelope.request, transport: { outboundSequence: sequence }, outbox: [storedEnvelope] },
          };
        }
        throw new Error(`Unexpected transition ${event.type}`);
      },
    };
    const sent = [];
    const posted = [];
    const state = {
      tabId: 9,
      clientId: 'client',
      contentEpoch: 'content',
      closed: false,
      port: {},
      ws: { readyState: 1, send(value) { sent.push(JSON.parse(value)); } },
    };
    const outbox = createProtocolOutbox({
      backgroundEpoch: 'background',
      backgroundState,
      post(_port, value) { posted.push(value); },
      summarize(value) { return value; },
    });

    const first = await outbox.flushCriticalOutbox(state);
    assert.equal(first.flushed, false);
    assert.equal(sent.length, 0);
    assert.equal(posted.some((item) => item.status === 'extension queueing'), true);
    assert.equal(storedEnvelope.messageId, 'terminal-persisted');

    const second = await outbox.flushCriticalOutbox(state);
    assert.equal(second.flushed, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].messageId, 'terminal-persisted');
    assert.equal(sent[0].source.sequence, 1);
  } finally {
    if (previousWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previousWebSocket;
  }
});
