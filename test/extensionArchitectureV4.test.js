import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { ProtocolV4Adapter } from '../src/bridge/adapters/protocolV4Adapter.js';
import { isCommandResponsePayload } from '../src/bridge/coordinator/bridgeClientEventRouter.js';
import {
  ExtensionMessageKind,
  createExtensionEnvelope,
  validateExtensionEnvelope,
} from '../src/bridge/protocol/v4.js';
import {
  RequestBlocker,
  RequestEffectType,
  RequestEventType,
  SourceConnection,
  createRequestEvent,
} from '../src/bridge/state/requestEvents.js';
import { reduceRequestState } from '../src/bridge/state/requestMachine.js';
import {
  BackgroundStateStore,
  DownloadStatus,
  EffectStatus,
  LeaseStatus,
  createTabRuntimeState,
  reduceTabRuntimeState,
} from '../tools/chrome-bridge-extension/background/stateV4.js';
import { MessageKind } from '../tools/chrome-bridge-extension/background/protocolV4.js';
import { createProtocolOutbox } from '../tools/chrome-bridge-extension/background/outboxV4.js';
import { handlePayload } from '../tools/chrome-bridge-extension/background/portRouter.js';

function source(sequence, overrides = {}) {
  return {
    clientId: 'client-v4', tabId: 17, backgroundEpoch: 'background-v4', contentEpoch: 'content-v4', sequence, ...overrides,
  };
}

function transition(state, event) {
  const outcome = reduceTabRuntimeState(state, { tabId: 17, backgroundEpoch: 'background-v4', ...event });
  return outcome;
}

test('protocol 4 adapter rejects raw, duplicate, and stale messages without applying payloads', () => {
  const invalid = validateExtensionEnvelope({ type: 'hello', protocolVersion: 3 });
  assert.equal(invalid.valid, false);
  const adapter = new ProtocolV4Adapter();
  const first = createExtensionEnvelope(ExtensionMessageKind.TRANSPORT_HELLO, { type: 'hello' }, { source: source(1), messageId: 'message-1' });
  const prepared = adapter.prepare(first);
  assert.equal(prepared.accepted, true);
  assert.equal(adapter.prepare(first).accepted, true, 'uncommitted delivery must remain retryable');
  assert.equal(adapter.commit(prepared).accepted, true);
  assert.equal(adapter.ingest(first).reason, 'duplicate_message');
  const stale = createExtensionEnvelope(ExtensionMessageKind.TAB_OBSERVATION, { type: 'tab.observation' }, { source: source(1), messageId: 'message-2' });
  assert.equal(adapter.ingest(stale).reason, 'stale_sequence');
  const next = createExtensionEnvelope(ExtensionMessageKind.TAB_OBSERVATION, { type: 'tab.observation' }, { source: source(2), messageId: 'message-3' });
  assert.equal(adapter.ingest(next).accepted, true);
  const oldEpoch = createExtensionEnvelope(ExtensionMessageKind.TAB_OBSERVATION, { type: 'tab.observation' }, {
    source: source(3, { contentEpoch: 'content-old' }), messageId: 'message-old-epoch',
  });
  assert.equal(adapter.ingest(oldEpoch).reason, 'stale_content_epoch');
  const withoutHello = new ProtocolV4Adapter().ingest(next);
  assert.equal(withoutHello.reason, 'handshake_required');
});

