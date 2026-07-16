import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { InputEditor, parseKey, renderToString, stripAnsi, visibleLength } from 'terlio.js';
import {
  shouldRouteToProjectTask,
  shouldNavigateCommandSuggestions,
  shouldShowDebugEvents,
  isUserFacingActivity,
  activityEntryForLine,
  fitLiveText,
  buildLiveLines,
  transcriptBodyText,
  deriveInteractiveRuntimeStatus,
} from '../src/interactive/view.js';
import { buildHelpText, commandSuggestions, completeCommand, normalizeCommand } from '../src/interactive/commands.js';
import { handleCommand } from '../src/interactive/commandHandler.js';
import { reconcileVisibleProgressSnapshot, renderEvent, visibleProgressLines } from '../src/interactive/runtime.js';
import { TerlioInteractiveRuntime } from '../src/interactiveTerlio.js';
import { TerlioInputDecoder, applyTerlioEditorKey, normalizeTerlioKey } from '../src/interactive/terlioInput.js';
import { buildTranscriptLines, prepareInteractiveView, renderHeader, renderInteractiveView } from '../src/interactive/terlioView.js';
import { createTranscriptScrollState, resolveTranscriptScroll, scrollTranscript } from '../src/interactive/terlioScroll.js';
import { resolveInteractiveLayout } from '../src/interactive/terlioLayout.js';
import { makeDefaultState } from '../src/interactive/state.js';
import { DEFAULT_INTERACTIVE_THEME_NAME, INTERACTIVE_THEME_NAMES, resolveInteractiveTheme } from '../src/interactive/terlioThemes.js';

function runtimeOptions(overrides = {}) {
  return {
    bridge: {
      health: () => ({ ok: true, clients: [], pendingRequests: 0 }),
      onClientLifecycle: () => () => {},
      ...overrides.bridge,
    },
    fileStore: {},
    projectService: null,
    turnManager: null,
    workflowManager: { list: () => [], ...overrides.workflowManager },
    ...overrides,
  };
}

test('terlio key parser and editor cover the interactive editing contract', () => {
  assert.equal(parseKey('\u007f').name, 'backspace');
  assert.equal(parseKey('\u001b[3~').name, 'delete');
  assert.equal(parseKey('\u0001').name, 'home');
  assert.equal(parseKey('\u0005').name, 'end');
  assert.equal(parseKey('\u001bb').name, 'left');
  assert.equal(parseKey('\u001bb').word, true);
  assert.equal(parseKey('\u001bf').name, 'right');
  assert.equal(parseKey('\u001b[200~hello\nworld\u001b[201~').name, 'paste');
  assert.equal(parseKey('\u001b[200~hello\nworld\u001b[201~').text, 'hello\nworld');

  const editor = new InputEditor('hello world');
  editor.moveWord(-1);
  editor.deleteWordBack();
  assert.equal(editor.value, 'world');
  editor.insertPaste('one\r\ntwo');
  assert.equal(editor.value, 'one\ntwoworld');
});



test('Terlio input adapter preserves macOS editing sequences from the previous UI', () => {
  assert.equal(normalizeTerlioKey('\u001b\u007f').name, 'delete-word-left');
  assert.equal(normalizeTerlioKey('\u001bd').name, 'delete-word-right');
  assert.equal(normalizeTerlioKey('\u001b[1;13D').name, 'home');
  assert.equal(normalizeTerlioKey('\u001b[1;13C').name, 'end');
  assert.equal(normalizeTerlioKey('\u001b[1;9D').name, 'home');
  assert.equal(normalizeTerlioKey('\u001b[1;9C').name, 'end');
  assert.equal(normalizeTerlioKey('\u001b[1;5D').word, true);
  assert.equal(normalizeTerlioKey('\u001b[1;5C').word, true);

  const editor = new InputEditor('one two three');
  editor.cursor = 4;
  const result = applyTerlioEditorKey(editor, normalizeTerlioKey('\u001bd'), { multiline: false });
  assert.equal(result.handled, true);
  assert.equal(editor.value, 'one  three');
  assert.equal(editor.cursor, 4);
});

