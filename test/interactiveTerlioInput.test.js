import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { InputEditor, parseKey, renderToString } from 'terlio.js';
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
import { commandSuggestions, completeCommand, normalizeCommand } from '../src/interactive/commands.js';
import { reconcileVisibleProgressSnapshot, renderEvent, visibleProgressLines } from '../src/interactive/runtime.js';
import { TerlioInteractiveRuntime } from '../src/interactiveTerlio.js';
import { TerlioInputDecoder, applyTerlioEditorKey, normalizeTerlioKey } from '../src/interactive/terlioInput.js';
import { prepareInteractiveView, renderInteractiveView } from '../src/interactive/terlioView.js';
import { createTranscriptScrollState, resolveTranscriptScroll, scrollTranscript } from '../src/interactive/terlioScroll.js';
import { resolveInteractiveLayout } from '../src/interactive/terlioLayout.js';
import { makeDefaultState } from '../src/interactive/state.js';

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

test('slash completion keeps exact /tab command before /tabs until arguments start', () => {
  const bareSuggestions = commandSuggestions('/tab');
  assert.equal(bareSuggestions[0].cmd, '/tab');
  assert.ok(bareSuggestions.some((item) => item.cmd === '/tabs'));
  assert.deepEqual(commandSuggestions('/tab '), []);
  assert.deepEqual(commandSuggestions('/tab 2'), []);
  assert.equal(completeCommand('/tab 2'), '/tab 2');
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



test('responsive Terlio layout uses chat-only narrow mode and balanced sidebars on wide terminals', () => {
  const narrow = resolveInteractiveLayout({ width: 80, height: 30, inputHeight: 4 });
  assert.equal(narrow.mode, 'narrow');
  assert.equal(narrow.chatWidth, 80);
  assert.equal(narrow.leftWidth, 0);
  assert.equal(narrow.rightWidth, 0);

  const wide = resolveInteractiveLayout({ width: 180, height: 34, inputHeight: 4 });
  assert.equal(wide.mode, 'wide');
  assert.equal(wide.leftWidth, wide.rightWidth);
  assert.equal(wide.leftWidth + wide.chatWidth + wide.rightWidth + 2, 180);
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
  assert.equal(prepared.layout.mode, 'centered');
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
