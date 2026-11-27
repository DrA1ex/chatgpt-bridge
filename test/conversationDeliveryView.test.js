import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateLocalDelivery, mergeConversationItems } from '../src/turn/conversationHistoryView.js';

const user = { id: 'local', threadId: 'thread', turnId: 'turn', type: 'user_message', status: 'completed', content: { text: 'Continue' } };
const remoteId = '12345678-1234-1234-1234-123456789abc';
const remote = { id: 'remote', threadId: 'thread', turnId: 'remote', type: 'user_message', status: 'completed', content: { text: 'Continue', sourceMessageId: remoteId } };
const failed = { id: 'turn', status: 'failed', startedAt: '2026-01-01', error: { message: 'Timeout' } };

test('a queued cancelled prompt is not sent, a failed started one is unconfirmed', async () => {
  const [unconfirmed] = await annotateLocalDelivery([user], [failed], async () => []);
  assert.equal(unconfirmed.delivery.state, 'unconfirmed');
  const [notSent] = await annotateLocalDelivery([user], [{ ...failed, startedAt: '' }], async () => []);
  assert.equal(notSent.delivery.state, 'not_sent');
  assert.equal(mergeConversationItems([remote], [unconfirmed]).length, 2);
});

test('native submission evidence reconciles failed responses without a red duplicate', async () => {
  const events = [{ type: 'request.effect.succeeded', data: { effectType: 'prompt.submit', result: { submittedUserTurnKey: remoteId } } }];
  const [accepted] = await annotateLocalDelivery([user], [failed], async () => events);
  assert.equal(accepted.delivery.state, 'confirmed');
  const merged = mergeConversationItems([remote], [accepted]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, user.id);
  assert.equal(merged[0].delivery.state, 'confirmed');
});

test('dismissed local attempt stays hidden but its artifact and canonical message survive', async () => {
  const [unconfirmed] = await annotateLocalDelivery([{ ...user, content: { ...user.content, historyDismissed: true } }], [failed], async () => []);
  const artifact = { id: 'artifact', turnId: 'turn', threadId: 'thread', type: 'artifact' };
  const merged = mergeConversationItems([remote], [unconfirmed, artifact]);
  assert.deepEqual(merged.map(item => item.id), ['remote', 'artifact']);
});


test('a later exact native match wins over an older text-only local attempt', () => {
  const old = { ...user, id: 'legacy', turnId: 'legacy' };
  const exact = { ...user, id: 'exact', turnId: 'exact', content: { ...user.content, sourceMessageId: remoteId } };
  const items = mergeConversationItems([remote], [old, exact]);
  assert.equal(items[0].id, 'exact');
  assert.equal(items[0].delivery.state, 'confirmed');
  assert.equal(items[1].id, 'legacy');
});

test('two legacy turns cannot consume one canonical message by arbitrary order', () => {
  const duplicate = { ...user, id: 'duplicate', turnId: 'duplicate' };
  const items = mergeConversationItems([remote], [user, duplicate]);
  assert.deepEqual(items.map(item => item.id), ['remote', 'local', 'duplicate']);
});

test('a repeated external prompt with a new native ID is visible during generation', () => {
  const answer = { ...remote, id: 'remote-answer', type: 'agent_message', content: { text: 'Previous answer' } };
  const liveId = '12345678-1234-1234-1234-123456789abd';
  const live = [{ id: liveId, role: 'user', text: 'Continue' }, { id: 'live-answer', role: 'assistant', text: 'New response' }];
  const items = mergeConversationItems([remote, answer], [], live);
  assert.deepEqual(items.map(item => item.content.text), ['Continue', 'Previous answer', 'Continue', 'New response']);
  assert.equal(items.at(-1).status, 'in_progress');
});

test('queued identical local prompt does not borrow an older canonical answer', async () => {
  const local = await annotateLocalDelivery([user], [{ id: user.turnId, status: 'queued' }], async () => []);
  const items = mergeConversationItems([remote], local);
  assert.equal(items.length, 2);
  assert.equal(items[1].delivery.state, 'pending');
});
