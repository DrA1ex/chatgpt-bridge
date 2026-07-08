import { config } from './config.js';
import {
  loadInteractiveState,
  saveInteractiveState,
  handleCommand,
  renderEvent,
  rememberResponse,
  runProjectTask,
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
  { cmd: '/resume', category: 'Project', usage: '/resume', description: 'Attach to a prompt already running in the active tab' },
  { cmd: '/result', category: 'Project', usage: '/result', description: 'Show last project result' },
  { cmd: '/recover', category: 'Project', usage: '/recover [list|n] [--apply|--force]', description: 'Recover one of the latest visible ChatGPT answers' },
  { cmd: '/responses', category: 'Project', usage: '/responses [list|n]', description: 'List saved answers or show full answer text' },
  { cmd: '/apply', category: 'Project', usage: '/apply [zipPath] [--plan|--force|--interactive]', description: 'Apply last result or a local ZIP file' },
  { cmd: '/stop', category: 'System', usage: '/stop', description: 'Cancel the active request' },
  { cmd: '/clear', category: 'System', usage: '/clear', description: 'Clear the terminal transcript' },
  { cmd: '/quit', category: 'System', usage: '/quit', description: 'Exit interactive mode' },
];

const COMMAND_NAMES = COMMANDS.map((item) => item.cmd);

export function shouldRouteToProjectTask(state = {}, options = {}, message = '') {
  const text = String(message || '').trim();
  return Boolean(
    text &&
    state?.projectRoot &&
    options?.projectService &&
    options?.turnManager
  );
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
  if (cmd === '/answer' || cmd === '/answers' || cmd === '/response') return `/responses${rest ? ` ${rest}` : ''}`;
  return raw;
}

async function captureConsoleLines(fn, onLine = null) {
  const lines = [];
  const oldLog = console.log;
  const oldError = console.error;
  const oldWarn = console.warn;
  const write = (...args) => {
    const line = args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg, null, 2)).join(' ');
    lines.push(line);
    if (typeof onLine === 'function') onLine(line);
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

export function commandSuggestions(input) {
  const value = String(input || '').trimStart();
  if (!value.startsWith('/')) return [];
  const match = value.match(/^(\/\S+)([\s\S]*)$/);
  if (!match) return [];
  const token = match[1].toLowerCase();
  const rest = match[2] || '';
  // Once the user has typed a complete command followed by whitespace, the
  // completion surface belongs to that command's arguments. Do not keep showing
  // longer command names such as `/tabs` while the user is typing `/tab 1`.
  if (COMMAND_NAMES.includes(token) && /^\s/.test(rest)) return [];
  return COMMANDS
    .filter((item) => item.cmd.startsWith(token))
    .sort((a, b) => {
      const aExact = a.cmd === token ? 0 : 1;
      const bExact = b.cmd === token ? 0 : 1;
      return aExact - bExact || a.cmd.localeCompare(b.cmd);
    });
}

export function shouldCompleteSlashCommand(input, selected) {
  const value = String(input || '');
  const token = value.trimStart().split(/\s+/, 1)[0];
  if (!selected?.cmd) return false;
  if (token === selected.cmd && /\s/.test(value.slice(value.indexOf(token) + token.length))) return false;
  return token !== selected.cmd || !value.endsWith(' ');
}

