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