test('Terlio input decoder buffers split escape sequences and bracketed paste', () => {
  const decoder = new TerlioInputDecoder();
  assert.deepEqual(decoder.feed('\u001b'), []);
  const optionLeft = decoder.feed('b');
  assert.equal(optionLeft.length, 1);
  assert.equal(optionLeft[0].name, 'left');
  assert.equal(optionLeft[0].word, true);

  assert.deepEqual(decoder.feed('\u001b[200~first\n'), []);
  assert.deepEqual(decoder.feed('second'), []);
  const paste = decoder.feed('\u001b[201~');
  assert.equal(paste.length, 1);
  assert.equal(paste[0].name, 'paste');
  assert.equal(paste[0].text, 'first\nsecond');

  assert.deepEqual(decoder.feed('\u001b'), []);
  assert.equal(decoder.flush()[0].name, 'escape');
});

test('slash completion shows command help first and parameter help after selection', () => {
  const initial = commandSuggestions('/');
  assert.ok(initial.some((item) => item.cmd === '/session'));
  assert.ok(initial.every((item) => item.description));

  const bareSuggestions = commandSuggestions('/tab');
  assert.equal(bareSuggestions[0].cmd, '/tab');
  assert.ok(bareSuggestions.some((item) => item.cmd === '/tabs'));

  const tabArguments = commandSuggestions('/tab ');
  assert.ok(tabArguments.some((item) => item.value === 'current'));
  assert.ok(tabArguments.some((item) => item.value === 'auto'));
  assert.ok(tabArguments.some((item) => item.value === 'drop'));
  assert.equal(completeCommand('/tab 2'), '/tab 2');
});

test('session completion defaults to list numbers and still accepts full session ids', () => {
  const context = {
    state: {
      lastSessions: [
        { id: 'session-alpha', title: 'Alpha project' },
        { id: 'session-beta', title: 'Beta project' },
      ],
    },
  };
  const command = commandSuggestions('/session');
  assert.equal(command[0].insert, '/session');
  assert.equal(command[0].executeBare, true);
  assert.equal(command[1].insert, '/session ');
  const args = commandSuggestions('/session ', context);
  assert.equal(args[0].value, 'new');
  assert.ok(args.some((item) => item.value === '1' && /Alpha project/.test(item.description)));
  assert.ok(args.some((item) => item.value === '2' && /session-beta/.test(item.description)));
  assert.equal(commandSuggestions('/session session-b', context)[0].insert, '/session session-beta');
});

test('nested workflow suggestions expose flags and session values', () => {
  const context = { state: { lastSessions: [{ id: 'session-one', title: 'One' }] } };
  assert.ok(commandSuggestions('/workflow ').some((item) => item.value === 'run'));
  assert.ok(commandSuggestions('/workflow run ').some((item) => item.value === '--session'));
  const sessions = commandSuggestions('/workflow run --session ', context);
  assert.ok(sessions.some((item) => item.value === 'new'));
  assert.ok(sessions.some((item) => item.value === '1'));
  assert.equal(commandSuggestions('/workflow run --session session-o', context)[0].value, 'session-one');
});

test('commands that support an empty argument expose an executable bare suggestion', () => {
  const workflow = commandSuggestions('/workflow');
  assert.equal(workflow[0].insert, '/workflow');
  assert.equal(workflow[0].executeBare, true);
  assert.match(workflow[0].description, /dashboard/i);
  assert.equal(workflow[1].insert, '/workflow ');

  const theme = commandSuggestions('/theme');
  assert.equal(theme[0].insert, '/theme');
  assert.equal(theme[0].executeBare, true);
  assert.equal(theme[1].insert, '/theme ');
});

test('tab completion defaults to numeric selectors while matching explicit long ids', () => {
  const context = { health: { clients: [{ id: 'client-alpha-long', title: 'Primary tab' }, { id: 'client-beta-long', title: 'Secondary tab' }] } };
  const defaults = commandSuggestions('/tab ', context);
  assert.ok(defaults.some((item) => item.value === '1' && /Primary tab/.test(item.label)));
  assert.ok(defaults.some((item) => item.value === '2' && /client-beta-long/.test(item.description)));
  assert.equal(commandSuggestions('/tab client-b', context)[0].insert, '/tab client-beta-long');
});

