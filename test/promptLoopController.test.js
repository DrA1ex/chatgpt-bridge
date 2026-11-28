import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PromptLoopController, hasCompletionMarker } from '../src/turn/promptLoopController.js';
import { extendImportedPrefix } from '../src/turn/existingChatConnector.js';

class Manager extends EventEmitter {
  turns = [];
  sent = [];
  cancelled = [];
  sessionId = 'original';
  async createThread() { return this.getThread('new-thread'); }
  async getThread(id) { return { id, sessionId: this.sessionId }; }
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

test('loop continues from the conversation and stops only on a plain final marker', async () => {
  const manager = new Manager();
  const loop = new PromptLoopController({ turnManager: manager, continuationDelayMs: 5 });
  await loop.start({ threadId: 'thread', message: 'Continue the plan', attachments: ['file'], maxIterations: 10 });
  const first = manager.sent[0].params;
  const marker = first.message.match(/BRIDGEDONE-[a-f0-9]+/)[0];
  assert.equal(hasCompletionMarker('Mention ' + marker, marker), false);
  assert.equal(hasCompletionMarker(marker + '\nmore work', marker), false);
  assert.equal(hasCompletionMarker('**' + marker + '**', marker), false);
  assert.equal(hasCompletionMarker('```\n' + marker, marker), false);
  manager.finish('completed', 'More work remains');
  await until(() => manager.sent.length === 2);
  assert.notEqual(manager.sent[1].params.message, first.message);
  assert.match(manager.sent[1].params.message, /Continue the original task/);
  assert.ok(manager.sent[1].params.message.includes(marker));
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

test('loops cannot run concurrently in duplicate local threads for the same conversation', async () => {
  const manager = new Manager();
  const loop = new PromptLoopController({ turnManager: manager });
  await loop.start({ threadId: 'first', message: 'Continue' });
  await assert.rejects(() => loop.start({ threadId: 'second', message: 'Continue' }), /already running/);
  await loop.stop('first');
});

test('artifact-only RPC server can initialize without a turn manager', async () => {
  const loop = new PromptLoopController({});
  assert.equal(loop.get('thread'), null);
  await assert.rejects(() => loop.start({ threadId: 'thread', message: 'Continue' }), /unavailable/);
});

test('partial history windows can prepend older messages without reimporting local turns', () => {
  const previous = [
    { id: 'visible:0', role: 'user', text: 'Continue' },
    { id: 'visible:1', role: 'assistant', text: 'First answer' },
    { id: 'visible:2', role: 'user', text: 'Continue' },
    { id: 'visible:3', role: 'assistant', text: 'Second answer' },
  ];
  const older = { id: 'earlier', role: 'assistant', text: 'Earlier answer' };
  const partial = [older, { ...previous[0], id: 'u1' }, { ...previous[1], id: 'a1' }];
  assert.deepEqual(extendImportedPrefix(previous, partial), [older, ...previous]);
  assert.equal(extendImportedPrefix(previous, [older, { ...previous[0], id: 'u1' }]), null);
});


test('loop advances from persisted completion even when terminal notification is missing', async () => {
  const manager = new Manager();
  const loop = new PromptLoopController({ turnManager: manager, checkIntervalMs: 5, continuationDelayMs: 5 });
  await loop.start({ threadId: 'thread', message: 'Continue' });
  Object.assign(manager.turns[0], { status: 'completed', answer: 'First step finished' });
  await until(() => manager.sent.length === 2);
  manager.emit('notification', { method: 'turn/completed', params: { turnId: '1' } });
  const marker = manager.sent[0].params.message.match(/BRIDGEDONE-[a-f0-9]+/)[0];
  Object.assign(manager.turns[1], { status: 'completed', answer: '', output: { type: 'text', text: 'Finished\n' + marker } });
  await until(() => loop.get('thread').status === 'completed');
  assert.equal(manager.sent.length, 2);
});

test('loop stops rather than blindly repeating after completion without a saved answer', async () => {
  const manager = new Manager();
  const loop = new PromptLoopController({ turnManager: manager });
  await loop.start({ threadId: 'thread', message: 'Continue' });
  manager.finish('completed', '');
  await until(() => loop.get('thread').status === 'failed');
  assert.match(loop.get('thread').reason, /without a saved response/);
  assert.equal(manager.sent.length, 1);
});


test('loop accepts the fileIds attachment alias only on its first iteration', async () => {
  const manager = new Manager();
  const loop = new PromptLoopController({ turnManager: manager, continuationDelayMs: 5 });
  await loop.start({ threadId: 'thread', message: 'Continue', fileIds: ['file'] });
  assert.deepEqual(manager.sent[0].params.attachments, ['file']);
  manager.finish('completed', 'More work');
  await until(() => manager.sent.length === 2);
  assert.deepEqual(manager.sent[1].params.attachments, []);
  assert.deepEqual(manager.sent[1].params.fileIds, []);
  await loop.stop('thread');
});

test('new loop binds later iterations to the observed conversation and browser client', async () => {
  const manager = new Manager();
  manager.sessionId = '';
  const loop = new PromptLoopController({ turnManager: manager, continuationDelayMs: 5 });
  const params = { message: 'Two steps', idempotencyKey: 'submission', project: { mode: 'package' } };
  const first = await loop.start(params);
  const replay = await loop.start(params);
  assert.equal(replay.turn.id, first.turn.id);
  assert.equal(manager.sent[0].params.newSession, true);
  assert.equal(manager.sent[0].params.sessionId, '');
  assert.equal(manager.sent.length, 1);
  manager.sessionId = 'created-conversation';
  manager.turns[0].output = {
    answer: 'Step one',
    response: { session: { id: manager.sessionId }, sourceClientId: 'extension:tab:42' },
  };
  manager.finish('completed', 'Step one');
  await until(() => manager.sent.length === 2);
  assert.equal(manager.sent[1].params.sessionId, manager.sessionId);
  assert.equal(manager.sent[1].params.sourceClientId, 'extension:tab:42');
  assert.equal(manager.sent[1].params.newSession, false);
  assert.equal(manager.sent[1].params.project, null);
  await loop.stop('new-thread');
});

test('stop during the continuation delay prevents the next submission', async () => {
  const manager = new Manager();
  const loop = new PromptLoopController({ turnManager: manager, continuationDelayMs: 40 });
  await loop.start({ threadId: 'thread', message: 'Two steps' });
  manager.finish('completed', 'First step');
  await until(() => loop.get('thread').nextIterationAt > 0);
  await loop.stop('thread');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(manager.sent.length, 1);
  assert.deepEqual(manager.cancelled, []);
});
