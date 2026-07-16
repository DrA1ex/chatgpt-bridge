import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

async function loadCore() {
  const [artifactSource, source] = await Promise.all([
    fs.readFile(path.resolve('tools/chrome-bridge-extension/artifactParserCore.js'), 'utf8'),
    fs.readFile(path.resolve('tools/chrome-bridge-extension/domParserCore.js'), 'utf8'),
  ]);
  const context = vm.createContext({});
  vm.runInContext(artifactSource, context, { filename: 'artifactParserCore.js' });
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

test('DOM completion requires final output and stopped generation but not the action bar', async () => {
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
  assert.equal(core.isCompletedSnapshot({ ...completed, artifacts: [], actionBarVisible: false }, 'wanted'), true);
  assert.equal(core.isCompletedSnapshot({ ...completed, artifacts: [], conversationId: 'other' }, 'wanted'), false);
  assert.equal(core.isCompletedSnapshot({ ...completed, artifacts: [{ phase: 'GENERATING' }] }, 'wanted'), false);
  assert.equal(core.isCompletedSnapshot({ ...completed, artifacts: [{ phase: 'READY' }] }, 'wanted'), true);
});


test('DOM parser selects the latest assistant turn after a submitted user turn', async () => {
  const core = await loadCore();
  const records = [
    { key: 'user-1', role: 'user' },
    { key: 'reasoning-1', role: 'assistant' },
    { key: 'final-1', role: 'assistant' },
    { key: 'user-2', role: 'user' },
  ];
  assert.equal(core.selectFirstTurnAfterRecord(records, 'user-1', 'assistant')?.key, 'reasoning-1');
  assert.equal(core.selectLatestTurnAfterRecord(records, 'user-1', 'assistant')?.key, 'final-1');
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
  assert.deepEqual(manifest.content_scripts[1].js, ['content/extensionApi.js', 'content/runtimeConfig.js', 'artifactParserCore.js', 'domParserCore.js', 'responseParserCore.js', 'observation/tabObservationCore.js', 'observation/tabObserver.js', 'content/domUtilities.js', 'content/panelRuntime.js', 'content/pageStatusRuntime.js', 'content/requestTelemetry.js', 'content/serverCommandRouter.js', 'content/requestLifecycleCore.js', 'content/requestSnapshotPolicy.js', 'content/requestCommands.js', 'content/requestPreparation.js', 'content/requestMonitor.js', 'content/responseRecovery.js', 'content/responseDom.js', 'content/artifactDom.js', 'content/artifactPreview.js', 'content/artifactTransfer.js', 'content/turnSnapshots.js', 'content/composerCommands.js', 'content/attachmentCommands.js', 'content/sessionCommands.js', 'content/intelligenceCommands.js', 'content/passiveTurnPolicy.js', 'content/pageRuntimeObservers.js', 'content.js']);
  const runtimeFiles = manifest.content_scripts[1].js.filter((file) => file === 'content.js' || file.startsWith('content/'));
  const runtimeSource = (await Promise.all(runtimeFiles.map((file) => fs.readFile(path.resolve('tools/chrome-bridge-extension', file), 'utf8')))).join('\n');
  const intelligenceSource = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/intelligenceCommands.js'), 'utf8');
  const composerSource = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/composerCommands.js'), 'utf8');
  assert.match(runtimeSource, /getFinalAssistantNode/);
  assert.match(runtimeSource, /readAssistantVisibleBlocks/);
  assert.match(runtimeSource, /extractFinalAnswer\(finalNode, explicitThinking/);
  assert.match(runtimeSource, /collectExplicitThinkingCandidates/);
  assert.match(runtimeSource, /loading-shimmer-tertiary/);
  assert.match(runtimeSource, /text-token-text-tertiary/);
  assert.match(runtimeSource, /reconcileThinkingCandidates/);
  assert.match(runtimeSource, /hasFinalMessage: Boolean\(finalNode\)/);
  assert.match(runtimeSource, /responseActionBarVisible/);
  assert.match(runtimeSource, /DOM_PARSER\.isTerminalResponseSnapshot/);
  assert.match(runtimeSource, /findChatObservationRoot/);
  assert.match(composerSource, /DOM_SCHEMA_CHANGED: Chat conversation root is missing/);
  assert.match(intelligenceSource, /\[data-testid="composer-intelligence-picker-content"\]/);
  assert.match(intelligenceSource, /\[role="menuitemradio"\]/);
  assert.match(intelligenceSource, /modelSubmenuOpener/);
  assert.match(intelligenceSource, /effortOptionsRoot/);
  assert.match(intelligenceSource, /enterModelSubmenuHover/);
  assert.match(intelligenceSource, /maintainModelSubmenuHover/);
  assert.match(intelligenceSource, /aria-controls/);
  assert.match(intelligenceSource, /aria-labelledby/);
  assert.match(intelligenceSource, /normalizeIntelligenceOptions/);
  assert.match(intelligenceSource, /resolveCurrentModel/);
  assert.match(runtimeSource, /assistant\.progress\.cleared/);
  assert.doesNotMatch(runtimeSource, /const answer = normalizeText\(snapshot\.answer \|\| snapshot\.raw/);
  assert.doesNotMatch(runtimeSource, /observer\.observe\(document\.documentElement/);
  assert.doesNotMatch(runtimeSource, /collectVisibleProgressElements/);
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

test('thinking reconciler never changes a logical item kind when React reuses the same DOM node', async () => {
  const core = await loadCore();
  let result = core.reconcileThinkingBlocks({}, [{
    nodeToken: 'shared-node', structuralHint: 'slot:0', kind: 'thinking', state: 'active', text: 'Checking the project', active: true,
  }], { turnId: 'turn-kind', now: 100 });
  const reasoningId = result.items[0].id;

  result = core.reconcileThinkingBlocks(result.state, [{
    nodeToken: 'shared-node', structuralHint: 'slot:0', kind: 'action_status', state: 'completed', text: 'Processing took 1m 1s', active: false,
  }], { turnId: 'turn-kind', now: 200, finalSeen: true });

  const reasoning = result.items.find((item) => item.id === reasoningId);
  const status = result.items.find((item) => item.id !== reasoningId);
  assert.equal(reasoning.kind, 'thinking');
  assert.equal(reasoning.state, 'completed');
  assert.equal(status.kind, 'action_status');
  assert.notEqual(status.id, reasoningId);
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


test('DOM turn selection requires the newly submitted user text and ignores unrelated new turns', async () => {
  const core = await loadCore();
  const baseline = new Set(['user-old', 'assistant-old']);
  const records = [
    { key: 'user-old', role: 'user', index: 0, text: 'previous prompt' },
    { key: 'assistant-old', role: 'assistant', index: 1, text: 'previous answer' },
    { key: 'user-expected', role: 'user', index: 2, text: `project.zip\nUpdate result.txt to revision 2` },
    { key: 'user-unrelated', role: 'user', index: 3, text: 'manual message from another interaction' },
  ];
  const matched = core.selectLatestMatchingNewTurnRecord(records, baseline, 'user', 'Update result.txt to revision 2');
  assert.equal(matched?.key, 'user-expected');
  assert.equal(core.userTurnMatchesExpectedText('token is unrelated', 'ok'), false);
  assert.equal(core.selectLatestMatchingNewTurnRecord(records, baseline, 'user', 'missing prompt'), null);
});

test('localized intelligence efforts normalize to stable internal ids', async () => {
  const core = await loadCore();
  const efforts = core.normalizeIntelligenceOptions('effort', [
    { label: 'Instant', rawText: 'Instant\n5.5', selected: false, annotation: '5.5' },
    { label: 'Средний', rawText: 'Средний', selected: false },
    { label: 'Высокий', rawText: 'Высокий', selected: true },
  ]);

  assert.deepEqual(Array.from(efforts, (item) => item.id), ['instant', 'medium', 'high']);
  assert.equal(efforts[2].label, 'Высокий');
  assert.equal(efforts[2].value, 'high');
  assert.equal(efforts[2].selected, true);
  assert.equal(core.intelligenceOptionMatches(efforts[1], 'medium'), true);
  assert.equal(core.intelligenceOptionMatches(efforts[2], 'high'), true);
  assert.equal(core.intelligenceOptionMatches(efforts[2], 'Высокий'), true);
});

test('current model is resolved from the transient submenu trigger and models keep annotations', async () => {
  const core = await loadCore();
  const state = core.resolveCurrentModel([
    { label: 'GPT-5.6 Sol', rawText: 'GPT-5.6 Sol', selected: true },
    { label: 'GPT-5.5', rawText: 'GPT-5.5', selected: false },
    { label: 'GPT-5.4', rawText: 'GPT-5.4\nДоступна до 23 июля', annotation: 'Доступна до 23 июля', selected: false },
    { label: 'o3', rawText: 'o3', selected: false },
  ], { label: 'GPT-5.6 Sol', rawText: 'GPT-5.6 Sol' });

  assert.equal(state.current.label, 'GPT-5.6 Sol');
  assert.equal(state.current.selectionSource, 'submenu-trigger');
  assert.equal(state.models.find((item) => item.label === 'GPT-5.4').annotation, 'Доступна до 23 июля');
  assert.equal(state.models.filter((item) => item.selected).length, 1);
  assert.equal(core.intelligenceOptionMatches(state.current, 'GPT-5.6 Sol'), true);
});

test('model trigger remains authoritative when a transient submenu check is stale', async () => {
  const core = await loadCore();
  const state = core.resolveCurrentModel([
    { label: 'GPT-5.6 Sol', rawText: 'GPT-5.6 Sol', selected: false },
    { label: 'GPT-5.5', rawText: 'GPT-5.5', selected: true },
  ], { label: 'GPT-5.6 Sol', rawText: 'GPT-5.6 Sol' });

  assert.equal(state.current.label, 'GPT-5.6 Sol');
  assert.equal(state.current.selectionSource, 'submenu-trigger');
  assert.equal(state.checkedModel.label, 'GPT-5.5');
});

test('localized intelligence fixture preserves top-level efforts and portal model submenu structure', async () => {
  const html = await fs.readFile(path.resolve('test/fixtures/chat-dom/intelligence-picker-ru.html'), 'utf8');
  assert.match(html, /data-testid="composer-intelligence-picker-content"/);
  assert.equal((html.match(/role="menuitemradio"/g) || []).length, 8);
  assert.match(html, /role="menuitem"[^>]+aria-haspopup="menu"[^>]+data-has-submenu/);
  assert.match(html, /aria-controls="radix-_r_2bk_"/);
  assert.match(html, /aria-labelledby="radix-_r_2bl_"/);
  assert.match(html, />Средний</);
  assert.match(html, />Высокий</);
});

test('code language candidate selection binds labels to their own pre block', async () => {
  const core = await loadCore();
  const candidates = [
    { text: 'JavaScript', nextPreIndex: 0, containerPreCount: 2, distance: 0 },
    { text: 'Python', nextPreIndex: 1, containerPreCount: 2, distance: 0 },
  ];
  assert.equal(core.selectCodeLanguageCandidate(candidates, 0), 'javascript');
  assert.equal(core.selectCodeLanguageCandidate(candidates, 1), 'python');
});

test('code language normalization accepts common aliases but rejects UI prose', async () => {
  const core = await loadCore();
  assert.equal(core.normalizeCodeLanguageLabel('language-js'), 'javascript');
  assert.equal(core.normalizeCodeLanguageLabel('C++'), 'cpp');
  assert.equal(core.normalizeCodeLanguageLabel('Copy code'), '');
  assert.equal(core.normalizeCodeLanguageLabel('Доступна до 23 июля'), '');
});

test('assistant author labels are excluded from progress history', async () => {
  const core = await loadCore();
  assert.equal(core.isAssistantAuthorLabel('ChatGPT сказал:'), true);
  assert.equal(core.isAssistantAuthorLabel('ChatGPT said:'), true);
  assert.equal(core.isAssistantAuthorLabel('Проверяю код'), false);
});

test('nested shimmer labels are removed without dropping accumulated reasoning checkpoints', async () => {
  const core = await loadCore();
  assert.equal(core.stripTrailingNestedProgressLabels('0%\n\nДумаю', ['Думаю']), '0%');
  assert.equal(core.stripTrailingNestedProgressLabels('0%\n10%\n20%\nWorking', ['Working']), '0%\n10%\n20%');
  assert.equal(core.stripTrailingNestedProgressLabels('Completed reasoning summary', ['Thinking']), 'Completed reasoning summary');
});

test('code language extraction tolerates localized code actions in the same header', async () => {
  const core = await loadCore();
  assert.deepEqual(Array.from(core.codeLanguageLabelsFromText('Python\nЗапустить')), ['python']);
  assert.deepEqual(Array.from(core.codeLanguageLabelsFromText('JavaScript Copy code')), ['javascript']);
  assert.deepEqual(Array.from(core.codeLanguageLabelsFromText('mermaid\nRun')), ['mermaid']);
  assert.deepEqual(Array.from(core.codeLanguageLabelsFromText('Python\nEjecutar código')), ['python']);
  assert.deepEqual(Array.from(core.codeLanguageLabelsFromText('JavaScript\nCode ausführen')), ['javascript']);
  assert.deepEqual(Array.from(core.codeLanguageLabelsFromText('Запустить\nКопировать код')), []);
});

test('code language candidate scoring prefers the header scoped to the target pre', async () => {
  const core = await loadCore();
  const candidates = [
    { text: 'JavaScript\nCopy code', preIndex: 0, sameCodeWrapper: true, headerLike: true },
    { text: 'Python\nЗапустить', preIndex: 1, sameCodeWrapper: true, directPreviousSibling: true, headerLike: true },
  ];
  assert.equal(core.selectCodeLanguageCandidate(candidates, 0), 'javascript');
  assert.equal(core.selectCodeLanguageCandidate(candidates, 1), 'python');
});

test('code language ranking associates action-first localized headers with the next code block', async () => {
  const core = await loadCore();
  const ranked = Array.from(core.rankCodeLanguageCandidates([
    { text: 'JavaScript Copy code', nextPreIndex: 0, containerPreCount: 1, headerLike: true, actionLike: true, directText: true, distance: 2, source: 'linear-interval' },
    { text: 'Run Python code', nextPreIndex: 1, containerPreCount: 1, headerLike: true, actionLike: true, directText: true, distance: 1, source: 'linear-interval' },
    { text: 'Example', nextPreIndex: 1, semanticContent: true, directText: true, distance: 0, source: 'linear-interval' },
  ], 1));
  assert.equal(ranked[0].language, 'python');
  assert.equal(ranked[0].source, 'linear-interval');
  assert.ok(ranked[0].score > 0);
  assert.equal(core.selectCodeLanguageCandidate([
    { text: 'JavaScript Copy code', nextPreIndex: 0, containerPreCount: 1, headerLike: true, actionLike: true },
    { text: 'Python\nЗапустить', nextPreIndex: 1, containerPreCount: 1, headerLike: true, actionLike: true },
  ], 1), 'python');
});

test('code language normalization preserves safe structurally scoped uncommon languages', async () => {
  const core = await loadCore();
  assert.equal(core.normalizeCodeLanguageLabel('Mermaid'), 'mermaid');
  assert.equal(core.normalizeCodeLanguageLabel('Objective-C'), 'objective-c');
  assert.equal(core.normalizeCodeLanguageLabel('Copy'), '');
  assert.equal(core.normalizeCodeLanguageLabel('Run code'), '');
});



test('code language extraction does not reinterpret nearby prose as a language label', async () => {
  const core = await loadCore();
  assert.deepEqual(Array.from(core.codeLanguageLabelsFromText('Here is the requested code.')), []);
  assert.deepEqual(Array.from(core.codeLanguageLabelsFromText('Example')), ['example']);
  assert.equal(core.selectCodeLanguageCandidate([{ text: 'Example', preIndex: 0, directPreviousSibling: true, sameCodeWrapper: true, semanticContent: true, knownLanguage: false }], 0), '');
  assert.equal(core.selectCodeLanguageCandidate([{ text: 'Python', preIndex: 0, directPreviousSibling: true, sameCodeWrapper: true, semanticContent: true, knownLanguage: true }], 0), '');
});

test('code language extraction understands accessibility descriptors and action-first labels', async () => {
  const core = await loadCore();
  assert.deepEqual(Array.from(core.codeLanguageLabelsFromText('Code block: Python')), ['python']);
  assert.deepEqual(Array.from(core.codeLanguageLabelsFromText('Run Python code')), ['python']);
  assert.deepEqual(Array.from(core.codeLanguageLabelsFromText('Запустить код JavaScript')), ['javascript']);
  assert.deepEqual(Array.from(core.codeLanguageLabelsFromText('Language — Objective-C')), ['objective-c']);
});

test('safe uncommon languages require structural code-header evidence', async () => {
  const core = await loadCore();
  assert.equal(core.selectCodeLanguageCandidate([{ text: 'customlang', preIndex: 0, directPreviousSibling: true, sameCodeWrapper: true, knownLanguage: false }], 0), '');
  assert.equal(core.selectCodeLanguageCandidate([{ text: 'customlang', preIndex: 0, directPreviousSibling: true, sameCodeWrapper: true, headerLike: true, knownLanguage: false }], 0), 'customlang');
});

test('DOM signature changes when code block language metadata mounts after code text', async () => {
  const core = await loadCore();
  const base = { phase: core.PHASE.ASSISTANT_FINAL_STREAMING, answer: '```\nvalue\n```', responseBlocks: [{ type: 'code_block', language: '', code: 'value', markdown: '```\nvalue\n```' }] };
  const resolved = { ...base, answer: '```python\nvalue\n```', responseBlocks: [{ type: 'code_block', language: 'python', code: 'value', markdown: '```python\nvalue\n```' }] };
  assert.notEqual(core.buildSnapshotSignature(base), core.buildSnapshotSignature(resolved));
});


test('code widget chrome classifier separates language metadata, actions, and unknown text', async () => {
  const core = await loadCore();
  const language = core.classifyCodeWidgetChromeText('JavaScript');
  assert.equal(language.kind, 'language');
  assert.equal(language.text, 'JavaScript');
  assert.deepEqual(Array.from(language.languages), ['javascript']);
  assert.equal(language.confidence, 'high');
  assert.equal(core.classifyCodeWidgetChromeText('Запустить', { interactive: true }).kind, 'interface_action');
  assert.equal(core.classifyCodeWidgetChromeText('Copy code').kind, 'interface_action');
  assert.equal(core.classifyCodeWidgetChromeText('Unexpected widget note').kind, 'unknown');
});

test('parser coverage summary exposes unknown and duplicate ownership instead of silently dropping it', async () => {
  const core = await loadCore();
  const summary = core.summarizeParserLeafOwnership([
    { category: 'content' },
    { category: 'content' },
    { category: 'interface' },
    { category: 'artifact' },
    { category: 'reasoning' },
    { category: 'unknown' },
    { category: 'duplicate' },
    { category: 'unknown-visual' },
  ]);
  assert.equal(summary.visibleTextLeaves, 7);
  assert.equal(summary.contentLeaves, 2);
  assert.equal(summary.interfaceLeaves, 1);
  assert.equal(summary.artifactLeaves, 1);
  assert.equal(summary.reasoningLeaves, 1);
  assert.equal(summary.unknownLeaves, 1);
  assert.equal(summary.duplicateLeaves, 1);
  assert.equal(summary.unknownVisualElements, 1);
  assert.equal(summary.classifiedLeaves, 5);
  assert.equal(summary.coveragePercent, 71.43);
});
