import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isInterimAssistantText,
  isUsableFinalAssistantText,
  normalizeAssistantText,
} from '../src/answerState.js';

test('normalizeAssistantText trims whitespace and trailing ellipsis', () => {
  assert.equal(normalizeAssistantText('  Thinking...  '), 'Thinking');
  assert.equal(normalizeAssistantText(' Думаю… '), 'Думаю');
});

test('isInterimAssistantText detects standalone thinking statuses', () => {
  assert.equal(isInterimAssistantText('Thinking'), true);
  assert.equal(isInterimAssistantText('Thinking...'), true);
  assert.equal(isInterimAssistantText('Думаю'), true);
  assert.equal(isInterimAssistantText('Думаю…'), true);
});

test('isInterimAssistantText does not reject real answers that start with Думаю', () => {
  assert.equal(isInterimAssistantText('Думаю, это можно сделать так.'), false);
  assert.equal(isUsableFinalAssistantText('Thinking through the problem, the answer is 42.'), true);
});
