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


test('generic closed code-copy controls are not artifact lifecycle states and cannot block ZIP completion', async () => {
  const core = await loadCore();
  assert.equal(core.isArtifactLifecycleStateDescriptor({
    tagName: 'button',
    dataState: 'closed',
    ariaLabel: 'Копировать',
    ownText: '',
  }), false);
  assert.equal(core.isArtifactLifecycleStateDescriptor({
    tagName: 'div',
    role: 'progressbar',
    ownText: 'Loading preview',
  }), true);
  assert.equal(core.isArtifactLifecycleStateDescriptor({
    tagName: 'div',
    className: 'motion-safe:animate-spin',
    ownText: '',
  }), true);

  const readyZip = { phase: 'READY', name: 'bundle.zip', downloadActionPresent: true };
  const falseCodeCandidate = {
    phase: 'GENERATING',
    name: 'alpha.txt',
    lifecycleObserved: false,
    downloadActionPresent: false,
    downloadable: false,
  };
  assert.equal(core.artifactBlocksCompletion(falseCodeCandidate), false);
  assert.equal(core.allArtifactsReady([readyZip, falseCodeCandidate]), true);
  assert.equal(core.allArtifactsReady([readyZip, { ...falseCodeCandidate, lifecycleObserved: true }]), false);
  assert.equal(core.allArtifactsReady([readyZip, { phase: 'FAILED', lifecycleObserved: true }]), true);
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

test('text artifact preview selects localized download and close controls inside the exact filename dialog', async () => {
  const core = await loadCore();
  const fixture = await fs.readFile(path.resolve('test/fixtures/chat-dom/artifact-text-preview-dialog-localized.html'), 'utf8');
  const dialogLabel = fixture.match(/role="dialog"[^>]*aria-label="([^"]+)"/)?.[1] || '';
  const heading = fixture.match(/<h2[^>]*>([^<]+)<\/h2>/)?.[1] || '';
  const previewIds = Array.from(fixture.matchAll(/id="(artifact-text-preview-[^"]+)"/g), (match) => match[1]);
  const header = fixture.match(/<header[^>]*>([\s\S]*?)<\/header>/)?.[1] || '';
  const controls = Array.from(header.matchAll(/<(button|a)\b([^>]*)>/g), (match) => ({
    tagName: match[1],
    testId: match[2].match(/data-testid="([^"]+)"/)?.[1] || '',
    ariaLabel: match[2].match(/aria-label="([^"]+)"/)?.[1] || '',
    title: match[2].match(/title="([^"]+)"/)?.[1] || '',
    hasDownloadAttribute: /\sdownload(?:=|\s|>)/.test(match[2]),
  }));

  const plan = core.planArtifactPreviewDownload({
    desiredName: '140b8ebff4ec-one.txt',
    dialogLabel,
    heading,
    fileNameCandidates: [heading],
    previewIds,
    controls,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.source, 'localized_download_label');
  assert.equal(plan.downloadControlIndex, 0);
  assert.equal(plan.closeControlIndex, 1);
  assert.equal(plan.closeSource, 'localized_close_label');
  assert.equal(plan.textPreview, true);
});

test('slot content preview finds the exact filename leaf and prefers stable close-button metadata', async () => {
  const core = await loadCore();
  const fixture = await fs.readFile(path.resolve('test/fixtures/chat-dom/artifact-text-preview-slot-localized.html'), 'utf8');
  const fileNameCandidates = Array.from(fixture.matchAll(/<span[^>]*class="[^"]*text-token-text-primary[^"]*truncate[^"]*"[^>]*>([^<]+)<\/span>/g), (match) => match[1]);
  const heading = fixture.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1]?.replace(/<[^>]+>/g, ' ') || '';
  const previewIds = Array.from(fixture.matchAll(/id="(artifact-text-preview-[^"]+)"/g), (match) => match[1]);
  const header = fixture.match(/<header[^>]*>([\s\S]*?)<\/header>/)?.[1] || '';
  const controls = Array.from(header.matchAll(/<(button|a)\b([^>]*)>/g), (match) => ({
    tagName: match[1],
    testId: match[2].match(/data-testid="([^"]+)"/)?.[1] || '',
    ariaLabel: match[2].match(/aria-label="([^"]+)"/)?.[1] || '',
    title: match[2].match(/title="([^"]+)"/)?.[1] || '',
    hasDownloadAttribute: /\sdownload(?:=|\s|>)/.test(match[2]),
  }));

  const plan = core.planArtifactPreviewDownload({
    desiredName: 'FILE-NAME',
    heading,
    fileNameCandidates,
    previewIds,
    controls,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.source, 'localized_download_label');
  assert.equal(plan.downloadControlIndex, 1);
  assert.equal(plan.closeControlIndex, 2);
  assert.equal(plan.closeSource, 'stable_close_testid');
});


