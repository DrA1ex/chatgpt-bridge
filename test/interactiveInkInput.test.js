import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldRouteToProjectTask, shouldNavigateCommandSuggestions, shouldShowDebugEvents, isUserFacingActivity, activityEntryForLine, fitLiveText, buildLiveLines, transcriptBodyText, deriveInteractiveRuntimeStatus } from '../src/interactiveInk.js';
import { commandSuggestions, shouldCompleteSlashCommand, completeCommand, normalizeCommand } from '../src/interactive/commands.js';
import { decodeInputAction, pastedTextFromInput } from '../src/interactive/lineEditor.js';
import { reconcileVisibleProgressSnapshot, renderEvent, visibleProgressLines } from '../src/interactive/runtime.js';

test('decodeInputAction handles macOS delete/backspace distinction conservatively', () => {
  assert.equal(decodeInputAction('\u007f', { name: 'delete', delete: true }), 'backspace');
  assert.equal(decodeInputAction('\u001b[3~', { name: 'delete' }), 'delete');
  assert.equal(decodeInputAction('', { name: 'backspace', delete: true }), 'backspace');
  assert.equal(decodeInputAction('\u0008', { name: 'c-h' }), 'backspace');
});

test('decodeInputAction handles common readline control keys', () => {
  assert.equal(decodeInputAction('\u0001', {}), 'line-start');
  assert.equal(decodeInputAction('\u0005', {}), 'line-end');
  assert.equal(decodeInputAction('\u000b', {}), 'kill-line-right');
  assert.equal(decodeInputAction('\u0015', {}), 'kill-line-left');
  assert.equal(decodeInputAction('\u0017', {}), 'delete-word-left');
  assert.equal(decodeInputAction('\u0004', {}), 'delete-or-exit');
  assert.equal(decodeInputAction('\u000a', {}), 'submit');
  assert.equal(decodeInputAction('\u000d', {}), 'submit');
});

test('decodeInputAction handles macOS option/cmd arrow style escape sequences', () => {
  assert.equal(decodeInputAction('\u001bb', {}), 'word-left');
  assert.equal(decodeInputAction('\u001bf', {}), 'word-right');
  assert.equal(decodeInputAction('\u001b\u007f', {}), 'delete-word-left');
  assert.equal(decodeInputAction('\u001b[1;13D', {}), 'line-start');
  assert.equal(decodeInputAction('\u001b[1;13C', {}), 'line-end');
  assert.equal(decodeInputAction('', { meta: true, name: 'left' }), 'word-left');
  assert.equal(decodeInputAction('', { meta: true, name: 'right' }), 'word-right');
  assert.equal(decodeInputAction('\u0001', { meta: true, name: 'left' }), 'line-start');
  assert.equal(decodeInputAction('\u0005', { meta: true, name: 'right' }), 'line-end');
});

test('decodeInputAction treats bare Escape as editor escape and supports common meta modifiers', () => {
  assert.equal(decodeInputAction('\u001b', {}), 'escape');
  assert.equal(decodeInputAction('\u001b[1;3D', {}), 'word-left');
  assert.equal(decodeInputAction('\u001b[1;3C', {}), 'word-right');
  assert.equal(decodeInputAction('\u001b[1;9D', {}), 'word-left');
  assert.equal(decodeInputAction('\u001b[1;9C', {}), 'word-right');
  assert.equal(decodeInputAction('\u001b[1;13D', {}), 'line-start');
  assert.equal(decodeInputAction('\u001b[1;13C', {}), 'line-end');
});


test('decodeInputAction and pastedTextFromInput handle bracketed paste', () => {
  assert.equal(decodeInputAction('\u001b[200~', {}), 'paste-start');
  assert.equal(decodeInputAction('\u001b[201~', {}), 'paste-end');
  assert.equal(pastedTextFromInput('\u001b[200~hello\nworld\u001b[201~'), 'hello\nworld');
  assert.equal(pastedTextFromInput('plain pasted text'), 'plain pasted text');
  assert.equal(pastedTextFromInput('\u001b[D'), '');
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
  assert.equal(normalizeCommand('/tab 2'), '/tab 2');
  assert.equal(normalizeCommand('/file'), '/file list');
  assert.equal(normalizeCommand('/file ./notes.txt'), '/file add ./notes.txt');
  assert.equal(normalizeCommand('/file remove 2'), '/file remove 2');
  assert.equal(normalizeCommand('/apply --plan'), '/apply --plan');
  assert.equal(normalizeCommand('/recover 2'), '/recover 2');
  assert.ok(commandSuggestions('/state').some((item) => item.cmd === '/state'));
  assert.ok(commandSuggestions('/reset').some((item) => item.cmd === '/reset'));
  assert.ok(commandSuggestions('/debug').some((item) => item.cmd === '/debug'));
});


