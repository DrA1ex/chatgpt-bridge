import { config } from './config.js';
import {
  loadInteractiveState,
  saveInteractiveState,
  handleCommand,
  renderEvent,
  runLegacyInteractive,
} from './interactiveLegacy.js';

const EXIT_COMMANDS = new Set(['/exit', '/quit', 'exit', 'quit']);
const MAX_TRANSCRIPT_ITEMS = 14;
const MAX_EVENT_LINES = 8;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const COMMANDS = [
  { cmd: '/help', category: 'System', usage: '/help', description: 'Show command overview' },
  { cmd: '/status', category: 'Connection', usage: '/status', description: 'Show bridge, tab, session, file and project state' },
  { cmd: '/connect', category: 'Connection', usage: '/connect', description: 'Show setup URL and connection hint' },
  { cmd: '/tabs', category: 'Connection', usage: '/tabs', description: 'List connected ChatGPT tabs' },
  { cmd: '/tab', category: 'Connection', usage: '/tab [n|auto]', description: 'Show or select the active tab' },
  { cmd: '/sessions', category: 'Session', usage: '/sessions', description: 'List visible ChatGPT sessions' },
  { cmd: '/session', category: 'Session', usage: '/session [n|new]', description: 'Show, select, or create a session' },
  { cmd: '/model', category: 'Model', usage: '/model [n|name|default|list]', description: 'Show or set model' },
  { cmd: '/effort', category: 'Model', usage: '/effort [value|default|list]', description: 'Show or set reasoning effort' },
  { cmd: '/events', category: 'Model', usage: '/events [quiet|normal|verbose]', description: 'Set event verbosity' },
  { cmd: '/file', category: 'Files', usage: '/file [path|clear|remove n]', description: 'Queue attachments for the next message' },
  { cmd: '/files', category: 'Files', usage: '/files', description: 'List local files known to bridge' },
  { cmd: '/artifacts', category: 'Artifacts', usage: '/artifacts', description: 'List artifacts from recent answers' },
  { cmd: '/download', category: 'Artifacts', usage: '/download <n|id> [path]', description: 'Download an artifact' },
  { cmd: '/open', category: 'Artifacts', usage: '/open <n|id>', description: 'Open an artifact with the OS' },
  { cmd: '/project', category: 'Project', usage: '/project [path]', description: 'Show or open a project root' },
  { cmd: '/scan', category: 'Project', usage: '/scan', description: 'Scan the current project' },
  { cmd: '/pack', category: 'Project', usage: '/pack', description: 'Create/reuse a project snapshot ZIP' },
  { cmd: '/task', category: 'Project', usage: '/task <text>', description: 'Run a project task with ZIP context' },
  { cmd: '/result', category: 'Project', usage: '/result', description: 'Show last project result' },
  { cmd: '/recover', category: 'Project', usage: '/recover [list|n] [--apply|--force]', description: 'Recover one of the latest visible ChatGPT answers' },
  { cmd: '/apply', category: 'Project', usage: '/apply [zipPath] [--plan|--force|--interactive]', description: 'Apply last result or a local ZIP file' },
  { cmd: '/stop', category: 'System', usage: '/stop', description: 'Cancel the active request' },
  { cmd: '/clear', category: 'System', usage: '/clear', description: 'Clear the terminal transcript' },
  { cmd: '/quit', category: 'System', usage: '/quit', description: 'Exit interactive mode' },
];

const COMMAND_NAMES = COMMANDS.map((item) => item.cmd);

