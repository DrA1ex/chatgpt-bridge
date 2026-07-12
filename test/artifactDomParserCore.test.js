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
  assert.deepEqual(Array.from(core.extractFileLikeNames('Changed index.js; download project-result.zip')), ['index.js', 'project-result.zip']);
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

test('text artifact preview selects the structural download control without localized action labels', async () => {
  const core = await loadCore();
  const fixture = await fs.readFile(path.resolve('test/fixtures/chat-dom/artifact-text-preview.html'), 'utf8');
  const dialogLabel = fixture.match(/role="dialog"[^>]*aria-label="([^"]+)"/)?.[1] || '';
  const heading = fixture.match(/<h2>([^<]+)<\/h2>/)?.[1] || '';
  const previewIds = Array.from(fixture.matchAll(/id="(artifact-text-preview-[^"]+)"/g), (match) => match[1]);
  const header = fixture.match(/<header>([\s\S]*?)<\/header>/)?.[1] || '';
  const controls = Array.from(header.matchAll(/<(button|a)\b([^>]*)>/g), (match) => ({
    tagName: match[1],
    testId: match[2].match(/data-testid="([^"]+)"/)?.[1] || '',
    hasDownloadAttribute: /\sdownload(?:=|\s|>)/.test(match[2]),
  }));

  const plan = core.planArtifactPreviewDownload({
    desiredName: 'eeb90261d0ea-one.txt',
    dialogLabel,
    heading,
    previewIds,
    controls,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.source, 'two_control_text_preview');
  assert.equal(plan.downloadControlIndex, 0);
  assert.equal(plan.closeControlIndex, 1);
  assert.equal(plan.textPreview, true);
});

test('artifact preview planning is fail-closed for mismatched files or ambiguous controls', async () => {
  const core = await loadCore();
  assert.equal(core.planArtifactPreviewDownload({
    desiredName: 'wanted.txt',
    dialogLabel: 'other.txt',
    heading: 'other.txt',
    previewIds: ['artifact-text-preview-other.txt'],
    controls: [{ tagName: 'button' }, { tagName: 'button' }],
  }).reason, 'preview_filename_mismatch');

  assert.equal(core.planArtifactPreviewDownload({
    desiredName: 'wanted.txt',
    dialogLabel: 'wanted.txt',
    heading: 'wanted.txt',
    previewIds: ['artifact-text-preview-wanted.txt'],
    controls: [{ tagName: 'button' }, { tagName: 'button' }, { tagName: 'button' }],
  }).reason, 'unsupported_text_preview_controls');
});
