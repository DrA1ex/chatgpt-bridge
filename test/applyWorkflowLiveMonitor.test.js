import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplyWorkflowLiveMonitor } from '../src/interactive/applyWorkflowLiveMonitor.js';
import { transcriptBodyText } from '../src/interactive/view.js';

function createRuntime(workflows) {
  return {
    entries: [],
    sequence: 0,
    invalidations: 0,
    options: { workflowManager: { list: () => workflows } },
    pushEntry(entry) {
      const created = { id: `entry-${++this.sequence}`, ...entry };
      this.entries.push(created);
      return created;
    },
    invalidate() { this.invalidations += 1; },
  };
}

function snapshot(overrides = {}) {
  return {
    type: 'watch.turn.snapshot',
    data: {
      sourceClientId: 'client-1', sessionId: 'session-1', turnKey: 'turn-1', userTurnKey: 'user-1',
      userPrompt: 'Please update the project', reasoning: 'Inspecting files', progress: 'Running checks',
      answer: 'I am preparing the archive.', terminal: false,
      ...overrides,
    },
  };
}

test('apply workflow live monitor prints and updates tab prompts, reasoning, and full answers without duplicates', () => {
  const workflows = [{ id: 'apply-1', label: 'Apply changes', preset: 'apply-changes', lifecycle: 'ready', binding: { clientId: 'client-1', sessionId: 'session-1' } }];
  const runtime = createRuntime(workflows);
  const monitor = new ApplyWorkflowLiveMonitor(runtime);
  assert.equal(monitor.handle(snapshot()), true);
  assert.equal(runtime.entries.length, 3);
  assert.deepEqual(runtime.entries.map((entry) => entry.title), [
    'ChatGPT tab · User', 'ChatGPT · Reasoning · streaming', 'ChatGPT · Answer · streaming',
  ]);
  assert.match(runtime.entries[1].body, /Inspecting files\nRunning checks/);

  const longAnswer = 'x'.repeat(20_000);
  monitor.handle(snapshot({ reasoning: 'Inspection complete', progress: '', answer: longAnswer, terminal: true }));
  assert.equal(runtime.entries.length, 3);
  assert.equal(runtime.entries[1].title, 'ChatGPT · Reasoning');
  assert.equal(runtime.entries[2].title, 'ChatGPT · Answer');
  assert.equal(runtime.entries[2].body.length, 20_000);
  assert.equal(transcriptBodyText(runtime.entries[2]).length, 20_000);
});

test('apply workflow live monitor ignores other presets and mismatched tabs', () => {
  const workflows = [{ id: 'guided-1', preset: 'guided-task', lifecycle: 'ready', binding: { clientId: 'client-1', sessionId: 'session-1' } }];
  const runtime = createRuntime(workflows);
  const monitor = new ApplyWorkflowLiveMonitor(runtime);
  assert.equal(monitor.handle(snapshot()), false);
  workflows[0] = { id: 'apply-1', preset: 'apply-changes', lifecycle: 'ready', binding: { clientId: 'client-other', sessionId: 'session-1' } };
  assert.equal(monitor.handle(snapshot()), false);
  assert.equal(runtime.entries.length, 0);
});


test('apply workflow live monitor combines multiple assistant containers for the same user turn', () => {
  const workflows = [{ id: 'apply-1', label: 'Apply changes', preset: 'apply-changes', lifecycle: 'ready', binding: { clientId: 'client-1', sessionId: 'session-1' } }];
  const runtime = createRuntime(workflows);
  const monitor = new ApplyWorkflowLiveMonitor(runtime);
  monitor.handle(snapshot({ turnKey: 'reasoning-turn', userTurnKey: 'user-shared', reasoning: 'First reasoning block', progress: '', answer: '' }));
  monitor.handle(snapshot({ turnKey: 'answer-turn', userTurnKey: 'user-shared', reasoning: 'Second reasoning block', progress: '', answer: 'Final answer', terminal: true }));
  assert.equal(runtime.entries.filter((entry) => entry.kind === 'user').length, 1);
  assert.equal(runtime.entries.length, 3);
  assert.equal(runtime.entries.find((entry) => entry.title === 'ChatGPT · Reasoning').body, 'First reasoning block\nSecond reasoning block');
  assert.equal(runtime.entries.find((entry) => entry.title === 'ChatGPT · Answer').body, 'Final answer');
});

test('apply workflow live monitor keeps only the current browser turn and never edits the local prompt editor', () => {
  const workflows = [{ id: 'apply-1', label: 'Apply changes', preset: 'apply-changes', lifecycle: 'ready', binding: { clientId: 'client-1', sessionId: 'session-1' } }];
  const runtime = createRuntime(workflows);
  runtime.editor = { value: 'local draft must stay here' };
  runtime.entries.push({ id: 'entry-local', kind: 'command', title: '/workflow', body: 'Watching' });
  const monitor = new ApplyWorkflowLiveMonitor(runtime);

  monitor.handle(snapshot({ userTurnKey: 'user-old', turnKey: 'assistant-old', userPrompt: 'Old observed prompt', reasoning: '', progress: '', answer: 'Old answer', terminal: true }));
  assert.equal(runtime.entries.filter((entry) => entry.title === 'ChatGPT tab · User').length, 1);

  monitor.handle(snapshot({ userTurnKey: 'user-current', turnKey: 'user-current', userPrompt: 'Current browser prompt', reasoning: '', progress: '', answer: '', phase: 'waiting-for-assistant', terminal: false }));
  const mirrored = runtime.entries.filter((entry) => /^ChatGPT/.test(entry.title));
  assert.deepEqual(mirrored.map((entry) => [entry.title, entry.body]), [['ChatGPT tab · User', 'Current browser prompt']]);
  assert.equal(runtime.entries.some((entry) => entry.id === 'entry-local'), true, 'non-monitor transcript entries must remain');
  assert.equal(runtime.editor.value, 'local draft must stay here');
  const activity = monitor.activityFor(workflows[0]);
  assert.equal(activity.active, true);
  assert.equal(activity.phase, 'waiting-for-assistant');
  assert.equal(activity.userPrompt, 'Current browser prompt');
});