test('renderEvent shows request progress phases without noisy dom polls in normal mode', () => {
  assert.equal(
    renderEvent({ type: 'request.progress', phase: 'generating', meaningful: true, thinkingLength: 120, progressLength: 24, answerLength: 0, artifactCount: 0, visibilityState: 'hidden', anchorConfidence: 'high' }),
    '[chat] generating · thinking 120 · progress 24 · tab hidden'
  );
  assert.equal(renderEvent({ type: 'request.progress', phase: 'generating', meaningful: false, reason: 'dom.poll' }), '');
  assert.equal(renderEvent({ type: 'request.phase', phase: 'waiting_for_assistant_turn' }), '[chat] phase: waiting_for_assistant_turn');
  assert.equal(renderEvent({ type: 'assistant_turn.captured', turnIndex: 42 }), '[chat] assistant turn captured #42');
  assert.equal(renderEvent({ type: 'assistant.progress.snapshot', text: 'Inspecting uploaded ZIP' }), '[progress] Inspecting uploaded ZIP');
});


test('Ink interactive routes plain prompts to project task when a project is open', () => {
  assert.equal(shouldRouteToProjectTask({ projectRoot: '/tmp/project' }, { projectService: {}, turnManager: {} }, 'fix bug'), true);
  assert.equal(shouldRouteToProjectTask({ projectRoot: '' }, { projectService: {}, turnManager: {} }, 'fix bug'), false);
  assert.equal(shouldRouteToProjectTask({ projectRoot: '/tmp/project' }, { projectService: null, turnManager: {} }, 'fix bug'), false);
  assert.equal(shouldRouteToProjectTask({ projectRoot: '/tmp/project' }, { projectService: {}, turnManager: {} }, ''), false);
});


test('renderEvent renders visible progress items with their kinds', () => {
  const line = renderEvent({ type: 'assistant.progress.snapshot', items: [{ kind: 'thinking', text: 'Думаю' }, { kind: 'action_status', text: 'Inspecting uploaded ZIP' }] });
  assert.equal(line, '[thinking] Думаю\n[action status] Inspecting uploaded ZIP');
});


