import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effortsListResult,
  intelligenceApplyResult,
  modelsListResult,
  preparationEffectResult,
} from '../scripts/e2e/mock-chatgpt/command-results.js';

const intelligence = {
  models: [
    { id: 'model-a', label: 'Model A', value: 'Model A', selected: false },
    { id: 'model-b', label: 'Model B', value: 'Model B', selected: true },
  ],
  efforts: [
    { id: 'effort-low', label: 'low', value: 'low', selected: true },
    { id: 'effort-high', label: 'high', value: 'high', selected: false },
  ],
  selectedModel: { id: 'model-b', label: 'Model B', value: 'Model B' },
  selectedEffort: { id: 'effort-low', label: 'low', value: 'low' },
};

test('mock model and effort list results match BridgeOperations contracts', () => {
  assert.deepEqual(modelsListResult(intelligence), {
    models: intelligence.models,
    current: intelligence.selectedModel,
    intelligence,
  });
  assert.deepEqual(effortsListResult(intelligence), {
    efforts: intelligence.efforts,
    current: intelligence.selectedEffort,
    intelligence,
  });
});

test('mock intelligence apply result reports exact requested fields and verified state', () => {
  assert.deepEqual(intelligenceApplyResult(intelligence, { model: 'Model B', effort: 'low' }), {
    model: 'Model B',
    effort: 'low',
    modelApplied: true,
    effortApplied: true,
    warnings: [],
    intelligence,
  });
  assert.deepEqual(intelligenceApplyResult(intelligence, { effort: 'high' }), {
    model: 'Model B',
    effort: 'high',
    modelApplied: false,
    effortApplied: true,
    warnings: [],
    intelligence,
  });
});

test('mock preparation effects preserve model, attachment, and session evidence', () => {
  const model = preparationEffectResult('model.apply', { intelligence, options: { model: 'Model B' } });
  assert.equal(model.modelApplied, true);
  assert.equal(model.effortApplied, false);
  assert.equal(model.intelligence, intelligence);

  const attachments = [{ id: 'a.txt', name: 'a.txt' }];
  assert.deepEqual(preparationEffectResult('attachments.upload', { attachments }), {
    completed: true,
    uploaded: 1,
    attachments,
  });

  const session = { id: 'session-local', url: 'https://chatgpt.com/c/session-local' };
  assert.deepEqual(preparationEffectResult('session.apply', { session }), { completed: true, session });
});
