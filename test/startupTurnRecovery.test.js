import test from 'node:test';
import assert from 'node:assert/strict';
import { selectStartupTurnRecovery } from '../src/interactive/startupTurnRecovery.js';

function interruptedTurn(overrides = {}) {
  return {
    id: 'turn-interrupted',
    status: 'interrupted',
    input: {
      cwd: '/tmp/project',
      output: { expected: 'zip', required: true },
    },
    output: null,
    ...overrides,
  };
}

function recoveryEvents() {
  return [
    {
      type: 'client.target.resolved',
      data: {
        clientId: 'client-before-reload',
        sourceUrl: 'https://chatgpt.com/c/conversation-one',
      },
    },
    {
      type: 'normal.done.received',
      data: {
        sourceClientId: 'client-before-reload',
        turnKey: 'assistant-turn-one',
      },
    },
  ];
}

test('startup recovery follows a reconnected client in the original conversation', () => {
  const candidate = selectStartupTurnRecovery({
    turn: interruptedTurn(),
    events: recoveryEvents(),
    state: { projectRoot: '/tmp/project' },
    health: {
      clients: [{
        id: 'client-after-reload',
        url: 'https://chatgpt.com/c/conversation-one',
      }],
    },
  });
  assert.deepEqual(candidate, {
    turnId: 'turn-interrupted',
    turnKey: 'assistant-turn-one',
    sourceClientId: 'client-after-reload',
  });
});

test('startup recovery prefers the still-connected correlated client', () => {
  const candidate = selectStartupTurnRecovery({
    turn: interruptedTurn(),
    events: recoveryEvents(),
    state: { projectRoot: '/tmp/project' },
    health: {
      clients: [{ id: 'client-before-reload', url: 'https://chatgpt.com/' }],
    },
  });
  assert.equal(candidate.sourceClientId, 'client-before-reload');
});

test('startup recovery refuses ambiguous, uncorrelated, cancelled, or completed turns', () => {
  const base = {
    events: recoveryEvents(),
    state: { projectRoot: '/tmp/project' },
  };
  const duplicateSessionHealth = {
    clients: [
      { id: 'client-a', url: 'https://chatgpt.com/c/conversation-one' },
      { id: 'client-b', url: 'https://chatgpt.com/c/conversation-one' },
    ],
  };
  assert.equal(selectStartupTurnRecovery({
    ...base,
    turn: interruptedTurn(),
    health: duplicateSessionHealth,
  }), null);
  assert.equal(selectStartupTurnRecovery({
    ...base,
    turn: interruptedTurn({ status: 'cancelled' }),
    health: { clients: [{ id: 'client-a', url: 'https://chatgpt.com/c/conversation-one' }] },
  }), null);
  assert.equal(selectStartupTurnRecovery({
    ...base,
    turn: interruptedTurn({ status: 'completed', output: { type: 'zip', fileId: 'file-ready' } }),
    health: { clients: [{ id: 'client-a', url: 'https://chatgpt.com/c/conversation-one' }] },
  }), null);
  assert.equal(selectStartupTurnRecovery({
    ...base,
    events: [{ type: 'normal.done.received', data: {} }],
    turn: interruptedTurn(),
    health: { clients: [{ id: 'client-a', url: 'https://chatgpt.com/c/conversation-one' }] },
  }), null);
});
