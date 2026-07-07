import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeInputAction } from '../src/interactiveInk.js';

test('decodeInputAction handles macOS delete/backspace distinction conservatively', () => {
  assert.equal(decodeInputAction('\u007f', { name: 'delete', delete: true }), 'backspace');
  assert.equal(decodeInputAction('\u001b[3~', { name: 'delete' }), 'delete');
  assert.equal(decodeInputAction('', { name: 'backspace', delete: true }), 'backspace');
  assert.equal(decodeInputAction('\u0008', { name: 'c-h' }), 'backspace');
});

test('decodeInputAction handles common readline control keys', () => {
  assert.equal(decodeInputAction('\u0001', {}), 'line-start');
  assert.equal(decodeInputAction('\u0005', {}), 'line-end');
  assert.equal(decodeInputAction('\u000b', {}), 'kill-line-right');
  assert.equal(decodeInputAction('\u0015', {}), 'kill-line-left');
  assert.equal(decodeInputAction('\u0017', {}), 'delete-word-left');
  assert.equal(decodeInputAction('\u0004', {}), 'delete-or-exit');
  assert.equal(decodeInputAction('\u000a', {}), 'submit');
  assert.equal(decodeInputAction('\u000d', {}), 'submit');
});

test('decodeInputAction handles macOS option/cmd arrow style escape sequences', () => {
  assert.equal(decodeInputAction('\u001bb', {}), 'word-left');
  assert.equal(decodeInputAction('\u001bf', {}), 'word-right');
  assert.equal(decodeInputAction('\u001b\u007f', {}), 'delete-word-left');
  assert.equal(decodeInputAction('\u001b[1;9D', {}), 'line-start');
  assert.equal(decodeInputAction('\u001b[1;9C', {}), 'line-end');
  assert.equal(decodeInputAction('', { meta: true, name: 'left' }), 'word-left');
  assert.equal(decodeInputAction('', { meta: true, name: 'right' }), 'word-right');
  assert.equal(decodeInputAction('\u0001', { meta: true, name: 'left' }), 'line-start');
  assert.equal(decodeInputAction('\u0005', { meta: true, name: 'right' }), 'line-end');
});
