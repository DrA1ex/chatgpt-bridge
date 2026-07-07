import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendOnlyDelta, deltaFromPrevious } from '../src/protocol.js';

test('appendOnlyDelta returns only safe suffixes', () => {
  assert.equal(appendOnlyDelta('', 'hello'), 'hello');
  assert.equal(appendOnlyDelta('hel', 'hello'), 'lo');
  assert.equal(appendOnlyDelta('hello', 'hello'), '');
});

test('appendOnlyDelta refuses replacement-style updates', () => {
  assert.equal(appendOnlyDelta('hello world', 'rewritten answer'), '');
  assert.equal(deltaFromPrevious('hello world', 'rewritten answer'), '');
});
