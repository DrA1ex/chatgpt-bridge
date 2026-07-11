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

test('DOM parser classifies captured lifecycle fixtures', async () => {
  const core = await loadCore();
  const fixtures = JSON.parse(await fs.readFile(path.resolve('test/fixtures/chat-dom/turn-phases.json'), 'utf8'));
  for (const fixture of fixtures) {
    assert.equal(core.classifyTurnPhase(fixture.signals), fixture.expected, fixture.name);
  }
});

test('DOM parser groups a short analyzed label with the following tool block', async () => {
  const core = await loadCore();
  const grouped = core.groupVisibleBlocks([
    { index: 0, text: 'Проанализировано', kind: 'status' },
    { index: 1, text: 'Python print("diagnostic-step-1")\nSTDOUT/STDERR diagnostic-step-1', hasCode: true, kind: 'tool' },
    { index: 2, text: 'Финальный ответ', final: true, kind: 'final' },
  ]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].kind, 'tool');
  assert.match(grouped[0].text, /Проанализировано/);
  assert.match(grouped[0].text, /diagnostic-step-1/);
  assert.equal(grouped[1].kind, 'final');
});

test('DOM completion requires final author node, stopped generation, action bar, and matching conversation', async () => {
  const core = await loadCore();
  const completed = {
    phase: core.PHASE.ASSISTANT_FINAL,
    hasFinalMessage: true,
    stopVisible: false,
    actionBarVisible: true,
    hasActiveTool: false,
    needsConfirmation: false,
    needsContinue: false,
    hasError: false,
    conversationId: 'wanted',
  };
  assert.equal(core.isCompletedSnapshot({ ...completed, artifacts: [] }, 'wanted'), true);
  assert.equal(core.isCompletedSnapshot({ ...completed, artifacts: [], stopVisible: true }, 'wanted'), false);
  assert.equal(core.isCompletedSnapshot({ ...completed, artifacts: [], actionBarVisible: false }, 'wanted'), false);
  assert.equal(core.isCompletedSnapshot({ ...completed, artifacts: [], conversationId: 'other' }, 'wanted'), false);
  assert.equal(core.isCompletedSnapshot({ ...completed, artifacts: [{ phase: 'GENERATING' }] }, 'wanted'), false);
  assert.equal(core.isCompletedSnapshot({ ...completed, artifacts: [{ phase: 'READY' }] }, 'wanted'), true);
});

test('DOM signature changes on phase, visible blocks, controls, and final answer', async () => {
  const core = await loadCore();
  const base = {
    phase: core.PHASE.ASSISTANT_REASONING,
    turnKey: 'request-1',
    answer: '',
    stopVisible: true,
    actionBarVisible: false,
    visibleBlocks: [{ kind: 'reasoning-summary', text: 'Разработал стратегию', testIds: ['cot-v5-native-tool-icon'] }],
    artifacts: [],
  };
  const signature = core.buildSnapshotSignature(base);
  assert.notEqual(core.buildSnapshotSignature({ ...base, phase: core.PHASE.ASSISTANT_FINAL_STREAMING, answer: 'Final' }), signature);
  assert.notEqual(core.buildSnapshotSignature({ ...base, visibleBlocks: [{ ...base.visibleBlocks[0], text: 'Новая отбивка' }] }), signature);
  assert.notEqual(core.buildSnapshotSignature({ ...base, stopVisible: false, actionBarVisible: true }), signature);
  assert.notEqual(core.buildSnapshotSignature({ ...base, modelSlug: 'gpt-5-6-thinking' }), signature);
  assert.notEqual(core.buildSnapshotSignature({ ...base, conversationId: 'conversation-2' }), signature);
});

test('extension manifest loads parser core before content script and content isolates final author node', async () => {
  const manifest = JSON.parse(await fs.readFile(path.resolve('tools/chrome-bridge-extension/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.content_scripts[0].js, ['artifactCaptureMain.js']);
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.deepEqual(manifest.content_scripts[1].js, ['domParserCore.js', 'content.js']);
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /getFinalAssistantNode/);
  assert.match(source, /readAssistantVisibleBlocks/);
  assert.match(source, /extractFinalAnswer\(finalNode\)/);
  assert.match(source, /hasFinalMessage: Boolean\(finalNode\)/);
  assert.match(source, /responseActionBarVisible/);
  assert.match(source, /DOM_PARSER\.isCompletedSnapshot/);
  assert.match(source, /findChatObservationRoot/);
  assert.match(source, /DOM_SCHEMA_CHANGED: Chat conversation root is missing/);
  assert.match(source, /\[data-testid="composer-intelligence-picker-content"\]/);
  assert.match(source, /\[role="menuitemradio"\]/);
  assert.match(source, /assistant\.progress\.cleared/);
  assert.doesNotMatch(source, /const answer = normalizeText\(snapshot\.answer \|\| snapshot\.raw/);
  assert.doesNotMatch(source, /observer\.observe\(document\.documentElement/);
  assert.doesNotMatch(source, /collectVisibleProgressElements/);
});