test('interactiveInk keeps local UI constants declared after refactor', () => {
  const source = readFileSync(new URL('../src/interactiveInk.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /MAX_TRANSCRIPT_ITEMS/);
  assert.match(source, /const\s+MAX_EVENT_LINES\s*=/);
  assert.match(source, /const\s+SPINNER_FRAMES\s*=/);
});


test('interactive refactor keeps shared console capture and line navigation imports wired', () => {
  const inkSource = readFileSync(new URL('../src/interactiveInk.js', import.meta.url), 'utf8');
  const controllerSource = readFileSync(new URL('../src/interactive/controller.js', import.meta.url), 'utf8');
  const lineEditorSource = readFileSync(new URL('../src/interactive/lineEditor.js', import.meta.url), 'utf8');
  assert.match(inkSource, /captureConsoleLines/);
  assert.match(controllerSource, /captureConsoleLines/);
  assert.match(lineEditorSource, /export function previousWordIndex/);
  assert.match(lineEditorSource, /export function nextWordIndex/);
  assert.match(lineEditorSource, /export const BRACKETED_PASTE_END/);
  assert.match(inkSource, /previousWordIndex/);
  assert.match(inkSource, /nextWordIndex/);
  assert.match(inkSource, /BRACKETED_PASTE_END/);
});


test('Ink command suggestions stay inactive while browsing slash commands from history', () => {
  assert.equal(shouldNavigateCommandSuggestions('/apply', false), false);
  assert.equal(shouldNavigateCommandSuggestions('/apply', true), true);
  assert.equal(shouldNavigateCommandSuggestions('plain message', true), false);
});

test('Ink shows debug event strip only in verbose mode and promotes key activity lines', () => {
  assert.equal(shouldShowDebugEvents({ eventLevel: 'normal' }), false);
  assert.equal(shouldShowDebugEvents({ eventLevel: 'quiet' }), false);
  assert.equal(shouldShowDebugEvents({ eventLevel: 'verbose' }), true);
  assert.equal(isUserFacingActivity('[result] ZIP artifact ready: result.zip'), true);
  assert.equal(isUserFacingActivity('[apply] safe plan detected; applying automatically.'), true);
  assert.equal(isUserFacingActivity('[request] started · model=auto'), true);
  assert.equal(isUserFacingActivity('[model] applied'), true);
  assert.equal(isUserFacingActivity('[open-tab] opening an isolated ChatGPT tab'), true);
  assert.equal(isUserFacingActivity('[chat] generating · thinking 120'), false);
  assert.equal(isUserFacingActivity('[debug] raw DOM poll'), false);
  assert.deepEqual(activityEntryForLine('[artifact] downloaded result.zip'), {
    kind: 'system',
    title: 'Artifact',
    body: '[artifact] downloaded result.zip',
  });
  assert.equal(activityEntryForLine('[debug] raw DOM poll'), null);
});

test('interactive Ink imports keySequence used for escape sequence buffering', () => {
  const inkSource = readFileSync(new URL('../src/interactiveInk.js', import.meta.url), 'utf8');
  const lineEditorSource = readFileSync(new URL('../src/interactive/lineEditor.js', import.meta.url), 'utf8');
  assert.match(inkSource, /keySequence/);
  assert.match(lineEditorSource, /export function keySequence/);
});


test('Ink live output is height-bounded and transcript uses Static rendering safely', () => {
  assert.equal(fitLiveText('one\ntwo\nthree\nfour', { maxLines: 3, maxColumns: 20 }), '… 2 earlier lines\nthree\nfour');
  assert.equal(fitLiveText('abcdefghijklmnopqrstuvwxyz', { maxLines: 2, maxColumns: 12 }), '… 2 earlier lines\nyz');
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
  const source = readFileSync(new URL('../src/interactiveInk.js', import.meta.url), 'utf8');
  assert.match(source, /React\.createElement\(Static/);
  assert.match(source, /function LivePanel/);
  assert.match(source, /overflowY: 'hidden'/);
  assert.doesNotMatch(source, /setEntries\(\(items\) => \[\.\.\.items, .*\]\.slice/);
  assert.match(source, /historyDraftRef/);
  assert.match(source, /setInputLine\(draft\.input, draft\.cursor\)/);
  assert.match(source, /activitySummaryRef/);
  assert.match(source, /flushActivitySummary\('Result activity'\)/);
  assert.match(source, /title = 'Task activity'/);
  assert.match(source, /React\.createElement\(LivePanel, \{ thinking, progress, answer/);
  assert.doesNotMatch(source, /React\.createElement\(LivePanel, \{ activityLines/);
  assert.match(source, /if \(shouldShowDebugEvents\(stateRef\.current\)\)/);
  assert.match(source, /if \(entry\) pushEntry\(entry\)/);
});


test('Ink transcript keeps the complete user prompt and full progress step text', () => {
  const prompt = `Start\n${'project context '.repeat(700)}\nEnd`;
  assert.equal(transcriptBodyText({ kind: 'user', body: prompt }), prompt);

  const step = `Inspecting files\n${'detail '.repeat(500)}`;
  const lines = visibleProgressLines({ items: [{ kind: 'tool_status', text: step }] });
  assert.equal(lines[0], `[tool status] ${step.trim()}`);
  const entry = activityEntryForLine(lines[0]);
  assert.equal(entry.title, 'Tool Status');
  assert.equal(entry.body, lines[0]);
});

test('progress snapshots update active items in place and commit completed logical ids once', () => {
  let state = { records: {} };
  let result = reconcileVisibleProgressSnapshot({ items: [{ id: 'step-1', kind: 'thinking', state: 'active', active: true, visible: true, revision: 1, text: 'Проверяю файлы' }] }, state);
  state = result.state;
  assert.equal(result.liveText, '');
  assert.deepEqual(result.completedLines, []);

  result = reconcileVisibleProgressSnapshot({ items: [{ id: 'step-1', kind: 'thinking', state: 'active', active: true, visible: true, revision: 2, text: 'Проверяю файлы и тесты' }] }, state);
  state = result.state;
  assert.deepEqual(result.completedLines, []);

  result = reconcileVisibleProgressSnapshot({ items: [{ id: 'step-1', kind: 'thinking', state: 'completed', active: false, visible: true, revision: 3, text: 'Проверил файлы и тесты' }] }, state);
  state = result.state;
  assert.deepEqual(result.completedLines, ['[thinking] Проверил файлы и тесты']);

  result = reconcileVisibleProgressSnapshot({ items: [{ id: 'step-1', kind: 'thinking', state: 'completed', active: false, visible: true, revision: 3, text: 'Проверил файлы и тесты' }] }, state);
  assert.deepEqual(result.completedLines, []);
});


test('Ink runtime status does not show idle while a request is tracked or resumable', () => {
  assert.deepEqual(
    deriveInteractiveRuntimeStatus({ ok: true, pendingRequests: 1, activeRequests: [{ requestId: 'req-1', phase: 'post_stop_settle', watchdog: { sourceAlive: true } }] }, false, 'idle'),
    { active: true, color: 'cyan', label: 'tracking · post_stop_settle', requestId: 'req-1', phase: 'post_stop_settle' },
  );
  assert.equal(
    deriveInteractiveRuntimeStatus({ ok: false, pendingRequests: 1, activeRequests: [{ requestId: 'req-2', phase: 'generating', watchdog: { sourceAlive: false } }] }, false, 'idle').label,
    'reconnecting · generating',
  );
  assert.equal(
    deriveInteractiveRuntimeStatus({ ok: true, pendingRequests: 0, activeClient: { activeRequest: { requestId: 'req-3', phase: 'generating' } } }, false, 'idle').label,
    'resume available · generating',
  );
  assert.equal(deriveInteractiveRuntimeStatus({ ok: true, pendingRequests: 0 }, false, 'idle').label, 'idle');
});
