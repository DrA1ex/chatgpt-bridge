export const EXIT_COMMANDS = new Set(['/exit', '/quit', 'exit', 'quit']);

export const COMMANDS = [
  { cmd: '/help', category: 'System', usage: '/help', description: 'Show command overview' },
  { cmd: '/chat', category: 'Messages', usage: '/chat <text>', description: 'Send a direct prompt without project ZIP context' },
  { cmd: '/status', category: 'Connection', usage: '/status', description: 'Show bridge, tab, session, file and project state' },
  { cmd: '/connect', category: 'Connection', usage: '/connect', description: 'Show setup URL and connection hint' },
  { cmd: '/tabs', category: 'Connection', usage: '/tabs', description: 'List connected ChatGPT tabs' },
  { cmd: '/tab', category: 'Connection', usage: '/tab [n|auto|drop n]', description: 'Show, select, or drop a tab' },
  { cmd: '/sessions', category: 'Session', usage: '/sessions', description: 'List visible ChatGPT sessions' },
  { cmd: '/session', category: 'Session', usage: '/session [n|new]', description: 'Show, select, or create a session' },
  { cmd: '/model', category: 'Model', usage: '/model [n|name|default|list]', description: 'Show or set model' },
  { cmd: '/effort', category: 'Model', usage: '/effort [value|default|list]', description: 'Show or set reasoning effort' },
  { cmd: '/events', category: 'Model', usage: '/events [quiet|normal|verbose]', description: 'Set event verbosity' },
  { cmd: '/state', category: 'System', usage: '/state', description: 'Show persisted interactive scope state' },
  { cmd: '/reset', category: 'System', usage: '/reset', description: 'Reset local interactive scope state' },
  { cmd: '/workflow', category: 'Workflow', usage: '/workflow [run|stop|resume|approve|history]', description: 'Show or control the current workflow run' },
  { cmd: '/file', category: 'Files', usage: '/file [path|clear|clear-ui|remove n]', description: 'Manage queued attachments' },
  { cmd: '/files', category: 'Files', usage: '/files [remove id]', description: 'List or remove local files known to bridge' },
  { cmd: '/artifacts', category: 'Artifacts', usage: '/artifacts', description: 'List artifacts from recent answers' },
  { cmd: '/download', category: 'Artifacts', usage: '/download <n|id> [path]', description: 'Download an artifact' },
  { cmd: '/open', category: 'Artifacts', usage: '/open <n|id>', description: 'Open an artifact with the OS' },
  { cmd: '/debug', category: 'System', usage: '/debug [n]', description: 'Show recent diagnostic events' },
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

export function normalizeCommand(line) {
  const raw = String(line || '').trim();
  if (!raw.startsWith('/')) return raw;
  const [cmd, ...restParts] = raw.split(/\s+/);
  const rest = restParts.join(' ');

  if (cmd === '/tab') {
    if (!rest) return '/tab current';
    if (rest === 'clear') return '/tab auto';
    return raw;
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
    if (!rest) return '/file list';
    if (rest === 'clear' || rest === 'clear-ui' || rest === 'list' || rest.startsWith('remove ') || rest.startsWith('add ')) return raw;
    return `/file add ${rest}`;
  }
  if (cmd === '/scan') return '/project scan';
  if (cmd === '/pack') return '/project pack';
  return raw;
}

export function buildHelpText() {
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
    for (const item of items) lines.push(`  ${item.usage.padEnd(34)} ${item.description}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

export function commandSuggestions(input) {
  const value = String(input || '').trimStart();
  if (!value.startsWith('/')) return [];
  const match = value.match(/^(\/\S+)([\s\S]*)$/);
  if (!match) return [];
  const token = match[1].toLowerCase();
  const rest = match[2] || '';
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