test('interactive commands use a single canonical command surface', () => {
  assert.equal(normalizeCommand('/status'), '/status');
  assert.equal(normalizeCommand('/connect'), '/connect');
  assert.equal(normalizeCommand('/tabs'), '/tabs');
  assert.equal(normalizeCommand('/tab'), '/tab current');
  assert.equal(normalizeCommand('/file'), '/file list');
  assert.equal(normalizeCommand('/file ./notes.txt'), '/file add ./notes.txt');
  assert.equal(normalizeCommand('/apply --plan'), '/apply --plan');
  assert.ok(commandSuggestions('/state').some((item) => item.cmd === '/state'));
  assert.ok(commandSuggestions('/reset').some((item) => item.cmd === '/reset'));
  assert.ok(commandSuggestions('/debug').some((item) => item.cmd === '/debug'));
  assert.ok(commandSuggestions('/info').some((item) => item.cmd === '/info'));
});

test('theme suggestion navigation previews without mutating persisted state and cancellation restores it', async () => {
  const state = makeDefaultState();
  state.themeName = 'slate';
  const runtime = new TerlioInteractiveRuntime(runtimeOptions(), state);
  runtime.running = true;
  runtime.invalidate = () => {};
  runtime.editor.set('/theme ');
  runtime.completionActive = true;
  runtime.syncThemePreview();
  assert.equal(runtime.themePreviewName, 'slate');
  await runtime.handleKey(parseKey('\u001b[B'));
  assert.notEqual(runtime.themePreviewName, '');
  assert.notEqual(runtime.themePreviewName, 'slate');
  assert.equal(state.themeName, 'slate');
  await runtime.handleKey(parseKey('\u001b'));
  assert.equal(runtime.themePreviewName, '');
  assert.equal(state.themeName, 'slate');
});

test('Terlio theme presets are suggested, applied, and stored in interactive state', async () => {
  const state = makeDefaultState();
  assert.equal(state.themeName, DEFAULT_INTERACTIVE_THEME_NAME);
  assert.ok(INTERACTIVE_THEME_NAMES.includes('slate'));
  assert.ok(commandSuggestions('/theme ').some((item) => item.value === 'ocean'));
  assert.deepEqual(commandSuggestions('/theme ocean '), []);
  assert.notEqual(resolveInteractiveTheme('ocean'), resolveInteractiveTheme('amber'));

  await handleCommand('/theme ocean', {
    bridge: {},
    fileStore: {},
    state,
    projectService: null,
    turnManager: null,
    workflowManager: null,
    confirm: async () => false,
  });
  assert.equal(state.themeName, 'ocean');
});

test('renderEvent shows request progress phases without noisy dom polls in normal mode', () => {
  assert.equal(
    renderEvent({ type: 'request.progress', phase: 'generating', meaningful: true, thinkingLength: 120, progressLength: 24, answerLength: 0, artifactCount: 0, visibilityState: 'hidden', anchorConfidence: 'high' }),
    '[chat] generating · thinking 120 · progress 24 · tab hidden',
  );
  assert.equal(renderEvent({ type: 'request.progress', phase: 'generating', meaningful: false, reason: 'dom.poll' }), '');
  assert.equal(renderEvent({ type: 'request.phase', phase: 'waiting_for_assistant_turn' }), '[chat] phase: waiting_for_assistant_turn');
  assert.equal(renderEvent({ type: 'assistant_turn.captured', turnIndex: 42 }), '[chat] assistant turn captured #42');
});

test('Terlio interactive routes plain prompts to project task when a project is open', () => {
  assert.equal(shouldRouteToProjectTask({ projectRoot: '/tmp/project' }, { projectService: {}, turnManager: {} }, 'fix bug'), true);
  assert.equal(shouldRouteToProjectTask({ projectRoot: '' }, { projectService: {}, turnManager: {} }, 'fix bug'), false);
  assert.equal(shouldRouteToProjectTask({ projectRoot: '/tmp/project' }, { projectService: null, turnManager: {} }, 'fix bug'), false);
});

