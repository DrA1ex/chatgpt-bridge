import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  EXTENSION_PROTOCOL_VERSION,
  ExtensionMessageDefinition,
  ExtensionMessageType,
  createExtensionEnvelope,
  validateExtensionEnvelope,
} from '../src/bridge/protocol/v5.js';
import {
  BACKGROUND_STATE_SCHEMA_VERSION,
  BACKGROUND_STATE_STORAGE_PREFIX,
  BackgroundStateStore,
  createTabRuntimeState,
  reduceTabRuntimeState,
} from '../tools/chrome-bridge-extension/background/stateV6.js';
import { createProtocolOutbox } from '../tools/chrome-bridge-extension/background/outboxV5.js';
import { MessageDefinition as BackgroundMessageDefinition } from '../tools/chrome-bridge-extension/background/protocolV5.js';
import { TabOperationPriority, TabOperationQueue } from '../tools/chrome-bridge-extension/background/tabOperationQueue.js';

function transition(state, event) {
  return reduceTabRuntimeState(state, { tabId: 77, backgroundEpoch: 'background-v5', contentEpoch: 'content-v5', ...event });
}

function memoryStorage(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(key) { return key === null ? structuredClone(values) : { [key]: structuredClone(values[key]) }; },
    async set(patch) { Object.assign(values, structuredClone(patch)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
  };
}

test('Protocol 5 is one explicit shared manifest and rejects legacy envelopes', () => {
  assert.equal(EXTENSION_PROTOCOL_VERSION, 5);
  assert.strictEqual(ExtensionMessageDefinition, BackgroundMessageDefinition);
  assert.equal(ExtensionMessageType.TAB_OBSERVATION, 'tab.observation');
  const envelope = createExtensionEnvelope(ExtensionMessageType.TAB_OBSERVATION, { observation: { revision: 1 } }, {
    messageId: 'observation-v5', source: { clientId: 'client', tabId: 77, backgroundEpoch: 'bg', contentEpoch: 'content', sequence: 1 },
  });
  assert.equal(validateExtensionEnvelope(envelope, { direction: 'extension_to_server', requireClientId: true }).valid, true);
  assert.equal(validateExtensionEnvelope(envelope, { direction: 'server_to_extension' }).valid, false);
  assert.equal(validateExtensionEnvelope({ ...envelope, protocolVersion: 4, kind: 'tab.observation', payload: envelope.body }).valid, false);
  const effectEnvelope = createExtensionEnvelope(ExtensionMessageType.EFFECT_SUCCEEDED, {
    requestId: 'request', effectId: 'effect', effectType: 'prompt.submit', result: { submitted: true },
  }, {
    messageId: 'effect-terminal', effectId: 'effect', request: { requestId: 'request', leaseId: 'lease', ownerServerInstanceId: 'server', responseEpoch: 0 },
    source: { clientId: 'client', tabId: 77, backgroundEpoch: 'bg', contentEpoch: 'content', sequence: 2 },
  });
  assert.equal(validateExtensionEnvelope(effectEnvelope, { direction: 'extension_to_server', requireClientId: true }).valid, true);
  assert.equal(validateExtensionEnvelope({ ...effectEnvelope, request: { ...effectEnvelope.request, leaseId: '' } }).valid, false);
  assert.equal(validateExtensionEnvelope({ ...effectEnvelope, body: { ...effectEnvelope.body, effectId: 'different' } }).valid, false);
  assert.equal(Object.hasOwn(envelope, 'kind'), false);
  assert.equal(Object.hasOwn(envelope, 'payload'), false);
});

test('schema 6 atomically persists an effect-backed command, BrowserEffect, and accepted outbox entry', () => {
  const request = { requestId: 'request', leaseId: 'lease', ownerServerInstanceId: 'server', responseEpoch: 0 };
  let state = createTabRuntimeState(77, 'background-v5');
  state = transition(state, { type: 'content.attached' }).state;
  state = transition(state, { type: 'lease.claim', ...request }).state;
  const acceptedEnvelope = createExtensionEnvelope(ExtensionMessageType.COMMAND_ACCEPTED, {
    commandId: 'command', requestId: request.requestId, commandMode: 'effect', effectId: 'effect', effectType: 'prompt.submit',
  }, {
    messageId: 'accepted', commandId: 'command', request, source: { clientId: 'client', tabId: 77, backgroundEpoch: 'bg', contentEpoch: 'content-v5', sequence: 0 },
  });
  const outcome = transition(state, {
    type: 'effect_command.dispatched', ...request, commandId: 'command', commandType: 'prompt.send', effectId: 'effect', kind: 'prompt.submit',
    idempotencyKey: 'request:prompt.submit', retryPolicy: 'never', attempt: 1,
    preconditions: request, preconditionsHash: 'sha256:test', acceptedEnvelope,
  });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.state.commands.command.status, 'accepted');
  assert.equal(outcome.state.effects.effect.status, 'dispatched');
  assert.deepEqual(outcome.state.outbox.map((item) => item.messageId), ['accepted']);
  assert.equal(Object.hasOwn(outcome.state.commands.command, 'reportedAt'), false);
  assert.equal(Object.hasOwn(outcome.state.effects.effect, 'reportedAt'), false);
});

