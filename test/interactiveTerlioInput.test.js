import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InputEditor, createTextSelectionState, parseKey, renderToFrame, renderToString, stripAnsi, visibleLength } from 'terlio.js';
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
import { BRACKETED_PASTE_DISABLE, BRACKETED_PASTE_ENABLE, TerlioInputDecoder, applyTerlioEditorKey, isLikelyRawPaste, normalizeTerlioKey } from '../src/interactive/terlioInput.js';
import { buildTranscriptLines, prepareInteractiveView, renderHeader, renderInteractiveView } from '../src/interactive/terlioView.js';
import { createTranscriptScrollState, resolveTranscriptScroll, scrollTranscript } from '../src/interactive/terlioScroll.js';
import { resolveInteractiveLayout } from '../src/interactive/terlioLayout.js';
import { makeDefaultState } from '../src/interactive/state.js';
import { DEFAULT_INTERACTIVE_THEME_NAME, INTERACTIVE_THEME_NAMES, resolveInteractiveTheme } from '../src/interactive/terlioThemes.js';
import { keyboardGridLines } from '../src/interactive/terlioHelp.js';
import { PromptEditor } from '../src/interactive/terlioPromptEditor.js';
import { addInputHistoryRecord, inputHistoryScopeKey, readInputHistory, writeInputHistory } from '../src/interactive/terlioHistory.js';

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