test('popcorn CSV preview matches filename stem plus format and ignores unrelated toolbar controls', async () => {
  const core = await loadCore();
  const fixture = await fs.readFile(path.resolve('test/fixtures/chat-dom/artifact-csv-popcorn-slot-localized.html'), 'utf8');
  const titleRoot = fixture.match(/data-testid="popcorn-file-title"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
  const titleLeaves = Array.from(titleRoot.matchAll(/<span[^>]*>([^<]+)<\/span>/g), (match) => match[1].trim());
  const actions = fixture.match(/data-testid="popcorn-toolbar-actions"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/)?.[1] || '';
  const controls = Array.from(actions.matchAll(/<(button|a)\b([^>]*)>/g), (match) => ({
    tagName: match[1],
    testId: match[2].match(/data-testid="([^"]+)"/)?.[1] || '',
    ariaLabel: match[2].match(/aria-label="([^"]+)"/)?.[1] || '',
    title: match[2].match(/title="([^"]+)"/)?.[1] || '',
    hasDownloadAttribute: /\sdownload(?:=|\s|>)/.test(match[2]),
  }));

  const plan = core.planArtifactPreviewDownload({
    desiredName: 'test_data.csv',
    desiredExtension: 'csv',
    desiredMime: 'text/csv',
    displayTitleCandidates: [titleLeaves[0]],
    formatLabels: [titleLeaves[1]],
    controls,
    allowFormatOnly: true,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.identitySource, 'display_title_stem_and_format');
  assert.equal(plan.expectedFormat, 'csv');
  assert.deepEqual(Array.from(plan.observedFormats), ['csv']);
  assert.equal(plan.downloadControlIndex, 1);
  assert.equal(plan.closeControlIndex, 2);
  assert.equal(plan.closeSource, 'stable_close_testid');
  assert.deepEqual(Array.from(plan.downloadNameAliases), ['test_data.csv']);
  assert.equal(plan.textPreview, false);
});

