import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExtensionMessageType,
  createExtensionEnvelope,
} from '../src/bridge/protocol/v5.js';
import {
  BackgroundStateStore,
  DownloadStatus,
} from '../tools/chrome-bridge-extension/background/stateV6.js';
import { createProtocolOutbox } from '../tools/chrome-bridge-extension/background/outboxV5.js';
import {
  handleEffectBegin,
  handlePayload,
} from '../tools/chrome-bridge-extension/background/portRouter.js';
import { handleServerEnvelope } from '../tools/chrome-bridge-extension/background/serverEnvelopeRouter.js';

function memoryStorage() {
  const values = new Map();
  return {
    async get(key) { return { [key]: structuredClone(values.get(key)) }; },
    async set(record) { for (const [key, value] of Object.entries(record)) values.set(key, structuredClone(value)); },
    async remove(key) { values.delete(key); },
  };
}

function harness(tabId = 141) {
  const backgroundState = new BackgroundStateStore(memoryStorage(), 'background-p0');
  const sent = [];
  const posted = [];
  const state = {
    tabId,
    clientId: `client-${tabId}`,
    contentEpoch: 'content-p0',
    connectionEpoch: 'connection-p0',
    protocolReady: true,
    preHelloPayloads: [],
    port: null,
    ws: { readyState: 1, send(value) { sent.push(JSON.parse(value)); } },
  };
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  const post = (_port, message) => posted.push(message);
  const outbox = createProtocolOutbox({
    backgroundEpoch: 'background-p0',
    backgroundState,
    post,
    summarize: (value) => value,
  });
  return {
    backgroundState,
    state,
    sent,
    posted,
    post,
    downloadCaptures: new Map(),
    createEnvelopeDraft: outbox.createEnvelopeDraft,
    sendProtocolMessage: outbox.sendProtocolMessage,
    flushCriticalOutbox: outbox.flushCriticalOutbox,
    replayCriticalOutbox: outbox.replayCriticalOutbox,
    scheduleReleaseDeadline() {},
    restore() {
      if (previousWebSocket === undefined) delete globalThis.WebSocket;
      else globalThis.WebSocket = previousWebSocket;
    },
  };
}

async function initialize(h) {
  const attached = await h.backgroundState.transition(h.state.tabId, {
    type: 'content.attached',
    contentEpoch: h.state.contentEpoch,
  });
  assert.equal(attached.accepted, true, attached.reason);
}

function source(sequence) {
  return {
    clientId: 'server',
    tabId: null,
    backgroundEpoch: 'server-p0',
    contentEpoch: '',
    sequence,
  };
}

function commandEnvelope(type, commandId, sequence, payload = {}) {
  return createExtensionEnvelope(ExtensionMessageType.COMMAND_EXECUTE, {
    type,
    commandId,
    serverInstanceId: 'server-p0',
    ...payload,
  }, {
    messageId: `message-${commandId}`,
    commandId,
    source: source(sequence),
  });
}

function rawUnknownCommandEnvelope() {
  return {
    protocolVersion: 5,
    messageId: 'message-unknown-command',
    messageType: ExtensionMessageType.COMMAND_EXECUTE,
    sentAt: Date.now(),
    source: source(1),
    request: null,
    commandId: 'unknown-command',
    effectId: null,
    causationId: null,
    body: {
      type: 'browser.command.not-real',
      commandId: 'unknown-command',
      serverInstanceId: 'server-p0',
    },
  };
}

test('shared command manifest is closed and every command declares ownership and recovery policy', () => {
  const manifest = globalThis.ChatGptBridgeCommandManifest;
  assert.ok(manifest);
  for (const type of manifest.commandTypes()) {
    const definition = manifest.commandDefinition(type);
    assert.ok(['standalone', 'request', 'either'].includes(definition.scope), `${type} scope`);
    assert.ok(['result', 'effect', 'release'].includes(definition.mode), `${type} mode`);
    assert.ok(['read', 'write', 'control', 'maintenance'].includes(definition.operation), `${type} operation`);
    assert.ok(['never', 'if_unconfirmed', 'always'].includes(definition.retryPolicy), `${type} retryPolicy`);
    assert.equal(typeof definition.reconcile, 'string', `${type} reconcile`);
    assert.notEqual(definition.reconcile, '', `${type} reconcile`);
  }
  assert.equal(manifest.commandDefinition('browser.command.not-real'), null);
  assert.throws(() => commandEnvelope('browser.command.not-real', 'unknown', 1), /unsupported command type/);
  assert.throws(() => createExtensionEnvelope(ExtensionMessageType.COMMAND_ACCEPTED, {
    commandId: 'accepted-without-mode',
  }, {
    commandId: 'accepted-without-mode',
    source: { clientId: 'client', tabId: 1, backgroundEpoch: 'background', contentEpoch: 'content', sequence: 1 },
  }), /commandMode is invalid/);
});

