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
  assert.equal(adapter.ingest(first).accepted, true);
  assert.equal(adapter.ingest(first).reason, 'duplicate_message');
  const stale = createExtensionEnvelope(ExtensionMessageKind.REQUEST_OBSERVATION, { type: 'tab.observation' }, { source: source(1), messageId: 'message-2' });
  assert.equal(adapter.ingest(stale).reason, 'stale_sequence');
  const next = createExtensionEnvelope(ExtensionMessageKind.REQUEST_OBSERVATION, { type: 'tab.observation' }, { source: source(2), messageId: 'message-3' });
  assert.equal(adapter.ingest(next).accepted, true);
  const oldEpoch = createExtensionEnvelope(ExtensionMessageKind.REQUEST_OBSERVATION, { type: 'tab.observation' }, {
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
  outcome = transition(state, { type: 'outbox.acknowledged', messageId: 'critical-1', sequence: 2, contentEpoch: 'content-v4' });
  assert.equal(outcome.accepted, true); state = outcome.state;
  assert.equal(state.outbox.length, 0);

  for (const status of [DownloadStatus.PLANNED, DownloadStatus.ARMED, DownloadStatus.BOUND, DownloadStatus.COMPLETED]) {
    outcome = transition(state, { type: 'download.transition', captureId: 'capture-1', status, contentEpoch: 'content-v4' });
    assert.equal(outcome.accepted, true); state = outcome.state;
  }
  assert.equal(transition(state, { type: 'download.transition', captureId: 'capture-1', status: DownloadStatus.RELEASED, contentEpoch: 'content-v4' }).reason, 'download_terminal');
  assert.equal(transition(state, { type: 'download.transition', captureId: 'capture-2', status: DownloadStatus.BOUND, contentEpoch: 'content-v4' }).reason, 'download_transition_invalid');
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

test('content execution store exposes a reducer-backed handle instead of shared mutable request state', async () => {
  const code = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/executionState.js'), 'utf8');
  const context = { console, MutationObserver: class MutationObserver {} };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(code, context);
  const store = context.ChatGptRequestExecutionState.createRequestExecutionStore();
  const original = { requestId: 'request-1', phase: 'created', artifacts: [] };
  assert.equal(store.setCurrent(original).accepted, true);
  const handle = store.getCurrent();
  handle.phase = 'executing';
  original.phase = 'corrupted-outside-store';
  assert.equal(handle.phase, 'executing');
  assert.equal(store.getSnapshot().revision, 2);
  assert.equal(store.setCurrent(null).accepted, true);
  assert.equal(store.getCurrent(), null);
});

test('content recovery preserves matching request evidence and rejects conflicting ownership', async () => {
  const code = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/executionState.js'), 'utf8');
  const context = { console, MutationObserver: class MutationObserver {} };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(code, context);
  const store = context.ChatGptRequestExecutionState.createRequestExecutionStore();
  store.setCurrent({ requestId: 'request-1', phase: 'waiting', lastAnswer: 'preserve me', artifacts: [{ id: 'artifact-1' }] });
  const recovered = store.recover({
    lease: { requestId: 'request-1', leaseId: 'lease-2', ownerServerInstanceId: 'server-1' },
    effects: [{ effectId: 'effect-1' }],
  });
  assert.equal(recovered.accepted, true);
  assert.equal(store.getCurrent().lastAnswer, 'preserve me');
  assert.equal(store.getCurrent().artifacts[0].id, 'artifact-1');
  assert.equal(store.getSnapshot().lifecycle, 'reconciling');
  const conflict = store.recover({ lease: { requestId: 'request-2', leaseId: 'lease-3', ownerServerInstanceId: 'server-2' } });
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.reason, 'request_conflict');
  assert.equal(store.getCurrent().requestId, 'request-1');
  assert.equal(store.getSnapshot().journal.at(-1).accepted, false);
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
  const send = router.indexOf('await sendProtocolPayload(state, payload);');
  const replay = router.indexOf('await deps.replayCriticalOutbox(state);');
  assert.ok(send >= 0 && helloBranch > send && replay > helloBranch);
  const background = await fs.readFile(path.resolve('tools/chrome-bridge-extension/background.js'), 'utf8');
  const socketOpen = background.slice(background.indexOf("ws.addEventListener('open'"), background.indexOf("ws.addEventListener('message'"));
  assert.doesNotMatch(socketOpen, /replayCriticalOutbox/);
});
