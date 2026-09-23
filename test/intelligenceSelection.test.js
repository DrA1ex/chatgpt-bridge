import test from 'node:test';
import assert from 'node:assert/strict';

import {
  alternativeSelectionOption,
  selectionOptionMatches,
} from '../scripts/e2e/intelligence-selection.js';

test('selection matching distinguishes a model from a longer prefixed label', () => {
  const current = { id: 'model-gpt-5-6-sol', label: 'GPT-5.6 Sol', value: 'GPT-5.6 Sol' };
  const thinking = { id: 'model-gpt-5-6-thinking', label: 'GPT-5.6 Thinking', value: 'GPT-5.6 Thinking' };

  assert.equal(selectionOptionMatches(current, 'GPT-5.6 Sol'), true);
  assert.equal(selectionOptionMatches(current, 'GPT-5.6 Thinking'), false);
  assert.equal(selectionOptionMatches(thinking, 'GPT-5.6 Thinking'), true);
});

test('selection matching accepts structural id prefixes without fuzzy visible-label matching', () => {
  assert.equal(selectionOptionMatches({ id: 'effort-high' }, 'high'), true);
  assert.equal(selectionOptionMatches({ id: 'model-gpt-5-thinking' }, 'GPT 5 Thinking'), true);
  assert.equal(selectionOptionMatches({ label: 'GPT 5' }, 'GPT 5 Thinking'), false);
});

test('alternative selection returns the longer distinct model option', () => {
  const current = { id: 'model-gpt-5-6-sol', label: 'GPT-5.6 Sol', value: 'GPT-5.6 Sol' };
  const options = [
    { ...current, selected: true },
    { id: 'model-gpt-5-6-thinking', label: 'GPT-5.6 Thinking', value: 'GPT-5.6 Thinking', selected: false },
  ];

  assert.equal(alternativeSelectionOption(options, current)?.value, 'GPT-5.6 Thinking');
});
