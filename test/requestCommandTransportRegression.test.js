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