test('renderEvent renders visible progress items with their kinds', () => {
  const line = renderEvent({ type: 'assistant.progress.snapshot', items: [{ kind: 'thinking', text: 'Думаю' }, { kind: 'action_status', text: 'Inspecting uploaded ZIP' }] });
  assert.equal(line, '[thinking] Думаю\n[action status] Inspecting uploaded ZIP');
});

test('interactive source uses terlio and contains no Ink or React runtime', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const packageLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const rootSource = readFileSync(new URL('../src/interactiveTerlio.js', import.meta.url), 'utf8');
  const runtimeSource = readFileSync(new URL('../src/interactive/terlioRuntime.js', import.meta.url), 'utf8');
  const viewSource = readFileSync(new URL('../src/interactive/terlioView.js', import.meta.url), 'utf8');
  assert.equal(packageJson.dependencies['terlio.js'], '1.0.1');
  assert.equal(packageJson.dependencies.ink, undefined);
  assert.equal(packageJson.dependencies.react, undefined);
  assert.equal(packageLock.packages['node_modules/ink'], undefined);
  assert.equal(packageLock.packages['node_modules/react'], undefined);
  assert.equal(packageLock.packages['node_modules/react-reconciler'], undefined);
  assert.equal(existsSync(new URL('../src/interactiveInk.js', import.meta.url)), false);
  assert.equal(existsSync(new URL('../src/interactive/lineEditor.js', import.meta.url)), false);
  assert.match(runtimeSource, /from 'terlio\.js'/);
  assert.match(viewSource, /from 'terlio\.js'/);
  assert.doesNotMatch(`${rootSource}\n${runtimeSource}\n${viewSource}`, /\bInk\b|React\.createElement|from ['"]ink['"]|from ['"]react['"]/);
});

test('Terlio command suggestions stay inactive while browsing slash commands from history', () => {
  assert.equal(shouldNavigateCommandSuggestions('/apply', false), false);
  assert.equal(shouldNavigateCommandSuggestions('/apply', true), true);
  assert.equal(shouldNavigateCommandSuggestions('plain message', true), false);
});

test('Terlio debug activity stays opt-in and promotes user-facing milestones', () => {
  assert.equal(shouldShowDebugEvents({ eventLevel: 'normal' }), false);
  assert.equal(shouldShowDebugEvents({ eventLevel: 'verbose' }), true);
  assert.equal(isUserFacingActivity('[result] ZIP artifact ready: result.zip'), true);
  assert.equal(isUserFacingActivity('[chat] generating · thinking 120'), false);
  assert.deepEqual(activityEntryForLine('[artifact] downloaded result.zip'), {
    kind: 'system',
    title: 'Artifact',
    body: '[artifact] downloaded result.zip',
  });
});

test('Terlio live output stays height-bounded', () => {
  assert.equal(fitLiveText('one\ntwo\nthree\nfour', { maxLines: 3, maxColumns: 20 }), '… 2 earlier lines\nthree\nfour');
  const live = buildLiveLines({
    activityLines: ['[chat] prompt sent', '[watchdog] checking source'],
    thinking: 'first\nsecond\nthird',
    progress: 'inspect\nvalidate',
    answer: 'a'.repeat(200),
    maxLines: 8,
    maxColumns: 40,
  });
  assert.ok(live.length <= 8);
  assert.ok(live.some((line) => line.startsWith('Assistant:') || line.startsWith('Assistant: …')));
  assert.ok(live.some((line) => line.startsWith('• ')));
});

test('Terlio view centers chat and keeps workflow context out of the reading column', () => {
  const state = makeDefaultState();
  state.sessionId = 'session-current';
  const runtime = new TerlioInteractiveRuntime(runtimeOptions(), state);
  runtime.entries.push({ id: 'entry-1', kind: 'user', title: 'You', body: 'Run the checks' });
  runtime.thinking = 'Inspecting project';
  runtime.editor.set('/workflow');
  runtime.completionActive = true;
  const view = renderInteractiveView({
    state,
    health: { ok: true, clients: [{ id: 'client-1', title: 'ChatGPT', visibilityState: 'visible' }], activeClient: { id: 'client-1', title: 'ChatGPT', visibilityState: 'visible' }, pendingRequests: 1 },
    workflow: { id: 'repair', config: { automation: { maxCycles: 5, session: { policy: 'current' } } }, automation: { id: 'run-1', status: 'validating', cycle: 1, maxCycles: 5, boundSessionId: 'session-current' } },
    editor: runtime.editor,
    entries: runtime.entries,
    eventLines: [],
    activityLines: [],
    thinking: runtime.thinking,
    progress: '',
    answer: '',
    phase: 'thinking',
    busy: true,
    tick: 1,
    suggestionIndex: 0,
    completionActive: true,
  }, { width: 120, height: 34 });
  const rendered = renderToString(view, { width: 120, height: 34 });
  assert.match(rendered, /ChatGPT Bridge/);
  assert.match(rendered, /repair: Running valida/);
  assert.match(rendered, /Chat ·/);
  assert.match(rendered, /current response/);
  assert.match(rendered, /bridge ›|busy ›/);
});



test('responsive Terlio layout has chat, sidebar, and workspace modes with expanding chat', () => {
  const chat = resolveInteractiveLayout({ width: 80, height: 30, inputHeight: 4 });
  assert.equal(chat.mode, 'chat');
  assert.equal(chat.chatWidth, 80);
  assert.equal(chat.leftWidth, 0);
  assert.equal(chat.rightWidth, 0);
  assert.equal(chat.inputWidth, 80);

  const sidebar = resolveInteractiveLayout({ width: 110, height: 32, inputHeight: 4 });
  assert.equal(sidebar.mode, 'sidebar');
  assert.ok(sidebar.leftWidth > 0);
  assert.equal(sidebar.rightWidth, 0);
  assert.equal(sidebar.leftWidth + sidebar.chatWidth + 1, 110);
  assert.equal(sidebar.inputWidth, 110);

  const workspace = resolveInteractiveLayout({ width: 200, height: 34, inputHeight: 4 });
  assert.equal(workspace.mode, 'workspace');
  assert.ok(workspace.leftWidth > 0);
  assert.ok(workspace.rightWidth > 0);
  assert.equal(workspace.leftWidth + workspace.chatWidth + workspace.rightWidth + 2, 200);
  assert.ok(workspace.chatWidth > 96, 'chat must use the remaining wide-terminal space instead of staying capped');
  assert.equal(workspace.inputWidth, 200);
});

test('autocomplete uses a fixed upward dock and does not resize the main layout', () => {
  const state = makeDefaultState();
  const base = {
    state,
    health: { ok: true, clients: [] },
    editor: new InputEditor('/'),
    entries: [{ id: 'entry-1', kind: 'assistant', title: 'Assistant', body: 'Hello' }],
    transcriptScroll: createTranscriptScrollState(),
  };
  const inactive = prepareInteractiveView({ ...base, completionActive: false }, { width: 110, height: 32 });
  const active = prepareInteractiveView({ ...base, completionActive: true }, { width: 110, height: 32 });
  assert.equal(active.layout.mainHeight, inactive.layout.mainHeight);
  const lines = renderToString(active.node, { width: 110, height: 32 }).split('\n').map(stripAnsi);
  const suggestionLine = lines.findIndex((line) => line.includes('/session'));
  const editorLine = lines.findIndex((line) => line.includes('bridge ›'));
  assert.ok(suggestionLine >= 0 && suggestionLine < editorLine, 'suggestions must open upward above the editor');
});

test('header aligns runtime state to the right edge and adapts metadata to available width', () => {
  const health = { ok: true, clients: [{ id: 'client-long', title: 'ChatGPT' }], activeClient: { id: 'client-long', title: 'ChatGPT' }, pendingRequests: 0 };
  for (const width of [60, 90, 150]) {
    const rendered = renderToString(renderHeader({
      health,
      state: { projectRoot: '/tmp/a-very-long-project-name', sessionId: 'session-very-long-identifier', model: 'long-model-name', effort: 'high', themeName: 'ocean', pendingAttachments: [1, 2] },
      width,
    }), { width, height: 4 });
    const lines = rendered.split('\n');
    assert.ok(lines.every((line) => visibleLength(line) === width));
    assert.match(stripAnsi(lines[1]), /idle\s*│$/);
    assert.ok(!stripAnsi(lines[2]).includes('undefined'));
  }
});

test('sidebar key help is not duplicated in the footer and chat-only footer stays compact', () => {
  const state = makeDefaultState();
  const model = { state, health: { ok: true, clients: [] }, editor: new InputEditor(), entries: [], transcriptScroll: createTranscriptScrollState() };
  const sidebar = renderToString(renderInteractiveView(model, { width: 110, height: 30 }), { width: 110, height: 30 }).split('\n').map(stripAnsi);
  assert.ok(sidebar.some((line) => line.includes('Keys')));
  assert.ok(!sidebar.at(-1).includes('PgUp'));
  const shortSidebar = renderToString(renderInteractiveView(model, { width: 110, height: 22 }), { width: 110, height: 22 }).split('\n').map(stripAnsi);
  assert.ok(!shortSidebar.some((line) => line.includes(' Keys ')));
  assert.match(shortSidebar.at(-1), /PgUp chat/);
  const narrow = renderToString(renderInteractiveView(model, { width: 80, height: 30 }), { width: 80, height: 30 }).split('\n').map(stripAnsi);
  assert.match(narrow.at(-1), /PgUp chat/);
});

test('/help and Ctrl+B details contain the complete keyboard reference', () => {
  const help = buildHelpText();
  assert.match(help, /Ctrl\+Home \/ End/);
  assert.match(help, /Option\+D/);
  const state = makeDefaultState();
  const details = renderToString(renderInteractiveView({
    state,
    health: { ok: true, clients: [] },
    editor: new InputEditor(),
    entries: [],
    detailsOpen: true,
    transcriptScroll: createTranscriptScrollState(),
  }, { width: 100, height: 32 }), { width: 100, height: 32 });
  assert.match(stripAnsi(details), /Ctrl\+Home \/ End/);
  assert.match(stripAnsi(details), /Ctrl\+D/);
});

test('three-column workspace starts only on genuinely wide terminals', () => {
  assert.equal(resolveInteractiveLayout({ width: 160, height: 34, inputHeight: 8 }).mode, 'sidebar');
  assert.equal(resolveInteractiveLayout({ width: 195, height: 34, inputHeight: 8 }).mode, 'sidebar');
  assert.equal(resolveInteractiveLayout({ width: 196, height: 34, inputHeight: 8 }).mode, 'workspace');
});

test('command transcript applies semantic color to numbered lists and theme values', () => {
  const theme = resolveInteractiveTheme('ocean');
  const lines = buildTranscriptLines([{ kind: 'command', title: '/sessions', body: 'Sessions:\n * [1] Alpha\n     id: session-alpha\nTheme changed: ocean' }], 80, theme);
  const rendered = lines.join('\n');
  assert.match(stripAnsi(rendered), /\[1\] Alpha/);
  assert.match(stripAnsi(rendered), /Theme changed: ocean/);
  assert.notEqual(rendered, stripAnsi(rendered));
});

test('Terlio transcript scroll follows the tail until the user scrolls away', () => {
  let state = createTranscriptScrollState();
  state = resolveTranscriptScroll(state, { totalRows: 100, visibleRows: 20 });
  assert.equal(state.scroll, 80);
  assert.equal(state.sticky, true);

  state = scrollTranscript(state, 'page-up');
  assert.equal(state.scroll, 62);
  assert.equal(state.sticky, false);

  state = resolveTranscriptScroll(state, { totalRows: 120, visibleRows: 20 });
  assert.equal(state.scroll, 62);
  assert.equal(state.sticky, false);

  state = scrollTranscript(state, 'end');
  assert.equal(state.scroll, 100);
  assert.equal(state.sticky, true);
});

test('Terlio runtime scroll keys change chat history without replacing input history navigation', async () => {
  const state = makeDefaultState();
  const runtime = new TerlioInteractiveRuntime(runtimeOptions(), state);
  runtime.running = true;
  runtime.invalidate = () => {};
  runtime.transcriptScroll = { scroll: 80, sticky: true, totalRows: 100, previousTotalRows: 100, visibleRows: 20 };
  runtime.editor.set('draft');
  await runtime.handleKey(parseKey('\u001b[5~'));
  assert.equal(runtime.transcriptScroll.scroll, 62);
  assert.equal(runtime.editor.value, 'draft');
  await runtime.handleKey(parseKey('\u001b[6~'));
  assert.equal(runtime.transcriptScroll.scroll, 80);
});

test('medium Terlio view shows the left panel and lets chat fill the remaining width', () => {
  const state = makeDefaultState();
  state.projectRoot = '/tmp/project';
  const model = {
    state,
    health: { ok: true, clients: [{ id: 'client-1', title: 'ChatGPT' }], activeClient: { id: 'client-1', title: 'ChatGPT' } },
    editor: new InputEditor('/'),
    entries: [{ id: 'entry-1', kind: 'assistant', title: 'Assistant', body: 'Hello' }],
    transcriptScroll: createTranscriptScrollState(),
    completionActive: true,
  };
  const prepared = prepareInteractiveView(model, { width: 110, height: 30 });
  const rendered = renderToString(prepared.node, { width: 110, height: 30 });
  assert.equal(prepared.layout.mode, 'sidebar');
  assert.match(rendered, /Context/);
  assert.match(rendered, /Keys/);
  assert.match(rendered, /Chat ·/);
  assert.match(rendered, /\/session/);
  assert.doesNotMatch(rendered, /Current activity/);
  assert.ok(rendered.split('\n').every((line) => visibleLength(line) === 110), 'header, main, input, and footer must all occupy the terminal width');
});

test('narrow Terlio view shows only chat until the details panel is opened', () => {
  const state = makeDefaultState();
  state.projectRoot = '/tmp/project';
  const model = {
    state,
    health: { ok: true, clients: [{ id: 'client-1', title: 'ChatGPT' }], activeClient: { id: 'client-1', title: 'ChatGPT' } },
    workflow: { id: 'repair', config: { automation: { maxCycles: 3 } }, automation: null },
    editor: new InputEditor(),
    entries: [{ id: 'entry-1', kind: 'assistant', title: 'Assistant', body: 'Hello' }],
    transcriptScroll: createTranscriptScrollState(),
  };
  const normal = renderToString(renderInteractiveView(model, { width: 80, height: 28 }), { width: 80, height: 28 });
  assert.match(normal, /Chat ·/);
  assert.doesNotMatch(normal, /Context/);
  assert.doesNotMatch(normal, /Navigation/);

  const details = renderToString(renderInteractiveView({ ...model, detailsOpen: true }, { width: 80, height: 28 }), { width: 80, height: 28 });
  assert.match(details, /Details/);
  assert.match(details, /Connection and context/);
  assert.match(details, /Workflow · repair/);
});

test('prepared Terlio view exposes transcript metrics used by keyboard scrolling', () => {
  const state = makeDefaultState();
  const prepared = prepareInteractiveView({
    state,
    health: { ok: true, clients: [] },
    editor: new InputEditor(),
    entries: Array.from({ length: 30 }, (_, index) => ({ id: `e-${index}`, kind: 'assistant', title: 'Assistant', body: `line ${index}` })),
    transcriptScroll: createTranscriptScrollState(),
  }, { width: 100, height: 24 });
  assert.ok(prepared.transcript.totalRows > prepared.transcript.visibleRows);
  assert.equal(prepared.transcript.atBottom, true);
  assert.equal(prepared.layout.mode, 'sidebar');
  assert.equal(prepared.layout.inputWidth, 100);
});

test('Terlio transcript keeps complete user prompt and progress step text', () => {
  const prompt = `Start\n${'project context '.repeat(700)}\nEnd`;
  assert.equal(transcriptBodyText({ kind: 'user', body: prompt }), prompt);
  const step = `Inspecting files\n${'detail '.repeat(500)}`;
  const lines = visibleProgressLines({ items: [{ kind: 'tool_status', text: step }] });
  assert.equal(lines[0], `[tool status] ${step.trim()}`);
});

test('progress snapshots update active items in place and commit completed logical ids once', () => {
  let state = { records: {} };
  let result = reconcileVisibleProgressSnapshot({ items: [{ id: 'step-1', kind: 'thinking', state: 'active', active: true, visible: true, revision: 1, text: 'Проверяю файлы' }] }, state);
  state = result.state;
  assert.deepEqual(result.completedLines, []);
  result = reconcileVisibleProgressSnapshot({ items: [{ id: 'step-1', kind: 'thinking', state: 'completed', active: false, visible: true, revision: 2, text: 'Проверил файлы' }] }, state);
  state = result.state;
  assert.deepEqual(result.completedLines, ['[thinking] Проверил файлы']);
  result = reconcileVisibleProgressSnapshot({ items: [{ id: 'step-1', kind: 'thinking', state: 'completed', active: false, visible: true, revision: 2, text: 'Проверил файлы' }] }, state);
  assert.deepEqual(result.completedLines, []);
});

test('Terlio runtime status does not show idle while a request is tracked or resumable', () => {
  assert.deepEqual(
    deriveInteractiveRuntimeStatus({ ok: true, pendingRequests: 1, activeRequests: [{ requestId: 'req-1', phase: 'post_stop_settle', watchdog: { sourceAlive: true } }] }, false, 'idle'),
    { active: true, color: 'cyan', label: 'tracking · post_stop_settle', requestId: 'req-1', phase: 'post_stop_settle' },
  );
  assert.equal(deriveInteractiveRuntimeStatus({ ok: true, pendingRequests: 0 }, false, 'idle').label, 'idle');
});




test('Ctrl+B toggles the Terlio details panel without changing the editor', async () => {
  const state = makeDefaultState();
  const runtime = new TerlioInteractiveRuntime(runtimeOptions(), state);
  runtime.running = true;
  runtime.invalidate = () => {};
  runtime.editor.set('draft');
  await runtime.handleKey(parseKey('\u0002'));
  assert.equal(runtime.detailsOpen, true);
  assert.equal(runtime.editor.value, 'draft');
  await runtime.handleKey(parseKey('\u0002'));
  assert.equal(runtime.detailsOpen, false);
});

test('Ctrl+L clears the Terlio transcript and live panels', async () => {
  const state = makeDefaultState();
  const runtime = new TerlioInteractiveRuntime(runtimeOptions(), state);
  runtime.running = true;
  runtime.invalidate = () => {};
  runtime.renderer.reset = () => {};
  runtime.output = { write: () => {}, off: () => {}, isTTY: false };
  runtime.entries.push({ id: 'entry-x', kind: 'user', title: 'You', body: 'old text' });
  runtime.thinking = 'old thinking';
  await runtime.handleKey(parseKey('\u000c'));
  assert.equal(runtime.entries.length, 1);
  assert.equal(runtime.entries[0].title, 'Cleared');
  assert.equal(runtime.thinking, '');
});

test('Ctrl+C preserves the interactive graceful shutdown contract', async () => {
  const state = makeDefaultState();
  const runtime = new TerlioInteractiveRuntime(runtimeOptions(), state);
  runtime.running = true;
  runtime.invalidate = () => {};
  runtime.abortController = new AbortController();
  await runtime.handleKey(parseKey('\u0003'));
  assert.equal(runtime.interruptPrompt, true);
  await runtime.handleKey(parseKey('d'));
  assert.equal(runtime.detachOnExit, true);
  assert.equal(runtime.running, false);
});