test('background rejects an unknown command before durable registration or content dispatch', async () => {
  const h = harness(142);
  try {
    await initialize(h);
    await handleServerEnvelope({ ...h, envelope: rawUnknownCommandEnvelope() });
    const runtime = await h.backgroundState.read(h.state.tabId);
    assert.deepEqual(runtime.commandOrder, []);
    assert.equal(h.posted.some((message) => message.type === 'server.message'), false);
    const rejected = runtime.outbox.find((entry) => entry.messageType === ExtensionMessageType.COMMAND_REJECTED);
    assert.ok(rejected);
    assert.equal(rejected.body.code, 'BROWSER_COMMAND_INVALID');
    assert.match(rejected.body.message, /unsupported command type/);
  } finally {
    h.restore();
  }
});

test('normal observations cannot reconcile a newly dispatched passive write; only a content reload can', async () => {
  const h = harness(143);
  const message = 'P0 passive prompt recovery marker';
  try {
    await initialize(h);
    await handleServerEnvelope({
      ...h,
      envelope: commandEnvelope('passive.prompt.submit', 'passive-command', 1, {
        message,
        preconditions: { commandType: 'passive.prompt.submit', message },
      }),
    });

    await handlePayload(h, null, h.state, {
      type: 'tab.observation',
      observation: { revision: 1, conversationId: 'conversation-p0', turn: { userPrompt: 'older prompt', userKey: 'user-old' } },
    });
    let runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.commands['passive-command'].status, 'dispatched');

    await handlePayload(h, null, h.state, { type: 'hello', url: 'https://chatgpt.com/c/conversation-p0' });
    runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.commands['passive-command'].status, 'dispatched');

    await handlePayload(h, null, h.state, {
      type: 'tab.observation',
      observation: { revision: 2, conversationId: 'conversation-p0', turn: { userPrompt: message, userKey: 'user-recovered' } },
    });
    runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.commands['passive-command'].status, 'succeeded');
    const terminals = runtime.outbox.filter((entry) => entry.commandId === 'passive-command'
      && entry.messageType === ExtensionMessageType.COMMAND_RESULT);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].body.resultType, 'passive.prompt.submitted');
    assert.equal(terminals[0].body.submittedUserTurnKey, 'user-recovered');
  } finally {
    h.restore();
  }
});

test('a completed persisted download capture proves artifact.fetch success after content reload', async () => {
  const h = harness(144);
  try {
    await initialize(h);
    await handleServerEnvelope({
      ...h,
      envelope: commandEnvelope('artifact.fetch', 'artifact-command', 1, {
        artifact: { id: 'artifact-p0', name: 'result.zip' },
        preconditions: { commandType: 'artifact.fetch', artifactId: 'artifact-p0', expectedName: 'result.zip' },
      }),
    });
    const common = { scope: 'standalone', commandId: 'artifact-command', captureId: 'capture-p0', contentEpoch: h.state.contentEpoch };
    for (const status of [DownloadStatus.PLANNED, DownloadStatus.ARMED, DownloadStatus.BOUND]) {
      const outcome = await h.backgroundState.transition(h.state.tabId, { type: 'download.transition', status, ...common });
      assert.equal(outcome.accepted, true, outcome.reason);
    }
    const completed = await h.backgroundState.transition(h.state.tabId, {
      type: 'download.transition',
      status: DownloadStatus.COMPLETED,
      ...common,
      downloadId: 77,
      result: { name: 'result.zip', mime: 'application/zip', filePath: '/tmp/result.zip', size: 1234, downloadId: 77 },
    });
    assert.equal(completed.accepted, true, completed.reason);

    await handlePayload(h, null, h.state, { type: 'hello', url: 'https://chatgpt.com/c/conversation-p0' });
    const runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.commands['artifact-command'].status, 'succeeded');
    const terminal = runtime.outbox.find((entry) => entry.commandId === 'artifact-command'
      && entry.messageType === ExtensionMessageType.COMMAND_RESULT);
    assert.ok(terminal);
    assert.equal(terminal.body.resultType, 'artifact.data.done');
    assert.equal(terminal.body.filePath, '/tmp/result.zip');
    assert.equal(terminal.body.downloadId, 77);
  } finally {
    h.restore();
  }
});

test('content executor cannot begin a terminal path for an effect absent from durable background state', async () => {
  const h = harness(145);
  try {
    await initialize(h);
    await assert.rejects(handleEffectBegin(h, h.state, {
      type: 'bridge.effect.begin',
      effectId: 'missing-effect',
      idempotencyKey: 'missing-effect-key',
      preconditionsHash: 'sha256:missing',
    }), /Browser effect intent rejected|effect_missing|not dispatched atomically/);
    const runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.effects['missing-effect'], undefined);
    assert.equal(runtime.outbox.some((entry) => entry.effectId === 'missing-effect'), false);
  } finally {
    h.restore();
  }
});
