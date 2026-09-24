import test from 'node:test';
import assert from 'node:assert/strict';
import { tabScopedClientId } from '../tools/chrome-bridge-extension/shared/tabClientIdentity.js';

test('tab-scoped client identity follows the physical tab across content runtime reloads', () => {
  assert.equal(tabScopedClientId('ext-before-navigation', 41), 'extension:tab:41');
  assert.equal(tabScopedClientId('ext-after-navigation', 41), 'extension:tab:41');
  assert.equal(tabScopedClientId('ext-before-navigation:tab:99', 41), 'extension:tab:41');
});

test('tab-scoped client identity separates tabs even when sessionStorage content ids are cloned', () => {
  const clonedContentId = 'ext-cloned-session';
  assert.equal(tabScopedClientId(clonedContentId, 41), 'extension:tab:41');
  assert.equal(tabScopedClientId(clonedContentId, 42), 'extension:tab:42');
});

test('tab-scoped client identity does not invent ownership without a browser tab id', () => {
  assert.equal(tabScopedClientId('ext-content', null), 'ext-content');
  assert.equal(tabScopedClientId('ext-content:tab:41', null), 'ext-content');
  assert.equal(tabScopedClientId('', null), '');
});
