import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InteractiveIntelligenceSync,
  desiredIntelligence,
  intelligenceMatches,
  intelligenceSnapshot,
} from '../src/interactive/intelligenceSync.js';

function runtimeFixture({
  selectedEffort = 'high',
  applyResult = null,
  listModelsError = null,
  listModelsFailures = 0,
} = {}) {
  const calls = [];
  let remainingListModelsFailures = listModelsFailures;
  const runtime = {
    state: {
      projectRoot: '/tmp/project', sessionId: 'session-1',
      model: 'Project model', effort: 'medium', currentModel: '', currentEffort: '',
    },
    entries: [],
    invalidations: 0,
    saves: 0,
    options: {
      bridge: {
        health: () => ({ ok: true, activeClient: { id: 'client-1', session: { id: 'session-1' } }, clients: [{ id: 'client-1' }] }),
        async listModels(options) {
          calls.push(['listModels', options]);
          const shouldFail = listModelsError && (listModelsFailures === 0 || remainingListModelsFailures-- > 0);
          if (shouldFail) throw listModelsError;
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

test('intelligence helpers use only persisted project model and effort preferences', () => {
  const state = { model: 'project-model', effort: 'medium' };
  assert.deepEqual(desiredIntelligence({ state }), {
    model: 'project-model', effort: 'medium',
  });
  const snapshot = intelligenceSnapshot({
    models: [{ label: 'GPT-5.6 Thinking', selected: true }],
    efforts: [{ id: 'x-high', selected: true }],
  });
  assert.equal(snapshot.model, 'GPT-5.6 Thinking');
  assert.equal(snapshot.effort, 'xhigh');
  assert.equal(intelligenceMatches('X-High', 'xhigh'), true);
});

test('connection intelligence sync reads model and effort and immediately applies the saved project effort', async () => {
  const { runtime, calls } = runtimeFixture({ selectedEffort: 'high' });
  const sync = new InteractiveIntelligenceSync(runtime);
  const result = await sync.sync('browser connected', { force: true });

  assert.equal(result.model, 'GPT-5.6 Thinking');
  assert.equal(runtime.state.currentModel, 'GPT-5.6 Thinking');
  assert.equal(runtime.state.currentEffort, 'medium');
  assert.deepEqual(calls.map((call) => call[0]), ['listModels', 'listEfforts', 'applyIntelligence']);
  assert.deepEqual(calls[2][1], { effort: 'medium' });
  assert.equal(calls[0][1].sourceClientId, 'client-1');
  assert.match(runtime.entries[0].body, /Project setting applied/);
  assert.equal(runtime.saves, 1);
});

test('connection intelligence sync only observes when the current effort already matches', async () => {
  const { runtime, calls } = runtimeFixture({ selectedEffort: 'medium' });
  const sync = new InteractiveIntelligenceSync(runtime);
  await sync.sync('browser connected', { force: true });
  assert.deepEqual(calls.map((call) => call[0]), ['listModels', 'listEfforts']);
  assert.equal(runtime.state.currentModel, 'GPT-5.6 Thinking');
  assert.equal(runtime.state.currentEffort, 'medium');
  assert.equal(runtime.entries.length, 0);
});


test('connection intelligence sync keeps retrying while the ChatGPT tab remains connected', async () => {
  const { runtime } = runtimeFixture({ listModelsError: new Error('Timed out waiting for models.list response after 12000ms') });
  const sync = new InteractiveIntelligenceSync(runtime);
  const result = await sync.sync('interactive startup', { force: true });
  assert.equal(result, null);
  assert.equal(runtime.entries.some((entry) => entry.kind === 'error'), false);
  assert.equal(runtime.entries.some((entry) => entry.title === 'Waiting for ChatGPT model/effort'), true);
  assert.equal(runtime.state.intelligenceSyncStatus, 'waiting');
  assert.ok(sync.timer, 'a connected-tab retry should be scheduled');
  sync.close();
});

test('connection intelligence sync closes the waiting notice after a retry succeeds', async () => {
  const { runtime } = runtimeFixture({
    selectedEffort: 'medium',
    listModelsError: new Error('Timed out waiting for models.list response after 12000ms'),
    listModelsFailures: 1,
  });
  const sync = new InteractiveIntelligenceSync(runtime);

  const first = await sync.sync('interactive startup', { force: true });
  assert.equal(first, null);
  assert.equal(runtime.state.intelligenceSyncStatus, 'waiting');
  assert.equal(runtime.entries.at(-1)?.title, 'Waiting for ChatGPT model/effort');

  clearTimeout(sync.timer);
  sync.timer = null;
  const second = await sync.sync('connected tab intelligence retry', { force: true });

  assert.equal(second.effort, 'medium');
  assert.equal(runtime.state.intelligenceSyncStatus, 'ready');
  assert.equal(runtime.state.intelligenceSyncMessage, '');
  assert.equal(runtime.entries.at(-1)?.title, 'ChatGPT model/effort ready');
  assert.match(runtime.entries.at(-1)?.body || '', /finished loading/i);
  sync.close();
});

test('model and effort timeout keeps retrying for a connected startup tab', async () => {
  const { runtime } = runtimeFixture({ listModelsError: new Error('Timed out waiting for models.list response after 12000ms') });
  const sync = new InteractiveIntelligenceSync(runtime);
  await sync.sync('interactive startup', { force: true });
  assert.equal(runtime.entries.some((entry) => entry.kind === 'error'), false);
  assert.equal(runtime.state.intelligenceSyncStatus, 'waiting');
  assert.ok(sync.timer);
  sync.close();
});

test('startup DOM readiness error keeps retrying while the ChatGPT tab remains connected', async () => {
  const { runtime } = runtimeFixture({
    listModelsError: new Error('DOM_SCHEMA_CHANGED: intelligence picker content was not found.'),
  });
  const sync = new InteractiveIntelligenceSync(runtime);
  await sync.sync('interactive startup', { force: true });
  assert.equal(runtime.entries.some((entry) => entry.kind === 'error'), false);
  assert.equal(runtime.state.intelligenceSyncStatus, 'waiting');
  assert.ok(sync.timer);
  sync.close();
});

test('permanent model and effort errors remain visible', async () => {
  const { runtime } = runtimeFixture({ listModelsError: new Error('Permission denied') });
  const sync = new InteractiveIntelligenceSync(runtime);
  await sync.sync('interactive startup', { force: true });
  assert.equal(runtime.entries.some((entry) => entry.kind === 'error' && entry.title === 'Could not read ChatGPT model/effort'), true);
  assert.equal(runtime.state.intelligenceSyncStatus, 'error');
  sync.close();
});
