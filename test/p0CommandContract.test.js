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
    assert.ok(Object.values(manifest.CommandReloadRecovery).includes(definition.reloadRecovery), `${type} reloadRecovery`);
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

async function attachReloadedContent(h, contentEpoch = `${h.state.contentEpoch}-reloaded`) {
  h.state.contentEpoch = contentEpoch;
  const attached = await h.backgroundState.transition(h.state.tabId, {
    type: 'content.attached',
    contentEpoch,
  });
  assert.equal(attached.accepted, true, attached.reason);
}

test('every standalone browser write has an explicit reload recovery class', () => {
  const manifest = globalThis.ChatGptBridgeCommandManifest;
  const expected = {
    'passive.prompt.submit': 'observation',
    'sessions.new': 'typed_uncertainty',
    'sessions.select': 'observation',
    'sessions.delete': 'typed_uncertainty',
    'browser.tab.open': 'typed_uncertainty',
    'browser.tab.close': 'typed_uncertainty',
    'browser.tab.close-owned': 'typed_uncertainty',
    'browser.tab.reload': 'content_epoch',
    'extension.reload': 'maintenance_epoch',
    'artifact.fetch': 'download_capture',
    'intelligence.apply': 'read_probe',
    'composer.attachments.clear': 'read_probe',
  };
  for (const [type, recovery] of Object.entries(expected)) {
    const definition = manifest.commandDefinition(type);
    assert.ok(definition, type);
    assert.ok(['write', 'maintenance'].includes(definition.operation), `${type} operation`);
    assert.equal(definition.reloadRecovery, recovery, `${type} reloadRecovery`);
  }
});

test('session selection is reconciled from matching conversation identity after reload', async () => {
  const h = harness(146);
  try {
    await initialize(h);
    await handleServerEnvelope({
      ...h,
      envelope: commandEnvelope('sessions.select', 'select-recovery', 1, { sessionId: 'target-session' }),
    });
    await attachReloadedContent(h);
    await handlePayload(h, null, h.state, { type: 'hello', url: 'https://chatgpt.com/c/target-session' });
    const runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.commands['select-recovery'].status, 'succeeded');
    const terminal = runtime.outbox.find((entry) => entry.commandId === 'select-recovery'
      && entry.messageType === ExtensionMessageType.COMMAND_RESULT);
    assert.equal(terminal?.body?.resultType, 'session.selected');
  } finally {
    h.restore();
  }
});

test('session deletion is not inferred from navigation to another conversation after reload', async () => {
  const h = harness(147);
  try {
    await initialize(h);
    await handleServerEnvelope({
      ...h,
      envelope: commandEnvelope('sessions.delete', 'delete-recovery', 1, {
        sessionId: 'deleted-session',
        expectedUrl: 'https://chatgpt.com/c/deleted-session',
      }),
    });
    await attachReloadedContent(h);
    await handlePayload(h, null, h.state, { type: 'hello', url: 'https://chatgpt.com/c/after-delete' });
    const runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.commands['delete-recovery'].status, 'uncertain');
    const terminal = runtime.outbox.find((entry) => entry.commandId === 'delete-recovery'
      && entry.messageType === ExtensionMessageType.COMMAND_REJECTED);
    assert.equal(terminal?.body?.code, 'COMMAND_OUTCOME_UNCERTAIN_AFTER_RELOAD');
    assert.equal(terminal?.body?.uncertain, true);
  } finally {
    h.restore();
  }
});

test('tab reload is proved only by a changed persisted content epoch', async () => {
  const h = harness(148);
  try {
    await initialize(h);
    await handleServerEnvelope({
      ...h,
      envelope: commandEnvelope('browser.tab.reload', 'tab-reload-recovery', 1, { reason: 'P0 reload recovery' }),
    });
    const before = await h.backgroundState.read(h.state.tabId);
    assert.equal(before.commands['tab-reload-recovery'].dispatchedContentEpoch, 'content-p0');
    await attachReloadedContent(h, 'content-p0-next');
    await handlePayload(h, null, h.state, { type: 'hello', url: 'https://chatgpt.com/c/reloaded' });
    const runtime = await h.backgroundState.read(h.state.tabId);
    assert.equal(runtime.commands['tab-reload-recovery'].status, 'succeeded');
    const terminal = runtime.outbox.find((entry) => entry.commandId === 'tab-reload-recovery'
      && entry.messageType === ExtensionMessageType.COMMAND_RESULT);
    assert.equal(terminal?.body?.resultType, 'browser.tab.reloaded');
    assert.equal(terminal?.body?.previousContentEpoch, 'content-p0');
    assert.equal(terminal?.body?.contentEpoch, 'content-p0-next');
  } finally {
    h.restore();
  }
});