test('background state serializes leases, idempotent effects, outbox ACKs, and terminal downloads', () => {
  let state = createTabRuntimeState(17, 'background-v4');
  let outcome = transition(state, { type: 'content.attached', contentEpoch: 'content-v4' });
  assert.equal(outcome.accepted, true); state = outcome.state;
  outcome = transition(state, { type: 'lease.claim', requestId: 'request-1', leaseId: 'lease-1', ownerServerInstanceId: 'server-1', contentEpoch: 'content-v4' });
  assert.equal(outcome.accepted, true); state = outcome.state;
  assert.equal(state.lease.status, LeaseStatus.CLAIMED);
  assert.equal(transition(state, { type: 'lease.reconciling', requestId: 'request-1', leaseId: 'lease-1', ownerServerInstanceId: 'server-1', contentEpoch: 'content-v4' }).accepted, true);
  assert.equal(transition(state, { type: 'lease.claim', requestId: 'request-2', leaseId: 'lease-2', ownerServerInstanceId: 'server-2', contentEpoch: 'content-v4' }).reason, 'lease_conflict');

  outcome = transition(state, {
    type: 'effect.planned', requestId: 'request-1', leaseId: 'lease-1', ownerServerInstanceId: 'server-1',
    effectId: 'effect-1', idempotencyKey: 'idem-1', kind: 'prompt.delivery', retryPolicy: 'never',
    preconditions: { conversationId: 'conversation-1' }, contentEpoch: 'content-v4',
  });
  assert.equal(outcome.accepted, true); state = outcome.state;
  assert.equal(state.effects['effect-1'].retryPolicy, 'never');
  assert.deepEqual(state.effects['effect-1'].preconditions, { conversationId: 'conversation-1' });
  assert.equal(transition(state, {
    type: 'effect.succeeded', requestId: 'request-1', leaseId: 'lease-1', ownerServerInstanceId: 'server-1',
    effectId: 'effect-1', idempotencyKey: 'idem-1', contentEpoch: 'content-v4',
  }).reason, 'effect_transition_invalid');
  outcome = transition(state, {
    type: 'effect.dispatched', requestId: 'request-1', leaseId: 'lease-1', ownerServerInstanceId: 'server-1',
    effectId: 'effect-1', idempotencyKey: 'idem-1', contentEpoch: 'content-v4',
  });
  assert.equal(outcome.accepted, true); state = outcome.state;
  outcome = transition(state, {
    type: 'effect.succeeded', requestId: 'request-1', leaseId: 'lease-1', ownerServerInstanceId: 'server-1',
    effectId: 'effect-1', idempotencyKey: 'idem-1', contentEpoch: 'content-v4',
  });
  assert.equal(outcome.accepted, true); state = outcome.state;
  assert.equal(state.effects['effect-1'].status, EffectStatus.SUCCEEDED);
  outcome = transition(state, { type: 'effect.reported', effectId: 'effect-1', contentEpoch: 'content-v4' });
  assert.equal(outcome.accepted, true); state = outcome.state;
  assert.ok(state.effects['effect-1'].reportedAt > 0);
  assert.equal(transition(state, {
    type: 'effect.succeeded', requestId: 'request-1', leaseId: 'lease-1', ownerServerInstanceId: 'server-1',
    effectId: 'effect-1', idempotencyKey: 'idem-1', contentEpoch: 'content-v4',
  }).reason, 'effect_terminal');

  const envelope = createExtensionEnvelope(ExtensionMessageKind.EFFECT_RESULT, { type: 'request.effect.succeeded' }, { source: source(2), messageId: 'critical-1' });
  outcome = transition(state, { type: 'outbox.enqueued', envelope, contentEpoch: 'content-v4' });
  assert.equal(outcome.accepted, true); state = outcome.state;
  outcome = transition(state, { type: 'transport.ack_rejected', messageId: 'critical-1', reason: 'canonical_commit_failed', contentEpoch: 'content-v4' });
  assert.equal(outcome.accepted, true); state = outcome.state;
  assert.equal(state.outbox.length, 1);
  assert.equal(state.transport.rejectedAckCount, 1);
  assert.equal(state.transport.lastRejectedAck.reason, 'canonical_commit_failed');
  const replayEnvelope = { ...envelope, source: { ...envelope.source, sequence: 3 } };
  outcome = transition(state, { type: 'outbox.resequenced', envelope: replayEnvelope, contentEpoch: 'content-v4' });
  assert.equal(outcome.accepted, true); state = outcome.state;
  assert.equal(state.outbox[0].source.sequence, 3);
  outcome = transition(state, { type: 'outbox.acknowledged', messageId: 'critical-1', sequence: 2, contentEpoch: 'content-v4' });
  assert.equal(outcome.accepted, true); state = outcome.state;
  assert.equal(state.outbox.length, 0);

  for (const status of [DownloadStatus.PLANNED, DownloadStatus.ARMED, DownloadStatus.BOUND, DownloadStatus.COMPLETED]) {
    outcome = transition(state, { type: 'download.transition', captureId: 'capture-1', status, contentEpoch: 'content-v4' });
    assert.equal(outcome.accepted, true); state = outcome.state;
  }
  assert.equal(transition(state, { type: 'download.transition', captureId: 'capture-1', status: DownloadStatus.RELEASED, contentEpoch: 'content-v4' }).reason, 'download_terminal');
  assert.equal(transition(state, { type: 'download.transition', captureId: 'capture-2', status: DownloadStatus.BOUND, contentEpoch: 'content-v4' }).reason, 'download_transition_invalid');
  outcome = transition(state, {
    type: 'command.registered', scope: 'standalone', commandId: 'command-1', commandType: 'models.list', causationId: 'server-message-1',
    idempotencyKey: 'command-1', retryPolicy: 'never',
    preconditions: { commandType: 'models.list' }, contentEpoch: 'content-v4',
  });
  assert.equal(outcome.accepted, true); state = outcome.state;
  assert.equal(state.commands['command-1'].idempotencyKey, 'command-1');
  assert.equal(state.commands['command-1'].retryPolicy, 'never');
  assert.deepEqual(state.commands['command-1'].preconditions, { commandType: 'models.list' });
  assert.equal(isCommandResponsePayload({ type: 'command.accepted', commandId: 'command-1' }), false);
  assert.equal(isCommandResponsePayload({ type: 'command.result', commandId: 'command-1' }), true);
});

