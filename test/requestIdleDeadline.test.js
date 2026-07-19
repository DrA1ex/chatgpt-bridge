import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

process.env.ENV_FILE = path.join(os.tmpdir(), `bridge-idle-timeout-${process.pid}.env`);
process.env.ANSWER_TIMEOUT_MS = '100';
process.env.API_TOKEN = 'test-api-token';
process.env.BRIDGE_TOKEN = 'test-bridge-token';

const { BrowserBridge } = await import('../src/browserBridge.js');
const { emitPromptSubmitted, emitTabObservation } = await import('./support/bridgeObservation.js');

class FakeHub extends EventEmitter {
  constructor() {
    super();
    this.activeClient = { id: 'client-1', url: 'https://chatgpt.com/' };
    this.sent = [];
  }
  get clients() { return [{ id: 'client-1', url: 'https://chatgpt.com/', activeRequest: null }]; }
  get selectedClientId() { return ''; }
  get needsSelection() { return false; }
  get debugEvents() { return []; }
  sendToActiveWithDelivery(payload) {
    this.sent.push({ clientId: 'client-1', payload });
    return { client: this.activeClient, delivered: Promise.resolve() };
  }
  sendToActive(payload) {
    this.sent.push({ clientId: 'client-1', payload });
    return this.activeClient;
  }
  sendToClient(clientId, payload) {
    this.sent.push({ clientId, payload });
    return true;
  }
}

function emitGeneratingObservation(hub, requestId) {
  emitTabObservation(hub, {
    requestId,
    generation: 'active',
    outputState: 'reasoning',
    finalMessage: false,
    stableForMs: 0,
  });
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('active request heartbeat keeps long ChatGPT generations alive past the idle timeout', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);

  let settled = false;
  const promise = bridge.sendRequest({ message: 'long task' }).finally(() => { settled = true; });
  await nextTick();

  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt, 'prompt.send should be sent');

  emitPromptSubmitted(hub, { requestId: prompt.requestId });
  emitGeneratingObservation(hub, prompt.requestId);

  for (let i = 0; i < 6; i += 1) {
    await sleep(30);
    hub.emit('client.activity', {
      clientId: 'client-1',
      client: { id: 'client-1', activeRequest: { requestId: prompt.requestId } },
      payload: { type: 'pong', activeRequest: { requestId: prompt.requestId } },
    });
  }

  assert.equal(settled, false, 'request should remain pending while activeRequest heartbeats arrive');
  assert.equal(hub.sent.some((entry) => entry.payload.type === 'prompt.cancel'), false, 'bridge should not cancel an active long-running request');

  emitTabObservation(hub, { requestId: prompt.requestId, answer: 'finished' });
  const result = await promise;
  assert.equal(result.answer, 'finished');
  await bridge.close();
});

test('request still times out when no request messages or activeRequest heartbeats arrive', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);

  let error = null;
  const promise = bridge.sendRequest({ message: 'silent task' }).catch((err) => { error = err; });
  await nextTick();

  await sleep(130);
  await promise;
  assert.match(error?.message || '', /Timed out waiting for ChatGPT request progress after 100ms|Source ChatGPT tab\/client disconnected/);
  assert.ok(hub.sent.some((entry) => entry.payload.type === 'prompt.cancel'), 'silent requests should still be cancelled');
  await bridge.close();
});