export function completeCommand(input) {
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

function deleteWordLeftAtCursor(value, cursor) {
  const text = String(value || '');
  const index = clampCursor(text, cursor);
  const start = previousWordIndex(text, index);
  if (start === index) return { value: text, cursor: index };
  return { value: `${text.slice(0, start)}${text.slice(index)}`, cursor: start };
}

function deleteWordRightAtCursor(value, cursor) {
  const text = String(value || '');
  const index = clampCursor(text, cursor);
  const end = nextWordIndex(text, index);
  if (end === index) return { value: text, cursor: index };
  return { value: `${text.slice(0, index)}${text.slice(end)}`, cursor: index };
}

function killLineLeftAtCursor(value, cursor) {
  const text = String(value || '');
  const index = clampCursor(text, cursor);
  return { value: text.slice(index), cursor: 0 };
}

function killLineRightAtCursor(value, cursor) {
  const text = String(value || '');
  const index = clampCursor(text, cursor);
  return { value: text.slice(0, index), cursor: index };
}


const BRACKETED_PASTE_START = '\u001b[200~';
const BRACKETED_PASTE_END = '\u001b[201~';

export function pastedTextFromInput(inputChar = '') {
  const raw = String(inputChar || '');
  if (!raw) return '';
  if (raw.includes(BRACKETED_PASTE_START) || raw.includes(BRACKETED_PASTE_END)) {
    const start = raw.indexOf(BRACKETED_PASTE_START);
    const end = raw.indexOf(BRACKETED_PASTE_END, start >= 0 ? start + BRACKETED_PASTE_START.length : 0);
    let value = raw;
    if (start >= 0) value = value.slice(start + BRACKETED_PASTE_START.length);
    if (end >= 0) {
      const adjustedEnd = start >= 0 ? end - (start + BRACKETED_PASTE_START.length) : end;
      value = value.slice(0, Math.max(0, adjustedEnd));
    }
    return value.replaceAll(BRACKETED_PASTE_START, '').replaceAll(BRACKETED_PASTE_END, '');
  }
  if (raw.length <= 1) return '';
  if (raw.includes('\u001b')) return '';
  // A terminal paste can include newlines/tabs. Treat other control bytes as
  // key sequences rather than text.
  return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw) ? '' : raw;
}

function keySequence(inputChar, key = {}) {
  return String(inputChar || key.sequence || key.raw || '');
}

function keyName(key = {}) {
  return String(key.name || key.key || '').toLowerCase();
}

function controlCode(sequence) {
  const value = String(sequence || '');
  return value.length === 1 ? value.charCodeAt(0) : 0;
}

function matchesAny(value, patterns) {
  const sequence = String(value || '');
  return patterns.some((pattern) => pattern instanceof RegExp ? pattern.test(sequence) : sequence === pattern);
}

function isControlSequence(inputChar, key = {}) {
  const sequence = keySequence(inputChar, key);
  if (!sequence) return false;
  if (key.ctrl || key.meta || key.alt || key.option) return true;
  if (sequence.length !== 1) return true;
  return sequence.charCodeAt(0) < 32 || sequence.charCodeAt(0) === 127;
}