test('background store restores a lease as reconciling under a new content epoch', async () => {
  const values = new Map();
  const storage = {
    async get(key) { return { [key]: values.get(key) }; },
    async set(patch) { for (const [key, value] of Object.entries(patch)) values.set(key, value); },
    async remove(key) { values.delete(key); },
  };
  const first = new BackgroundStateStore(storage, 'background-v4');
  await first.transition(17, { type: 'content.attached', contentEpoch: 'content-a' });
  await first.transition(17, { type: 'lease.claim', requestId: 'request-1', leaseId: 'lease-1', ownerServerInstanceId: 'server-1', contentEpoch: 'content-a' });
  const restarted = new BackgroundStateStore(storage, 'background-v4-restarted');
  const attached = await restarted.transition(17, { type: 'content.attached', contentEpoch: 'content-b' });
  assert.equal(attached.accepted, true);
  assert.equal(attached.state.lease.status, LeaseStatus.RECONCILING);
  assert.equal(attached.state.lease.contentEpoch, 'content-b');
});

test('background store allocates concurrent source sequences atomically', async () => {
  const values = new Map();
  const storage = {
    async get(key) { return { [key]: values.get(key) }; },
    async set(patch) { for (const [key, value] of Object.entries(patch)) values.set(key, value); },
  };
  const store = new BackgroundStateStore(storage, 'background-v4');
  await store.transition(17, { type: 'content.attached', contentEpoch: 'content-v4' });
  const outcomes = await Promise.all(Array.from({ length: 25 }, () => store.transition(17, {
    type: 'transport.outbound.next', contentEpoch: 'content-v4',
  })));
  assert.equal(outcomes.every((outcome) => outcome.accepted), true);
  assert.deepEqual(outcomes.map((outcome) => outcome.state.transport.outboundSequence), Array.from({ length: 25 }, (_, index) => index + 1));
  assert.equal((await store.read(17)).transport.outboundSequence, 25);
});

test('content execution store exposes a reducer-backed handle instead of shared mutable request state', async () => {
  const [requestStateCode, executionCode] = await Promise.all([
    fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestState.js'), 'utf8'),
    fs.readFile(path.resolve('tools/chrome-bridge-extension/content/executionState.js'), 'utf8'),
  ]);
  const context = { console, MutationObserver: class MutationObserver {} };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(requestStateCode, context);
  vm.runInContext(executionCode, context);
  const store = context.ChatGptRequestExecutionState.createRequestExecutionStore({
    recoverRequest: context.ChatGptRequestState.recoverRequestState,
  });
  const original = { requestId: 'request-1', phase: 'created' };
  assert.equal(store.setCurrent(original).accepted, true);
  const handle = store.getCurrent();
  handle.update('request.executor_updated', { phase: 'executing' });
  handle.update('request.anchor_updated', { pendingSubmittedTurnBaseline: new Set(['turn-before-reload']) });
  assert.deepEqual([...handle.pendingSubmittedTurnBaseline], ['turn-before-reload']);
  assert.throws(() => { handle.pendingSubmittedTurnBaseline = new Set(['forbidden']); }, TypeError);
  assert.throws(() => { handle.unknownLifecycleField = 'corrupted-directly'; }, TypeError);
  original.phase = 'corrupted-outside-store';
  assert.equal(handle.phase, 'executing');
  assert.equal(store.getSnapshot().revision, 3);
  assert.equal(store.setCurrent(null).accepted, true);
  assert.equal(store.getCurrent(), null);
});

