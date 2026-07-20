import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BackgroundStateStore,
  DownloadStatus,
} from '../tools/chrome-bridge-extension/background/stateV4.js';
import { createExtensionEnvelope, ExtensionMessageKind } from '../src/bridge/protocol/v4.js';

function memoryStorage() {
  const values = {};
  let failNextSet = false;
  return {
    values,
    failNext() { failNextSet = true; },
    async get(key) {
      if (key === null) return structuredClone(values);
      return { [key]: structuredClone(values[key]) };
    },
    async set(patch) {
      if (failNextSet) {
        failNextSet = false;
        throw new Error('injected storage failure');
      }
      Object.assign(values, structuredClone(patch));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}

const lease = {
  requestId: 'request-fault',
  leaseId: 'lease-fault',
  ownerServerInstanceId: 'server-fault',
  responseEpoch: 0,
  contentEpoch: 'content-fault',
};

const envelope = createExtensionEnvelope(ExtensionMessageKind.EFFECT_RESULT, {
  type: 'request.effect.succeeded',
  requestId: lease.requestId,
  effectId: 'effect-fault',
}, {
  messageId: 'outbox-fault',
  source: {
    clientId: 'client-fault', tabId: 41, backgroundEpoch: 'background-fault', contentEpoch: lease.contentEpoch, sequence: 1,
  },
  request: { requestId: lease.requestId, leaseId: lease.leaseId, ownerServerInstanceId: lease.ownerServerInstanceId },
  effectId: 'effect-fault',
});

const scenarios = [
  {
    name: 'content attach',
    setup: [],
    event: { type: 'content.attached', contentEpoch: lease.contentEpoch },
    verify(state) { assert.equal(state.contentEpoch, ''); },
  },
  {
    name: 'lease claim',
    setup: [{ type: 'content.attached', contentEpoch: lease.contentEpoch }],
    event: { type: 'lease.claim', ...lease },
    verify(state) { assert.equal(state.lease, null); },
  },
  {
    name: 'command registration',
    setup: [
      { type: 'content.attached', contentEpoch: lease.contentEpoch },
      { type: 'lease.claim', ...lease },
    ],
    event: { type: 'command.registered', ...lease, commandId: 'command-fault', commandType: 'prompt.send' },
    verify(state) { assert.equal(state.commands['command-fault'], undefined); },
  },
  {
    name: 'command dispatch',
    setup: [
      { type: 'content.attached', contentEpoch: lease.contentEpoch },
      { type: 'lease.claim', ...lease },
      { type: 'command.registered', ...lease, commandId: 'command-fault', commandType: 'prompt.send' },
    ],
    event: { type: 'command.dispatched', ...lease, commandId: 'command-fault' },
    verify(state) { assert.equal(state.commands['command-fault'].status, 'registered'); },
  },
  {
    name: 'effect intent',
    setup: [
      { type: 'content.attached', contentEpoch: lease.contentEpoch },
      { type: 'lease.claim', ...lease },
    ],
    event: { type: 'effect.planned', ...lease, effectId: 'effect-fault', kind: 'prompt.delivery', idempotencyKey: 'idem-fault' },
    verify(state) { assert.equal(state.effects['effect-fault'], undefined); },
  },
  {
    name: 'effect dispatch',
    setup: [
      { type: 'content.attached', contentEpoch: lease.contentEpoch },
      { type: 'lease.claim', ...lease },
      { type: 'effect.planned', ...lease, effectId: 'effect-fault', kind: 'prompt.delivery', idempotencyKey: 'idem-fault' },
    ],
    event: { type: 'effect.dispatched', ...lease, effectId: 'effect-fault', idempotencyKey: 'idem-fault' },
    verify(state) { assert.equal(state.effects['effect-fault'].status, 'planned'); },
  },
  {
    name: 'critical outbox enqueue',
    setup: [{ type: 'content.attached', contentEpoch: lease.contentEpoch }],
    event: { type: 'outbox.enqueued', contentEpoch: lease.contentEpoch, envelope },
    verify(state) { assert.equal(state.outbox.length, 0); },
  },
  {
    name: 'download plan',
    setup: [
      { type: 'content.attached', contentEpoch: lease.contentEpoch },
      { type: 'lease.claim', ...lease },
    ],
    event: {
      type: 'download.transition', ...lease, captureId: 'capture-fault', status: DownloadStatus.PLANNED,
      effectId: 'effect-fault', artifactCandidateId: 'candidate-fault', expectedNames: ['result.zip'],
    },
    verify(state) { assert.equal(state.downloads['capture-fault'], undefined); },
  },
  {
    name: 'lease release',
    setup: [
      { type: 'content.attached', contentEpoch: lease.contentEpoch },
      { type: 'lease.claim', ...lease },
      { type: 'lease.releasing', ...lease },
    ],
    event: { type: 'lease.release', ...lease },
    verify(state) { assert.equal(state.lease.status, 'releasing'); },
  },
];

for (const scenario of scenarios) {
  test(`background persistence fault at ${scenario.name} leaves the prior revision authoritative and is retryable`, async () => {
    const storage = memoryStorage();
    const store = new BackgroundStateStore(storage, 'background-fault');
    for (const setupEvent of scenario.setup) {
      const outcome = await store.transition(41, setupEvent);
      assert.equal(outcome.accepted, true, `${scenario.name}: setup ${setupEvent.type}`);
    }
    const before = structuredClone(await store.read(41));
    storage.failNext();
    await assert.rejects(
      store.transition(41, scenario.event),
      (error) => error?.code === 'BACKGROUND_STATE_PERSIST_FAILED' && error?.eventType === scenario.event.type,
    );
    const afterFailure = await store.read(41);
    assert.deepEqual(afterFailure, before);
    scenario.verify(afterFailure);

    const retry = await store.transition(41, scenario.event);
    assert.equal(retry.accepted, true, `${scenario.name}: physical retry must apply once`);
    assert.equal(retry.state.revision, before.revision + 1);
  });
}

test('negative ACK retains critical outbox data while a later positive ACK removes it exactly once', async () => {
  const storage = memoryStorage();
  const store = new BackgroundStateStore(storage, 'background-fault');
  await store.transition(41, { type: 'content.attached', contentEpoch: lease.contentEpoch });
  await store.transition(41, { type: 'outbox.enqueued', contentEpoch: lease.contentEpoch, envelope });
  const rejected = await store.transition(41, {
    type: 'transport.ack_rejected', contentEpoch: lease.contentEpoch, messageId: envelope.messageId, reason: 'canonical_commit_failed',
  });
  assert.equal(rejected.state.outbox.length, 1);
  assert.equal(rejected.state.transport.rejectedAckCount, 1);
  const acknowledged = await store.transition(41, {
    type: 'outbox.acknowledged', contentEpoch: lease.contentEpoch, messageId: envelope.messageId, sequence: 7,
  });
  assert.equal(acknowledged.state.outbox.length, 0);
  assert.equal(acknowledged.state.transport.ackCursor, 7);
  const duplicate = await store.transition(41, {
    type: 'outbox.acknowledged', contentEpoch: lease.contentEpoch, messageId: envelope.messageId, sequence: 8,
  });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'outbox_message_missing');
  assert.equal(duplicate.state.transport.ackCursor, 7);
});
