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
  assert.match(source, /extractFinalAnswer\(finalNode, explicitThinking/);
  assert.match(source, /collectExplicitThinkingCandidates/);
  assert.match(source, /loading-shimmer-tertiary/);
  assert.match(source, /text-token-text-tertiary/);
  assert.match(source, /reconcileThinkingCandidates/);
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

test('thinking reconciler keeps one logical id across shimmer updates and completed cot replacement', async () => {
  const core = await loadCore();
  let result = core.reconcileThinkingBlocks({}, [{
    nodeToken: 'node-a', structuralHint: 'slot:0', kind: 'thinking', state: 'active', text: 'Проверяю документацию', active: true,
  }], { turnId: 'turn-1', now: 100 });
  const id = result.items[0].id;
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].state, 'active');

  result = core.reconcileThinkingBlocks(result.state, [{
    nodeToken: 'node-a', structuralHint: 'slot:0', kind: 'thinking', state: 'active', text: 'Проверяю и обновляю документацию', active: true,
  }], { turnId: 'turn-1', now: 200 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, id);
  assert.equal(result.items[0].revision, 2);

  result = core.reconcileThinkingBlocks(result.state, [{
    nodeToken: 'node-b', structuralHint: 'slot:0', kind: 'thinking', state: 'completed', text: 'Проверил и обновил документацию, тестировал зависимости', active: false,
  }], { turnId: 'turn-1', now: 300, finalSeen: true });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, id);
  assert.equal(result.items[0].state, 'completed');
  assert.equal(result.events.filter((event) => event.type === 'completed').length, 1);
});

test('thinking reconciler ignores identical React replacement and creates a new id when a completed slot is reused', async () => {
  const core = await loadCore();
  let result = core.reconcileThinkingBlocks({}, [{
    nodeToken: 'node-a', structuralHint: 'slot:0', kind: 'thinking', state: 'completed', text: 'Проверил файлы', active: false,
  }], { turnId: 'turn-2', now: 100 });
  const firstId = result.items[0].id;

  result = core.reconcileThinkingBlocks(result.state, [{
    nodeToken: 'node-b', structuralHint: 'slot:0', kind: 'thinking', state: 'completed', text: 'Проверил файлы', active: false,
  }], { turnId: 'turn-2', now: 200 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, firstId);
  assert.equal(result.events.length, 0);

  result = core.reconcileThinkingBlocks(result.state, [{
    nodeToken: 'node-c', structuralHint: 'slot:0', kind: 'thinking', state: 'active', text: 'Запускаю тесты', active: true,
  }], { turnId: 'turn-2', now: 300 });
  assert.equal(result.items.length, 2);
  assert.notEqual(result.items[1].id, firstId);
  assert.equal(result.items[1].state, 'active');
});

test('thinking reconciler completes a vanished active step without duplicating it', async () => {
  const core = await loadCore();
  let result = core.reconcileThinkingBlocks({}, [{
    nodeToken: 'node-a', structuralHint: 'slot:0', kind: 'thinking', state: 'active', text: 'Изучаю проект', active: true,
  }], { turnId: 'turn-3', now: 100 });
  const id = result.items[0].id;
  result = core.reconcileThinkingBlocks(result.state, [], { turnId: 'turn-3', now: 200 });
  assert.equal(result.items[0].state, 'active');
  result = core.reconcileThinkingBlocks(result.state, [], { turnId: 'turn-3', now: 300 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, id);
  assert.equal(result.items[0].state, 'completed');
});


test('DOM parser recognizes conversation deletion from stable DOM metadata independently of localization', async () => {
  const core = await loadCore();
  const fixture = JSON.parse(await fs.readFile(path.resolve('test/fixtures/chat-dom/session-delete-menu-localized.json'), 'utf8'));
  for (const action of fixture.deleteActions) {
    assert.equal(core.isConversationDeleteActionDescriptor(action), true);
  }
  assert.equal(core.isConversationDeleteActionDescriptor(fixture.labelOnlyDelete), false);
  assert.equal(core.isConversationDeleteActionDescriptor(fixture.deleteAllAction), false);
  assert.equal(core.isConversationDeleteActionDescriptor(fixture.unrelatedAction), false);
  for (const confirmation of fixture.confirmations) {
    assert.equal(core.isConversationDeleteConfirmationDescriptor(confirmation), true);
  }
  assert.equal(core.isConversationDeleteConfirmationDescriptor(fixture.ordinaryButton), false);
  assert.equal(core.menuTriggerOwnsMenu({
    triggerId: fixture.trigger.id,
    triggerAriaControls: fixture.trigger.ariaControls,
    menuId: fixture.menu.id,
    menuAriaLabelledby: fixture.menu.ariaLabelledby,
  }), true);
});

test('DOM turn selection reanchors a steered request to the new user and assistant turns', async () => {
  const core = await loadCore();
  const records = [
    { key: 'user-initial', role: 'user', index: 0 },
    { key: 'assistant-initial-placeholder', role: 'assistant', index: 1 },
    { key: 'user-steer', role: 'user', index: 2 },
    { key: 'assistant-after-steer', role: 'assistant', index: 3 },
  ];
  const latestUser = core.selectLatestNewTurnRecord(records, new Set(['user-initial', 'assistant-initial-placeholder']), 'user');
  assert.equal(latestUser?.key, 'user-steer');
  const assistant = core.selectFirstTurnAfterRecord(records, latestUser.key, 'assistant');
  assert.equal(assistant?.key, 'assistant-after-steer');
});