test('content recovery preserves matching request evidence and rejects conflicting ownership', async () => {
  const [requestStateCode, executionCode] = await Promise.all([
    fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestState.js'), 'utf8'),
    fs.readFile(path.resolve('tools/chrome-bridge-extension/content/executionState.js'), 'utf8'),
  ]);
  const context = { console, MutationObserver: class MutationObserver {} };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(requestStateCode, context);
  vm.runInContext(executionCode, context);
  const store = context.ChatGptRequestExecutionState.createRequestExecutionStore({
    recoverRequest: context.ChatGptRequestState.recoverRequestState,
  });
  store.setCurrent({
    requestId: 'request-1',
    phase: 'waiting',
    submittedUserTurnKey: 'user-1',
    assistantTurnKey: 'assistant-1',
    lastAnswer: 'legacy fragment must not survive',
    artifacts: [{ id: 'legacy-artifact' }],
  });
  const recovered = store.recover({
    lease: { requestId: 'request-1', leaseId: 'lease-2', ownerServerInstanceId: 'server-1' },
    effects: [{ effectId: 'effect-1' }],
  });
  assert.equal(recovered.accepted, true);
  assert.equal(store.getCurrent().submittedUserTurnKey, 'user-1');
  assert.equal(store.getCurrent().assistantTurnKey, 'assistant-1');
  assert.equal(store.getCurrent().lastAnswer, undefined);
  assert.equal(store.getCurrent().artifacts, undefined);
  assert.equal(store.getSnapshot().lifecycle, 'reconciling');
  const conflict = store.recover({ lease: { requestId: 'request-2', leaseId: 'lease-3', ownerServerInstanceId: 'server-2' } });
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.reason, 'request_conflict');
  assert.equal(store.getCurrent().requestId, 'request-1');
  assert.equal(store.getSnapshot().journal.at(-1).accepted, false);
});


test('content reload hydrates a complete request projection before the protocol hello is serialized', async () => {
  const [requestStateCode, executionCode] = await Promise.all([
    fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestState.js'), 'utf8'),
    fs.readFile(path.resolve('tools/chrome-bridge-extension/content/executionState.js'), 'utf8'),
  ]);
  const context = { console, MutationObserver: class MutationObserver {} };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(requestStateCode, context);
  vm.runInContext(executionCode, context);
  const store = context.ChatGptRequestExecutionState.createRequestExecutionStore({
    recoverRequest: context.ChatGptRequestState.recoverRequestState,
  });
  const recovered = store.recover({
    lease: {
      requestId: 'request-reload',
      leaseId: 'lease-reload',
      ownerServerInstanceId: 'server-reload',
      claimedAt: 123,
    },
    effects: [{ effectId: 'page-ready' }],
  });
  assert.equal(recovered.accepted, true);
  const request = store.getCurrent();
  assert.equal(request.phase, 'reconciling');
  assert.equal(request.lastAnswer, undefined);
  assert.equal(request.lastThinking, undefined);
  assert.equal(request.artifacts, undefined);
  assert.deepEqual(Array.from(request.baselineTurnKeys), []);
  const status = context.ChatGptRequestState.publicRequestStatus(request, {
    generating: false,
    stopButtonVisible: false,
    url: 'https://chatgpt.com/c/reload',
    title: 'Reloaded chat',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(status)), {
    requestId: 'request-reload',
    leaseId: 'lease-reload',
    ownerServerInstanceId: 'server-reload',
    responseEpoch: 0,
    startedAt: 123,
    sentAt: 0,
    submittedUserTurnKey: '',
    submittedUserTurnIndex: -1,
    assistantTurnKey: '',
    assistantTurnIndex: -1,
    url: 'https://chatgpt.com/c/reload',
    title: 'Reloaded chat',
  });
});

test('uncertain browser effects enter canonical reconciliation and produce a recovery deadline', () => {
  let outcome = reduceRequestState(null, createRequestEvent(RequestEventType.CREATED, 'request-1', {}, { occurredAt: 1 }));
  outcome = reduceRequestState(outcome.state, createRequestEvent(RequestEventType.SOURCE_BOUND, 'request-1', { sourceClientId: 'client-v4' }, { occurredAt: 2 }));
  outcome = reduceRequestState(outcome.state, createRequestEvent(RequestEventType.EFFECT_STARTED, 'request-1', { effectId: 'effect-1', effectType: 'prompt.delivery' }, { occurredAt: 3 }));
  outcome = reduceRequestState(outcome.state, createRequestEvent(RequestEventType.EFFECT_UNCERTAIN, 'request-1', {
    effectId: 'effect-1', idempotencyKey: 'idem-1', message: 'content reloaded', recoveryTimeoutMs: 5_000,
  }, { occurredAt: 4 }));
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.state.source.connection, SourceConnection.RECONCILING);
  assert.equal(outcome.state.blocker, RequestBlocker.RECOVERY);
  assert.equal(outcome.effects[0].type, RequestEffectType.EFFECT_RECONCILE);
  assert.equal(outcome.deadlines[0].kind, 'recovery');
});

