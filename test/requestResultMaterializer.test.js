import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestResultMaterializer } from '../src/bridge/coordinator/requestResultMaterializer.js';
import { RequestTerminalCode } from '../src/bridge/state/requestEvents.js';

function setup(artifacts = []) {
  const state = { requestId: 'request', answer: 'old stream', thinking: '', artifacts,
    events: [], resolve(value) { this.result = value; }, reject(error) { this.error = error; } };
  const pending = new Map([[state.requestId, state]]);
  const owner = { pending, artifacts: {}, runtime: { clear() {} }, emitRequestEvent() {} };
  return { state, owner, materializer: new RequestResultMaterializer(owner), canonical: { terminal: { code: RequestTerminalCode.COMPLETED } } };
}

test('canonical completion without terminal evidence rejects instead of hanging forever', async () => {
  const { state, owner, materializer, canonical } = setup();
  await materializer.finishFromCanonicalState(state, canonical);
  assert.equal(state.error.code, 'FINAL_RESPONSE_MISSING');
  assert.equal(owner.pending.size, 0);
});

test('canonical observation recovers a missing projection and preserves message ids', async () => {
  const { state, materializer, canonical } = setup();
  canonical.terminal.evidence = { answer: 'Final answer', turnKey: 'assistant-turn', messageId: 'assistant-id', submittedUserTurnKey: 'user-id' };
  await materializer.finishFromCanonicalState(state, canonical);
  assert.equal(state.result.answer, 'Final answer');
  assert.equal(state.result.messageId, 'assistant-id');
  assert.equal(state.result.userTurnKey, 'user-id');
});

test('artifact settlement failure terminates the runtime with a specific error', async () => {
  const { state, owner, materializer, canonical } = setup([{ id: 'image' }]);
  state.deferredDone = { answer: 'Final answer', metadata: {} };
  owner.artifacts.settled = async () => { throw new Error('capture failed'); };
  await materializer.finishFromCanonicalState(state, canonical);
  assert.equal(state.error.code, 'FINAL_ARTIFACT_SETTLEMENT_FAILED');
  assert.equal(owner.pending.size, 0);
});


test('a throwing terminal subscriber cannot lose the final response', async () => {
  const { state, owner, materializer, canonical } = setup();
  state.deferredDone = { answer: 'Final answer', metadata: {} };
  owner.emitRequestEvent = () => { throw new Error('subscriber disconnected'); };
  await materializer.finishFromCanonicalState(state, canonical);
  assert.equal(state.result.answer, 'Final answer');
  assert.equal(owner.pending.size, 0);
});

test('a throwing error subscriber cannot prevent request rejection', async () => {
  const { state, owner, materializer } = setup();
  owner.emitRequestEvent = () => { throw new Error('subscriber disconnected'); };
  materializer.finish(state, new Error('actual request failure'));
  assert.equal(state.error.message, 'actual request failure');
  assert.equal(owner.pending.size, 0);
});