export function decodeInputAction(inputChar, key = {}) {
  const sequence = keySequence(inputChar, key);
  const name = keyName(key);
  const lowerInput = String(inputChar || '').toLowerCase();
  const code = controlCode(sequence);
  const ctrl = Boolean(key.ctrl || key.control);
  const alt = Boolean(key.option || key.alt);
  const meta = Boolean(key.meta);

  if (sequence === BRACKETED_PASTE_START) return 'paste-start';
  if (sequence === BRACKETED_PASTE_END) return 'paste-end';

  // Return/Enter can arrive as LF (Ctrl+J), CR (Ctrl+M), or Ink's key.return.
  if (key.return || name === 'return' || name === 'enter' || code === 10 || code === 13) return 'submit';

  if ((ctrl && lowerInput === 'c') || code === 3 || name === 'c-c') return 'interrupt';
  if ((ctrl && lowerInput === 'l') || code === 12 || name === 'c-l') return 'clear-screen';
  if ((ctrl && lowerInput === 'a') || code === 1 || name === 'c-a') return 'line-start';
  if ((ctrl && lowerInput === 'e') || code === 5 || name === 'c-e') return 'line-end';
  if ((ctrl && lowerInput === 'b') || code === 2 || name === 'c-b') return 'left';
  if ((ctrl && lowerInput === 'f') || code === 6 || name === 'c-f') return 'right';
  if ((ctrl && lowerInput === 'p') || code === 16 || name === 'c-p') return 'history-prev';
  if ((ctrl && lowerInput === 'n') || code === 14 || name === 'c-n') return 'history-next';
  if ((ctrl && lowerInput === 'k') || code === 11 || name === 'c-k') return 'kill-line-right';
  if ((ctrl && lowerInput === 'u') || code === 21 || name === 'c-u') return 'kill-line-left';
  if ((ctrl && lowerInput === 'w') || code === 23 || name === 'c-w') return 'delete-word-left';
  if ((ctrl && lowerInput === 'd') || code === 4 || name === 'c-d') return 'delete-or-exit';
  if (code === 8 || name === 'c-h') return 'backspace';

  // Different terminals report Backspace as key.backspace, key.delete, DEL, BS,
  // or only as key.name. macOS Terminal/iTerm often label Backspace as `delete`
  // while sending DEL. Prefer DEL/BS and Ink's backspace flag as backward-delete.
  if (key.backspace || name === 'backspace' || sequence === '\u007f' || sequence === '\u0008') return 'backspace';

  // Forward delete is only trusted from explicit terminal delete sequences. Do not
  // infer it from key.name === "delete" alone on macOS, because that is commonly
  // the physical Backspace key.
  const explicitForwardDelete = matchesAny(sequence, ['\u001b[3~', '\u001b[3;2~', '\u001b[3;3~', '\u001b[3;5~', '\u001b[3;9~']);
  if (explicitForwardDelete) return 'delete';
  if (key.delete || name === 'delete') return 'backspace';

  // Word editing/navigation. macOS Terminal/iTerm commonly sends ESC-b/ESC-f and
  // ESC-DEL for Option+Arrow / Option+Backspace. Some profiles send ESC + arrow
  // as separate keypresses, which is handled in the useInput pending-escape branch.
  if (matchesAny(sequence, ['\u001b\u007f', '\u001b\u0008'])) return 'delete-word-left';
  if (matchesAny(sequence, ['\u001bd', '\u001bD'])) return 'delete-word-right';
  if (matchesAny(sequence, [
    '\u001bb', '\u001bB', '\u001b\u001b[D', '\u001b[1;3D', '\u001b[1;5D', '\u001b[1;7D', '\u001b[1;9D',
    '\u001b[5D', '\u001b[5;3D', '\u001b[5;5D', '\u001b[1;3~', /\u001b\[.*;(?:3|5|9)D$/
  ])) return 'word-left';
  if (matchesAny(sequence, [
    '\u001bf', '\u001bF', '\u001b\u001b[C', '\u001b[1;3C', '\u001b[1;5C', '\u001b[1;7C', '\u001b[1;9C',
    '\u001b[5C', '\u001b[5;3C', '\u001b[5;5C', '\u001b[1;3~', /\u001b\[.*;(?:3|5|9)C$/
  ])) return 'word-right';

  // Cmd+Arrow is terminal-dependent. Many macOS terminal profiles map it to
  // Home/End; some emit CSI with modifier 9/10/13/14. If a terminal swallows
  // Cmd+Arrow globally, Node cannot observe it.
  if (key.home || name === 'home' || matchesAny(sequence, [
    '\u001b[H', '\u001bOH', '\u001b[1~', '\u001b[7~', '\u001b[1;13D', '\u001b[1;14D',
    /\u001b\[.*;(?:13|14)D$/
  ])) return 'line-start';
  if (key.end || name === 'end' || matchesAny(sequence, [
    '\u001b[F', '\u001bOF', '\u001b[4~', '\u001b[8~', '\u001b[1;13C', '\u001b[1;14C',
    /\u001b\[.*;(?:13|14)C$/
  ])) return 'line-end';

  if ((ctrl || key.ctrl) && (key.leftArrow || name === 'left')) return 'word-left';
  if ((ctrl || key.ctrl) && (key.rightArrow || name === 'right')) return 'word-right';
  if (alt && (key.leftArrow || name === 'left')) return 'word-left';
  if (alt && (key.rightArrow || name === 'right')) return 'word-right';
  // In Node/readline, key.meta usually means Alt/Option rather than the macOS
  // Command key. Treat generic meta+arrow as word movement. Command+arrow is
  // supported through explicit Home/End or CSI modifier sequences above.
  if (meta && (key.leftArrow || name === 'left')) return 'word-left';
  if (meta && (key.rightArrow || name === 'right')) return 'word-right';
  if (key.leftArrow || name === 'left' || sequence === '\u001b[D' || sequence === '\u001bOD') return 'left';
  if (key.rightArrow || name === 'right' || sequence === '\u001b[C' || sequence === '\u001bOC') return 'right';
  if (key.upArrow || name === 'up' || sequence === '\u001b[A' || sequence === '\u001bOA') return 'history-prev';
  if (key.downArrow || name === 'down' || sequence === '\u001b[B' || sequence === '\u001bOB') return 'history-next';

  if (key.escape || name === 'escape' || sequence === '\u001b') return 'escape';
  return null;
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
  if (type === 'assistant.progress.snapshot') return 'progress';
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
      { kind: 'system', title: 'Ready', body: `Type a prompt directly, or use /help. Server: ${config.publicBaseUrl}` },
    ]);
    const [eventLines, setEventLines] = useState([]);
    const [input, setInput] = useState('');
    const [cursor, setCursor] = useState(0);
    const [busy, setBusy] = useState(false);
    const [answer, setAnswer] = useState('');
    const [thinking, setThinking] = useState('');
    const [progress, setProgress] = useState('');
    const [phase, setPhase] = useState('idle');
    const [statusTick, setStatusTick] = useState(0);
    const [suggestionIndex, setSuggestionIndex] = useState(0);
    const [interruptPrompt, setInterruptPrompt] = useState(false);
    const [confirmPrompt, setConfirmPrompt] = useState('');
    const abortRef = useRef(null);
    const historyRef = useRef([]);
    const historyIndexRef = useRef(null);
    const pendingEscapeRef = useRef(0);
    const pendingEscapeBufferRef = useRef('');
    const pendingEscapeTimerRef = useRef(null);
    const bracketedPasteRef = useRef(false);
    const confirmResolverRef = useRef(null);

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
      createConsoleStream: (label = 'Working') => {
        let printedAnswer = '';
        let printedThinking = '';
        pushEventLine(`[command] ${label}`);
        return {
          status(line) {
            if (line) pushEventLine(line);
          },
          onThinkingUpdate(text) {
            const value = String(text || '');
            if (!value || value === printedThinking) return;
            printedThinking = value;
            setThinking(value);
          },
          onProgressUpdate(text) {
            const value = String(text || '');
            if (!value) return;
            setProgress(value);
          },
          onAnswerUpdate(text) {
            const value = String(text || '');
            if (!value || value === printedAnswer) return;
            printedAnswer = value;
            setAnswer(value);
          },
          onArtifactUpdate(artifacts = []) {
            if (artifacts.length) pushEventLine(`[artifact] discovered ${artifacts.length}`);
          },
          finish(finalAnswer = '') {
            const text = String(finalAnswer || printedAnswer || '').trim();
            setThinking('');
            setProgress('');
            setAnswer('');
            if (text) pushEntry({ kind: 'assistant', title: 'Assistant', body: text });
            else pushEventLine('[answer] empty final answer');
          },
          fail() {
            setThinking('');
            setProgress('');
            setAnswer('');
          },
        };
      },
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
      setEventLines([]);
      pushEntry({ kind: 'user', title: 'You', subtitle: `project: ${state.projectRoot}`, body: message });
      try {
        await runProjectTask(message, { ...context, signal: abortController.signal });
        await saveInteractiveState(state).catch(() => {});
      } catch (err) {
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
          onProgressUpdate: (text) => setProgress(text || ''),
          onAnswerUpdate: (text) => setAnswer(text || ''),
          onArtifactUpdate: (artifacts) => {
            state.lastArtifacts = artifacts;
            if (artifacts?.length) pushEventLine(`[artifact] discovered ${artifacts.length}`);
          },
        }, { signal: abortController.signal, fullResponse: true });

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
        if (response.thinking) pushEntry({ kind: 'command', title: 'Thinking', body: response.thinking });
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
          historyIndexRef.current = null;
        }
      }, 45);
    };

    const applyLineEditAction = (resolvedAction) => {
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
      if (EXIT_COMMANDS.has(message.toLowerCase())) {
        app.exit();
        return;
      }
      if (message === '/clear') {
        setEntries([{ kind: 'system', title: 'Cleared', body: 'Transcript cleared.' }]);
        setEventLines([]);
        setAnswer('');
        setThinking('');
        setProgress('');
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
          setCursor((value) => previousWordIndex(input, value));
          return;
        }
        if (inputChar === 'f' || inputChar === 'F' || action === 'right') {
          clearPendingEscape();
          setCursor((value) => nextWordIndex(input, value));
          return;
        }
        if (inputChar === 'd' || inputChar === 'D') {
          clearPendingEscape();
          editInputLine((value, index) => deleteWordRightAtCursor(value, index));
          return;
        }
        if (inputChar === '\u007f' || inputChar === '\u0008' || action === 'backspace') {
          clearPendingEscape();
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
        setEntries([{ kind: 'system', title: 'Cleared', body: 'Transcript cleared.' }]);
        setEventLines([]);
        return;
      }
      if (action === 'line-start') { setCursor(0); return; }
      if (action === 'line-end') { setCursor(input.length); return; }
      if (action === 'word-left') { setCursor((value) => previousWordIndex(input, value)); return; }
      if (action === 'word-right') { setCursor((value) => nextWordIndex(input, value)); return; }
      if (action === 'left') { setCursor((value) => Math.max(0, value - 1)); return; }
      if (action === 'right') { setCursor((value) => Math.min(input.length, value + 1)); return; }
      if (action === 'backspace') { editInputLine((value, index) => backspaceAtCursor(value, index)); return; }
      if (action === 'delete') { editInputLine((value, index) => deleteAtCursor(value, index)); return; }
      if (action === 'delete-word-left') { editInputLine((value, index) => deleteWordLeftAtCursor(value, index)); return; }
      if (action === 'delete-word-right') { editInputLine((value, index) => deleteWordRightAtCursor(value, index)); return; }
      if (action === 'kill-line-left') { editInputLine((value, index) => killLineLeftAtCursor(value, index)); return; }
      if (action === 'kill-line-right') { editInputLine((value, index) => killLineRightAtCursor(value, index)); return; }
      if (action === 'delete-or-exit') {
        if (input.length) editInputLine((value, index) => deleteAtCursor(value, index));
        else app.exit();
        return;
      }
      if (action === 'escape') {
        scheduleBareEscape();
        return;
      }

      if (action === 'submit') {
        const suggestions = commandSuggestions(input);
        if (input.trimStart().startsWith('/') && suggestions.length) {
          const selected = suggestions[Math.max(0, Math.min(suggestionIndex, suggestions.length - 1))];
          const token = input.trimStart().split(/\s+/, 1)[0];
          if (selected && shouldCompleteSlashCommand(input, selected)) {
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
      if (action === 'history-prev') {
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
      if (action === 'history-next') {
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
        progress ? React.createElement(Panel, { title: 'Progress', borderColor: 'blue' },
          React.createElement(Text, null, preserveText(progress, 2000))
        ) : null,
        answer ? React.createElement(Panel, { title: 'Assistant streaming', borderColor: 'cyan' },
          React.createElement(Text, null, preserveText(answer, 6000))
        ) : null
      ),
      React.createElement(EventStrip, { events: eventLines }),
      interruptPrompt ? React.createElement(InterruptPrompt) : null,
      confirmPrompt ? React.createElement(ConfirmPrompt, { prompt: confirmPrompt }) : null,
      React.createElement(Box, { marginTop: 1, width: stdout?.columns || undefined }, React.createElement(InputLine, { input, cursor, busy: busy || Boolean(confirmPrompt), selectedIndex: suggestionIndex, width: stdout?.columns || undefined }))
    );
  }

  const instance = render(React.createElement(App));
  await instance.waitUntilExit();
  // If the user chose detach while a prompt was running, do not send a local
  // shutdown cancellation. The browser tab can finish and /recover can attach
  // the result later.
  if (!detachOnExit) await options.bridge.close();
}