test('content request projection rejects direct mutation and legacy lifecycle fields', async () => {
  const contentRoot = path.resolve('tools/chrome-bridge-extension/content');
  const files = [];
  async function collect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(resolved);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(resolved);
    }
  }
  await collect(contentRoot);
  const directMutation = /\b(?:request|activeRequest)\.[A-Za-z_$][\w$]*\s*=(?!=)/;
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    const relative = path.relative(process.cwd(), file);
    assert.doesNotMatch(source, directMutation, `direct request projection write in ${relative}`);
  }
  const [requestState, executionState] = await Promise.all([
    fs.readFile(path.join(contentRoot, 'requestState.js'), 'utf8'),
    fs.readFile(path.join(contentRoot, 'executionState.js'), 'utf8'),
  ]);
  assert.doesNotMatch(requestState, /lastAnswer|lastThinking|lastProgressText|reasoningHistory|terminalCandidate|sawGenerating|sawAnswer/);
  assert.doesNotMatch(executionState, /request\.patched|parser_cache_updated/);
  assert.doesNotMatch(executionState, /new Proxy\s*\(/);
  assert.match(executionState, /Object\.freeze\(view\)/);
});

test('browser writes are confined to explicit executor adapters', async () => {
  const contentRoot = path.resolve('tools/chrome-bridge-extension/content');
  const contentWriteAdapters = new Set([
    'artifactPreview.js',
    'artifactTransfer.js',
    'attachmentCommands.js',
    'composerCommands.js',
    'intelligenceCommands.js',
    'sessionCommands.js',
  ]);
  const contentFiles = await fs.readdir(contentRoot, { withFileTypes: true });
  const browserWrite = /\.(?:click|requestSubmit)\s*\(|dispatchEvent\s*\(/;
  for (const entry of contentFiles) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const source = await fs.readFile(path.join(contentRoot, entry.name), 'utf8');
    if (!browserWrite.test(source)) continue;
    assert.equal(contentWriteAdapters.has(entry.name), true, `browser write outside executor adapter: ${entry.name}`);
  }

  const extensionRoot = path.resolve('tools/chrome-bridge-extension');
  const privilegedWriteAdapters = new Set([
    path.join('background', 'downloadCoordinator.js'),
    path.join('background', 'tabController.js'),
  ]);
  const privilegedFiles = [];
  async function collect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(resolved);
      else if (entry.isFile() && entry.name.endsWith('.js')) privilegedFiles.push(resolved);
    }
  }
  await collect(extensionRoot);
  const privilegedWrite = /chrome\.(?:tabs\.(?:create|update|remove|reload)|downloads\.download)\s*\(/;
  for (const file of privilegedFiles) {
    const source = await fs.readFile(file, 'utf8');
    if (!privilegedWrite.test(source)) continue;
    const relative = path.relative(extensionRoot, file);
    assert.equal(privilegedWriteAdapters.has(relative), true, `privileged browser write outside adapter: ${relative}`);
  }
});

test('extension source contains one protocol and one DOM observation owner', async () => {
  const files = await Promise.all([
    'tools/chrome-bridge-extension/background.js',
    'tools/chrome-bridge-extension/content.js',
    'tools/chrome-bridge-extension/content/requestMonitor.js',
    'tools/chrome-bridge-extension/content/pageRuntimeObservers.js',
  ].map((file) => fs.readFile(path.resolve(file), 'utf8')));
  const [background, content, requestMonitor, passive] = files;
  assert.doesNotMatch(`${background}\n${content}`, /protocolVersion\s*:\s*3|EXTENSION_PROTOCOL_VERSION\s*=\s*3/);
  assert.doesNotMatch(content, /let\s+activeRequest\s*=/);
  assert.doesNotMatch(requestMonitor, /new\s+MutationObserver/);
  assert.doesNotMatch(passive, /new\s+MutationObserver/);
  assert.ok(background.trimEnd().split('\n').length <= 1_000);
  assert.ok(content.trimEnd().split('\n').length <= 1_000);
});

test('background sends protocol hello before replaying persisted critical messages', async () => {
  const router = await fs.readFile(path.resolve('tools/chrome-bridge-extension/background/portRouter.js'), 'utf8');
  const helloBranch = router.indexOf("if (payload.type === 'hello')");
  const send = router.indexOf('await sendProtocolPayload(state, outboundPayload, settledCommand ? protocolOptionsForCommand(settledCommand) : {});');
  const replay = router.indexOf('await deps.replayCriticalOutbox(state);');
  assert.ok(send >= 0 && helloBranch > send && replay > helloBranch);
  const background = await fs.readFile(path.resolve('tools/chrome-bridge-extension/background.js'), 'utf8');
  const socketOpen = background.slice(background.indexOf("ws.addEventListener('open'"), background.indexOf("ws.addEventListener('message'"));
  assert.doesNotMatch(socketOpen, /replayCriticalOutbox/);
  assert.match(router, /payload\.type !== 'hello' && !state\.protocolReady/);
  assert.ok(router.indexOf('state.protocolReady = true;') > replay);
  assert.match(router, /payload\.type === 'request\.release\.completed'/);
  assert.match(router, /lease:\s*releaseLease/);
  const commandRouter = await fs.readFile(path.resolve('tools/chrome-bridge-extension/background/serverEnvelopeRouter.js'), 'utf8');
  assert.match(commandRouter, /kind:\s*MessageKind\.COMMAND_ACCEPTED/);
  assert.match(commandRouter, /kind:\s*MessageKind\.COMMAND_REJECTED/);
  assert.match(commandRouter, /causationId:\s*envelope\.messageId/);
  assert.match(commandRouter, /lease:\s*envelope\.request/);
});

