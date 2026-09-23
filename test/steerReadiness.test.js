import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForSteerReadiness } from '../src/bridge/coordinator/steerReadiness.js';

test('steer readiness does not open on generation-start alone', async () => {
  const state = { done: false, answer: '', thinking: '', progressText: '', progress: {} };
  const lifecycle = { getState() { return { submission: 'submitted', generation: 'active' }; } };
  setTimeout(() => { state.thinking = 'first reasoning progress'; }, 40);
  const ready = await waitForSteerReadiness({
    requestId: 'steer-progress', state, lifecycle, timeoutMs: 1_000, steerReadyTimeoutMs: 1_000, pollMs: 5,
  });
  assert.equal(ready.steerReadiness.semanticProgress, true);
});

test('explicit send control can prove steer readiness before text projection arrives', async () => {
  const state = { done: false, answer: '', thinking: '', progressText: '', progress: { sendButtonVisible: true } };
  const lifecycle = { getState() { return { submission: 'submitted', generation: 'active' }; } };
  const ready = await waitForSteerReadiness({
    requestId: 'steer-control', state, lifecycle, timeoutMs: 100, steerReadyTimeoutMs: 100, pollMs: 5,
  });
  assert.equal(ready.steerReadiness.explicitControl, true);
});

test('steer readiness reports completion before a steer window opens', async () => {
  const state = { done: true, answer: '', thinking: '', progressText: '', progress: {} };
  const lifecycle = { getState() { return { submission: 'submitted', generation: 'stopped' }; } };
  await assert.rejects(() => waitForSteerReadiness({
    requestId: 'steer-finished', state, lifecycle, timeoutMs: 100, steerReadyTimeoutMs: 100, pollMs: 5,
  }), (error) => error.code === 'REQUEST_COMPLETED_BEFORE_STEER');
});
