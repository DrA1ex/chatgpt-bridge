import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKGROUND_STATE_STORAGE_PREFIX,
  BackgroundStateStore,
  createTabRuntimeState,
} from '../tools/chrome-bridge-extension/background/stateV6.js';
import { estimateRuntimeStateBytes } from '../tools/chrome-bridge-extension/background/stateV6Compaction.js';

function quotaStorage(seed = {}, quotaBytes = 350_000) {
  const values = structuredClone(seed);
  return {
    values,
    async get(key) {
      if (key === null) return structuredClone(values);
      return { [key]: structuredClone(values[key]) };
    },
    async set(patch) {
      const next = { ...values, ...structuredClone(patch) };
      const bytes = new TextEncoder().encode(JSON.stringify(next)).byteLength;
      if (bytes > quotaBytes) {
        const error = new Error(`QUOTA_BYTES exceeded: ${bytes} > ${quotaBytes}`);
        error.name = 'QuotaExceededError';
        throw error;
      }
      Object.assign(values, structuredClone(patch));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}

function oldCommand(index) {
  return {
    commandId: `old-command-${index}`,
    commandType: 'response.snapshot.request',
    scope: 'standalone',
    requestId: '',
    leaseId: '',
    ownerServerInstanceId: '',
    responseEpoch: 0,
    idempotencyKey: `old-command-${index}`,
    preconditions: {},
    retryPolicy: 'always',
    mode: 'result',
    status: 'succeeded',
    resultPayload: { type: 'response.snapshot', text: 'x'.repeat(24_000), index },
    createdAt: index,
    updatedAt: index,
  };
}

function activeState(tabId = 77) {
  const state = createTabRuntimeState(tabId, 'background-old');
  state.contentEpoch = 'content-current';
  state.lease = {
    requestId: 'request-current',
    leaseId: 'lease-current',
    ownerServerInstanceId: 'server-current',
    responseEpoch: 0,
    status: 'executing',
  };
  for (let index = 0; index < 70; index += 1) {
    const command = oldCommand(index);
    state.commands[command.commandId] = command;
    state.commandOrder.push(command.commandId);
  }
  state.commands['command-current'] = {
    commandId: 'command-current', commandType: 'prompt.send', mode: 'effect', scope: 'request',
    requestId: 'request-current', leaseId: 'lease-current', ownerServerInstanceId: 'server-current', responseEpoch: 0,
    idempotencyKey: 'command-current', preconditions: {}, retryPolicy: 'always', status: 'accepted', physicalEffectId: 'effect-current',
    createdAt: 100, updatedAt: 100,
  };
  state.commandOrder.push('command-current');
  state.effects['effect-current'] = {
    effectId: 'effect-current', kind: 'page.ready.initial', idempotencyKey: 'effect-current', commandId: 'command-current',
    causationId: 'command-current', requestId: 'request-current', leaseId: 'lease-current', ownerServerInstanceId: 'server-current',
    responseEpoch: 0, preconditions: {}, preconditionsHash: 'hash-current', retryPolicy: 'always', attempt: 1,
    status: 'dispatched', plannedAt: 100, dispatchedAt: 100, settledAt: 0, result: null, error: null, createdAt: 100, updatedAt: 100,
  };
  state.effectOrder.push('effect-current');
  return state;
}

test('background store compacts stale terminal history before a terminal effect commit reaches storage quota', async () => {
  const tabId = 77;
  const key = `${BACKGROUND_STATE_STORAGE_PREFIX}${tabId}`;
  const seeded = activeState(tabId);
  assert.ok(estimateRuntimeStateBytes(seeded) > 1_000_000);
  const storage = quotaStorage({ [key]: seeded }, 350_000);
  const store = new BackgroundStateStore(storage, 'background-current', { targetBytes: 300_000 });
  const terminalEnvelope = {
    protocolVersion: 5,
    messageId: 'effect-terminal-message',
    messageType: 'effect.succeeded',
    sentAt: Date.now(),
    source: { clientId: 'client-current', tabId, backgroundEpoch: 'background-current', contentEpoch: 'content-current', sequence: 0 },
    request: { requestId: 'request-current', leaseId: 'lease-current', ownerServerInstanceId: 'server-current', responseEpoch: 0 },
    commandId: 'command-current', effectId: 'effect-current', causationId: 'command-current',
    body: { requestId: 'request-current', effectId: 'effect-current', effectType: 'page.ready.initial' },
  };
  const outcome = await store.transition(tabId, {
    type: 'effect.succeeded',
    requestId: 'request-current', leaseId: 'lease-current', ownerServerInstanceId: 'server-current', responseEpoch: 0,
    effectId: 'effect-current', idempotencyKey: 'effect-current', preconditionsHash: 'hash-current', attempt: 1,
    result: null, terminalEnvelope, contentEpoch: 'content-current',
  });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.state.effects['effect-current'].status, 'succeeded');
  assert.equal(outcome.state.commands['command-current'].status, 'succeeded');
  assert.equal(outcome.state.outbox.some((item) => item.messageId === 'effect-terminal-message'), true);
  assert.ok(outcome.state.commandOrder.length < seeded.commandOrder.length);
  assert.ok(outcome.state.metrics.stateCompactions >= 1);
  assert.ok(outcome.state.metrics.persistenceBytes < 350_000);
  assert.ok(estimateRuntimeStateBytes(storage.values[key]) < 350_000);
});

test('background compaction preserves uncertain records and every record referenced by critical outbox', async () => {
  const tabId = 78;
  const key = `${BACKGROUND_STATE_STORAGE_PREFIX}${tabId}`;
  const seeded = createTabRuntimeState(tabId, 'background-old');
  seeded.contentEpoch = 'content-current';
  for (let index = 0; index < 70; index += 1) {
    const command = oldCommand(index);
    seeded.commands[command.commandId] = command;
    seeded.commandOrder.push(command.commandId);
  }
  const recoveryEvidence = { probe: 'x'.repeat(64_000), verdict: 'unknown' };
  seeded.effects['uncertain-effect'] = {
    effectId: 'uncertain-effect', kind: 'prompt.submit', idempotencyKey: 'uncertain-effect', commandId: '', causationId: '',
    requestId: 'old-request', leaseId: 'old-lease', ownerServerInstanceId: 'old-server', responseEpoch: 0,
    preconditions: {}, preconditionsHash: 'uncertain-hash', retryPolicy: 'never', attempt: 1, status: 'uncertain',
    plannedAt: 1, dispatchedAt: 2, settledAt: 3, result: null, error: { code: 'UNKNOWN' },
    reconciliationEvidence: recoveryEvidence, createdAt: 1, updatedAt: 3,
  };
  seeded.effectOrder.push('uncertain-effect');
  seeded.outbox.push({
    protocolVersion: 5, messageId: 'referenced-command-envelope', messageType: 'command.result', sentAt: 1,
    source: { clientId: 'client', tabId, backgroundEpoch: 'background-old', contentEpoch: 'content-current', sequence: 1 },
    request: null, commandId: 'old-command-0', effectId: null, causationId: null,
    body: { commandId: 'old-command-0', resultType: 'response.snapshot' },
  });
  const storage = quotaStorage({ [key]: seeded }, 350_000);
  const store = new BackgroundStateStore(storage, 'background-current', { targetBytes: 300_000 });
  const outcome = await store.transition(tabId, { type: 'transport.outbound.next', contentEpoch: 'content-current' });
  assert.equal(outcome.accepted, true);
  assert.ok(outcome.state.commands['old-command-0']);
  assert.ok(outcome.state.effects['uncertain-effect']);
  assert.deepEqual(outcome.state.effects['uncertain-effect'].reconciliationEvidence, recoveryEvidence);
  assert.equal(outcome.state.outbox[0].messageId, 'referenced-command-envelope');
});
