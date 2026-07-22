import test from 'node:test';
import assert from 'node:assert/strict';

import {
  alternativeSelectionOption,
  selectionOptionMatches,
} from '../scripts/e2e/intelligence-selection.js';

test('selection matching distinguishes a model from a longer prefixed label', () => {
  const current = { id: 'model-gpt-mock', label: 'GPT Mock', value: 'GPT Mock' };
  const thinking = { id: 'model-gpt-mock-thinking', label: 'GPT Mock Thinking', value: 'GPT Mock Thinking' };

  assert.equal(selectionOptionMatches(current, 'GPT Mock'), true);
  assert.equal(selectionOptionMatches(current, 'GPT Mock Thinking'), false);
  assert.equal(selectionOptionMatches(thinking, 'GPT Mock Thinking'), true);
});

test('selection matching accepts structural id prefixes without fuzzy visible-label matching', () => {
  assert.equal(selectionOptionMatches({ id: 'effort-high' }, 'high'), true);
  assert.equal(selectionOptionMatches({ id: 'model-gpt-5-thinking' }, 'GPT 5 Thinking'), true);
  assert.equal(selectionOptionMatches({ label: 'GPT 5' }, 'GPT 5 Thinking'), false);
});

test('alternative selection returns the longer distinct model option', () => {
  const current = { id: 'model-gpt-mock', label: 'GPT Mock', value: 'GPT Mock' };
  const options = [
    { ...current, selected: true },
    { id: 'model-gpt-mock-thinking', label: 'GPT Mock Thinking', value: 'GPT Mock Thinking', selected: false },
  ];

  assert.equal(alternativeSelectionOption(options, current)?.value, 'GPT Mock Thinking');
});