test('Terlio runtime restores pointer reporting and the normal screen on stop', () => {
  const writes = [];
  const input = {
    isTTY: true,
    setRawMode() {},
    pause() {},
    off() {},
  };
  const output = {
    isTTY: true,
    columns: 100,
    rows: 34,
    write(value) { writes.push(String(value)); return true; },
    off() {},
  };
  const runtime = new TerlioInteractiveRuntime(runtimeOptions({ input, output }), makeDefaultState());
  runtime.running = true;
  runtime.pointerActive = true;
  runtime.stop();
  const terminalOutput = writes.join('');
  assert.match(terminalOutput, /\x1b\[\?1006l/);
  assert.match(terminalOutput, /\x1b\[\?1000l/);
  assert.match(terminalOutput, /\x1b\[\?1049l/);
  assert.match(terminalOutput, /\x1b\[\?25h/);
});

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
  const space = normalizeTerlioKey(' ');
  assert.equal(space.sequence, ' ');
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

test('workflow suggestions describe the bare wizard action and expose optional targets after space', () => {
  const context = { state: { lastSessions: [{ id: 'session-one', title: 'One' }] } };
  const bare = commandSuggestions('/workflow', context);
  assert.equal(bare[0].insert, '/workflow');
  assert.equal(bare[0].detail, '(open wizard)');
  assert.equal(bare[0].executeBare, true);
  assert.equal(bare.length, 1, 'bare /workflow must remain the first and only action until Space is typed');
  const suggestions = commandSuggestions('/workflow ', context);
  assert.deepEqual(suggestions.map((item) => item.value), ['wizard', 'open', 'new', 'active', 'action', 'settings']);
  assert.equal(commandSuggestions('/workflow run ', context).length, 0);
});

test('commands that support an empty argument expose an executable bare suggestion', () => {
  const workflow = commandSuggestions('/workflow');
  assert.equal(workflow[0].insert, '/workflow');
  assert.equal(workflow[0].executeBare, true);
  assert.match(workflow[0].description, /wizard/i);
  assert.equal(workflow[0].detail, '(open wizard)');
  assert.equal(workflow.length, 1);

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
  assert.equal(packageJson.dependencies['terlio.js'], '1.1.0');
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
    workflow: { id: 'repair', lifecycle: 'running', phase: 'checking', run: { id: 'run-1', phase: 'checking', cycle: 1, maxCycles: 5, source: { sessionId: 'session-current' } } },
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
  assert.match(rendered, /repair: Running project checks/);
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

  const sidebar = resolveInteractiveLayout({ width: 120, height: 32, inputHeight: 4 });
  assert.equal(sidebar.mode, 'sidebar');
  assert.ok(sidebar.leftWidth > 0);
  assert.equal(sidebar.rightWidth, 0);
  assert.equal(sidebar.leftWidth + sidebar.chatWidth + 1, 120);
  assert.equal(sidebar.inputWidth, 120);

  const workspace = resolveInteractiveLayout({ width: 200, height: 34, inputHeight: 4 });
  assert.equal(workspace.mode, 'workspace');
  assert.ok(workspace.leftWidth > 0);
  assert.ok(workspace.rightWidth > 0);
  assert.equal(workspace.leftWidth + workspace.chatWidth + workspace.rightWidth + 2, 200);
  assert.ok(workspace.chatWidth > 96, 'chat must use the remaining wide-terminal space instead of staying capped');
  assert.equal(workspace.inputWidth, 200);
});

test('autocomplete temporarily reduces the chat only while suggestions are visible', () => {
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
  assert.ok(active.layout.mainHeight < inactive.layout.mainHeight);
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

test('active passive workflow replaces idle in the header immediately', () => {
  const rendered = stripAnsi(renderToString(renderHeader({
    health: { ok: true, clients: [{ id: 'client-1', title: 'ChatGPT' }], activeClient: { id: 'client-1', title: 'ChatGPT' } },
    state: { projectRoot: '/tmp/project', sessionId: 'session-1', pendingAttachments: [] },
    workflow: { id: 'apply-1', preset: 'apply-changes', lifecycle: 'ready', execution: { subscription: { enabled: true } }, run: { id: '', phase: 'none' } },
    width: 100,
  }), { width: 100, height: 4 }));
  assert.match(rendered, /Watching the ChatGPT tab/);
  assert.doesNotMatch(rendered, /\bidle\b/i);
});

test('plain transcript text keeps its normal color after wrapping and explicit newlines', () => {
  const lines = buildTranscriptLines([{
    id: 'entry-wrap', kind: 'assistant', title: 'Assistant',
    body: `${'plain words '.repeat(12).trim()}\nSecond plain paragraph`,
  }], 24, resolveInteractiveTheme('ocean'));
  const bodyLines = lines.slice(1, -1).filter(Boolean);
  assert.ok(bodyLines.length >= 3, 'body should wrap to multiple lines');
  assert.ok(bodyLines.every((line) => !line.includes('\u001b[')), 'plain continuation lines must not be forced into muted ANSI color');
});

test('sidebar key help is not duplicated in the footer and chat-only footer stays compact', () => {
  const state = makeDefaultState();
  const model = { state, health: { ok: true, clients: [] }, editor: new InputEditor(), entries: [], transcriptScroll: createTranscriptScrollState() };
  const sidebar = renderToString(renderInteractiveView(model, { width: 120, height: 30 }), { width: 120, height: 30 }).split('\n').map(stripAnsi);
  assert.ok(sidebar.some((line) => line.includes('Keys')));
  assert.ok(!sidebar.at(-1).includes('PgUp'));
  const shortSidebar = renderToString(renderInteractiveView(model, { width: 120, height: 22 }), { width: 120, height: 22 }).split('\n').map(stripAnsi);
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
  assert.equal(resolveInteractiveLayout({ width: 114, height: 34, inputHeight: 8 }).mode, 'chat');
  assert.equal(resolveInteractiveLayout({ width: 115, height: 34, inputHeight: 8 }).mode, 'sidebar');
  assert.equal(resolveInteractiveLayout({ width: 169, height: 34, inputHeight: 8 }).mode, 'sidebar');
  assert.equal(resolveInteractiveLayout({ width: 170, height: 34, inputHeight: 8 }).mode, 'workspace');
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
  const prepared = prepareInteractiveView(model, { width: 120, height: 30 });
  const rendered = renderToString(prepared.node, { width: 120, height: 30 });
  assert.equal(prepared.layout.mode, 'sidebar');
  assert.match(rendered, /Context/);
  assert.match(rendered, /Keys/);
  assert.match(rendered, /Chat ·/);
  assert.match(rendered, /\/session/);
  assert.doesNotMatch(rendered, /Current activity/);
  assert.ok(rendered.split('\n').every((line) => visibleLength(line) === 120), 'header, main, input, and footer must all occupy the terminal width');
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
  }, { width: 120, height: 24 });
  assert.ok(prepared.transcript.totalRows > prepared.transcript.visibleRows);
  assert.equal(prepared.transcript.atBottom, true);
  assert.equal(prepared.layout.mode, 'sidebar');
  assert.equal(prepared.layout.inputWidth, 120);
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


test('Terlio 1.1 pointer input routes wheel events to the chat pane', () => {
  const decoder = new TerlioInputDecoder();
  const [pointer] = decoder.feed('\u001b[<65;12;8M');
  assert.equal(pointer.type, 'pointer');
  assert.equal(pointer.name, 'wheel-down');
  assert.equal(pointer.deltaY, 1);

  const state = makeDefaultState();
  const model = {
    state,
    health: { ok: true, clients: [] },
    editor: new InputEditor(),
    entries: Array.from({ length: 40 }, (_, index) => ({ id: `e-${index}`, kind: 'assistant', title: 'Assistant', body: `line ${index}` })),
    transcriptScroll: createTranscriptScrollState(),
    onTranscriptWheel: () => true,
    onTranscriptPointer: () => true,
  };
  const prepared = prepareInteractiveView(model, { width: 100, height: 24 });
  const frame = renderToFrame(prepared.node, { width: 100, height: 24 });
  assert.ok(frame.pointerRegions.some((region) => region.id === 'bridge:chat'));
});

test('scrollbar click and drag seek through the transcript and capture the pointer', () => {
  const runtime = new TerlioInteractiveRuntime(runtimeOptions(), makeDefaultState());
  runtime.running = true;
  runtime.invalidate = () => {};
  runtime.transcriptScroll = { scroll: 0, sticky: false, totalRows: 100, previousTotalRows: 100, visibleRows: 20 };
  let captured = false;
  let prevented = false;
  const handled = runtime.handleTranscriptPointer({
    action: 'drag',
    localX: 99,
    localY: 20,
    currentTarget: { bounds: { width: 100, height: 22 } },
    capturePointer() { captured = true; },
    preventDefault() { prevented = true; },
  });
  assert.equal(handled, true);
  assert.equal(runtime.transcriptScroll.scroll, 80);
  assert.equal(runtime.transcriptScroll.sticky, true);
  assert.equal(captured, true);
  assert.equal(prevented, true);
});

test('mouse wheel and Shift+Up/Down scroll transcript by lines', async () => {
  const state = makeDefaultState();
  const runtime = new TerlioInteractiveRuntime(runtimeOptions(), state);
  runtime.running = true;
  runtime.invalidate = () => {};
  runtime.transcriptScroll = { scroll: 50, sticky: false, totalRows: 100, previousTotalRows: 100, visibleRows: 20 };
  runtime.handleTranscriptWheel({ deltaY: -1, preventDefault() {} });
  assert.equal(runtime.transcriptScroll.scroll, 47);
  const shiftUp = parseKey('\u001b[1;2A');
  assert.equal(shiftUp.shift, true);
  await runtime.handleKey(shiftUp);
  assert.equal(runtime.transcriptScroll.scroll, 46);
  await runtime.handleKey(parseKey('\u001b[1;2B'));
  assert.equal(runtime.transcriptScroll.scroll, 47);
});

test('Ctrl+B help uses one column below 120 columns and wraps only long entries', () => {
  const oneColumn = keyboardGridLines(70, { terminalWidth: 119 });
  const enterIndex = oneColumn.findIndex((line) => line.startsWith('Enter'));
  assert.ok(enterIndex >= 0);
  assert.match(oneColumn[enterIndex], /send the input or accept/);
  assert.match(oneColumn[enterIndex + 1], /^\s+suggestion/);
  assert.ok(oneColumn.some((line) => line.startsWith('Shift\/Ctrl+Enter') && /insert a line break/.test(line)));

  const twoColumns = keyboardGridLines(130, { terminalWidth: 120 });
  assert.ok(twoColumns.some((line) => /Enter/.test(line) && /Ctrl\+A/.test(line)));
  assert.ok(twoColumns.some((line) => /Ctrl\+T/.test(line)));
});

test('Ctrl+B details expose scroll metrics when content does not fit', () => {
  const state = makeDefaultState();
  const prepared = prepareInteractiveView({
    state,
    health: { ok: true, clients: [] },
    editor: new InputEditor(),
    entries: [],
    detailsOpen: true,
    detailsScroll: createTranscriptScrollState(),
    transcriptScroll: createTranscriptScrollState(),
  }, { width: 100, height: 20 });
  assert.ok(prepared.details.totalRows > prepared.details.visibleRows);
  const rendered = stripAnsi(renderToString(prepared.node, { width: 100, height: 20 }));
  assert.match(rendered, /Details · Ctrl\+B close/);
  assert.match(rendered, /lines above|lines below|following/);
});

test('assistant response streams into one transcript entry and completes in place', () => {
  const state = makeDefaultState();
  const runtime = new TerlioInteractiveRuntime(runtimeOptions(), state);
  runtime.running = true;
  runtime.invalidate = () => {};
  const initialCount = runtime.entries.length;
  runtime.updateAssistantStream('Hel');
  assert.equal(runtime.entries.length, initialCount + 1);
  const id = runtime.entries.at(-1).id;
  assert.equal(runtime.entries.at(-1).title, 'Assistant · streaming');
  assert.equal(runtime.entries.at(-1).body, 'Hel');
  runtime.updateAssistantStream('Hello');
  assert.equal(runtime.entries.length, initialCount + 1);
  assert.equal(runtime.entries.at(-1).id, id);
  assert.equal(runtime.entries.at(-1).body, 'Hello');
  runtime.completeAssistantStream('Hello world');
  assert.equal(runtime.entries.at(-1).id, id);
  assert.equal(runtime.entries.at(-1).title, 'Assistant');
  assert.equal(runtime.entries.at(-1).body, 'Hello world');
  assert.equal(runtime.streamingEntryId, '');
});

test('completion mode without matching suggestions does not reserve transcript space', () => {
  const state = makeDefaultState();
  const base = {
    state,
    health: { ok: true, clients: [] },
    editor: new InputEditor('/definitely-no-such-command'),
    entries: [],
    transcriptScroll: createTranscriptScrollState(),
  };
  const inactive = prepareInteractiveView({ ...base, completionActive: false }, { width: 100, height: 28 });
  const active = prepareInteractiveView({ ...base, completionActive: true }, { width: 100, height: 28 });
  assert.equal(active.layout.mainHeight, inactive.layout.mainHeight);
});

test('Shift+Up and Shift+Down scroll transcript before slash suggestion navigation', async () => {
  const runtime = new TerlioInteractiveRuntime(runtimeOptions(), makeDefaultState());
  runtime.running = true;
  runtime.invalidate = () => {};
  runtime.transcriptScroll = { scroll: 50, sticky: false, totalRows: 100, previousTotalRows: 100, visibleRows: 20 };
  runtime.editor.set('/workflow');
  runtime.completionActive = true;
  runtime.suggestionIndex = 1;
  await runtime.handleKey(normalizeTerlioKey('\u001b[1;2A'));
  assert.equal(runtime.transcriptScroll.scroll, 49);
  assert.equal(runtime.suggestionIndex, 1);
  assert.equal(runtime.editor.value, '/workflow');
  await runtime.handleKey(normalizeTerlioKey('\u001b[1;2B'));
  assert.equal(runtime.transcriptScroll.scroll, 50);
  assert.equal(runtime.suggestionIndex, 1);
});

test('Escape closes Ctrl+B details first and keeps the current draft untouched', async () => {
  const runtime = new TerlioInteractiveRuntime(runtimeOptions(), makeDefaultState());
  runtime.running = true;
  runtime.invalidate = () => {};
  runtime.editor.set('unfinished draft');
  runtime.detailsOpen = true;
  await runtime.handleKey(parseKey('\u001b'));
  assert.equal(runtime.detailsOpen, false);
  assert.equal(runtime.editor.value, 'unfinished draft');
});

test('Escape-cancelled input is added to history and remains recallable', async () => {
  const state = makeDefaultState();
  state.projectRoot = '/tmp/history-project';
  const runtime = new TerlioInteractiveRuntime(runtimeOptions({ projectPath: '/tmp/history-project' }), state);
  runtime.running = true;
  runtime.invalidate = () => {};
  runtime.editor.set('cancelled multi-line\ndraft');
  await runtime.handleKey(parseKey('\u001b'));
  assert.equal(runtime.editor.value, '');
  assert.equal(runtime.history[0].text, 'cancelled multi-line\ndraft');
  await runtime.handleKey(parseKey('\u001b[A'));
  assert.equal(runtime.editor.value, 'cancelled multi-line\ndraft');
});

test('input history is scoped by project or fallback directory and preserves paste tokens', () => {
  const state = makeDefaultState();
  const projectScope = inputHistoryScopeKey({ projectRoot: '/tmp/project-a' }, '/tmp/fallback');
  const fallbackScope = inputHistoryScopeKey({}, '/tmp/fallback');
  assert.notEqual(projectScope, fallbackScope);
  const record = { text: 'prefix ' + 'x'.repeat(300), pastes: [{ start: 7, end: 307, chars: 300 }] };
  let history = addInputHistoryRecord([], record);
  writeInputHistory(state, projectScope, history);
  history = readInputHistory(state, projectScope);
  assert.deepEqual(history, [record]);
  assert.deepEqual(readInputHistory(state, fallbackScope), []);
});



test('input history survives a real state save and a fresh Node process', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'bridge-input-history-'));
  const cwd = process.cwd();
  const run = (source) => spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd,
    env: { ...process.env, DATA_DIR: dataDir, ENV_FILE: path.join(dataDir, '.env') },
    encoding: 'utf8',
  });
  try {
    const save = run(`
      import { makeDefaultState, saveInteractiveState } from './src/interactive/state.js';
      import { writeInputHistory } from './src/interactive/terlioHistory.js';
      const state = makeDefaultState();
      state.projectRoot = '/tmp/persisted-project';
      writeInputHistory(state, '/tmp/persisted-project', [{ text: 'persist me', pastes: [] }]);
      await saveInteractiveState(state);
    `);
    assert.equal(save.status, 0, save.stderr);
    const load = run(`
      import { loadInteractiveState } from './src/interactive/state.js';
      import { readInputHistory } from './src/interactive/terlioHistory.js';
      const state = await loadInteractiveState({ get: async () => null });
      process.stdout.write(JSON.stringify(readInputHistory(state, '/tmp/persisted-project')));
    `);
    assert.equal(load.status, 0, load.stderr);
    assert.deepEqual(JSON.parse(load.stdout), [{ text: 'persist me', pastes: [] }]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Enter executes an exact optional-argument command instead of completing flags', async () => {
  const runtime = new TerlioInteractiveRuntime(runtimeOptions(), makeDefaultState());
  runtime.running = true;
  runtime.invalidate = () => {};
  runtime.editor.set('/workflow run');
  runtime.completionActive = true;
  runtime.suggestionIndex = 1;
  let submitted = null;
  runtime.submitLine = async (line) => { submitted = line; };
  await runtime.handleKey(parseKey('\r'));
  assert.equal(submitted, '/workflow run');
  assert.equal(runtime.editor.value, '');
});

test('multiline input uses Up and Down for cursor movement before suggestions or history', async () => {
  const runtime = new TerlioInteractiveRuntime(runtimeOptions(), makeDefaultState());
  runtime.running = true;
  runtime.invalidate = () => {};
  runtime.output.columns = 80;
  runtime.history = [{ text: 'older command', pastes: [] }];
  runtime.editor.set('first line\nsecond line');
  runtime.editor.cursor = runtime.editor.value.length;
  const initialCursor = runtime.editor.cursor;
  await runtime.handleKey(parseKey('\u001b[A'));
  assert.ok(runtime.editor.cursor < initialCursor);
  assert.equal(runtime.editor.value, 'first line\nsecond line');
  const movedCursor = runtime.editor.cursor;
  await runtime.handleKey(parseKey('\u001b[B'));
  assert.ok(runtime.editor.cursor > movedCursor);
  assert.equal(runtime.editor.value, 'first line\nsecond line');
});

test('Up and Down browse history only from an empty field or an unchanged history item', async () => {
  const runtime = new TerlioInteractiveRuntime(runtimeOptions(), makeDefaultState());
  runtime.running = true;
  runtime.invalidate = () => {};
  runtime.history = [{ text: 'older command', pastes: [] }];
  runtime.editor.set('new text');
  await runtime.handleKey(parseKey('\u001b[A'));
  assert.equal(runtime.editor.value, 'new text');
  runtime.editor.clear();
  await runtime.handleKey(parseKey('\u001b[A'));
  assert.equal(runtime.editor.value, 'older command');
  await runtime.handleKey(parseKey('\u001b[B'));
  assert.equal(runtime.editor.value, '');
});

test('large multiline paste collapses visually, moves as one token, expands on backspace, and sends raw text', async () => {
  const editor = new PromptEditor('before ');
  const pasted = `line one\n${'payload '.repeat(50)}line end`;
  editor.insertPaste(pasted);
  const display = editor.getDisplayModel();
  assert.match(display.value, /\[pasted \d+ symbols\]/);
  assert.equal(editor.value, `before ${pasted}`);
  const tokenStart = 7;
  editor.cursor = tokenStart;
  editor.move(1);
  assert.equal(editor.cursor, editor.value.length);
  editor.backspace();
  assert.equal(editor.value, `before ${pasted}`);
  assert.equal(editor.pastes.length, 1);
  assert.equal(editor.pastes[0].collapsed, false);
  assert.doesNotMatch(editor.getDisplayModel().value, /\[pasted/);

  const rawPaste = `column\tvalue\r\n${pasted}`;
  const runtime = new TerlioInteractiveRuntime(runtimeOptions(), makeDefaultState());
  runtime.running = true;
  runtime.invalidate = () => {};
  runtime.editor = new PromptEditor();
  runtime.editor.insertPaste(rawPaste);
  assert.notEqual(runtime.editor.value, rawPaste, 'the display editor may normalize tabs and line endings');
  assert.equal(runtime.editor.getSubmissionValue(), rawPaste, 'submission must preserve the original pasted text');
  let submitted = '';
  runtime.submitLine = async (message) => { submitted = message; };
  await runtime.handleKey(parseKey('\r'));
  assert.equal(submitted, rawPaste);
});

test('raw and bracketed multiline paste are recognized and bracketed paste mode is restored', () => {
  assert.equal(isLikelyRawPaste('first\nsecond'), true);
  assert.equal(isLikelyRawPaste('x'.repeat(251)), true);
  assert.equal(isLikelyRawPaste('ordinary text'), false);
  assert.match(BRACKETED_PASTE_ENABLE, /\?2004h/);
  assert.match(BRACKETED_PASTE_DISABLE, /\?2004l/);
});

test('input editor grows to at most five rows for multiline prompts', () => {
  const state = makeDefaultState();
  const editor = new PromptEditor('1\n2\n3\n4\n5\n6\n7');
  const prepared = prepareInteractiveView({
    state,
    health: { ok: true, clients: [] },
    editor,
    entries: [],
    transcriptScroll: createTranscriptScrollState(),
  }, { width: 100, height: 30 });
  assert.equal(prepared.layout.editorRows, 5);
  assert.equal(prepared.layout.inputHeight, 7);
});

test('transcript supports multiline drag selection and short-click copy', () => {
  const selection = createTextSelectionState();
  const copied = [];
  const prepared = prepareInteractiveView({
    state: makeDefaultState(),
    health: { ok: true, clients: [] },
    editor: new PromptEditor(),
    entries: [{ id: 'one', kind: 'assistant', title: 'Assistant', body: 'alpha beta\ngamma delta' }],
    transcriptScroll: createTranscriptScrollState(),
    transcriptSelection: selection,
    onTranscriptSelectionChange() {},
    onTranscriptCopy(text) { copied.push(text); return { copied: true }; },
    onTranscriptWheel() { return true; },
    onTranscriptPointer() { return false; },
  }, { width: 100, height: 24 });
  const frame = renderToFrame(prepared.node, { width: 100, height: 24 });
  const region = frame.pointerRegions.find((item) => item.id === 'bridge:chat:selection');
  assert.ok(region);
  const event = (localX, localY) => ({
    button: 'left', localX, localY,
    preventDefault() {}, stopPropagation() {}, capturePointer() {}, releasePointerCapture() {},
  });
  region.onClick(event(2, 1), {});
  region.onDrag(event(7, 2), {});
  region.onRelease(event(7, 2), {});
  assert.match(selection.text, /alpha beta[\s\S]*gamma/);
  const selectedView = prepareInteractiveView({
    state: makeDefaultState(), health: { ok: true, clients: [] }, editor: new PromptEditor(),
    entries: [{ id: 'one', kind: 'assistant', title: 'Assistant', body: 'alpha beta\ngamma delta' }],
    transcriptScroll: createTranscriptScrollState(), transcriptSelection: selection,
  }, { width: 100, height: 24 });
  assert.match(stripAnsi(renderToString(selectedView.node, { width: 100, height: 24 })), /selected · click highlight to copy/);
  const pointInside = event(3, 1);
  region.onClick(pointInside, {});
  region.onRelease(pointInside, {});
  assert.equal(copied.length, 1);
  assert.match(copied[0], /alpha beta[\s\S]*gamma/);
  assert.equal(selection.text, '');
});