for (const scenario of [
  { type: 'sessions.new', payload: {} },
  { type: 'browser.tab.open', payload: {} },
  { type: 'browser.tab.close', payload: {} },
  { type: 'browser.tab.close-owned', payload: {} },
]) {
  test(`${scenario.type} becomes typed uncertainty after a lost result and is never repeated`, async () => {
    const h = harness(150 + scenario.type.length);
    const commandId = `${scenario.type}-uncertain`;
    try {
      await initialize(h);
      await handleServerEnvelope({
        ...h,
        envelope: commandEnvelope(scenario.type, commandId, 1, scenario.payload),
      });
      const dispatchCount = h.posted.filter((message) => message.type === 'server.message'
        && message.payload?.commandId === commandId).length;
      assert.equal(dispatchCount, 1);
      await attachReloadedContent(h);
      await handlePayload(h, null, h.state, { type: 'hello', url: 'https://chatgpt.com/c/reloaded' });
      const runtime = await h.backgroundState.read(h.state.tabId);
      assert.equal(runtime.commands[commandId].status, 'uncertain');
      assert.equal(h.posted.filter((message) => message.type === 'server.message'
        && message.payload?.commandId === commandId).length, 1, 'write was not dispatched a second time');
      const terminal = runtime.outbox.find((entry) => entry.commandId === commandId
        && entry.messageType === ExtensionMessageType.COMMAND_REJECTED);
      assert.equal(terminal?.body?.code, 'COMMAND_OUTCOME_UNCERTAIN_AFTER_RELOAD');
      assert.equal(terminal?.body?.uncertain, true);
    } finally {
      h.restore();
    }
  });
}

for (const scenario of [
  {
    type: 'intelligence.apply',
    payload: { options: { model: 'gpt-test', effort: 'high' } },
    evidence: { model: 'gpt-test', effort: 'high' },
  },
  {
    type: 'composer.attachments.clear',
    payload: {},
    evidence: { attachmentCount: 0 },
  },
]) {
  test(`${scenario.type} uses a read probe after reload and succeeds only from explicit evidence`, async () => {
    const h = harness(190 + scenario.type.length);
    const commandId = `${scenario.type}-probe-success`;
    try {
      await initialize(h);
      await handleServerEnvelope({
        ...h,
        envelope: commandEnvelope(scenario.type, commandId, 1, scenario.payload),
      });
      await attachReloadedContent(h);
      await handlePayload(h, null, h.state, { type: 'hello', url: 'https://chatgpt.com/c/reloaded' });
      const probes = h.posted.filter((message) => message.type === 'server.message'
        && message.payload?.type === 'standalone.reconcile'
        && message.payload?.commandId === commandId);
      assert.equal(probes.length, 1);
      assert.equal(probes[0].payload.commandType, scenario.type);

      await handlePayload(h, null, h.state, {
        type: 'standalone.reconciliation',
        commandId,
        commandType: scenario.type,
        outcome: 'proved_succeeded',
        evidence: scenario.evidence,
      });
      const runtime = await h.backgroundState.read(h.state.tabId);
      assert.equal(runtime.commands[commandId].status, 'succeeded');
      const terminal = runtime.outbox.find((entry) => entry.commandId === commandId
        && entry.messageType === ExtensionMessageType.COMMAND_RESULT);
      assert.ok(terminal);
      assert.equal(h.posted.filter((message) => message.type === 'server.message'
        && message.payload?.type === scenario.type
        && message.payload?.commandId === commandId).length, 1, 'original write was not repeated');
    } finally {
      h.restore();
    }
  });

  test(`${scenario.type} becomes typed uncertainty when its read probe cannot prove success`, async () => {
    const h = harness(220 + scenario.type.length);
    const commandId = `${scenario.type}-probe-unknown`;
    try {
      await initialize(h);
      await handleServerEnvelope({
        ...h,
        envelope: commandEnvelope(scenario.type, commandId, 1, scenario.payload),
      });
      await attachReloadedContent(h);
      await handlePayload(h, null, h.state, { type: 'hello', url: 'https://chatgpt.com/c/reloaded' });
      await handlePayload(h, null, h.state, {
        type: 'standalone.reconciliation',
        commandId,
        commandType: scenario.type,
        outcome: 'unknown',
        evidence: { reason: 'dom_unavailable' },
      });
      const runtime = await h.backgroundState.read(h.state.tabId);
      assert.equal(runtime.commands[commandId].status, 'uncertain');
      const terminal = runtime.outbox.find((entry) => entry.commandId === commandId
        && entry.messageType === ExtensionMessageType.COMMAND_REJECTED);
      assert.equal(terminal?.body?.code, 'COMMAND_READ_PROBE_UNCERTAIN');
      assert.equal(h.posted.filter((message) => message.type === 'server.message'
        && message.payload?.type === scenario.type
        && message.payload?.commandId === commandId).length, 1, 'original write was not repeated');
    } finally {
      h.restore();
    }
  });
}


