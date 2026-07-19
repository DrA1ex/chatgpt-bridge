import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/eventBus.js';
import { BridgeClientEventRouter } from '../src/bridge/coordinator/bridgeClientEventRouter.js';

test('bridge routes passive TabObservation snapshots to the transient workflow event channel only', () => {
  const eventBus = new EventBus();
  const seen = [];
  eventBus.on('event', (event) => seen.push(event));
  const router = new BridgeClientEventRouter({
    pending: new Map(), commands: new Map(), artifacts: new Map(), eventBus,
    lifecycle: {}, publishObservedTurn() {}, registerObservedArtifacts: (items) => items,
    handleCommandResponse() {},
  });
  router.handleClientActivity('client-1', { session: { id: 'session-1' } }, {
    type: 'tab.observation',
    observation: {
      conversationId: 'session-1', revision: 4, observedAt: Date.now(),
      activeRequest: null,
      turn: { key: 'assistant-1', userKey: 'user-1', userPrompt: 'Update it', index: 1, promptBoundary: { submittedUserTurnKey: 'user-1', submittedUserTurnIndex: 0 } },
      generation: { state: 'running' }, blocker: { state: 'none' }, stableForMs: 0,
      output: { state: 'streaming', thinking: 'Inspecting', progress: 'Reading', answer: 'Working' },
      artifacts: [],
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'watch.turn.snapshot');
  assert.equal(seen[0].data.sourceClientId, 'client-1');
  assert.equal(seen[0].data.userTurnKey, 'user-1');
  assert.equal(seen[0].data.reasoning, 'Inspecting');
  assert.equal(eventBus.recentEvents(10).length, 0);
});
