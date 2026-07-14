import test from 'node:test';
import assert from 'node:assert/strict';
import { VisibleProgressTracker } from '../src/visibleProgressTracker.js';

class MemoryMetadataStore {
  constructor() { this.items = new Map(); }
  async createItem(item) { const record = structuredClone(item); this.items.set(record.id, record); return structuredClone(record); }
  async updateItem(id, patch) {
    const current = this.items.get(id);
    const next = { ...current, ...structuredClone(patch), content: patch.content ? structuredClone(patch.content) : current.content };
    this.items.set(id, next);
    return structuredClone(next);
  }
}

test('visible progress tracker preserves cleared reasoning and stores each named phase separately', async () => {
  const metadataStore = new MemoryMetadataStore();
  const events = [];
  let sequence = 0;
  const tracker = new VisibleProgressTracker({
    metadataStore,
    threadId: 'thread-1',
    turnId: 'turn-1',
    createId: () => `item-${++sequence}`,
    record: async (type, data) => events.push({ type, data }),
  });

  await tracker.updateThinking('phase one partial', { type: 'thinking.snapshot' });
  await tracker.updateThinking('', { type: 'thinking.snapshot' });
  await tracker.updateItems([
    { id: 'phase-a', key: 'phase-a', kind: 'thinking', text: 'phase one complete', revision: 2, state: 'completed', active: false, visible: false },
    { id: 'tool-a', key: 'tool-a', kind: 'tool_status', text: 'inspecting files', revision: 1, state: 'completed', active: false, visible: false },
  ]);
  await tracker.updateItems([
    { id: 'phase-a', key: 'phase-a', kind: 'thinking', text: 'phase one complete', revision: 2, state: 'completed', active: false, visible: false },
    { id: 'phase-b', key: 'phase-b', kind: 'thinking', text: 'phase two partial', revision: 1, state: 'active', active: true, visible: true },
  ]);
  await tracker.finalize({
    thinking: '',
    progressItems: [{ id: 'phase-b', key: 'phase-b', kind: 'thinking', text: 'phase two complete', revision: 3, state: 'completed', active: false, visible: false }],
    reasoningHistory: [{ id: 'phase-a', key: 'phase-a', kind: 'thinking', text: 'phase one complete', revision: 2, state: 'completed', active: false, visible: false }],
  });

  const items = [...metadataStore.items.values()];
  const reasoning = items.filter((item) => item.type === 'reasoning');
  const progress = items.filter((item) => item.type === 'progress');
  assert.equal(reasoning.length, 2, 'snapshot reasoning should be adopted by phase-a rather than duplicated');
  assert.equal(progress.length, 1);
  assert.deepEqual(reasoning.map((item) => item.content.logicalId), ['phase-a', 'phase-b']);
  assert.deepEqual(reasoning.map((item) => item.content.text), ['phase one complete', 'phase two complete']);
  assert.ok(reasoning.every((item) => item.status === 'completed'));
  assert.ok(reasoning.every((item) => item.content.text.length > 0));
  assert.equal(progress[0].content.kind, 'tool_status');
  assert.equal(progress[0].content.text, 'inspecting files');
  assert.ok(events.some((event) => event.type === 'item/reasoning/completed'));
});

test('visible progress tracker does not overwrite a fallback phase with an empty final thinking value', async () => {
  const metadataStore = new MemoryMetadataStore();
  let sequence = 0;
  const tracker = new VisibleProgressTracker({
    metadataStore,
    threadId: 'thread-2',
    turnId: 'turn-2',
    createId: () => `item-${++sequence}`,
    record: async () => {},
  });
  await tracker.updateThinking('complete visible reasoning summary');
  await tracker.updateThinking('');
  await tracker.finalize({ thinking: '', reasoningHistory: [], progressItems: [] });
  const [item] = [...metadataStore.items.values()];
  assert.equal(item.status, 'completed');
  assert.equal(item.content.text, 'complete visible reasoning summary');
  assert.equal(item.content.active, false);
});