const standaloneWriteFixtures = Object.freeze([
  ['passive.prompt.submit', { message: 'fault boundary prompt', preconditions: { commandType: 'passive.prompt.submit', message: 'fault boundary prompt' } }],
  ['sessions.new', {}],
  ['sessions.select', { sessionId: 'conversation-target', preconditions: { commandType: 'sessions.select', conversationId: 'conversation-target' } }],
  ['sessions.delete', { sessionId: 'conversation-target', expectedUrl: 'https://chatgpt.com/c/conversation-target', preconditions: { commandType: 'sessions.delete', conversationId: 'conversation-target' } }],
  ['browser.tab.open', {}],
  ['browser.tab.close', {}],
  ['browser.tab.close-owned', {}],
  ['browser.tab.reload', {}],
  ['artifact.fetch', { artifact: { id: 'artifact-fault', name: 'fault.zip' }, preconditions: { commandType: 'artifact.fetch', artifactId: 'artifact-fault', expectedName: 'fault.zip' } }],
  ['intelligence.apply', { options: { model: 'model-fault', effort: 'high' }, preconditions: { commandType: 'intelligence.apply', model: 'model-fault', effort: 'high' } }],
  ['composer.attachments.clear', { preconditions: { commandType: 'composer.attachments.clear' } }],
]);

test('every managed standalone write proves registered-but-undispatched work did not start after reload', async () => {
  let tabId = 400;
  for (const [commandType, payload] of standaloneWriteFixtures) {
    const definition = globalThis.ChatGptBridgeCommandManifest.commandDefinition(commandType);
    if (definition.reloadRecovery === globalThis.ChatGptBridgeCommandManifest.CommandReloadRecovery.MAINTENANCE_EPOCH) continue;
    const h = harness(tabId += 1);
    try {
      await initialize(h);
      const commandId = `registered-${commandType}`;
      const registered = await h.backgroundState.transition(h.state.tabId, {
        type: 'command.registered',
        scope: 'standalone',
        commandId,
        commandType,
        mode: definition.mode,
        idempotencyKey: commandId,
        retryPolicy: definition.retryPolicy,
        reconcilePolicy: definition.reconcile,
        operation: definition.operation,
        preconditions: payload.preconditions || { commandType },
        contentEpoch: h.state.contentEpoch,
      });
      assert.equal(registered.accepted, true, `${commandType}: ${registered.reason}`);

      await handlePayload(h, null, h.state, { type: 'hello', url: 'https://chatgpt.com/c/current' });
      const runtime = await h.backgroundState.read(h.state.tabId);
      assert.equal(runtime.commands[commandId].status, 'rejected', commandType);
      const terminal = runtime.outbox.find((entry) => entry.commandId === commandId
        && entry.messageType === ExtensionMessageType.COMMAND_REJECTED);
      assert.ok(terminal, `${commandType}: missing proved-not-started terminal`);
      assert.equal(terminal.body.code, 'COMMAND_PROVED_NOT_STARTED', commandType);
      assert.equal(terminal.body.reconciliationOutcome, 'proved_not_started', commandType);
      assert.equal(terminal.body.uncertain, false, commandType);
      assert.equal(terminal.body.retryable, true, commandType);
      assert.equal(h.posted.some((message) => message.type === 'server.message'), false, `${commandType}: write must not dispatch`);
    } finally {
      h.restore();
    }
  }
});

test('durable registration failure prevents physical dispatch for every standalone write', async () => {
  let tabId = 500;
  for (const [commandType, payload] of standaloneWriteFixtures) {
    const h = harness(tabId += 1);
    try {
      await initialize(h);
      const originalTransition = h.backgroundState.transition.bind(h.backgroundState);
      const failingState = {
        read: h.backgroundState.read.bind(h.backgroundState),
        transition(id, event) {
          if (event.type === 'command.registered') throw new Error('injected registration persistence failure');
          return originalTransition(id, event);
        },
      };
      await assert.rejects(
        handleServerEnvelope({ ...h, backgroundState: failingState, envelope: commandEnvelope(commandType, `registration-fault-${commandType}`, 1, payload) }),
        /injected registration persistence failure/,
        commandType,
      );
      assert.equal(h.posted.some((message) => message.type === 'server.message'), false, `${commandType}: write dispatched before durable registration`);
      const runtime = await h.backgroundState.read(h.state.tabId);
      assert.equal(runtime.commandOrder.length, 0, commandType);
    } finally {
      h.restore();
    }
  }
});

test('duplicate physical delivery of every standalone write dispatches one logical command', async () => {
  let tabId = 600;
  for (const [commandType, payload] of standaloneWriteFixtures) {
    const h = harness(tabId += 1);
    try {
      await initialize(h);
      const envelope = commandEnvelope(commandType, `duplicate-${commandType}`, 1, payload);
      await handleServerEnvelope({ ...h, envelope });
      await handleServerEnvelope({ ...h, envelope });
      const dispatches = h.posted.filter((message) => message.type === 'server.message'
        && message.payload?.commandId === `duplicate-${commandType}`);
      assert.equal(dispatches.length, 1, commandType);
      const runtime = await h.backgroundState.read(h.state.tabId);
      assert.equal(runtime.commandOrder.filter((id) => id === `duplicate-${commandType}`).length, 1, commandType);
    } finally {
      h.restore();
    }
  }
});