test('normal observations are disposable while exact critical envelopes remain until exact ACK', async () => {
  const storage = memoryStorage();
  const backgroundState = new BackgroundStateStore(storage, 'background-v5');
  await backgroundState.transition(77, { type: 'content.attached', contentEpoch: 'content-v5' });
  const sent = [];
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  try {
    const state = { tabId: 77, clientId: 'client', contentEpoch: 'content-v5', port: null, ws: { readyState: 1, send(value) { sent.push(JSON.parse(value)); } } };
    const outbox = createProtocolOutbox({ backgroundEpoch: 'background-v5', backgroundState, post() {}, summarize: (value) => value });
    await outbox.sendProtocolMessage(state, ExtensionMessageType.TAB_OBSERVATION, { observation: { revision: 1 } });
    assert.equal((await backgroundState.read(77)).outbox.length, 0);
    const result = await outbox.sendProtocolMessage(state, ExtensionMessageType.COMMAND_RESULT, { commandId: 'read-command', resultType: 'models.snapshot', models: [] }, { commandId: 'read-command' });
    assert.deepEqual((await backgroundState.read(77)).outbox.map((item) => item.messageId), [result.messageId]);
    const wrong = await backgroundState.transition(77, { type: 'outbox.acknowledged', messageId: 'different', sequence: 2, contentEpoch: 'content-v5' });
    assert.equal(wrong.accepted, false);
    assert.equal((await backgroundState.read(77)).outbox.length, 1);
    const exact = await backgroundState.transition(77, { type: 'outbox.acknowledged', messageId: result.messageId, sequence: 2, contentEpoch: 'content-v5' });
    assert.equal(exact.accepted, true);
    assert.equal(exact.state.outbox.length, 0);
    assert.equal(sent.length, 2);
  } finally {
    if (previousWebSocket === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = previousWebSocket;
  }
});


test('concurrent outbox flushes rerun from persisted messages without reconstructing terminal records', async () => {
  const storage = memoryStorage();
  const backgroundState = new BackgroundStateStore(storage, 'background-v5');
  await backgroundState.transition(77, { type: 'content.attached', contentEpoch: 'content-v5' });
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  try {
    const sent = [];
    let nestedFlush = null;
    let outbox = null;
    const state = {
      tabId: 77, clientId: 'client', contentEpoch: 'content-v5', port: null,
      ws: {
        readyState: 1,
        send(value) {
          const parsed = JSON.parse(value);
          sent.push(parsed.messageId);
          if (sent.length !== 1) return;
          const second = outbox.createEnvelopeDraft(state, ExtensionMessageType.COMMAND_RESULT, {
            commandId: 'command-second', resultType: 'models.snapshot', models: [],
          }, { commandId: 'command-second', messageId: 'terminal-second' });
          nestedFlush = backgroundState.transition(77, {
            type: 'outbox.enqueued', envelope: second, contentEpoch: 'content-v5',
          }).then(() => outbox.flushCriticalOutbox(state));
        },
      },
    };
    outbox = createProtocolOutbox({ backgroundEpoch: 'background-v5', backgroundState, post() {}, summarize: (value) => value });
    const first = outbox.createEnvelopeDraft(state, ExtensionMessageType.COMMAND_RESULT, {
      commandId: 'command-first', resultType: 'models.snapshot', models: [],
    }, { commandId: 'command-first', messageId: 'terminal-first' });
    const stored = await backgroundState.transition(77, { type: 'outbox.enqueued', envelope: first, contentEpoch: 'content-v5' });
    assert.equal(stored.accepted, true);
    await outbox.flushCriticalOutbox(state);
    await nestedFlush;
    assert.equal(sent.includes('terminal-first'), true);
    assert.equal(sent.includes('terminal-second'), true);
    assert.deepEqual((await backgroundState.read(77)).outbox.map((item) => item.messageId), ['terminal-first', 'terminal-second']);
  } finally {
    if (previousWebSocket === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = previousWebSocket;
  }
});

test('tab queue preserves per-source order while reserving control capacity', async () => {
  const queue = new TabOperationQueue({ maxPending: 2, reservedCritical: 1 });
  const order = [];
  let unblock;
  const running = queue.run(77, () => new Promise((resolve) => { unblock = resolve; }), { label: 'running', priority: TabOperationPriority.REQUEST, serialGroup: 'content' });
  await new Promise((resolve) => setImmediate(resolve));
  const request = queue.run(77, async () => { order.push('request'); }, { label: 'request', priority: TabOperationPriority.REQUEST, serialGroup: 'server', order: 1 });
  const release = queue.run(77, async () => { order.push('release'); }, { label: 'release', priority: TabOperationPriority.RELEASE, critical: true, serialGroup: 'server', order: 2 });
  await assert.rejects(queue.run(77, async () => {}, { label: 'overflow' }), (error) => error?.code === 'TAB_OPERATION_QUEUE_FULL');
  unblock();
  await Promise.all([running, request, release]);
  assert.deepEqual(order, ['request', 'release']);
});

test('production hard cut contains no classifier, record reporter, legacy executor protocol, or lifecycle shadow mutation', async () => {
  const roots = ['src', 'tools/chrome-bridge-extension'];
  const files = [];
  async function walk(root) {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  }
  for (const root of roots) await walk(root);
  const entries = await Promise.all(files.map(async (file) => [file, await fs.readFile(file, 'utf8')]));
  const source = entries.map(([, value]) => value).join('\n');
  assert.doesNotMatch(source, /protocolV4|stateV4|outboxV4|unreportedCriticalReporter|extensionKindForPayload|kindForPayload/);
  assert.doesNotMatch(source, /send\(\{\s*type:\s*['"](?:prompt\.accepted|prompt\.steered|prompt\.cancelled|request\.release\.completed|prompt\.execution\.step\.completed)['"]/);
  assert.doesNotMatch(source, /prompt\.cancelled|request\.release\.completed|prompt\.execution\.step\.completed/);
  const executorBoundarySource = entries
    .filter(([file]) => file.includes(path.join('tools', 'chrome-bridge-extension', 'content'))
      || file.endsWith(path.join('background', 'portRouter.js')))
    .map(([, value]) => value)
    .join('\n');
  assert.doesNotMatch(executorBoundarySource, /request\.effect\.(?:started|reconciled|failed)|request\.cleanup\.(?:completed|failed)|bridge\.effect\.plan|reportExecutionFailure/);
  assert.doesNotMatch(source, /state\.(?:accepted|promptSubmitted|currentGenerationActive|cancelRequested)\b\s*=/);
  assert.doesNotMatch(source, /reportedAt/);

  const contentRouter = entries.find(([file]) => file.endsWith(path.join('content', 'serverCommandRouter.js')))?.[1] || '';
  const handlerTypes = new Set([...contentRouter.matchAll(/['"]([a-z][A-Za-z0-9.-]+)['"]\s*:\s*handle[A-Z]/g)].map((match) => match[1]));
  handlerTypes.add('command.cancel');
  const manifestTypes = new Set(globalThis.ChatGptBridgeCommandManifest.commandTypes());
  assert.deepEqual([...handlerTypes].sort(), [...manifestTypes].sort());

  const backgroundRouter = entries.find(([file]) => file.endsWith(path.join('background', 'serverEnvelopeRouter.js')))?.[1] || '';
  assert.match(backgroundRouter, /if \(!definition\) throw new Error\(`Unsupported browser command type:/);
  assert.doesNotMatch(backgroundRouter, /return\s+['"]result['"]\s*;\s*}\s*\/\/\s*fallback/i);
  assert.equal(BACKGROUND_STATE_SCHEMA_VERSION, 6);
  assert.equal(BACKGROUND_STATE_STORAGE_PREFIX, 'chatgptBridgeV6:tab:');
});
