import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { BrowserBridge } from '../src/browserBridge.js';
import { emitTabObservation } from './support/bridgeObservation.js';

class FakeHub extends EventEmitter {
  constructor() {
    super();
    this.clients = [];
    this.activeClient = null;
    this.selectedClientId = '';
    this.needsSelection = false;
    this.serverInstanceId = 'server-test';
  }
}

test('BrowserBridge journals terminal observed turns with monotonic sequence envelopes', () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const turns = [];
  const envelopes = [];
  const removeTurn = bridge.onObservedTurn((turn) => turns.push(turn));
  const removeEnvelope = bridge.onObservedTurnEnvelope((envelope) => envelopes.push(envelope));
  try {
    emitTabObservation(hub, {
      requestId: '', clientId: 'client-1', activeRequest: false,
      conversationId: 'session-1', userTurnKey: 'user-1', assistantTurnKey: 'assistant-1',
      userPrompt: 'first prompt', answer: 'first',
    });
    emitTabObservation(hub, {
      requestId: '', clientId: 'client-1', activeRequest: false,
      conversationId: 'session-1', userTurnKey: 'user-2', assistantTurnKey: 'assistant-2',
      userPrompt: 'second prompt', answer: 'second',
    });
    assert.deepEqual(turns.map((turn) => turn.turnKey), ['assistant-1', 'assistant-2']);
    assert.deepEqual(envelopes.map((entry) => entry.sequence), [1, 2]);
    assert.deepEqual(bridge.listObservedTurns({ afterSequence: 1 }).map((entry) => entry.turn.turnKey), ['assistant-2']);
  } finally {
    removeTurn();
    removeEnvelope();
  }
});
