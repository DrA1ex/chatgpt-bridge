import { config } from './config.js';
import { captureConsoleLines } from './interactive/consoleCapture.js';
import {
  EXIT_COMMANDS,
  buildHelpText,
  commandSuggestions,
  completeCommand,
  normalizeCommand,
  shouldCompleteSlashCommand,
} from './interactive/commands.js';
import {
  backspaceAtCursor,
  clampCursor,
  decodeInputAction,
  deleteAtCursor,
  deleteWordLeftAtCursor,
  deleteWordRightAtCursor,
  insertAtCursor,
  isControlSequence,
  keySequence,
  BRACKETED_PASTE_END,
  killLineLeftAtCursor,
  killLineRightAtCursor,
  nextWordIndex,
  pastedTextFromInput,
  previousWordIndex,
} from './interactive/lineEditor.js';
import {
  loadInteractiveState,
  saveInteractiveState,
  handleCommand,
  reconcileVisibleProgressSnapshot,
  renderEvent,
  rememberResponse,
  runProjectTask,
  runLegacyInteractive,
} from './interactiveLegacy.js';

const MAX_ACTIVITY_LINES = 6;
const MAX_EVENT_LINES = 10;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function shouldRouteToProjectTask(state = {}, options = {}, message = '') {
  const text = String(message || '').trim();
  return Boolean(
    text &&
    state?.projectRoot &&
    options?.projectService &&
    options?.turnManager
  );
}

export function shouldNavigateCommandSuggestions(input = '', completionActive = false) {
  if (!completionActive) return false;
  const value = String(input || '');
  return value.trimStart().startsWith('/') && commandSuggestions(value).length > 0;
}