test('release completion preserves command lease identity after clearing persisted browser ownership', async () => {
  const values = new Map();
  const storage = {
    async get(key) { return { [key]: values.get(key) }; },
    async set(patch) { for (const [key, value] of Object.entries(patch)) values.set(key, value); },
  };
  const backgroundState = new BackgroundStateStore(storage, 'background-release');
  const tabId = 17;
  const contentEpoch = 'content-release';
  const lease = { requestId: 'request-release', leaseId: 'lease-release', ownerServerInstanceId: 'server-release' };
  await backgroundState.transition(tabId, { type: 'content.attached', contentEpoch });
  await backgroundState.transition(tabId, { type: 'lease.claim', ...lease, contentEpoch });
  await backgroundState.transition(tabId, { type: 'lease.releasing', ...lease, contentEpoch });

  const sent = [];
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = { OPEN: 1 };
  try {
    const state = {
      tabId,
      clientId: 'client-release',
      contentEpoch,
      protocolReady: true,
      preHelloPayloads: [],
      ws: { readyState: 1, send(value) { sent.push(JSON.parse(value)); } },
    };
    const outbox = createProtocolOutbox({
      backgroundEpoch: 'background-release',
      backgroundState,
      post() {},
      summarize: (payload) => payload,
    });
    const deps = {
      backgroundState,
      post() {},
      sendProtocolPayload: outbox.sendProtocolPayload,
      replayCriticalOutbox: outbox.replayCriticalOutbox,
    };

    await handlePayload(deps, null, state, {
      type: 'diagnostic', name: 'request.released', requestId: lease.requestId,
    });
    assert.equal((await backgroundState.read(tabId)).lease.status, LeaseStatus.RELEASING);

    await handlePayload(deps, null, state, {
      type: 'request.release.completed',
      commandId: 'release-command',
      ...lease,
      released: true,
    });

    assert.equal((await backgroundState.read(tabId)).lease, null);
    const result = sent.find((envelope) => envelope.payload?.commandId === 'release-command');
    assert.ok(result);
    assert.equal(result.kind, MessageKind.COMMAND_RESULT);
    assert.deepEqual(result.request, { ...lease, responseEpoch: 0 });
    assert.equal(result.payload.activeRequest, null);
  } finally {
    if (previousWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previousWebSocket;
  }
});

test('background outbox coalesces replaceable observations and records bounded pressure metrics', () => {
  let state = createTabRuntimeState(17, 'background-v4');
  state = transition(state, { type: 'content.attached', contentEpoch: 'content-v4' }).state;
  const first = createExtensionEnvelope(ExtensionMessageKind.TAB_OBSERVATION, { type: 'tab.observation', revision: 1 }, {
    source: source(10), messageId: 'observation-1',
  });
  const second = createExtensionEnvelope(ExtensionMessageKind.TAB_OBSERVATION, { type: 'tab.observation', revision: 2 }, {
    source: source(11), messageId: 'observation-2',
  });
  state = transition(state, { type: 'outbox.enqueued', envelope: first, contentEpoch: 'content-v4' }).state;
  state = transition(state, { type: 'outbox.enqueued', envelope: second, contentEpoch: 'content-v4' }).state;
  assert.equal(state.outbox.length, 1);
  assert.equal(state.outbox[0].messageId, 'observation-2');
  assert.equal(state.metrics.observationCoalesced, 1);
  assert.equal(state.metrics.outboxHighWater, 1);
});

test('tab operation queue is linearizable per tab while allowing independent tabs to run concurrently', async () => {
  const { TabOperationQueue } = await import('../tools/chrome-bridge-extension/background/tabOperationQueue.js');
  const queue = new TabOperationQueue({ maxPending: 10 });
  const order = [];
  let releaseFirst;
  let releaseOther;
  const first = queue.run(17, async () => {
    order.push('tab17:first:start');
    await new Promise((resolve) => { releaseFirst = resolve; });
    order.push('tab17:first:end');
  });
  const second = queue.run(17, async () => { order.push('tab17:second'); });
  const other = queue.run(18, async () => {
    order.push('tab18:start');
    await new Promise((resolve) => { releaseOther = resolve; });
    order.push('tab18:end');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['tab17:first:start', 'tab18:start']);
  releaseFirst();
  await second;
  assert.deepEqual(order.slice(0, 4), ['tab17:first:start', 'tab18:start', 'tab17:first:end', 'tab17:second']);
  releaseOther();
  await Promise.all([first, other]);
});

test('released leases reject every later command or browser effect transition', () => {
  let state = createTabRuntimeState(17, 'background-v4');
  state = transition(state, { type: 'content.attached', contentEpoch: 'content-v4' }).state;
  const lease = { requestId: 'request-release-guard', leaseId: 'lease-release-guard', ownerServerInstanceId: 'server-release-guard' };
  state = transition(state, { type: 'lease.claim', ...lease, contentEpoch: 'content-v4' }).state;
  state = transition(state, { type: 'lease.releasing', ...lease, contentEpoch: 'content-v4' }).state;
  state = transition(state, { type: 'lease.release', ...lease, contentEpoch: 'content-v4' }).state;
  assert.equal(transition(state, {
    type: 'command.registered', commandId: 'late-command', commandType: 'prompt.send',
    idempotencyKey: 'late-command', ...lease, contentEpoch: 'content-v4',
  }).reason, 'lease_mismatch');
  assert.equal(transition(state, {
    type: 'effect.planned', effectId: 'late-effect', kind: 'prompt.submit', idempotencyKey: 'late-effect',
    ...lease, contentEpoch: 'content-v4',
  }).reason, 'lease_mismatch');
});

test('tab operation queue rejects overflow and exposes high-water diagnostics', async () => {
  const { TabOperationQueue } = await import('../tools/chrome-bridge-extension/background/tabOperationQueue.js');
  const queue = new TabOperationQueue({ maxPending: 1 });
  let release;
  const first = queue.run(17, () => new Promise((resolve) => { release = resolve; }), { label: 'first' });
  await assert.rejects(
    queue.run(17, async () => {}, { label: 'second' }),
    (error) => error?.code === 'TAB_OPERATION_QUEUE_FULL' && error.queueMetrics?.rejected === 1,
  );
  assert.deepEqual(queue.metrics(17), {
    pending: 1, queued: 0, running: true, highWater: 1, rejected: 1, cancelled: 0,
    limit: 1, reservedCritical: 8, byPriority: { 20: 1 },
  });
  release();
  await first;
  assert.equal(queue.metrics(17).pending, 0);
});

test('browser effect reconciliation clears recovery only with typed proof and never replays a write', () => {
  const buildUncertain = () => {
    let outcome = reduceRequestState(null, createRequestEvent(RequestEventType.CREATED, 'request-reconcile', {}, { occurredAt: 1 }));
    outcome = reduceRequestState(outcome.state, createRequestEvent(RequestEventType.SOURCE_BOUND, 'request-reconcile', { sourceClientId: 'client-v4' }, { occurredAt: 2 }));
    outcome = reduceRequestState(outcome.state, createRequestEvent(RequestEventType.EFFECT_STARTED, 'request-reconcile', { effectId: 'effect-prompt', effectType: 'prompt.delivery' }, { occurredAt: 3 }));
    return reduceRequestState(outcome.state, createRequestEvent(RequestEventType.EFFECT_UNCERTAIN, 'request-reconcile', {
      effectId: 'effect-prompt', effectType: 'prompt.delivery', idempotencyKey: 'idem-prompt', retryPolicy: 'if_unconfirmed',
    }, { occurredAt: 4 })).state;
  };

  const succeeded = reduceRequestState(buildUncertain(), createRequestEvent(RequestEventType.EFFECT_RECONCILED, 'request-reconcile', {
    originalEffectId: 'effect-prompt', effectType: 'prompt.delivery', outcome: 'succeeded', evidence: { promptBoundaryFound: true },
  }, { occurredAt: 5 }));
  assert.equal(succeeded.accepted, true);
  assert.equal(succeeded.state.source.connection, SourceConnection.CONNECTED);
  assert.equal(succeeded.state.blocker, RequestBlocker.NONE);
  assert.equal(succeeded.effects.length, 0);

  const notStarted = reduceRequestState(buildUncertain(), createRequestEvent(RequestEventType.EFFECT_RECONCILED, 'request-reconcile', {
    originalEffectId: 'effect-prompt', effectType: 'prompt.delivery', outcome: 'not_started', evidence: { promptBoundaryFound: false },
  }, { occurredAt: 5 }));
  assert.equal(notStarted.accepted, true);
  assert.equal(notStarted.state.lifecycle, 'failed');
  assert.equal(notStarted.state.terminal.evidence.recoverable, true);
  assert.equal(notStarted.state.terminal.evidence.safeToRetryAsNewRequest, true);
  assert.equal(notStarted.effects.some((effect) => effect.type === RequestEffectType.EFFECT_RECONCILE), false);

  const failed = reduceRequestState(buildUncertain(), createRequestEvent(RequestEventType.EFFECT_RECONCILED, 'request-reconcile', {
    originalEffectId: 'effect-prompt', effectType: 'prompt.delivery', outcome: 'failed', evidence: { errorCode: 'UPLOAD_FAILED' },
  }, { occurredAt: 5 }));
  assert.equal(failed.accepted, true);
  assert.equal(failed.state.lifecycle, 'failed');
  assert.equal(failed.state.terminal.code, 'effect_failed');
  assert.equal(failed.effects.some((effect) => effect.type === RequestEffectType.EFFECT_RECONCILE), false);

  const uncertain = reduceRequestState(buildUncertain(), createRequestEvent(RequestEventType.EFFECT_RECONCILED, 'request-reconcile', {
    originalEffectId: 'effect-prompt', effectType: 'prompt.delivery', outcome: 'uncertain',
  }, { occurredAt: 5 }));
  assert.equal(uncertain.accepted, true);
  assert.notEqual(uncertain.state.lifecycle, 'failed');
  assert.equal(uncertain.state.blocker, RequestBlocker.RECOVERY);
  assert.equal(uncertain.effects.length, 0);
});

test('background state persistence fails closed and leaves the committed in-memory revision unchanged', async () => {
  const values = {};
  let failWrites = false;
  const storage = {
    async get(key) {
      if (key === null) return { ...values };
      return { [key]: values[key] };
    },
    async set(patch) {
      if (failWrites) throw new Error('storage unavailable');
      Object.assign(values, structuredClone(patch));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
  const store = new BackgroundStateStore(storage, 'background-persist');
  await store.transition(31, { type: 'content.attached', contentEpoch: 'content-a' });
  const committed = await store.read(31);
  failWrites = true;
  await assert.rejects(
    store.transition(31, {
      type: 'lease.claim',
      requestId: 'request-a',
      leaseId: 'lease-a',
      ownerServerInstanceId: 'server-a',
      contentEpoch: 'content-a',
    }),
    (error) => error?.code === 'BACKGROUND_STATE_PERSIST_FAILED' && error?.eventType === 'lease.claim',
  );
  const after = await store.read(31);
  assert.equal(after.revision, committed.revision);
  assert.equal(after.lease, null);
});


test('background state refuses to authorize transitions without durable session storage', async () => {
  const store = new BackgroundStateStore(null, 'background-no-storage');
  await assert.rejects(
    store.transition(32, { type: 'content.attached', contentEpoch: 'content-a' }),
    (error) => error?.code === 'BACKGROUND_STATE_READ_UNAVAILABLE',
  );
});


test('background state refuses to replace missing persisted state when session storage reads fail', async () => {
  const store = new BackgroundStateStore({
    async get() { throw new Error('read unavailable'); },
    async set() { throw new Error('must not write'); },
    async remove() {},
  }, 'background-read-failure');
  await assert.rejects(
    store.transition(33, { type: 'content.attached', contentEpoch: 'content-a' }),
    (error) => error?.code === 'BACKGROUND_STATE_READ_FAILED',
  );
});

test('legacy background state is removed only after current and legacy tab states are confirmed idle', async () => {
  const currentKey = 'chatgptBridgeV5:tab:31';
  const values = {
    'chatgptBridgeV4:tab:30': { ...createTabRuntimeState(30, 'background-cleanup'), schemaVersion: 4 },
    'chatgptBridgeV3:tab:1': { legacy: true },
    'chatgptBridgeV2:runtime': { legacy: true },
    [currentKey]: createTabRuntimeState(31, 'background-cleanup'),
  };
  const storage = {
    async get(key) {
      if (key === null) return structuredClone(values);
      return { [key]: structuredClone(values[key]) };
    },
    async set(patch) { Object.assign(values, structuredClone(patch)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
  };
  const store = new BackgroundStateStore(storage, 'background-cleanup');
  const cleaned = await store.cleanupLegacyStateIfIdle();
  assert.deepEqual(cleaned.removed.sort(), [
    'chatgptBridgeV2:runtime',
    'chatgptBridgeV3:tab:1',
    'chatgptBridgeV4:tab:30',
  ]);
  assert.equal(values['chatgptBridgeV4:tab:30'], undefined);

  values['chatgptBridgeV4:tab:32'] = {
    ...createTabRuntimeState(32, 'background-cleanup'),
    schemaVersion: 4,
    lease: { requestId: 'r', leaseId: 'l', ownerServerInstanceId: 's', status: LeaseStatus.CLAIMED },
  };
  const blocked = await store.cleanupLegacyStateIfIdle();
  assert.equal(blocked.reason, 'active_background_state');
  assert.ok(values['chatgptBridgeV4:tab:32']);
});
