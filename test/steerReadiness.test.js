import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForSteerReadiness } from '../src/bridge/coordinator/steerReadiness.js';

test('steer readiness opens as soon as canonical generation is active', async () => {
  const state = { done: false, answer: '', thinking: '', progressText: '', progress: {} };
  const lifecycle = { getState() { return { submission: 'submitted', generation: 'active' }; } };
  const ready = await waitForSteerReadiness({
    requestId: 'steer-active', state, lifecycle, timeoutMs: 100, steerReadyTimeoutMs: 100, pollMs: 5,
  });
  assert.equal(ready.steerReadiness.canonicalGeneration, true);
  assert.equal(ready.steerReadiness.semanticProgress, false);
  assert.equal(ready.steerReadiness.explicitControl, false);
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
