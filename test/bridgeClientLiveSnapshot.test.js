import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/eventBus.js';
import { BridgeClientEventRouter } from '../src/bridge/coordinator/bridgeClientEventRouter.js';

test('bridge routes passive live snapshots to the transient workflow event channel only', () => {
  const eventBus = new EventBus();
  const seen = [];
  eventBus.on('event', (event) => seen.push(event));
  const router = new BridgeClientEventRouter({
    pending: new Map(), commands: new Map(), artifacts: new Map(), eventBus,
    lifecycle: {}, publishObservedTurn() {}, registerObservedArtifacts: (items) => items,
    sendPromptToClient() {}, handleCommandResponse() {},
  });
  router.handleClientMessage('client-1', {
    type: 'observed.turn.snapshot', session: { id: 'session-1' }, turnKey: 'assistant-1', userTurnKey: 'user-1',
    userPrompt: 'Update it', reasoning: 'Inspecting', progress: 'Reading', answer: 'Working', terminal: false,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'watch.turn.snapshot');
  assert.equal(seen[0].data.sourceClientId, 'client-1');
  assert.equal(seen[0].data.userTurnKey, 'user-1');
  assert.equal(seen[0].data.reasoning, 'Inspecting');
  assert.equal(eventBus.recentEvents(10).length, 0);
});
