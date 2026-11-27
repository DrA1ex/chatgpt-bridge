import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { BridgeCommandRegistry } from '../src/bridge/coordinator/bridgeCommandRegistry.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(t) {
  const sent = [];
  const registry = new BridgeCommandRegistry({ hub: {
    sendToClientWithDelivery(id, payload) {
      sent.push(payload);
      return { client: { id } };
    },
  } });
  t.after(() => registry.close());
  const send = (options = {}) => registry.send('models.list', {}, { sourceClientId: 'tab-1', ...options });
  const respond = (commandId, type = 'command.result', extra = {}) => registry.handleResponse('tab-1', {
    commandId, type, resultType: 'models.snapshot', models: [], ...extra,
  });
  return { registry, sent, send, respond };
}

test('command.rejected rejects a result command with its typed error', async (t) => {
  const { send, sent, respond } = harness(t);
  const pending = send();
  const rejected = assert.rejects(pending, (error) => error.code === 'TAB_BUSY' && error.message === 'Tab is busy');
  await flush();
  respond(sent[0].commandId, 'command.rejected', { code: 'TAB_BUSY', message: 'Tab is busy' });
  await rejected;
});

test('abort after release waiting prevents dispatch and leaves no command correlation', async (t) => {
  const { registry, sent, send } = harness(t);
  let release;
  registry.waitForReleaseBarrier = () => new Promise((resolve) => { release = resolve; });
  const controller = new AbortController();
  const pending = send({ signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort('cancelled while waiting');
  release();
  await rejected;
  assert.deepEqual(sent, []);
  assert.equal(registry.size, 0);
});

test('shutdown during release waiting prevents later command dispatch', async (t) => {
  const { registry, sent, send } = harness(t);
  let release;
  registry.waitForReleaseBarrier = () => new Promise((resolve) => { release = resolve; });
  const pending = send();
  const rejected = assert.rejects(pending, /shutting down/);
  registry.close();
  release();
  await rejected;
  assert.deepEqual(sent, []);
});

test('command settlement detaches its abort listener', async (t) => {
  const { send, sent, respond } = harness(t);
  const controller = new AbortController();
  const pending = send({ signal: controller.signal });
  await flush();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  respond(sent[0].commandId);
  await pending;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('duplicate command IDs cannot replace an outstanding command', async (t) => {
  const { send, sent, respond } = harness(t);
  const first = send({ commandId: 'same-id' });
  await flush();
  const second = send({ commandId: 'same-id' });
  const rejected = assert.rejects(second, (error) => error.code === 'BROWSER_COMMAND_ID_IN_USE');
  await flush();
  respond('same-id');
  await rejected;
  await first;
  assert.equal(sent.length, 1);
});
