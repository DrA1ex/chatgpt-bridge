import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExtensionMessageDefinition,
  ExtensionMessageType,
  createExtensionEnvelope,
  validateExtensionEnvelope,
} from '../src/bridge/protocol/v5.js';
import {
  MessageDefinition,
  MessageType,
} from '../tools/chrome-bridge-extension/background/protocolV5.js';
import {
  CommandStatus,
  EffectStatus,
  LeaseStatus,
  createTabRuntimeState,
  reduceTabRuntimeState,
} from '../tools/chrome-bridge-extension/background/stateV6.js';
import { BridgeCommandRegistry } from '../src/bridge/coordinator/bridgeCommandRegistry.js';
import { ProtocolV5Adapter } from '../src/bridge/adapters/protocolV5Adapter.js';
import { createRequestEffectDescriptor } from '../src/bridge/requestExecutionPlan.js';

const tabId = 91;
const backgroundEpoch = 'background-v5';
const contentEpoch = 'content-v5';
const request = Object.freeze({
  requestId: 'request-v5',
  leaseId: 'lease-v5',
  ownerServerInstanceId: 'server-v5',
  responseEpoch: 0,
});

function source(sequence = 0) {
  return { clientId: 'client-v5', tabId, backgroundEpoch, contentEpoch, sequence };
}

function envelope(messageType, body, options = {}) {
  return createExtensionEnvelope(messageType, body, {
    source: source(0),
    request: options.request === false ? null : request,
    commandId: options.commandId || body.commandId || null,
    effectId: options.effectId || body.effectId || null,
    messageId: options.messageId,
  });
}

function transition(state, event) {
  return reduceTabRuntimeState(state, { tabId, backgroundEpoch, contentEpoch, ...event });
}

function claimedState() {
  let state = createTabRuntimeState(tabId, backgroundEpoch);
  state = transition(state, { type: 'content.attached', contentEpoch }).state;
  state = transition(state, { type: 'lease.claim', ...request }).state;
  state = transition(state, { type: 'lease.executing', ...request }).state;
  return state;
}

function effectCommandState() {
  let state = claimedState();
  const acceptedEnvelope = envelope(ExtensionMessageType.COMMAND_ACCEPTED, {
    commandId: 'command-steer', requestId: request.requestId, commandMode: 'effect', effectId: 'effect-steer', effectType: 'prompt.steer',
  }, { commandId: 'command-steer', messageId: 'accepted-steer' });
  const outcome = transition(state, {
    type: 'effect_command.dispatched',
    commandId: 'command-steer',
    commandType: 'prompt.steer',
    effectId: 'effect-steer',
    kind: 'prompt.steer',
    idempotencyKey: 'request-v5:steer:1',
    retryPolicy: 'never',
    preconditions: { currentResponseEpoch: 0, targetResponseEpoch: 1 },
    preconditionsHash: 'sha256:steer',
    attempt: 1,
    acceptedEnvelope,
    ...request,
  });
  assert.equal(outcome.accepted, true);
  return outcome.state;
}

test('server and extension consume one shared Protocol 5 manifest', () => {
  assert.equal(ExtensionMessageType, MessageType);
  assert.equal(ExtensionMessageDefinition, MessageDefinition);
  assert.equal(ExtensionMessageDefinition[ExtensionMessageType.EFFECT_SUCCEEDED].terminal, true);
  assert.equal(ExtensionMessageDefinition[ExtensionMessageType.COMMAND_ACCEPTED].terminal, false);
  assert.equal(ExtensionMessageDefinition[ExtensionMessageType.LEASE_QUARANTINED].owner, 'lease');
});

test('Protocol 5 rejects legacy kind/payload envelopes and requires fixed correlation', () => {
  const legacy = {
    protocolVersion: 5,
    messageId: 'legacy-envelope',
    kind: 'effect.result',
    payload: { type: 'request.effect.succeeded' },
    source: source(1),
  };
  assert.equal(validateExtensionEnvelope(legacy).valid, false);
  assert.throws(
    () => createExtensionEnvelope(ExtensionMessageType.EFFECT_SUCCEEDED, {}, { source: source(1), request }),
    /requires effectId/,
  );
});



