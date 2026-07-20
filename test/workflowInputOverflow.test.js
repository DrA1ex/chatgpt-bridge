import test from 'node:test';
import assert from 'node:assert/strict';
import { routeObservedTurn } from '../src/workflow/support/observedTurnRouter.js';

function runtime(hydrationStatus) {
  return {
    id: 'workflow-overflow',
    hydrationStatus,
    config: {
      watch: { mode: 'auto' },
      automation: { suspendWatcher: false },
      execution: { maxDeferredTurns: 1 },
    },
    workflowState: {
      lifecycle: 'ready',
      subscription: { enabled: true },
      binding: { epoch: 3, clientId: 'client-1', sessionId: 'session-1' },
      queueLimit: 1,
    },
  };
}

const turn = {
  sourceClientId: 'client-1',
  sessionId: 'session-1',
  turnKey: 'turn-overflow',
  answer: 'result',
  artifacts: [],
};

test('startup inbox overflow preserves queued work and dead-letters only the newest observed input', async () => {
  const target = runtime('hydrating');
  const deadLetters = [];
  const failures = [];
  await routeObservedTurn({
    workflows: new Map([[target.id, target]]),
    turn,
    isWorkflowActive: () => false,
    enqueue: async () => { throw new Error('normal queue must not run while hydrating'); },
    processObserved: async () => {},
    failRuntime: async (...args) => { failures.push(args); },
    store: {
      async enqueueStartupInput() {
        const error = new Error('full');
        error.code = 'WORKFLOW_STARTUP_INBOX_FULL';
        error.limit = 1;
        throw error;
      },
      async addDeadLetter(value) { deadLetters.push(value); },
    },
  });
  assert.equal(deadLetters.length, 1);
  assert.equal(deadLetters[0].reason, 'startup_inbox_full');
  assert.equal(deadLetters[0].turn.turnKey, 'turn-overflow');
  assert.equal(failures.length, 1);
  assert.equal(failures[0][2].diagnosticOnly, true);
});

test('canonical input queue overflow is typed backpressure rather than a terminal workflow failure', async () => {
  const target = runtime('ready');
  const deadLetters = [];
  const failures = [];
  await routeObservedTurn({
    workflows: new Map([[target.id, target]]),
    turn,
    isWorkflowActive: () => false,
    enqueue: async () => {
      const error = new Error('queue full');
      error.code = 'input_queue_full';
      throw error;
    },
    processObserved: async () => {},
    failRuntime: async (...args) => { failures.push(args); },
    store: { async addDeadLetter(value) { deadLetters.push(value); } },
  });
  assert.equal(deadLetters.length, 1);
  assert.equal(deadLetters[0].reason, 'input_queue_full');
  assert.equal(failures[0][1].code, 'WORKFLOW_INPUT_DEAD_LETTERED');
  assert.equal(failures[0][2].diagnosticOnly, true);
});