function truncate(text, limit = 100) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function preserveText(text, limit = 4000) {
  const value = String(text || '').trimEnd();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… ${value.length - limit} more chars`;
}

export function transcriptBodyText(entry = {}) {
  const body = String(entry.body || '').trimEnd();
  return entry.kind === 'user' ? body : preserveText(body, 12_000);
}

export function fitLiveText(text, options = {}) {
  const value = String(text || '').replace(/\r/g, '').trimEnd();
  if (!value) return '';
  const maxLines = Math.max(1, Number(options.maxLines) || 6);
  const maxColumns = Math.max(12, Number(options.maxColumns) || 96);
  const wrapped = [];
  for (const rawLine of value.split('\n')) {
    const line = rawLine || ' ';
    for (let offset = 0; offset < line.length; offset += maxColumns) wrapped.push(line.slice(offset, offset + maxColumns));
  }
  if (wrapped.length <= maxLines) return wrapped.join('\n');
  if (maxLines === 1) return wrapped.at(-1) || '';
  const hidden = wrapped.length - maxLines + 1;
  return [`… ${hidden} earlier line${hidden === 1 ? '' : 's'}`, ...wrapped.slice(-(maxLines - 1))].join('\n');
}

function wrapLiveSection(label, text, maxColumns) {
  const value = String(text || '').replace(/\r/g, '').trimEnd();
  if (!value) return [];
  const prefix = `${label}: `;
  const continuation = ' '.repeat(prefix.length);
  const contentWidth = Math.max(8, maxColumns - prefix.length);
  const contentLines = [];
  for (const rawLine of value.split('\n')) {
    const line = rawLine || ' ';
    for (let offset = 0; offset < line.length; offset += contentWidth) contentLines.push(line.slice(offset, offset + contentWidth));
  }
  return contentLines.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
}

export function buildLiveLines(options = {}) {
  const maxLines = Math.max(1, Number(options.maxLines) || 10);
  const maxColumns = Math.max(24, Number(options.maxColumns) || 96);
  const activity = (Array.isArray(options.activityLines) ? options.activityLines : [])
    .map((line) => `• ${String(line || '').replace(/\s+/g, ' ').trim()}`)
    .filter((line) => line !== '• ')
    .map((line) => line.length > maxColumns ? `${line.slice(0, Math.max(1, maxColumns - 1))}…` : line);
  const sections = {
    activity,
    thinking: wrapLiveSection('Thinking', options.thinking, maxColumns),
    progress: wrapLiveSection('Progress', options.progress, maxColumns),
    answer: wrapLiveSection('Assistant', options.answer, maxColumns),
  };
  const caps = {
    activity: Math.min(3, sections.activity.length),
    thinking: Math.min(3, sections.thinking.length),
    progress: Math.min(3, sections.progress.length),
    answer: sections.answer.length,
  };
  const allocation = { activity: 0, thinking: 0, progress: 0, answer: 0 };
  let remaining = maxLines;

  for (const name of ['answer', 'progress', 'activity', 'thinking']) {
    if (remaining > 0 && caps[name] > 0) {
      allocation[name] += 1;
      remaining -= 1;
    }
  }
  const extraOrder = ['answer', 'answer', 'activity', 'progress', 'thinking'];
  while (remaining > 0) {
    let added = false;
    for (const name of extraOrder) {
      if (remaining <= 0) break;
      if (allocation[name] >= caps[name]) continue;
      allocation[name] += 1;
      remaining -= 1;
      added = true;
    }
    if (!added) break;
  }

  const result = [];
  for (const name of ['activity', 'thinking', 'progress', 'answer']) {
    const count = allocation[name];
    if (!count) continue;
    const source = sections[name];
    const selected = source.slice(-count);
    if (source.length > count && selected.length) {
      const labels = { thinking: 'Thinking', progress: 'Progress', answer: 'Assistant' };
      selected[0] = name === 'activity'
        ? `… ${selected[0].replace(/^•\s*/, '')}`
        : `${labels[name]}: … ${selected[0].trimStart().replace(/^[^:]+:\s*/, '')}`;
    }
    result.push(...selected);
  }
  return result.slice(0, maxLines);
}

function compactTabLabel(client) {
  if (!client) return '(no tab)';
  const title = client.title || client.session?.title || client.url || client.id;
  const state = [client.visibilityState === 'visible' ? 'visible' : '', client.focused ? 'focused' : ''].filter(Boolean).join('/');
  return `${truncate(title, 58)}${state ? ` · ${state}` : ''}`;
}

function eventTone(line) {
  if (/\[error\]|ERROR|failed/i.test(line)) return 'red';
  if (/\[done\]|applied|attached/i.test(line)) return 'green';
  if (/warning|warn|select-tab|not-connected/i.test(line)) return 'yellow';
  if (/generation|prompt|request/i.test(line)) return 'cyan';
  return 'gray';
}

export function shouldShowDebugEvents(state = {}) {
  return state.eventLevel === 'verbose';
}

export function isUserFacingActivity(line = '') {
  const text = String(line || '');
  if (!text.trim()) return false;
  if (/^\[(request|project|file|result|artifact|apply|task|resume|turn|done|warn|error|watchdog|recoverable|select-tab|session|model)\]/i.test(text)) return true;
  if (/^\[chat\] (prompt delivered|prompt accepted|prompt sent|generation started|generation stopped|assistant turn captured|user turn captured|phase:)/i.test(text)) return true;
  if (/^\[(thinking|progress|action status|tool status)\]/i.test(text)) return true;
  return false;
}

function splitActivityMessages(value = '') {
  return String(value || '')
    .split(/\n(?=\[[^\]]+\]\s)/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function compactActivityLine(line = '') {
  const raw = String(line || '').replace(/\r/g, '').trim();
  if (/^\[(thinking|progress|action status|tool status)\]/i.test(raw)) {
    return preserveText(raw, 12_000);
  }
  return truncate(raw.replace(/\s+/g, ' '), 240);
}

export function activityEntryForLine(line = '') {
  const body = compactActivityLine(line);
  if (!isUserFacingActivity(body)) return null;
  const tag = body.match(/^\[([^\]]+)\]/)?.[1] || 'activity';
  const title = tag
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return { kind: 'system', title: title || 'Activity', body };
}

function nextPhaseFromEvent(event, fallback) {
  const type = String(event?.type || '');
  if (type === 'request.started') return 'starting';
  if (type === 'prompt.delivered' || type === 'prompt.accepted') return 'delivered';
  if (type === 'prompt.sent' || type === 'chat.prompt.sent') return 'sent';
  if (type === 'generation.started' || type === 'chat.generation.started') return 'generating';
  if (type === 'thinking.delta' || type === 'thinking.snapshot') return 'thinking';
  if (type === 'assistant.progress.snapshot') return 'progress';
  if (type === 'answer.delta' || type === 'answer.snapshot') return 'writing answer';
  if (type === 'generation.stopped' || type === 'chat.generation.stopped') return 'reading answer';
  if (type === 'request.done') return 'done';
  if (type.startsWith('watchdog.') || type.startsWith('forced_snapshot.')) return 'watchdog';
  if (type === 'request.error' || type === 'request.recoverable_failed') return 'error';
  if (type.startsWith('files.attach')) return 'attaching files';
  if (type.startsWith('model.apply')) return 'applying settings';
  return fallback;
}

async function loadInkModules() {
  try {
    const [reactModule, inkModule] = await Promise.all([import('react'), import('ink')]);
    return { React: reactModule.default || reactModule, ink: inkModule };
  } catch (err) {
    err.message = `Ink UI dependencies are not installed: ${err.message}`;
    throw err;
  }
}

export async function runInteractive(options) {
  let modules;
  try {
    modules = await loadInkModules();
  } catch (err) {
    console.error(err.message);
    console.error('Falling back to legacy interactive mode. Run `npm install` if this checkout was copied without dependencies.');
    return runLegacyInteractive(options);
  }

  const { React, ink } = modules;
  const { render, Box, Text, Static, useApp, useInput, useStdout } = ink;
  const { useEffect, useMemo, useRef, useState } = React;
  const initialState = await loadInteractiveState(options.fileStore);
  if (options.projectPath) initialState.projectRoot = options.projectPath;

  function Badge({ label, color = 'white' }) {
    return React.createElement(Text, { color }, ` ${label} `);
  }

  function KeyValue({ name, value, color }) {
    return React.createElement(Text, null,
      React.createElement(Text, { dimColor: true }, `${name}: `),
      React.createElement(Text, { color }, value)
    );
  }

  function Panel({ title, borderColor = 'gray', children, ...boxProps }) {
    return React.createElement(Box, { ...boxProps, flexDirection: 'column', borderStyle: 'round', borderColor, paddingX: 1 },
      title ? React.createElement(Text, { bold: true }, title) : null,
      children
    );
  }

  function EntryCard({ entry }) {
    const colorByKind = {
      system: 'gray',
      user: 'blue',
      assistant: 'green',
      command: 'magenta',
      error: 'red',
      artifact: 'yellow',
    };
    const color = colorByKind[entry.kind] || 'gray';
    const title = entry.title || entry.kind;
    return React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: color, paddingX: 1, marginBottom: 1 },
      React.createElement(Text, { color, bold: true }, title),
      entry.subtitle ? React.createElement(Text, { dimColor: true }, entry.subtitle) : null,
      entry.body ? React.createElement(Text, null, transcriptBodyText(entry)) : null
    );
  }

  function StatusHeader({ health, state, busy, phase, tick }) {
    const activeClient = health.activeClient || health.clients?.[0] || null;
    const status = health.ok ? 'connected' : health.needsSelection ? 'select tab' : 'offline';
    const statusColor = health.ok ? 'green' : health.needsSelection ? 'yellow' : 'red';
    const spinner = busy ? `${SPINNER_FRAMES[tick % SPINNER_FRAMES.length]} ${phase || 'working'}` : 'idle';
    const projectName = state.projectRoot ? state.projectRoot.split(/[\\/]/).filter(Boolean).slice(-1)[0] : 'none';

    return React.createElement(Panel, { title: 'ChatGPT Bridge', borderColor: statusColor },
      React.createElement(Box, { justifyContent: 'space-between' },
        React.createElement(Box, null,
          React.createElement(Badge, { label: status, color: statusColor }),
          React.createElement(Text, null, ` ${health.transport || 'transport?'} · tabs ${health.clients?.length || 0} · pending ${health.pendingRequests || 0}`)
        ),
        React.createElement(Text, { color: busy ? 'yellow' : 'gray' }, spinner)
      ),
      React.createElement(Box, { marginTop: 1, flexDirection: 'column' },
        React.createElement(KeyValue, { name: 'Tab', value: compactTabLabel(activeClient), color: activeClient?.focused ? 'green' : undefined }),
        React.createElement(Text, null,
          React.createElement(Text, { dimColor: true }, 'Session: '), state.sessionId || 'current tab',
          React.createElement(Text, { dimColor: true }, '  Model: '), state.model || 'default',
          React.createElement(Text, { dimColor: true }, '  Effort: '), state.effort || 'default'
        ),
        React.createElement(Text, null,
          React.createElement(Text, { dimColor: true }, 'Files: '), `${state.pendingAttachments.length} queued`,
          React.createElement(Text, { dimColor: true }, '  Project: '), projectName,
          React.createElement(Text, { dimColor: true }, '  Events: '), state.eventLevel || 'normal'
        )
      )
    );
  }

  function EventStrip({ events, width }) {
    if (!events.length) return null;
    const maxColumns = Math.max(24, Number(width) - 4 || 96);
    return React.createElement(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: 'gray', paddingX: 1 },
      React.createElement(Text, { dimColor: true }, 'Debug events · /events verbose'),
      ...events.slice(-MAX_EVENT_LINES).map((line, index) => {
        const compact = String(line || '').replace(/\s+/g, ' ').trim();
        const fitted = compact.length > maxColumns ? `${compact.slice(0, Math.max(1, maxColumns - 1))}…` : compact;
        return React.createElement(Text, { key: `${index}-${fitted.slice(0, 20)}`, color: eventTone(fitted) }, fitted);
      })
    );
  }

  function LivePanel({ thinking, progress, answer, width, height }) {
    if (!height || height < 4) return null;
    const maxColumns = Math.max(24, Number(width) - 4 || 96);
    const lines = buildLiveLines({ activityLines: [], thinking, progress, answer, maxLines: Math.max(1, height - 3), maxColumns });
    if (!lines.length) return null;
    return React.createElement(Panel, { title: 'Live', borderColor: answer ? 'cyan' : progress ? 'blue' : thinking ? 'yellow' : 'gray', height, overflowY: 'hidden', marginTop: 1 },
      ...lines.map((line, index) => React.createElement(Text, { key: `${index}-${line.slice(0, 24)}`, color: eventTone(line) }, line))
    );
  }

  function Suggestions({ input, selectedIndex = 0, enabled = true }) {
    const suggestions = enabled ? commandSuggestions(input) : [];
    if (!suggestions.length) {
      return React.createElement(Box, { flexDirection: 'column', height: 4 },
        React.createElement(Text, { dimColor: true }, 'Enter sends · Tab completes commands · ↑/↓ history'),
        React.createElement(Text, null, ''),
        React.createElement(Text, null, ''),
        React.createElement(Text, null, '')
      );
    }
    const safeIndex = Math.max(0, Math.min(selectedIndex, suggestions.length - 1));
    const offset = Math.max(0, Math.min(Math.max(0, suggestions.length - 3), safeIndex - 1));
    const visible = suggestions.slice(offset, offset + 3);
    return React.createElement(Box, { flexDirection: 'column', height: 4 },
      React.createElement(Text, { dimColor: true }, `Commands ${safeIndex + 1}/${suggestions.length} · ↑/↓ select · Tab/Enter complete`),
      ...[0, 1, 2].map((row) => {
        const item = visible[row];
        if (!item) return React.createElement(Text, { key: `empty-${row}` }, '');
        const absolute = offset + row;
        const selected = absolute === safeIndex;
        return React.createElement(Text, { key: item.cmd, inverse: selected, color: selected ? undefined : 'cyan' }, `${selected ? '› ' : '  '}${item.usage.padEnd(32)} ${item.description}`);
      })
    );
  }

  function InputLine({ input, cursor, busy, selectedIndex, completionActive, width }) {
    const promptColor = busy ? 'yellow' : 'green';
    const placeholder = busy ? 'request is running; type /stop or press Ctrl+C' : 'type a message or /help';
    const value = input || '';
    const safeCursor = clampCursor(value, cursor);
    const left = value.slice(0, safeCursor);
    const cursorChar = value[safeCursor] || ' ';
    const right = value.slice(safeCursor + (value[safeCursor] ? 1 : 0));
    return React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: promptColor, paddingX: 1, width: width || '100%' },
      React.createElement(Text, null,
        React.createElement(Text, { color: promptColor, bold: true }, busy ? 'busy › ' : 'bridge › '),
        value
          ? React.createElement(React.Fragment, null, left, React.createElement(Text, { inverse: true }, cursorChar), right)
          : React.createElement(React.Fragment, null, React.createElement(Text, { dimColor: true }, placeholder), React.createElement(Text, { inverse: true }, ' '))
      ),
      React.createElement(Suggestions, { input, selectedIndex, enabled: completionActive })
    );
  }

  function InterruptPrompt() {
    return React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1, marginTop: 1 },
      React.createElement(Text, { color: 'yellow', bold: true }, 'Request is still running'),
      React.createElement(Text, null, 'Press c to cancel the ChatGPT prompt, d to detach/exit and leave it running, Esc to continue.')
    );
  }

  function ConfirmPrompt({ prompt }) {
    return React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1, marginTop: 1 },
      React.createElement(Text, { color: 'yellow', bold: true }, 'Confirmation'),
      React.createElement(Text, null, prompt || 'Confirm? [y/N]'),
      React.createElement(Text, { dimColor: true }, 'Press y to accept, n/Esc/Enter to cancel.')
    );
  }

  let detachOnExit = false;

  function App() {
    const app = useApp();
    const { stdout } = useStdout();
    const stateRef = useRef(initialState);
    const [entries, setEntries] = useState(() => [
      { id: 'entry-0', kind: 'system', title: 'Ready', body: `Type a prompt directly, or use /help. Server: ${config.publicBaseUrl}` },
    ]);
    const [eventLines, setEventLines] = useState([]);
    const [activityLines, setActivityLines] = useState([]);
    const [input, setInput] = useState('');
    const [cursor, setCursor] = useState(0);
    const [busy, setBusy] = useState(false);
    const [answer, setAnswer] = useState('');
    const [thinking, setThinking] = useState('');
    const [progress, setProgress] = useState('');
    const [phase, setPhase] = useState('idle');
    const [statusTick, setStatusTick] = useState(0);
    const [suggestionIndex, setSuggestionIndex] = useState(0);
    const [completionActive, setCompletionActive] = useState(false);
    const [interruptPrompt, setInterruptPrompt] = useState(false);
    const [confirmPrompt, setConfirmPrompt] = useState('');
    const [transcriptEpoch, setTranscriptEpoch] = useState(0);
    const abortRef = useRef(null);
    const historyRef = useRef([]);
    const historyIndexRef = useRef(null);
    const historyBrowsingRef = useRef(false);
    const historyDraftRef = useRef(null);
    const activitySummaryRef = useRef([]);
    const lastActivityPrintRef = useRef({ line: '', at: 0 });
    const entrySequenceRef = useRef(1);
    const pendingEscapeRef = useRef(0);
    const pendingEscapeBufferRef = useRef('');
    const pendingEscapeTimerRef = useRef(null);
    const bracketedPasteRef = useRef(false);
    const confirmResolverRef = useRef(null);
    const chatProgressStateRef = useRef({ records: {} });

    const setInputLine = (value, nextCursor = null) => {
      const text = String(value || '');
      setInput(text);
      setCursor(nextCursor == null ? text.length : clampCursor(text, nextCursor));
    };

    const editInputLine = (editor) => {
      setInput((current) => {
        const result = editor(String(current || ''), cursor);
        const nextValue = typeof result === 'string' ? result : String(result.value || '');
        setCursor(typeof result === 'string' ? nextValue.length : clampCursor(nextValue, result.cursor));
        return nextValue;
      });
    };

    const pushEntry = (entry) => {
      const id = `entry-${entrySequenceRef.current++}`;
      setEntries((items) => [...items, { id, time: new Date().toISOString(), ...entry }]);
    };

    const clearTranscript = () => {
      try { stdout?.write?.('\u001b[2J\u001b[H'); } catch {}
      const id = `entry-${entrySequenceRef.current++}`;
      setTranscriptEpoch((value) => value + 1);
      setEntries([{ id, time: new Date().toISOString(), kind: 'system', title: 'Cleared', body: 'Transcript cleared.' }]);
      setEventLines([]);
      setActivityLines([]);
      activitySummaryRef.current = [];
      lastActivityPrintRef.current = { line: '', at: 0 };
      setAnswer('');
      setThinking('');
      setProgress('');
    };

    const pushEventLine = (line = '') => {
      const text = String(line).trimEnd();
      if (!text) return;
      setEventLines((lines) => [...lines, ...text.split('\n').filter(Boolean)].slice(-MAX_EVENT_LINES));
    };

    const pushActivityLine = (line = '') => {
      const items = splitActivityMessages(line)
        .map(compactActivityLine)
        .filter(isUserFacingActivity);
      if (!items.length) return;

      if (shouldShowDebugEvents(stateRef.current)) {
        setActivityLines((lines) => [...lines, ...items].slice(-MAX_ACTIVITY_LINES));
        for (const item of items) {
          const summary = activitySummaryRef.current;
          if (summary.at(-1) === item) continue;
          activitySummaryRef.current = [...summary, item].slice(-12);
        }
        return;
      }

      const now = Date.now();
      for (const item of items) {
        const previous = lastActivityPrintRef.current;
        if (previous.line === item && now - previous.at < 1_500) continue;
        lastActivityPrintRef.current = { line: item, at: now };
        const entry = activityEntryForLine(item);
        if (entry) pushEntry(entry);
      }
    };

    const resetActivity = () => {
      activitySummaryRef.current = [];
      lastActivityPrintRef.current = { line: '', at: 0 };
      setActivityLines([]);
      setEventLines([]);
    };

    const flushActivitySummary = (title = 'Task activity') => {
      if (!shouldShowDebugEvents(stateRef.current)) {
        activitySummaryRef.current = [];
        return;
      }
      const lines = activitySummaryRef.current;
      if (!lines.length) return;
      pushEntry({ kind: 'system', title, body: lines.join('\n') });
      activitySummaryRef.current = [];
    };

    const setInputFromHistory = (value) => {
      historyBrowsingRef.current = true;
      setCompletionActive(false);
      setSuggestionIndex(0);
      setInputLine(value || '');
    };

    const markInputTouched = ({ completion = true } = {}) => {
      if (historyBrowsingRef.current) {
        historyIndexRef.current = null;
        historyDraftRef.current = null;
      }
      historyBrowsingRef.current = false;
      if (completion) setCompletionActive(true);
    };

    const context = useMemo(() => ({
      bridge: options.bridge,
      fileStore: options.fileStore,
      state: stateRef.current,
      projectService: options.projectService,
      turnManager: options.turnManager,
      createConsoleStream: (label = 'Working') => {
        let printedAnswer = '';
        let printedThinking = '';
        pushEventLine(`[command] ${label}`);
        return {
          status(line) {
            if (!line) return;
            pushEventLine(line);
            pushActivityLine(line);
          },
          onThinkingUpdate(text) {
            const value = String(text || '');
            if (value === printedThinking) return;
            printedThinking = value;
            setThinking(value);
          },
          onProgressUpdate(text) {
            const value = String(text || '');
            setProgress(value);
          },
          onAnswerUpdate(text) {
            const value = String(text || '');
            if (value === printedAnswer) return;
            printedAnswer = value;
            setAnswer(value);
          },
          onArtifactUpdate(artifacts = []) {
            if (artifacts.length) {
              const line = `[artifact] discovered ${artifacts.length}`;
              pushEventLine(line);
              pushActivityLine(line);
            }
          },
          finish(finalAnswer = '') {
            const text = String(finalAnswer || printedAnswer || '').trim();
            setThinking('');
            setProgress('');
            setAnswer('');
            flushActivitySummary();
            if (text) pushEntry({ kind: 'assistant', title: 'Assistant', body: text });
            else pushEventLine('[answer] empty final answer');
          },
          fail() {
            setThinking('');
            setProgress('');
            setAnswer('');
            flushActivitySummary();
          },
        };
      },
      captureConsoleForStream: true,
      confirm: async (question) => new Promise((resolve) => {
        confirmResolverRef.current = resolve;
        setConfirmPrompt(String(question || 'Confirm? [y/N] '));
      }),
    }), []);

    useEffect(() => {
      const interval = setInterval(() => setStatusTick((v) => v + 1), 180);
      const unsubscribe = typeof options.bridge.onClientLifecycle === 'function'
        ? options.bridge.onClientLifecycle(() => setStatusTick((v) => v + 1))
        : () => {};
      return () => {
        clearInterval(interval);
        clearTimeout(pendingEscapeTimerRef.current);
        unsubscribe();
      };
    }, []);

    const runProjectChat = async (message) => {
      const state = stateRef.current;
      if (!options.bridge.health().ok) {
        pushEntry({ kind: 'error', title: 'Not connected', body: 'No ChatGPT browser extension is connected. Use /connect, then reload ChatGPT and connect the extension.' });
        return;
      }
      const abortController = new AbortController();
      abortRef.current = abortController;
      setBusy(true);
      setPhase('running project task');
      setAnswer('');
      setThinking('');
      setProgress('');
      resetActivity();
      chatProgressStateRef.current = { records: {} };
      pushEntry({ kind: 'user', title: 'You', subtitle: `project: ${state.projectRoot}`, body: message });
      try {
        await runProjectTask(message, { ...context, signal: abortController.signal });
        flushActivitySummary('Result activity');
        await saveInteractiveState(state).catch(() => {});
      } catch (err) {
        flushActivitySummary('Result activity');
        pushEntry({ kind: 'error', title: 'Project task failed', body: err.message });
        await saveInteractiveState(state).catch(() => {});
      } finally {
        abortRef.current = null;
        setBusy(false);
        setPhase('idle');
      }
    };

    const runChat = async (message) => {
      const state = stateRef.current;
      if (!options.bridge.health().ok) {
        pushEntry({ kind: 'error', title: 'Not connected', body: 'No ChatGPT browser extension is connected. Use /connect, then reload ChatGPT and connect the extension.' });
        return;
      }
      const attachments = state.pendingAttachments.map((file) => file.id);
      const abortController = new AbortController();
      abortRef.current = abortController;
      setBusy(true);
      setPhase('starting');
      setAnswer('');
      setThinking('');
      setProgress('');
      resetActivity();
      pushEntry({
        kind: 'user',
        title: 'You',
        subtitle: attachments.length ? `files: ${state.pendingAttachments.map((file) => file.name).join(', ')}` : '',
        body: message,
      });
      try {
        const response = await options.bridge.sendRequest({
          message,
          sessionId: state.sessionId,
          model: state.model,
          effort: state.effort,
          attachments,
        }, {
          onEvent: (event) => {
            setPhase((current) => nextPhaseFromEvent(event, current));
            if (event?.type === 'assistant.progress.snapshot') {
              const reconciled = reconcileVisibleProgressSnapshot(event, chatProgressStateRef.current);
              chatProgressStateRef.current = reconciled.state;
              setProgress(reconciled.liveText);
              for (const completedLine of reconciled.completedLines) {
                pushEventLine(completedLine);
                pushActivityLine(completedLine);
              }
              return;
            }
            const line = renderEvent(event, state.eventLevel);
            if (line) {
              pushEventLine(line);
              pushActivityLine(line);
            }
          },
          onThinkingUpdate: (text) => setThinking(text || ''),
          onProgressUpdate: (text) => setProgress(text || ''),
          onAnswerUpdate: (text) => setAnswer(text || ''),
          onArtifactUpdate: (artifacts) => {
            state.lastArtifacts = artifacts;
            if (artifacts?.length) {
              const line = `[artifact] discovered ${artifacts.length}`;
              pushEventLine(line);
              pushActivityLine(line);
            }
          },
        }, { signal: abortController.signal, fullResponse: true, confirmClientSelection: ({ message: question }) => context.confirm(question) });

        if (response.session?.id) state.sessionId = response.session.id;
        if (Array.isArray(response.artifacts) && response.artifacts.length) state.lastArtifacts = response.artifacts;
        state.pendingAttachments = [];
        const finalAnswer = String(response.answer || response.response || '');
        rememberResponse(state, {
          id: response.requestId || response.id || '',
          source: 'chat',
          title: 'Assistant answer',
          text: finalAnswer,
          artifactCount: Array.isArray(response.artifacts) ? response.artifacts.length : 0,
          createdAt: response.createdAt,
        });
        setAnswer('');
        setThinking('');
        setProgress('');
        flushActivitySummary();
        pushEntry({ kind: 'assistant', title: 'Assistant', body: finalAnswer || '(empty answer)' });
        if (response.artifacts?.length) {
          pushEntry({
            kind: 'artifact',
            title: `Artifacts (${response.artifacts.length})`,
            body: response.artifacts.map((artifact, index) => `[${index + 1}] ${artifact.name || artifact.filename || artifact.id || 'artifact'}`).join('\n'),
          });
        }
        await saveInteractiveState(state).catch(() => {});
      } catch (err) {
        flushActivitySummary();
        pushEntry({ kind: 'error', title: 'Request failed', body: err.message });
        pushEventLine('Queued attachments were kept for retry. Use /file clear to clear them.');
        await saveInteractiveState(state).catch(() => {});
      } finally {
        abortRef.current = null;
        setBusy(false);
        setPhase('idle');
      }
    };

    const clearPendingEscape = () => {
      clearTimeout(pendingEscapeTimerRef.current);
      pendingEscapeTimerRef.current = null;
      pendingEscapeRef.current = 0;
      pendingEscapeBufferRef.current = '';
    };

    const scheduleBareEscape = () => {
      clearTimeout(pendingEscapeTimerRef.current);
      pendingEscapeRef.current = Date.now();
      pendingEscapeBufferRef.current = '';
      pendingEscapeTimerRef.current = setTimeout(() => {
        if (!pendingEscapeRef.current || pendingEscapeBufferRef.current) return;
        clearPendingEscape();
        if (input.length) {
          setInputLine('');
          setSuggestionIndex(0);
          setCompletionActive(false);
          historyIndexRef.current = null;
          historyDraftRef.current = null;
          historyBrowsingRef.current = false;
        }
      }, 45);
    };

    const applyLineEditAction = (resolvedAction) => {
      if (resolvedAction && resolvedAction !== 'escape') markInputTouched();
      if (resolvedAction === 'line-start') { setCursor(0); return true; }
      if (resolvedAction === 'line-end') { setCursor(input.length); return true; }
      if (resolvedAction === 'word-left') { setCursor((value) => previousWordIndex(input, value)); return true; }
      if (resolvedAction === 'word-right') { setCursor((value) => nextWordIndex(input, value)); return true; }
      if (resolvedAction === 'left') { setCursor((value) => Math.max(0, value - 1)); return true; }
      if (resolvedAction === 'right') { setCursor((value) => Math.min(input.length, value + 1)); return true; }
      if (resolvedAction === 'backspace') { editInputLine((value, index) => backspaceAtCursor(value, index)); return true; }
      if (resolvedAction === 'delete') { editInputLine((value, index) => deleteAtCursor(value, index)); return true; }
      if (resolvedAction === 'delete-word-left') { editInputLine((value, index) => deleteWordLeftAtCursor(value, index)); return true; }
      if (resolvedAction === 'delete-word-right') { editInputLine((value, index) => deleteWordRightAtCursor(value, index)); return true; }
      if (resolvedAction === 'kill-line-left') { editInputLine((value, index) => killLineLeftAtCursor(value, index)); return true; }
      if (resolvedAction === 'kill-line-right') { editInputLine((value, index) => killLineRightAtCursor(value, index)); return true; }
      return false;
    };

    const submitLine = async (line) => {
      const message = String(line || '').trim();
      if (!message) return;
      historyRef.current = [message, ...historyRef.current.filter((item) => item !== message)].slice(0, 80);
      historyIndexRef.current = null;
      historyDraftRef.current = null;
      historyBrowsingRef.current = false;
      if (EXIT_COMMANDS.has(message.toLowerCase())) {
        app.exit();
        return;
      }
      if (message === '/clear') {
        clearTranscript();
        return;
      }
      if (message === '/help') {
        pushEntry({ kind: 'system', title: 'Help', body: buildHelpText() });
        return;
      }
      if (message === '/stop') {
        if (abortRef.current && !abortRef.current.signal.aborted) {
          abortRef.current.abort('Cancelled by /stop');
          pushEntry({ kind: 'system', title: 'Cancelling', body: 'Active request cancellation requested.' });
        } else {
          const output = await captureConsoleLines(() => handleCommand('/stop', context), (line) => pushEventLine(line));
          pushEntry({ kind: 'command', title: '/stop', body: output || 'No active request.' });
        }
        return;
      }
      if (message.startsWith('/')) {
        const normalized = normalizeCommand(message);
        setBusy(true);
        setPhase('running command');
        try {
          pushEventLine(`[command] ${normalized}`);
          const output = await captureConsoleLines(async () => {
            await handleCommand(normalized, context);
            await saveInteractiveState(stateRef.current).catch(() => {});
          }, (line) => pushEventLine(line));
          pushEntry({
            kind: 'command',
            title: normalized === message ? message : `${message}  →  ${normalized}`,
            body: output || 'OK',
          });
          setStatusTick((v) => v + 1);
        } catch (err) {
          pushEntry({ kind: 'error', title: message, body: err.message });
        } finally {
          setBusy(false);
          setPhase('idle');
        }
        return;
      }
      if (busy) {
        pushEntry({ kind: 'system', title: 'Request already running', body: 'Use /stop or Ctrl+C to cancel before sending another prompt.' });
        return;
      }
      if (shouldRouteToProjectTask(stateRef.current, options, message)) {
        await runProjectChat(message);
      } else {
        await runChat(message);
      }
    };

    useInput((inputChar, key) => {
      const rawInput = String(inputChar || '');
      if (bracketedPasteRef.current) {
        const endIndex = rawInput.indexOf(BRACKETED_PASTE_END);
        const chunk = endIndex >= 0 ? rawInput.slice(0, endIndex) : rawInput;
        if (chunk) editInputLine((value, index) => insertAtCursor(value, index, chunk));
        if (endIndex >= 0) bracketedPasteRef.current = false;
        return;
      }

      const fullPaste = pastedTextFromInput(rawInput);
      if (fullPaste) {
        clearPendingEscape();
        historyIndexRef.current = null;
        markInputTouched();
        setSuggestionIndex(0);
        editInputLine((value, index) => insertAtCursor(value, index, fullPaste));
        return;
      }

      const action = decodeInputAction(inputChar, key);
      if (action === 'paste-start') {
        clearPendingEscape();
        bracketedPasteRef.current = true;
        return;
      }
      if (action === 'paste-end') {
        bracketedPasteRef.current = false;
        return;
      }
      const pendingEscapeAt = pendingEscapeRef.current;
      if (pendingEscapeAt && Date.now() - pendingEscapeAt <= 500) {
        const sequencePart = keySequence(inputChar, key);
        const combinedSequence = `\u001b${pendingEscapeBufferRef.current}${sequencePart}`;
        const combinedAction = decodeInputAction(combinedSequence, {});
        if (combinedAction === 'paste-start') {
          clearPendingEscape();
          bracketedPasteRef.current = true;
          return;
        }
        if (combinedAction === 'paste-end') {
          clearPendingEscape();
          bracketedPasteRef.current = false;
          return;
        }
        const mappedAction = combinedAction === 'left' ? 'word-left' : combinedAction === 'right' ? 'word-right' : combinedAction;
        if (mappedAction && mappedAction !== 'escape' && applyLineEditAction(mappedAction)) {
          clearPendingEscape();
          return;
        }
        if (/^\u001b(?:\[|O)?[0-9;?]*$/.test(combinedSequence)) {
          pendingEscapeBufferRef.current += sequencePart;
          return;
        }
        if (inputChar === 'b' || inputChar === 'B' || action === 'left') {
          clearPendingEscape();
          markInputTouched();
          setCursor((value) => previousWordIndex(input, value));
          return;
        }
        if (inputChar === 'f' || inputChar === 'F' || action === 'right') {
          clearPendingEscape();
          markInputTouched();
          setCursor((value) => nextWordIndex(input, value));
          return;
        }
        if (inputChar === 'd' || inputChar === 'D') {
          clearPendingEscape();
          markInputTouched();
          editInputLine((value, index) => deleteWordRightAtCursor(value, index));
          return;
        }
        if (inputChar === '\u007f' || inputChar === '\u0008' || action === 'backspace') {
          clearPendingEscape();
          markInputTouched();
          editInputLine((value, index) => deleteWordLeftAtCursor(value, index));
          return;
        }
        if (action && action !== 'escape') clearPendingEscape();
      } else if (pendingEscapeAt) {
        clearPendingEscape();
      }

      if (confirmPrompt) {
        if (action === 'escape' || inputChar === 'n' || inputChar === 'N' || action === 'submit') {
          const resolver = confirmResolverRef.current;
          confirmResolverRef.current = null;
          setConfirmPrompt('');
          if (resolver) resolver(false);
          return;
        }
        if (inputChar === 'y' || inputChar === 'Y') {
          const resolver = confirmResolverRef.current;
          confirmResolverRef.current = null;
          setConfirmPrompt('');
          if (resolver) resolver(true);
          return;
        }
        return;
      }

      if (interruptPrompt) {
        if (action === 'escape') {
          clearPendingEscape();
          setInterruptPrompt(false);
          return;
        }
        if (inputChar === 'c' || inputChar === 'C') {
          setInterruptPrompt(false);
          if (abortRef.current && !abortRef.current.signal.aborted) {
            abortRef.current.abort('Cancelled by Ctrl+C');
            pushEntry({ kind: 'system', title: 'Cancelling', body: 'Active request cancellation requested.' });
          }
          return;
        }
        if (inputChar === 'd' || inputChar === 'D') {
          detachOnExit = true;
          app.exit();
          return;
        }
        return;
      }

      if (action === 'interrupt') {
        if (abortRef.current && !abortRef.current.signal.aborted) {
          setInterruptPrompt(true);
          return;
        }
        app.exit();
        return;
      }
      if (action === 'clear-screen') {
        clearTranscript();
        return;
      }
      if (action === 'line-start') { markInputTouched(); setCursor(0); return; }
      if (action === 'line-end') { markInputTouched(); setCursor(input.length); return; }
      if (action === 'word-left') { markInputTouched(); setCursor((value) => previousWordIndex(input, value)); return; }
      if (action === 'word-right') { markInputTouched(); setCursor((value) => nextWordIndex(input, value)); return; }
      if (action === 'left') { markInputTouched(); setCursor((value) => Math.max(0, value - 1)); return; }
      if (action === 'right') { markInputTouched(); setCursor((value) => Math.min(input.length, value + 1)); return; }
      if (action === 'backspace') { markInputTouched(); editInputLine((value, index) => backspaceAtCursor(value, index)); return; }
      if (action === 'delete') { markInputTouched(); editInputLine((value, index) => deleteAtCursor(value, index)); return; }
      if (action === 'delete-word-left') { markInputTouched(); editInputLine((value, index) => deleteWordLeftAtCursor(value, index)); return; }
      if (action === 'delete-word-right') { markInputTouched(); editInputLine((value, index) => deleteWordRightAtCursor(value, index)); return; }
      if (action === 'kill-line-left') { markInputTouched(); editInputLine((value, index) => killLineLeftAtCursor(value, index)); return; }
      if (action === 'kill-line-right') { markInputTouched(); editInputLine((value, index) => killLineRightAtCursor(value, index)); return; }
      if (action === 'delete-or-exit') {
        if (input.length) { markInputTouched(); editInputLine((value, index) => deleteAtCursor(value, index)); }
        else app.exit();
        return;
      }
      if (action === 'escape') {
        scheduleBareEscape();
        return;
      }

      if (action === 'submit') {
        const suggestions = shouldNavigateCommandSuggestions(input, completionActive) ? commandSuggestions(input) : [];
        if (suggestions.length) {
          const selected = suggestions[Math.max(0, Math.min(suggestionIndex, suggestions.length - 1))];
          const token = input.trimStart().split(/\s+/, 1)[0];
          if (selected && shouldCompleteSlashCommand(input, selected)) {
            setInputLine(`${selected.cmd} `);
            setSuggestionIndex(0);
            return;
          }
        }
        const line = input;
        historyBrowsingRef.current = false;
        historyDraftRef.current = null;
        setCompletionActive(false);
        setInputLine('');
        setSuggestionIndex(0);
        void submitLine(line);
        return;
      }
      if (action === 'history-prev') {
        const suggestions = shouldNavigateCommandSuggestions(input, completionActive) ? commandSuggestions(input) : [];
        if (suggestions.length) {
          setSuggestionIndex((value) => Math.max(0, value - 1));
          return;
        }
        const history = historyRef.current;
        if (!history.length) return;
        if (historyIndexRef.current == null) historyDraftRef.current = { input, cursor };
        const nextIndex = historyIndexRef.current == null ? 0 : Math.min(historyIndexRef.current + 1, history.length - 1);
        historyIndexRef.current = nextIndex;
        setInputFromHistory(history[nextIndex] || '');
        return;
      }
      if (action === 'history-next') {
        const suggestions = shouldNavigateCommandSuggestions(input, completionActive) ? commandSuggestions(input) : [];
        if (suggestions.length) {
          setSuggestionIndex((value) => Math.min(suggestions.length - 1, value + 1));
          return;
        }
        const history = historyRef.current;
        if (!history.length || historyIndexRef.current == null) return;
        const nextIndex = historyIndexRef.current - 1;
        if (nextIndex < 0) {
          historyIndexRef.current = null;
          historyBrowsingRef.current = false;
          setCompletionActive(false);
          const draft = historyDraftRef.current || { input: '', cursor: 0 };
          historyDraftRef.current = null;
          setInputLine(draft.input, draft.cursor);
        } else {
          historyIndexRef.current = nextIndex;
          setInputFromHistory(history[nextIndex] || '');
        }
        return;
      }
      if (key.tab) {
        markInputTouched();
        const suggestions = commandSuggestions(input);
        if (input.trimStart().startsWith('/') && suggestions.length) {
          const selected = suggestions[Math.max(0, Math.min(suggestionIndex, suggestions.length - 1))];
          if (selected && shouldCompleteSlashCommand(input, selected)) {
            setInputLine(`${selected.cmd} `);
            setSuggestionIndex(0);
            return;
          }
        }
        setInputLine(completeCommand(input));
        return;
      }
      if (inputChar && !isControlSequence(inputChar, key) && inputChar >= ' ') {
        historyIndexRef.current = null;
        markInputTouched();
        setSuggestionIndex(0);
        editInputLine((value, index) => insertAtCursor(value, index, inputChar));
      }
    });

    const health = options.bridge.health();
    const state = stateRef.current;
    void statusTick;

    const terminalRows = Math.max(18, Number(stdout?.rows) || 34);
    const terminalColumns = Math.max(40, Number(stdout?.columns) || 100);
    const showDebug = shouldShowDebugEvents(state) && eventLines.length > 0;
    const debugHeight = showDebug ? Math.min(MAX_EVENT_LINES, eventLines.length) + 3 : 0;
    const overlayHeight = interruptPrompt || confirmPrompt ? 5 : 0;
    const fixedHeight = 8 + 8 + debugHeight + overlayHeight; // status + input + optional debug/confirmation
    const liveHeight = Math.max(0, terminalRows - fixedHeight - 1);

    return React.createElement(Box, { flexDirection: 'column' },
      React.createElement(Static, { key: transcriptEpoch, items: entries }, (entry) => React.createElement(EntryCard, { key: entry.id, entry })),
      React.createElement(StatusHeader, { health, state, busy, phase, tick: statusTick }),
      React.createElement(LivePanel, { thinking, progress, answer, width: terminalColumns, height: liveHeight }),
      showDebug ? React.createElement(EventStrip, { events: eventLines, width: terminalColumns }) : null,
      interruptPrompt ? React.createElement(InterruptPrompt) : null,
      confirmPrompt ? React.createElement(ConfirmPrompt, { prompt: confirmPrompt }) : null,
      React.createElement(Box, { marginTop: 1, width: stdout?.columns || undefined }, React.createElement(InputLine, { input, cursor, busy: busy || Boolean(confirmPrompt), selectedIndex: suggestionIndex, completionActive, width: stdout?.columns || undefined }))
    );
  }

  const instance = render(React.createElement(App));
  await instance.waitUntilExit();
  // If the user chose detach while a prompt was running, do not send a local
  // shutdown cancellation. The browser tab can finish and /recover can attach
  // the result later.
  if (!detachOnExit) await options.bridge.close();
}