test('Protocol 5 adapter preserves command correlation on physical effect outcomes', () => {
  const adapter = new ProtocolV5Adapter();
  const client = { id: 'client-v5', browserTabId: tabId, connectionId: 'connection-v5' };
  const hello = createExtensionEnvelope(ExtensionMessageType.TRANSPORT_HELLO, {
    serverInstanceId: request.ownerServerInstanceId,
  }, {
    source: source(1),
    request: null,
    messageId: 'hello-v5',
  });
  assert.equal(adapter.ingest(hello, client).accepted, true);

  const terminal = createExtensionEnvelope(ExtensionMessageType.EFFECT_SUCCEEDED, {
    commandId: 'command-steer',
    requestId: request.requestId,
    effectId: 'effect-steer',
    effectType: 'prompt.steer',
    result: { previousResponseEpoch: 0, targetResponseEpoch: 1 },
  }, {
    source: source(2),
    request,
    commandId: 'command-steer',
    effectId: 'effect-steer',
    messageId: 'effect-terminal-v5',
  });
  const accepted = adapter.ingest(terminal, client);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.payload.commandId, 'command-steer');
  assert.equal(accepted.payload.effectId, 'effect-steer');
  assert.equal(accepted.payload.type, 'request.effect.succeeded');
});

test('effect-backed command, physical effect, and accepted outbox entry commit atomically', () => {
  const state = effectCommandState();
  assert.equal(state.commands['command-steer'].status, CommandStatus.ACCEPTED);
  assert.equal(state.effects['effect-steer'].status, EffectStatus.DISPATCHED);
  assert.deepEqual(state.outbox.map((item) => item.messageType), [ExtensionMessageType.COMMAND_ACCEPTED]);
  assert.equal(state.outbox[0].messageId, 'accepted-steer');
});

test('one physical effect terminal settles the derived command and appends exactly one terminal envelope', () => {
  let state = effectCommandState();
  const terminalEnvelope = envelope(ExtensionMessageType.EFFECT_SUCCEEDED, {
    commandId: 'command-steer', requestId: request.requestId, effectId: 'effect-steer', effectType: 'prompt.steer',
    result: { previousResponseEpoch: 0, targetResponseEpoch: 1, submittedUserTurnKey: 'user-2' },
  }, { commandId: 'command-steer', effectId: 'effect-steer', messageId: 'effect-steer-succeeded' });
  const outcome = transition(state, {
    type: 'effect.succeeded',
    effectId: 'effect-steer',
    idempotencyKey: 'request-v5:steer:1',
    preconditionsHash: 'sha256:steer',
    result: terminalEnvelope.body.result,
    terminalEnvelope,
    ...request,
  });
  assert.equal(outcome.accepted, true);
  state = outcome.state;
  assert.equal(state.effects['effect-steer'].status, EffectStatus.SUCCEEDED);
  assert.equal(state.commands['command-steer'].status, CommandStatus.SUCCEEDED);
  assert.equal(state.commands['command-steer'].physicalEffectId, 'effect-steer');
  assert.deepEqual(state.outbox.map((item) => item.messageId), ['accepted-steer', 'effect-steer-succeeded']);
  assert.equal(Object.hasOwn(state.commands['command-steer'], 'reportedAt'), false);
  assert.equal(Object.hasOwn(state.effects['effect-steer'], 'reportedAt'), false);

  const forbidden = transition(state, {
    type: 'command.succeeded', commandId: 'command-steer', terminalEnvelope,
    resultPayload: terminalEnvelope.body, ...request,
  });
  assert.equal(forbidden.accepted, false);
  assert.equal(forbidden.reason, 'effect_backed_command_has_no_terminal_result');
});

test('ACK removes only the exact immutable terminal messageId', () => {
  let state = effectCommandState();
  const terminalEnvelope = envelope(ExtensionMessageType.EFFECT_UNCERTAIN, {
    commandId: 'command-steer', requestId: request.requestId, effectId: 'effect-steer', effectType: 'prompt.steer',
    code: 'PROMPT_SUBMIT_UNCERTAIN', message: 'No proof', uncertain: true,
  }, { commandId: 'command-steer', effectId: 'effect-steer', messageId: 'effect-steer-uncertain' });
  state = transition(state, {
    type: 'effect.uncertain', effectId: 'effect-steer', idempotencyKey: 'request-v5:steer:1',
    preconditionsHash: 'sha256:steer', error: { code: 'PROMPT_SUBMIT_UNCERTAIN', message: 'No proof' }, terminalEnvelope, ...request,
  }).state;
  const missing = transition(state, { type: 'outbox.acknowledged', messageId: 'command-steer', sequence: 1 });
  assert.equal(missing.accepted, false);
  assert.equal(missing.reason, 'outbox_message_missing');
  const acceptedAck = transition(state, { type: 'outbox.acknowledged', messageId: 'effect-steer-uncertain', sequence: 2 });
  assert.equal(acceptedAck.accepted, true);
  assert.deepEqual(acceptedAck.state.outbox.map((item) => item.messageId), ['accepted-steer']);
});

