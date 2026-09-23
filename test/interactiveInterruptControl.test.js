import test from 'node:test';
import assert from 'node:assert/strict';
import { handleInteractiveInterrupt } from '../src/interactive/interruptControl.js';

test('idle interactive Ctrl+C exits immediately without workflow compatibility state', () => {
  let exited = 0;
  const runtime = {
    abortController: null,
    detachOnExit: false,
    exit() { exited += 1; },
    invalidate() {},
  };

  handleInteractiveInterrupt(runtime);
  assert.equal(exited, 1);
  assert.equal(runtime.detachOnExit, false);
});

test('active interactive Ctrl+C opens the request interrupt prompt instead of exiting', () => {
  let exited = 0;
  const runtime = {
    abortController: new AbortController(),
    interruptPrompt: null,
    detachOnExit: false,
    exit() { exited += 1; },
    invalidate() {},
  };

  handleInteractiveInterrupt(runtime);
  assert.equal(exited, 0);
  assert.ok(runtime.interruptPrompt);
});