test('preview may use an arbitrary display title only when its format is unique after the exact action click', async () => {
  const core = await loadCore();
  const controls = [
    { tagName: 'button', ariaLabel: 'Download' },
    { tagName: 'button', testId: 'close-button', ariaLabel: 'Close' },
  ];
  const accepted = core.planArtifactPreviewDownload({
    desiredName: 'project-result.zip',
    displayTitleCandidates: ['Release bundle'],
    formatLabels: ['ZIP'],
    controls,
    allowFormatOnly: true,
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.identitySource, 'unique_format_after_exact_action');
  assert.deepEqual(Array.from(accepted.downloadNameAliases), ['Release bundle.zip']);

  const rejected = core.planArtifactPreviewDownload({
    desiredName: 'project-result.zip',
    displayTitleCandidates: ['Release bundle'],
    formatLabels: ['ZIP'],
    controls,
    allowFormatOnly: false,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'preview_filename_mismatch');
});

test('preview download aliases do not duplicate an extension already present in the display title', async () => {
  const core = await loadCore();
  const plan = core.planArtifactPreviewDownload({
    desiredName: 'test_data.csv',
    displayTitleCandidates: ['test_data.csv'],
    formatLabels: ['CSV'],
    controls: [
      { tagName: 'button', ariaLabel: 'Download' },
      { tagName: 'button', testId: 'close-button', ariaLabel: 'Close' },
    ],
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(Array.from(plan.downloadNameAliases), ['test_data.csv']);
});

test('artifact preview localized action fallback supports common UI languages', async () => {
  const core = await loadCore();
  for (const label of ['Download', 'Скачать', 'Télécharger', 'Herunterladen', 'Descargar', 'Scarica', 'Baixar', 'ダウンロード', '다운로드', '下载']) {
    assert.equal(core.artifactPreviewActionKind({ ariaLabel: label }), 'download', label);
  }
  for (const label of ['Close', 'Закрыть', 'Выйти из полноэкранного режима', 'Quitter le plein écran', 'Vollbildmodus verlassen', 'Cerrar', '閉じる', '닫기', '关闭']) {
    assert.equal(core.artifactPreviewActionKind({ ariaLabel: label }), 'close', label);
  }
  assert.equal(core.artifactPreviewActionKind({ testId: 'close-button', ariaLabel: 'anything' }), 'close');
  assert.equal(core.artifactPreviewActionKind({ ariaLabel: 'Share' }), '');
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
  }).reason, 'download_control_not_identified');
});


test('late preview cleanup is limited to text-like URL captures', async () => {
  const core = await loadCore();
  assert.equal(core.shouldWaitForLateArtifactPreview({
    artifact: { name: 'report.txt', mime: 'text/plain' },
    result: { captureSource: 'page-url' },
    previewObserved: false,
  }), true);
  assert.equal(core.shouldWaitForLateArtifactPreview({
    artifact: { name: 'data.json', mime: 'application/json' },
    result: { captureSource: 'dom-url' },
    previewObserved: false,
  }), true);
  assert.equal(core.shouldWaitForLateArtifactPreview({
    artifact: { name: 'bundle.zip', mime: 'application/zip' },
    result: { captureSource: 'page-url' },
    previewObserved: false,
  }), false);
  assert.equal(core.shouldWaitForLateArtifactPreview({
    artifact: { name: 'video.mp4', mime: 'video/mp4' },
    result: { captureSource: 'chrome-downloads' },
    previewObserved: false,
  }), false);
  assert.equal(core.shouldWaitForLateArtifactPreview({
    artifact: { name: 'report.txt', mime: 'text/plain' },
    result: { captureSource: 'chrome-downloads' },
    previewObserved: false,
  }), false);
  assert.equal(core.shouldWaitForLateArtifactPreview({
    artifact: { name: 'report.txt', mime: 'text/plain' },
    result: { captureSource: 'page-url' },
    previewObserved: true,
  }), false);
});

test('artifact preview readiness waits through loader and delayed controls/content', async () => {
  const core = await loadCore();
  const plan = { ok: true, textPreview: true, downloadControlIndex: 0 };
  assert.deepEqual({ ...core.artifactPreviewReadiness({
    plan,
    downloadControlUsable: false,
    textContentMounted: false,
    loaderVisible: true,
  }) }, { ready: false, reason: 'preview_loading' });
  assert.deepEqual({ ...core.artifactPreviewReadiness({
    plan,
    downloadControlUsable: true,
    textContentMounted: false,
    loaderVisible: false,
  }) }, { ready: false, reason: 'text_content_not_ready' });
  assert.deepEqual({ ...core.artifactPreviewReadiness({
    plan,
    downloadControlUsable: true,
    textContentMounted: true,
    loaderVisible: false,
  }) }, { ready: true, reason: 'ready' });
});

test('artifact action selection ignores shared selector hints and chooses the exact requested filename', async () => {
  const core = await loadCore();
  const artifact = {
    name: 'run-two.json',
    fileName: 'run-two.json',
    blockStart: '64',
    blockEnd: '128',
    actionOrdinal: 0,
    actionTag: 'button',
    selectorHint: 'div > p > button.behavior-btn',
  };
  const candidates = [
    { name: 'run-one.txt', blockStart: '0', blockEnd: '62', actionOrdinal: 0, actionTag: 'button', selectorMatched: true },
    { name: 'run-two.json', blockStart: '64', blockEnd: '128', actionOrdinal: 0, actionTag: 'button', selectorMatched: true },
    { name: 'run-three.csv', blockStart: '130', blockEnd: '236', actionOrdinal: 0, actionTag: 'button', selectorMatched: true },
  ];

  const selected = core.selectArtifactActionCandidate(artifact, candidates);
  assert.equal(selected.ok, true);
  assert.equal(selected.index, 1);
  assert.equal(selected.exactName, true);
  assert.equal(selected.candidateName, 'run-two.json');
});

test('artifact action selection never treats a selector hint as identity', async () => {
  const core = await loadCore();
  const selected = core.selectArtifactActionCandidate(
    { name: 'wanted.json', selectorHint: 'button.behavior-btn' },
    [{ name: 'other.txt', selectorMatched: true, actionTag: 'button' }],
  );
  assert.equal(selected.ok, false);
  assert.equal(selected.reason, 'artifact_action_identity_not_found');
});

test('artifact action selection permits a stable block/action locator when a generic action has no filename', async () => {
  const core = await loadCore();
  const selected = core.selectArtifactActionCandidate({
    name: 'project-result.zip',
    blockStart: '10',
    blockEnd: '20',
    actionOrdinal: 1,
    actionTag: 'button',
  }, [{
    name: '',
    blockStart: '10',
    blockEnd: '20',
    actionOrdinal: 1,
    actionTag: 'button',
    selectorMatched: true,
  }]);
  assert.equal(selected.ok, true);
  assert.equal(selected.locatorIdentity, true);
});
