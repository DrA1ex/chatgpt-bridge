import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InteractiveIntelligenceSync,
  desiredIntelligence,
  intelligenceMatches,
  intelligenceSnapshot,
  selectIntelligenceWorkflow,
} from '../src/interactive/intelligenceSync.js';

function workflow(overrides = {}) {
  return {
    id: 'apply-1',
    label: 'Apply changes',
    preset: 'apply-changes',
    projectRoot: '/tmp/project',
    clientId: 'client-1',
    sessionId: 'session-1',
    watcher: { status: 'running' },
    intelligence: { model: 'GPT-5.6 Thinking', effort: 'xhigh' },
    ...overrides,
  };
}

function runtimeFixture({ workflows = [workflow()], selectedEffort = 'high', applyResult = null } = {}) {
  const calls = [];
  const runtime = {
    state: {
      projectRoot: '/tmp/project', sessionId: 'session-1', focusedWorkflowId: 'apply-1',
      model: 'Project model', effort: 'medium', currentModel: '', currentEffort: '',
    },
    entries: [],
    invalidations: 0,
    saves: 0,
    options: {
      workflowManager: { list: () => workflows },
      bridge: {
        health: () => ({ ok: true, activeClient: { id: 'client-1', session: { id: 'session-1' } }, clients: [{ id: 'client-1' }] }),
        async listModels(options) {
          calls.push(['listModels', options]);
          return {
            models: [{ id: 'gpt-5-6-thinking', label: 'GPT-5.6 Thinking', selected: true }],
            current: { id: 'gpt-5-6-thinking', label: 'GPT-5.6 Thinking', selected: true },
            intelligence: { selectedModel: { id: 'gpt-5-6-thinking', label: 'GPT-5.6 Thinking', selected: true } },
          };
        },
        async listEfforts(options) {
          calls.push(['listEfforts', options]);
          return {
            efforts: [{ id: selectedEffort, value: selectedEffort, label: selectedEffort, selected: true }],
            current: { id: selectedEffort, value: selectedEffort, label: selectedEffort, selected: true },
            intelligence: { selectedEffort: { id: selectedEffort, value: selectedEffort, label: selectedEffort, selected: true } },
          };
        },
        async applyIntelligence(values, options) {
          calls.push(['applyIntelligence', values, options]);
          return applyResult || {
            model: '', effort: values.effort, modelApplied: false, effortApplied: true, warnings: [],
            intelligence: {
              models: [{ id: 'gpt-5-6-thinking', label: 'GPT-5.6 Thinking', selected: true }],
              efforts: [{ id: values.effort, value: values.effort, label: values.effort, selected: true }],
              selectedModel: { id: 'gpt-5-6-thinking', label: 'GPT-5.6 Thinking', selected: true },
              selectedEffort: { id: values.effort, value: values.effort, label: values.effort, selected: true },
            },
          };
        },
      },
    },
    pushEntry(entry) { this.entries.push(entry); return entry; },
    invalidate() { this.invalidations += 1; },
    async saveState() { this.saves += 1; },
  };
  return { runtime, calls };
}

test('intelligence helpers prefer the active focused workflow and normalize selected values', () => {
  const workflows = [
    workflow({ id: 'other', clientId: 'other-client' }),
    workflow(),
  ];
  const state = { projectRoot: '/tmp/project', sessionId: 'session-1', focusedWorkflowId: 'apply-1', model: 'project-model', effort: 'medium' };
  const health = { activeClient: { id: 'client-1', session: { id: 'session-1' } } };
  assert.equal(selectIntelligenceWorkflow(workflows, { state, health }).id, 'apply-1');
  assert.deepEqual(desiredIntelligence({ state, workflows, health }), {
    workflow: workflows[1], model: 'GPT-5.6 Thinking', effort: 'xhigh',
  });
  const snapshot = intelligenceSnapshot({
    models: [{ label: 'GPT-5.6 Thinking', selected: true }],
    efforts: [{ id: 'x-high', selected: true }],
  });
  assert.equal(snapshot.model, 'GPT-5.6 Thinking');
  assert.equal(snapshot.effort, 'xhigh');
  assert.equal(intelligenceMatches('X-High', 'xhigh'), true);
});

test('connection intelligence sync reads model and effort and immediately applies the saved workflow effort', async () => {
  const { runtime, calls } = runtimeFixture({ selectedEffort: 'high' });
  const sync = new InteractiveIntelligenceSync(runtime);
  const result = await sync.sync('browser connected', { force: true });

  assert.equal(result.model, 'GPT-5.6 Thinking');
  assert.equal(runtime.state.currentModel, 'GPT-5.6 Thinking');
  assert.equal(runtime.state.currentEffort, 'xhigh');
  assert.deepEqual(calls.map((call) => call[0]), ['listModels', 'listEfforts', 'applyIntelligence']);
  assert.deepEqual(calls[2][1], { effort: 'xhigh' });
  assert.equal(calls[0][1].sourceClientId, 'client-1');
  assert.match(runtime.entries[0].body, /high → xhigh/);
  assert.equal(runtime.saves, 1);
});

test('connection intelligence sync only observes when the current effort already matches', async () => {
  const { runtime, calls } = runtimeFixture({ selectedEffort: 'xhigh' });
  const sync = new InteractiveIntelligenceSync(runtime);
  await sync.sync('browser connected', { force: true });
  assert.deepEqual(calls.map((call) => call[0]), ['listModels', 'listEfforts']);
  assert.equal(runtime.state.currentModel, 'GPT-5.6 Thinking');
  assert.equal(runtime.state.currentEffort, 'xhigh');
  assert.equal(runtime.entries.length, 0);
});
