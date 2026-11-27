import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PromptLoopController, hasCompletionMarker } from '../src/turn/promptLoopController.js';
import { extendImportedPrefix } from '../src/turn/existingChatConnector.js';

class Manager extends EventEmitter {
  turns = [];
  sent = [];
  cancelled = [];
  async getThread(id) { return { id, sessionId: 'original' }; }
  async listTurns() { return this.turns; }
  async startTurn(params, options) {
    this.sent.push({ params, options });
    const turn = { id: String(this.sent.length), status: 'running' };
    this.turns.push(turn);
    return { turn };
  }
  async getTurn(id) { return this.turns.find(turn => turn.id === id); }
  async getItems({ turnId }) { return [{ type: 'agent_message', status: 'completed', content: { text: (await this.getTurn(turnId)).answer } }]; }
  async cancelTurn(id) { this.cancelled.push(id); }
  finish(status, answer) {
    const turn = this.turns.at(-1);
    Object.assign(turn, { status, answer });
    this.emit('notification', { method: 'turn/' + status, params: { turnId: turn.id } });
  }
}

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for loop state');
}

test('loop uses one completion marker, repeats original prompt and stops only on final marker', async () => {
  const manager = new Manager();
  const loop = new PromptLoopController({ turnManager: manager });
  await loop.start({ threadId: 'thread', message: 'Continue the plan', attachments: ['file'], maxIterations: 10 });
  const first = manager.sent[0].params;
  const marker = first.message.match(/BRIDGE_DONE_[a-f0-9]+/)[0];
  assert.equal(hasCompletionMarker('Mention ' + marker, marker), false);
  assert.equal(hasCompletionMarker(marker + '\nmore work', marker), false);
  manager.finish('completed', 'More work remains');
  await until(() => manager.sent.length === 2);
  assert.equal(manager.sent[1].params.message, first.message);
  assert.equal(manager.sent[1].params.sessionId, 'original');
  assert.deepEqual(manager.sent[1].params.attachments, []);
  manager.finish('completed', 'Complete\n' + marker);
  await until(() => loop.get('thread').status === 'completed');
  assert.equal(manager.sent.length, 2);
});

test('loop stops at limit, failure, and manual cancellation', async () => {
  for (const ending of ['limit', 'failed', 'stopped']) {
    const manager = new Manager();
    const loop = new PromptLoopController({ turnManager: manager });
    await loop.start({ threadId: 'thread', message: 'Continue', maxIterations: 1 });
    if (ending === 'stopped') await loop.stop('thread');
    else manager.finish(ending === 'failed' ? 'failed' : 'completed', 'Not done');
    await until(() => loop.get('thread').status === ending);
    assert.equal(manager.sent.length, 1);
    if (ending === 'stopped') assert.deepEqual(manager.cancelled, ['1']);
  }
});

test('history extension prepends only a uniquely aligned prefix', () => {
  const old = [{ id: 'old', role: 'user', text: 'Previous question' }];
  const earlier = { id: 'new', role: 'assistant', text: 'Older answer' };
  const duplicate = { id: 'another', role: 'user', text: 'Previous question' };
  assert.deepEqual(extendImportedPrefix(old, [earlier, duplicate]), [earlier, ...old]);
  assert.equal(extendImportedPrefix(old, [earlier, duplicate, old[0]]), null);
  assert.equal(extendImportedPrefix(old, [earlier]), null);
});
