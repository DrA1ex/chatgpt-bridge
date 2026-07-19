import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClientEventRouter } from '../src/bridge/coordinator/bridgeClientEventRouter.js';
import { RequestEventType } from '../src/bridge/state/requestEvents.js';

test('request-scoped command rejection fails the canonical request instead of being ignored', () => {
  const state = { requestId: 'request-command-rejected', clientId: 'client-a' };
  const transitions = [];
  const router = new BridgeClientEventRouter({
    pending: new Map([[state.requestId, state]]),
    commands: new Map(),
    artifacts: new Map(),
    lifecycle: {
      canonicalEvent(_state, type, data, source) { return { type, data, source }; },
      ingestRequestTransition(_state, event) { transitions.push(event); },
      touchState() {},
    },
    publishObservedTurn() {},
    registerObservedArtifacts() {},
    handleCommandResponse() {},
  });

  router.handleClientMessage('client-a', {
    type: 'command.error',
    commandId: 'background-command-id',
    requestId: state.requestId,
    message: 'Browser command registration rejected: command_identity_missing',
  });

  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].type, RequestEventType.FAILED);
  assert.equal(transitions[0].data.code, 'BROWSER_COMMAND_REJECTED');
  assert.match(transitions[0].data.message, /command_identity_missing/);
});

test('background command.accepted telemetry cannot implicitly accept a request', () => {
  const state = { requestId: 'request-command-accepted', clientId: 'client-a' };
  let touched = 0;
  let accepted = 0;
  const router = new BridgeClientEventRouter({
    pending: new Map([[state.requestId, state]]),
    commands: new Map(),
    artifacts: new Map(),
    lifecycle: {
      touchState() { touched += 1; },
      markPromptAccepted() { accepted += 1; },
    },
    publishObservedTurn() {},
    registerObservedArtifacts() {},
    handleCommandResponse() {},
  });

  router.handleClientMessage('client-a', {
    type: 'command.accepted',
    commandId: 'background-command-id',
    requestId: state.requestId,
  });

  assert.equal(touched, 0);
  assert.equal(accepted, 0);
});


test('canonical browser-effect transitions are published once to turn event consumers', () => {
  const state = {
    requestId: 'request-effect-events',
    clientId: 'client-a',
    accepted: true,
    events: [],
  };
  const acceptedTransitions = new Set();
  const publicEvents = [];
  const router = new BridgeClientEventRouter({
    pending: new Map([[state.requestId, state]]),
    commands: new Map(),
    artifacts: new Map(),
    lifecycle: {
      canonicalEvent(_state, type, data, source) { return { type, data, source }; },
      ingestRequestTransition(_state, event) {
        const key = `${event.type}:${event.data?.effectId || ''}`;
        if (acceptedTransitions.has(key)) return { accepted: false, reason: 'duplicate' };
        acceptedTransitions.add(key);
        return { accepted: true };
      },
      touchState() {},
      emitRequestEvent(_state, event) {
        publicEvents.push(event);
        state.events.push(event);
      },
    },
    publishObservedTurn() {},
    registerObservedArtifacts() {},
    handleCommandResponse() {},
  });

  const started = {
    type: 'request.effect.started',
    requestId: state.requestId,
    effectId: 'effect-prompt-submit',
    effectType: 'prompt.submit',
  };
  const succeeded = {
    type: 'request.effect.succeeded',
    requestId: state.requestId,
    effectId: 'effect-prompt-submit',
    effectType: 'prompt.submit',
    result: { submittedUserTurnKey: 'user-turn-1' },
  };
  router.handleClientMessage('client-a', started);
  router.handleClientMessage('client-a', started);
  router.handleClientMessage('client-a', succeeded);
  router.handleClientMessage('client-a', succeeded);

  assert.equal(publicEvents.filter((event) => event.type === 'request.effect.started').length, 1);
  assert.equal(publicEvents.filter((event) => event.type === 'request.effect.succeeded').length, 1);
  assert.equal(publicEvents.filter((event) => event.type === 'prompt.sent').length, 1);
  assert.equal(publicEvents.find((event) => event.type === 'request.effect.succeeded')?.effectType, 'prompt.submit');
  assert.equal(publicEvents.find((event) => event.type === 'prompt.sent')?.effectId, 'effect-prompt-submit');
});
