import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { BrowserBridge } from '../src/browserBridge.js';

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
    hub.emit('client.message', {
      clientId: 'client-1',
      payload: {
        type: 'observed.turn.terminal',
        turnKey: 'assistant-1',
        session: { id: 'session-1' },
        answer: 'first',
        artifacts: [],
      },
    });
    hub.emit('client.message', {
      clientId: 'client-1',
      payload: {
        type: 'observed.turn.terminal',
        turnKey: 'assistant-2',
        session: { id: 'session-1' },
        answer: 'second',
        artifacts: [],
      },
    });
    assert.deepEqual(turns.map((turn) => turn.turnKey), ['assistant-1', 'assistant-2']);
    assert.deepEqual(envelopes.map((entry) => entry.sequence), [1, 2]);
    assert.deepEqual(bridge.listObservedTurns({ afterSequence: 1 }).map((entry) => entry.turn.turnKey), ['assistant-2']);
  } finally {
    removeTurn();
    removeEnvelope();
  }
});