function truncate(text, limit = 100) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function preserveText(text, limit = 4000) {
  const value = String(text || '').trimEnd();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… ${value.length - limit} more chars`;
}

function compactTabLabel(client) {
  if (!client) return '(no tab)';
  const title = client.title || client.session?.title || client.url || client.id;
  const state = [client.visibilityState === 'visible' ? 'visible' : '', client.focused ? 'focused' : ''].filter(Boolean).join('/');
  return `${truncate(title, 58)}${state ? ` · ${state}` : ''}`;
}

function normalizeCommand(line) {
  const raw = String(line || '').trim();
  if (!raw.startsWith('/')) return raw;
  const [cmd, ...restParts] = raw.split(/\s+/);
  const rest = restParts.join(' ');

  if (cmd === '/status') return '/health';
  if (cmd === '/connect') return '/setup';
  if (cmd === '/diag') return '/diagnostics';
  if (cmd === '/tabs') return '/clients';
  if (cmd === '/tab') {
    if (!rest) return '/client current';
    if (rest === 'auto' || rest === 'clear') return '/select auto';
    if (rest === 'close-stale') return '/clients';
    return `/select ${rest}`;
  }
  if (cmd === '/session') {
    if (!rest) return '/session current';
    if (rest === 'new' || rest === 'current' || rest === 'refresh') return raw;
    if (rest.startsWith('select ')) return raw;
    return `/session select ${rest}`;
  }
  if (cmd === '/project') {
    if (!rest) return raw;
    if (/^(open|scan|pack|sync|sessions|session)\b/.test(rest)) return raw;
    return `/project open ${rest}`;
  }
  if (cmd === '/file') {
    if (!rest) return '/attachments';
    if (rest === 'clear') return '/detach all';
    if (rest.startsWith('remove ')) return `/detach ${rest.slice('remove '.length).trim()}`;
    if (rest.startsWith('add ')) return raw;
    return `/attach ${rest}`;
  }
  if (cmd === '/scan') return '/project scan';
  if (cmd === '/pack') return '/project pack';
  if (cmd === '/apply') return `/result apply${rest ? ` ${rest}` : ''}`;
  if (cmd === '/recover') return `/recover${rest ? ` ${rest}` : ''}`;
  return raw;
}

async function captureConsoleLines(fn) {
  const lines = [];
  const oldLog = console.log;
  const oldError = console.error;
  const oldWarn = console.warn;
  const write = (...args) => {
    lines.push(args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg, null, 2)).join(' '));
  };
  console.log = write;
  console.error = write;
  console.warn = write;
  try {
    await fn();
  } finally {
    console.log = oldLog;
    console.error = oldError;
    console.warn = oldWarn;
  }
  return lines.join('\n').trim();
}

function buildHelpText() {
  const groups = new Map();
  for (const item of COMMANDS) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  const lines = [
    'Plain text sends a normal ChatGPT prompt. Use /task only for project ZIP workflow.',
    '',
  ];
  for (const [category, items] of groups.entries()) {
    lines.push(`${category}:`);
    for (const item of items) {
      lines.push(`  ${item.usage.padEnd(34)} ${item.description}`);
    }
    lines.push('');
  }
  lines.push('Hidden compatibility aliases still work: /ask, /clients, /select, /attachments, /detach, /diagnostics, /health.');
  return lines.join('\n').trim();
}

function commandSuggestions(input) {
  const value = String(input || '').trimStart();
  if (!value.startsWith('/')) return [];
  const token = value.split(/\s+/, 1)[0].toLowerCase();
  return COMMANDS
    .filter((item) => item.cmd.startsWith(token));
}

function completeCommand(input) {
  const value = String(input || '');
  const match = value.match(/^(\s*\/\S*)(.*)$/);
  if (!match) return value;
  const prefix = match[1].trimStart().toLowerCase();
  const matches = COMMAND_NAMES.filter((cmd) => cmd.startsWith(prefix));
  if (!matches.length) return value;
  if (matches.length === 1) return `${matches[0]}${match[2] || ' '}`;
  let common = matches[0];
  for (const cmd of matches.slice(1)) {
    let i = 0;
    while (i < common.length && common[i] === cmd[i]) i += 1;
    common = common.slice(0, i);
  }
  return common.length > prefix.length ? `${common}${match[2] || ''}` : value;
}


function clampCursor(value, cursor) {
  const length = String(value || '').length;
  return Math.max(0, Math.min(length, Number(cursor) || 0));
}

function previousWordIndex(value, cursor) {
  const text = String(value || '');
  let index = clampCursor(text, cursor);
  while (index > 0 && /\s/.test(text[index - 1])) index -= 1;
  while (index > 0 && !/\s/.test(text[index - 1])) index -= 1;
  return index;
}

function nextWordIndex(value, cursor) {
  const text = String(value || '');
  let index = clampCursor(text, cursor);
  while (index < text.length && /\s/.test(text[index])) index += 1;
  while (index < text.length && !/\s/.test(text[index])) index += 1;
  return index;
}

function insertAtCursor(value, cursor, input) {
  const text = String(value || '');
  const index = clampCursor(text, cursor);
  const chunk = String(input || '');
  return { value: `${text.slice(0, index)}${chunk}${text.slice(index)}`, cursor: index + chunk.length };
}

function backspaceAtCursor(value, cursor) {
  const text = String(value || '');
  const index = clampCursor(text, cursor);
  if (index <= 0) return { value: text, cursor: index };
  return { value: `${text.slice(0, index - 1)}${text.slice(index)}`, cursor: index - 1 };
}

function deleteAtCursor(value, cursor) {
  const text = String(value || '');
  const index = clampCursor(text, cursor);
  if (index >= text.length) return { value: text, cursor: index };
  return { value: `${text.slice(0, index)}${text.slice(index + 1)}`, cursor: index };
}

function keySequence(inputChar) {
  return String(inputChar || '');
}

function eventTone(line) {
  if (/\[error\]|ERROR|failed/i.test(line)) return 'red';
  if (/\[done\]|applied|attached/i.test(line)) return 'green';
  if (/warning|warn|select-tab|not-connected/i.test(line)) return 'yellow';
  if (/generation|prompt|request/i.test(line)) return 'cyan';
  return 'gray';
}

function nextPhaseFromEvent(event, fallback) {
  const type = String(event?.type || '');
  if (type === 'request.started') return 'starting';
  if (type === 'prompt.delivered' || type === 'prompt.accepted') return 'delivered';
  if (type === 'prompt.sent' || type === 'chat.prompt.sent') return 'sent';
  if (type === 'generation.started' || type === 'chat.generation.started') return 'generating';
  if (type === 'thinking.delta' || type === 'thinking.snapshot') return 'thinking';
  if (type === 'answer.delta' || type === 'answer.snapshot') return 'writing answer';
  if (type === 'generation.stopped' || type === 'chat.generation.stopped') return 'reading answer';
  if (type === 'request.done') return 'done';
  if (type === 'request.error') return 'error';
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
  const { render, Box, Text, useApp, useInput, useStdout } = ink;
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

  function Panel({ title, borderColor = 'gray', children }) {
    return React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', borderColor, paddingX: 1 },
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
      entry.body ? React.createElement(Text, null, preserveText(entry.body)) : null
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

  function EventStrip({ events }) {
    if (!events.length) return null;
    return React.createElement(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: 'gray', paddingX: 1 },
      React.createElement(Text, { dimColor: true }, 'Events'),
      ...events.slice(-MAX_EVENT_LINES).map((line, index) => React.createElement(Text, { key: `${index}-${line.slice(0, 20)}`, color: eventTone(line) }, line))
    );
  }

  function Suggestions({ input, selectedIndex = 0 }) {
    const suggestions = commandSuggestions(input);
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

  function InputLine({ input, cursor, busy, selectedIndex, width }) {
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
      React.createElement(Suggestions, { input, selectedIndex })
    );
  }

  function InterruptPrompt() {
    return React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1, marginTop: 1 },
      React.createElement(Text, { color: 'yellow', bold: true }, 'Request is still running'),
      React.createElement(Text, null, 'Press c to cancel the ChatGPT prompt, d to detach/exit and leave it running, Esc to continue.')
    );
  }

  let detachOnExit = false;

  function App() {
    const app = useApp();
    const { stdout } = useStdout();
    const stateRef = useRef(initialState);
    const [entries, setEntries] = useState(() => [
      { kind: 'system', title: 'Ready', body: `Type a prompt directly, or use /help. Server: ${config.publicBaseUrl}` },
    ]);
    const [eventLines, setEventLines] = useState([]);
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [answer, setAnswer] = useState('');
    const [thinking, setThinking] = useState('');
    const [phase, setPhase] = useState('idle');
    const [statusTick, setStatusTick] = useState(0);
    const [suggestionIndex, setSuggestionIndex] = useState(0);
    const [interruptPrompt, setInterruptPrompt] = useState(false);
    const abortRef = useRef(null);
    const historyRef = useRef([]);
    const historyIndexRef = useRef(null);

    const transcriptLimit = Math.max(6, Math.min(MAX_TRANSCRIPT_ITEMS, (stdout?.rows || 34) - 18));

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
      setEntries((items) => [...items, { time: new Date().toISOString(), ...entry }].slice(-MAX_TRANSCRIPT_ITEMS));
    };

    const pushEventLine = (line = '') => {
      const text = String(line).trimEnd();
      if (!text) return;
      setEventLines((lines) => [...lines, ...text.split('\n').filter(Boolean)].slice(-MAX_EVENT_LINES));
    };

    const context = useMemo(() => ({
      bridge: options.bridge,
      fileStore: options.fileStore,
      state: stateRef.current,
      projectService: options.projectService,
      turnManager: options.turnManager,
      confirm: async () => false,
    }), []);

    useEffect(() => {
      const interval = setInterval(() => setStatusTick((v) => v + 1), 180);
      const unsubscribe = typeof options.bridge.onClientLifecycle === 'function'
        ? options.bridge.onClientLifecycle(() => setStatusTick((v) => v + 1))
        : () => {};
      return () => {
        clearInterval(interval);
        unsubscribe();
      };
    }, []);

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
      setEventLines([]);
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
            const line = renderEvent(event, state.eventLevel);
            if (line) pushEventLine(line);
          },
          onThinkingUpdate: (text) => setThinking(text || ''),
          onAnswerUpdate: (text) => setAnswer(text || ''),
          onArtifactUpdate: (artifacts) => {
            state.lastArtifacts = artifacts;
            if (artifacts?.length) pushEventLine(`[artifact] discovered ${artifacts.length}`);
          },
        }, { signal: abortController.signal, fullResponse: true });

        if (response.session?.id) state.sessionId = response.session.id;
        if (Array.isArray(response.artifacts) && response.artifacts.length) state.lastArtifacts = response.artifacts;
        state.pendingAttachments = [];
        setAnswer('');
        setThinking('');
        if (response.thinking) pushEntry({ kind: 'command', title: 'Thinking', body: response.thinking });
        pushEntry({ kind: 'assistant', title: 'Assistant', body: response.answer || '(empty answer)' });
        if (response.artifacts?.length) {
          pushEntry({
            kind: 'artifact',
            title: `Artifacts (${response.artifacts.length})`,
            body: response.artifacts.map((artifact, index) => `[${index + 1}] ${artifact.name || artifact.filename || artifact.id || 'artifact'}`).join('\n'),
          });
        }
        await saveInteractiveState(state).catch(() => {});
      } catch (err) {
        pushEntry({ kind: 'error', title: 'Request failed', body: err.message });
        pushEventLine('Queued attachments were kept for retry. Use /file clear to clear them.');
        await saveInteractiveState(state).catch(() => {});
      } finally {
        abortRef.current = null;
        setBusy(false);
        setPhase('idle');
      }
    };

    const submitLine = async (line) => {
      const message = String(line || '').trim();
      if (!message) return;
      historyRef.current = [message, ...historyRef.current.filter((item) => item !== message)].slice(0, 80);
      historyIndexRef.current = null;
      if (EXIT_COMMANDS.has(message.toLowerCase())) {
        app.exit();
        return;
      }
      if (message === '/clear') {
        setEntries([{ kind: 'system', title: 'Cleared', body: 'Transcript cleared.' }]);
        setEventLines([]);
        setAnswer('');
        setThinking('');
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
          const output = await captureConsoleLines(() => handleCommand('/stop', context));
          pushEntry({ kind: 'command', title: '/stop', body: output || 'No active request.' });
        }
        return;
      }
      if (message.startsWith('/')) {
        const normalized = normalizeCommand(message);
        try {
          const output = await captureConsoleLines(async () => {
            await handleCommand(normalized, context);
            await saveInteractiveState(stateRef.current).catch(() => {});
          });
          pushEntry({
            kind: 'command',
            title: normalized === message ? message : `${message}  →  ${normalized}`,
            body: output || 'OK',
          });
          setStatusTick((v) => v + 1);
        } catch (err) {
          pushEntry({ kind: 'error', title: message, body: err.message });
        }
        return;
      }
      if (busy) {
        pushEntry({ kind: 'system', title: 'Request already running', body: 'Use /stop or Ctrl+C to cancel before sending another prompt.' });
        return;
      }
      await runChat(message);
    };

    useInput((inputChar, key) => {
      if (interruptPrompt) {
        if (key.escape) {
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
      if (key.ctrl && inputChar === 'c') {
        if (abortRef.current && !abortRef.current.signal.aborted) {
          setInterruptPrompt(true);
          return;
        }
        app.exit();
        return;
      }
      if (key.ctrl && inputChar === 'l') {
        setEntries([{ kind: 'system', title: 'Cleared', body: 'Transcript cleared.' }]);
        setEventLines([]);
        return;
      }
      if (key.return) {
        const suggestions = commandSuggestions(input);
        if (input.trimStart().startsWith('/') && suggestions.length) {
          const selected = suggestions[Math.max(0, Math.min(suggestionIndex, suggestions.length - 1))];
          const token = input.trimStart().split(/\s+/, 1)[0];
          if (selected && token !== selected.cmd) {
            setInputLine(`${selected.cmd} `);
            setSuggestionIndex(0);
            return;
          }
        }
        const line = input;
        setInputLine('');
        setSuggestionIndex(0);
        void submitLine(line);
        return;
      }
      if (key.backspace) {
        editInputLine((value, index) => backspaceAtCursor(value, index));
        return;
      }
      if (key.delete) {
        editInputLine((value, index) => deleteAtCursor(value, index));
        return;
      }
      if (key.upArrow) {
        const suggestions = commandSuggestions(input);
        if (input.trimStart().startsWith('/') && suggestions.length) {
          setSuggestionIndex((value) => Math.max(0, value - 1));
          return;
        }
        const history = historyRef.current;
        if (!history.length) return;
        const nextIndex = historyIndexRef.current == null ? 0 : Math.min(historyIndexRef.current + 1, history.length - 1);
        historyIndexRef.current = nextIndex;
        setInputLine(history[nextIndex] || '');
        return;
      }
      if (key.downArrow) {
        const suggestions = commandSuggestions(input);
        if (input.trimStart().startsWith('/') && suggestions.length) {
          setSuggestionIndex((value) => Math.min(suggestions.length - 1, value + 1));
          return;
        }
        const history = historyRef.current;
        if (!history.length || historyIndexRef.current == null) return;
        const nextIndex = historyIndexRef.current - 1;
        if (nextIndex < 0) {
          historyIndexRef.current = null;
          setInputLine('');
        } else {
          historyIndexRef.current = nextIndex;
          setInputLine(history[nextIndex] || '');
        }
        return;
      }
      if (key.tab) {
        const suggestions = commandSuggestions(input);
        if (input.trimStart().startsWith('/') && suggestions.length) {
          const selected = suggestions[Math.max(0, Math.min(suggestionIndex, suggestions.length - 1))];
          if (selected) {
            setInputLine(`${selected.cmd} `);
            setSuggestionIndex(0);
            return;
          }
        }
        setInputLine(completeCommand(input));
        return;
      }
      const sequence = keySequence(inputChar);
      if (key.leftArrow || sequence === '\u001b[D') {
        if (key.meta) setCursor(0);
        else if (key.ctrl) setCursor((value) => previousWordIndex(input, value));
        else setCursor((value) => Math.max(0, value - 1));
        return;
      }
      if (key.rightArrow || sequence === '\u001b[C') {
        if (key.meta) setCursor(input.length);
        else if (key.ctrl) setCursor((value) => nextWordIndex(input, value));
        else setCursor((value) => Math.min(input.length, value + 1));
        return;
      }
      // Common terminal sequences: Option+Left/Right => ESC b/f; Home/End
      // or Cmd+Left/Right are often mapped to these by macOS terminal apps.
      if (sequence === '\u001bb') { setCursor((value) => previousWordIndex(input, value)); return; }
      if (sequence === '\u001bf') { setCursor((value) => nextWordIndex(input, value)); return; }
      if (key.home || sequence === '\u0001' || sequence === '\u001b[H' || sequence === '\u001bOH') { setCursor(0); return; }
      if (key.end || sequence === '\u0005' || sequence === '\u001b[F' || sequence === '\u001bOF') { setCursor(input.length); return; }
      if (key.escape) return;
      if (inputChar) {
        historyIndexRef.current = null;
        setSuggestionIndex(0);
        editInputLine((value, index) => insertAtCursor(value, index, inputChar));
      }
    });

    const health = options.bridge.health();
    const state = stateRef.current;
    void statusTick;

    return React.createElement(Box, { flexDirection: 'column' },
      React.createElement(StatusHeader, { health, state, busy, phase, tick: statusTick }),
      React.createElement(Box, { flexDirection: 'column', marginTop: 1 },
        ...entries.slice(-transcriptLimit).map((entry, index) => React.createElement(EntryCard, { key: `${index}-${entry.time || ''}-${entry.title}`, entry })),
        thinking ? React.createElement(Panel, { title: 'Thinking', borderColor: 'yellow' },
          React.createElement(Text, null, preserveText(thinking, 3000))
        ) : null,
        answer ? React.createElement(Panel, { title: 'Assistant streaming', borderColor: 'cyan' },
          React.createElement(Text, null, preserveText(answer, 6000))
        ) : null
      ),
      React.createElement(EventStrip, { events: eventLines }),
      interruptPrompt ? React.createElement(InterruptPrompt) : null,
      React.createElement(Box, { marginTop: 1, width: stdout?.columns || undefined }, React.createElement(InputLine, { input, cursor, busy, selectedIndex: suggestionIndex, width: stdout?.columns || undefined }))
    );
  }

  const instance = render(React.createElement(App));
  await instance.waitUntilExit();
  // If the user chose detach while a prompt was running, do not send a local
  // shutdown cancellation. The browser tab can finish and /recover can attach
  // the result later.
  if (!detachOnExit) await options.bridge.close();
}
