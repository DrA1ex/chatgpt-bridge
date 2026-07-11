import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

async function loadCore() {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/domParserCore.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: 'domParserCore.js' });
  return context.ChatGptDomParserCore;
}

test('artifact parser recognizes filenames used by button-only ChatGPT file cards', async () => {
  const core = await loadCore();
  assert.equal(core.extractFileLikeName('artifact-single.txt'), 'artifact-single.txt');
  assert.equal(core.extractFileLikeName('Скачать artifact-table.csv'), 'artifact-table.csv');
  assert.equal(core.extractFileLikeName('artifact-data.json готов'), 'artifact-data.json');
  assert.equal(core.extractFileLikeName('Download quarterly report 2026.csv'), 'quarterly report 2026.csv');
  assert.equal(core.extractFileLikeName('ordinary sentence without a file'), '');
  assert.equal(core.extractFileLikeName('GPT-5.6'), '');
});

test('artifact phase separates generating, ready, and failed file cards', async () => {
  const core = await loadCore();
  assert.equal(core.classifyArtifactPhase({ text: 'Creating report.csv', busy: true }), 'GENERATING');
  assert.equal(core.classifyArtifactPhase({ text: 'report.csv', downloadActionPresent: true, downloadable: true }), 'READY');
  assert.equal(core.classifyArtifactPhase({ text: 'Failed to create report.csv' }), 'FAILED');
  assert.equal(core.allArtifactsReady([{ phase: 'READY' }, { phase: 'READY' }]), true);
  assert.equal(core.allArtifactsReady([{ phase: 'READY' }, { phase: 'GENERATING' }]), false);
});

test('artifact state participates in the DOM stability signature', async () => {
  const core = await loadCore();
  const base = {
    phase: core.PHASE.ASSISTANT_FINAL,
    turnKey: 'turn-1',
    answer: 'done',
    artifacts: [{ id: 'a', name: 'report.csv', phase: 'GENERATING', downloadable: false }],
    visibleBlocks: [],
  };
  assert.notEqual(
    core.buildSnapshotSignature(base),
    core.buildSnapshotSignature({ ...base, artifacts: [{ ...base.artifacts[0], phase: 'READY', downloadable: true }] }),
  );
});
