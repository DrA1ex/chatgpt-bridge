import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { waitForTurn } from '../src/interactive/controller.js';

test('waitForTurn replays persisted progress items that arrived before live subscription', async () => {
  const turnManager = new EventEmitter();
  turnManager.getTurnEvents = async () => [{
    id: 'event-progress-1',
    type: 'item/progress/completed',
    data: {
      logicalId: 'progress:first-update',
      kind: 'action_status',
      text: 'Сначала найду тот PR и проверю путь обработки первой отбивки.',
      state: 'completed',
      active: false,
      visible: true,
      revision: 1,
    },
  }];
  turnManager.getTurn = async () => ({ id: 'turn-1', status: 'completed' });

  const statuses = [];
  const progress = [];
  const consoleStream = {
    status: (line) => statuses.push(line),
    onThinkingUpdate: () => {},
    onProgressUpdate: (text) => progress.push(text),
    onAnswerUpdate: () => {},
  };

  const turn = await waitForTurn(turnManager, 'turn-1', { eventLevel: 'normal' }, consoleStream);

  assert.equal(turn.status, 'completed');
  assert.deepEqual(progress, ['']);
  assert.deepEqual(statuses, [
    '[action status] Сначала найду тот PR и проверю путь обработки первой отбивки.',
  ]);
});