test('background owns release completion and atomically creates lease.released', () => {
  let state = claimedState();
  state = transition(state, { type: 'lease.releasing', ...request }).state;
  const releasedEnvelope = envelope(ExtensionMessageType.LEASE_RELEASED, {
    commandId: 'command-release', requestId: request.requestId, released: true, activeRequest: null,
  }, { commandId: 'command-release', messageId: 'lease-released' });
  state = transition(state, {
    type: 'command.registered', scope: 'request', commandId: 'command-release', commandType: 'request.release', mode: 'release',
    terminalEnvelope: releasedEnvelope, idempotencyKey: 'release-v5', retryPolicy: 'never', preconditions: {}, ...request,
  }).state;
  const acceptedEnvelope = envelope(ExtensionMessageType.COMMAND_ACCEPTED, {
    commandId: 'command-release', requestId: request.requestId, commandMode: 'release',
  }, { commandId: 'command-release', messageId: 'release-accepted' });
  state = transition(state, { type: 'command.dispatched', commandId: 'command-release', acceptedEnvelope, ...request }).state;
  const ready = transition(state, { type: 'command.release_ready', commandId: 'command-release', ...request });
  assert.equal(ready.accepted, true);
  state = ready.state;
  assert.equal(state.lease, null);
  assert.equal(state.commands['command-release'].status, CommandStatus.SUCCEEDED);
  assert.deepEqual(state.outbox.map((item) => item.messageType), [ExtensionMessageType.COMMAND_ACCEPTED, ExtensionMessageType.LEASE_RELEASED]);
});

test('unproven cleanup quarantines the tab instead of blocking unrelated scheduling forever', () => {
  let state = claimedState();
  state = transition(state, { type: 'lease.releasing', ...request }).state;
  const releasedEnvelope = envelope(ExtensionMessageType.LEASE_RELEASED, {
    commandId: 'command-release', requestId: request.requestId, released: true,
  }, { commandId: 'command-release', messageId: 'lease-release-unused' });
  state = transition(state, {
    type: 'command.registered', scope: 'request', commandId: 'command-release', commandType: 'request.release', mode: 'release',
    terminalEnvelope: releasedEnvelope, idempotencyKey: 'release-v5', ...request,
  }).state;
  const acceptedEnvelope = envelope(ExtensionMessageType.COMMAND_ACCEPTED, {
    commandId: 'command-release', requestId: request.requestId, commandMode: 'release',
  }, { commandId: 'command-release', messageId: 'release-accepted' });
  state = transition(state, { type: 'command.dispatched', commandId: 'command-release', acceptedEnvelope, ...request }).state;
  const quarantinedEnvelope = envelope(ExtensionMessageType.LEASE_QUARANTINED, {
    commandId: 'command-release', requestId: request.requestId, code: 'RELEASE_CLEANUP_TIMEOUT', message: 'Cleanup unproven', reason: 'timeout',
  }, { commandId: 'command-release', messageId: 'lease-quarantined' });
  const outcome = transition(state, {
    type: 'command.uncertain', commandId: 'command-release', error: { code: 'RELEASE_CLEANUP_TIMEOUT', message: 'Cleanup unproven' },
    resultPayload: quarantinedEnvelope.body, terminalEnvelope: quarantinedEnvelope, ...request,
  });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.state.lease.status, LeaseStatus.QUARANTINED);
  assert.equal(outcome.state.outbox.at(-1).messageType, ExtensionMessageType.LEASE_QUARANTINED);
});

test('effect-backed command registry settles only from the physical effect outcome', async () => {
  let delivered = null;
  const hub = {
    sendToClientWithDelivery(clientId, payload) {
      delivered = { clientId, payload };
      return { client: { id: clientId }, delivered: Promise.resolve() };
    },
  };
  const registry = new BridgeCommandRegistry({ hub });
  const promise = registry.send('prompt.steer', {
    message: 'continue',
    effect: createRequestEffectDescriptor({ request, kind: 'prompt.steer', logicalId: 'registry-steer' }),
  }, {
    sourceClientId: 'client-v5', request, timeoutMs: 5_000,
  });
  await Promise.resolve();
  const commandId = delivered.payload.commandId;
  assert.equal(registry.handleResponse('client-v5', { type: 'command.result', commandId, resultType: 'prompt.steered' }), false);
  assert.equal(registry.has(commandId), true);
  assert.equal(registry.handleResponse('client-v5', {
    type: 'request.effect.succeeded', commandId, requestId: request.requestId, effectId: delivered.payload.effect.effectId, effectType: 'prompt.steer',
    result: { previousResponseEpoch: 0, targetResponseEpoch: 1, submittedUserTurnKey: 'user-2' },
  }), true);
  const result = await promise;
  assert.equal(result.targetResponseEpoch, 1);
  assert.equal(registry.has(commandId), false);
});
