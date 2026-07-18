import { INTERACTIVE_THEME_PROFILES } from './terlioThemes.js';
import { keyboardHelpText } from './terlioHelp.js';

export const EXIT_COMMANDS = new Set(['/exit', '/quit', 'exit', 'quit']);

export const COMMANDS = [
  { cmd: '/help', category: 'System', usage: '/help', detail: '', description: 'Show command overview' },
  { cmd: '/chat', category: 'Messages', usage: '/chat <text>', detail: '<text>', description: 'Send a direct prompt without project ZIP context' },
  { cmd: '/status', category: 'Connection', usage: '/status', detail: '', description: 'Show bridge, tab, session, file and project state' },
  { cmd: '/connect', category: 'Connection', usage: '/connect', detail: '', description: 'Show setup URL and connection hint' },
  { cmd: '/tabs', category: 'Connection', usage: '/tabs', detail: '', description: 'List connected ChatGPT tabs' },
  { cmd: '/tab', category: 'Connection', usage: '/tab [n|auto|drop n]', detail: '<id|auto|drop>', description: 'Show, select, or drop a tab' },
  { cmd: '/sessions', category: 'Session', usage: '/sessions', detail: '', description: 'List visible ChatGPT sessions' },
  { cmd: '/session', category: 'Session', usage: '/session [id|new]', detail: '<id|new>', description: 'Show, select, or create a session' },
  { cmd: '/model', category: 'Model', usage: '/model [name|default|list]', detail: '<name|default>', description: 'Show or set model' },
  { cmd: '/effort', category: 'Model', usage: '/effort [value|default|list]', detail: '<value|default>', description: 'Show or set reasoning effort' },
  { cmd: '/events', category: 'Model', usage: '/events [quiet|normal|verbose]', detail: '<level>', description: 'Set event verbosity' },
  { cmd: '/theme', category: 'Appearance', usage: '/theme [name]', detail: '<name>', description: 'Apply a Terlio theme preset' },
  { cmd: '/themes', category: 'Appearance', usage: '/themes', detail: '', description: 'List available Terlio theme presets' },
  { cmd: '/state', category: 'System', usage: '/state', detail: '', description: 'Show persisted interactive scope state' },
  { cmd: '/info', category: 'System', usage: '/info', detail: '', description: 'Toggle the connection and workflow details panel' },
  { cmd: '/reset', category: 'System', usage: '/reset', detail: '', description: 'Reset local interactive scope state' },
  { cmd: '/workflow', category: 'Workflow', usage: '/workflow [wizard|open|new|active|action|settings]', detail: '<action>', bareDetail: '(open wizard)', description: 'Open or target the workflow wizard' },
  { cmd: '/file', category: 'Files', usage: '/file [path|clear|remove n]', detail: '<path|action>', description: 'Manage queued attachments' },
  { cmd: '/files', category: 'Files', usage: '/files [remove id]', detail: '<action>', description: 'List or remove local files known to bridge' },
  { cmd: '/artifacts', category: 'Artifacts', usage: '/artifacts', detail: '', description: 'List artifacts from recent answers' },
  { cmd: '/download', category: 'Artifacts', usage: '/download <n|id> [path]', detail: '<artifact>', description: 'Download an artifact' },
  { cmd: '/open', category: 'Artifacts', usage: '/open <n|id>', detail: '<artifact>', description: 'Open an artifact with the OS' },
  { cmd: '/debug', category: 'System', usage: '/debug [n]', detail: '<count>', description: 'Show recent diagnostic events' },
  { cmd: '/project', category: 'Project', usage: '/project [path|action]', detail: '<path|action>', description: 'Show or open a project root' },
  { cmd: '/scan', category: 'Project', usage: '/scan', detail: '', description: 'Scan the current project' },
  { cmd: '/pack', category: 'Project', usage: '/pack', detail: '', description: 'Create or reuse a project snapshot ZIP' },
  { cmd: '/task', category: 'Project', usage: '/task <text>', detail: '<text>', description: 'Run a project task with ZIP context' },
  { cmd: '/resume', category: 'Project', usage: '/resume', detail: '', description: 'Attach to a prompt already running in the active tab' },
  { cmd: '/result', category: 'Project', usage: '/result', detail: '', description: 'Show last project result' },
  { cmd: '/recover', category: 'Project', usage: '/recover [list|n] [--apply|--force]', detail: '<answer|flag>', description: 'Recover one of the latest visible ChatGPT answers' },
  { cmd: '/responses', category: 'Project', usage: '/responses [list|n]', detail: '<answer>', description: 'List saved answers or show full answer text' },
  { cmd: '/apply', category: 'Project', usage: '/apply [zipPath] [--plan|--force|--interactive]', detail: '<zip|flag>', description: 'Apply last result or a local ZIP file' },
  { cmd: '/stop', category: 'System', usage: '/stop', detail: '', description: 'Cancel the active request' },
  { cmd: '/clear', category: 'System', usage: '/clear', detail: '', description: 'Clear the terminal transcript' },
  { cmd: '/quit', category: 'System', usage: '/quit', detail: '', description: 'Exit interactive mode' },
];

const COMMAND_NAMES = COMMANDS.map((item) => item.cmd);

const BARE_COMMAND_HELP = new Map([
  ['/tab', 'Show the currently selected browser tab'],
  ['/session', 'Show the currently selected ChatGPT session'],
  ['/model', 'Show the current model setting'],
  ['/effort', 'Show the current reasoning effort'],
  ['/events', 'Show the current event verbosity'],
  ['/theme', 'Show the current terminal theme'],
  ['/workflow', 'Open the context-sensitive workflow wizard'],
  ['/file', 'List queued attachments'],
  ['/files', 'List local files known to the bridge'],
  ['/debug', 'Show the default recent diagnostic snapshot'],
  ['/project', 'Show the current project status'],
  ['/recover', 'List recent recoverable ChatGPT answers'],
  ['/responses', 'List saved assistant responses'],
  ['/apply', 'Apply the currently selected ZIP result'],
]);


const COMMAND_PRIORITY = new Map([
  ['/session', 0],
  ['/workflow', 1],
  ['/theme', 2],
  ['/chat', 3],
  ['/help', 4],
]);

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
    'Type / to see commands. Complete a command to see its parameters.',
    '',
    'Keyboard:',
    keyboardHelpText(),
    '',
  ];
  for (const [category, items] of groups.entries()) {
    lines.push(`${category}:`);
    for (const item of items) lines.push(`  ${item.usage.padEnd(38)} ${item.description}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

export function commandSuggestions(input, context = {}) {
  const value = String(input || '').trimStart();
  if (!value.startsWith('/')) return [];
  const parsed = parseCommandInput(value);
  if (!parsed) return [];
  const command = parsed.command.toLowerCase();

  if (!parsed.hasArgumentSeparator) {
    const matches = COMMANDS
      .filter((item) => item.cmd.startsWith(command))
      .sort((a, b) => {
        const aExact = a.cmd === command ? 0 : 1;
        const bExact = b.cmd === command ? 0 : 1;
        const aPriority = COMMAND_PRIORITY.get(a.cmd) ?? 100;
        const bPriority = COMMAND_PRIORITY.get(b.cmd) ?? 100;
        return aExact - bExact || aPriority - bPriority || a.cmd.localeCompare(b.cmd);
      });
    const result = [];
    for (const item of matches) {
      const bareDescription = item.cmd === command ? BARE_COMMAND_HELP.get(item.cmd) : '';
      if (bareDescription) {
        result.push({
          ...item,
          kind: 'command-bare',
          label: item.cmd,
          detail: item.bareDetail || '(no arguments)',
          description: bareDescription,
          insert: item.cmd,
          executeBare: true,
          appendSpace: false,
        });
        // `/workflow` is a complete, useful command on its own. Do not put an
        // argument-expansion row ahead of that action; parameter suggestions
        // appear only after the user actually types a space. Other legacy
        // commands keep their explicit "show arguments" row.
        if (item.cmd !== '/workflow' && item.detail) {
          result.push({
            ...item,
            kind: 'command-options',
            label: `${item.cmd} …`,
            insert: `${item.cmd} `,
            appendSpace: false,
          });
        }
        continue;
      }
      result.push({
        ...item,
        kind: 'command',
        label: item.cmd,
        insert: `${item.cmd}${item.detail ? ' ' : ''}`,
        appendSpace: Boolean(item.detail),
      });
    }
    return result;
  }

  if (!COMMAND_NAMES.includes(command)) return [];
  return argumentSuggestions(command, parsed.argumentsText, context);
}

export function shouldCompleteSlashCommand(input, selected) {
  if (!selected?.insert) return false;
  return String(input || '') !== selected.insert;
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

function argumentSuggestions(command, argumentsText, context) {
  const normalized = String(argumentsText || '').replace(/^\s+/, '');
  const trailingSpace = /\s$/.test(normalized);
  const tokens = normalized ? normalized.trim().split(/\s+/) : [];
  const current = trailingSpace ? '' : tokens.at(-1) || '';
  const completed = trailingSpace ? tokens : tokens.slice(0, -1);
  const singleValueCommands = new Set(['/session', '/theme', '/model', '/effort', '/events', '/download', '/open', '/responses']);
  if (singleValueCommands.has(command) && completed.length) return [];

  if (command === '/session') return filterChoices(sessionChoices(context), current, command, completed);
  if (command === '/theme') return filterChoices(themeChoices(context), current, command, completed);
  if (command === '/tab') return tabSuggestions({ current, completed, context, command });
  if (command === '/model') return filterChoices(modelChoices(context), current, command, completed);
  if (command === '/effort') return filterChoices([
    choice('auto', 'Use ChatGPT default effort'),
    choice('instant', 'Fast response with minimal reasoning'),
    choice('low', 'Low reasoning effort'),
    choice('medium', 'Medium reasoning effort'),
    choice('high', 'High reasoning effort'),
    choice('xhigh', 'Maximum reasoning effort'),
    choice('default', 'Reset to ChatGPT default'),
    choice('list', 'Read visible effort options from ChatGPT'),
  ], current, command, completed);
  if (command === '/events') return filterChoices([
    choice('quiet', 'Only important milestones and errors'),
    choice('normal', 'Normal interactive activity'),
    choice('verbose', 'Include raw diagnostic events'),
  ], current, command, completed);
  if (command === '/workflow') return workflowSuggestions({ current, completed, context, command });
  if (command === '/file') {
    if (completed.length) return [];
    return filterChoices([
      choice('list', 'List queued attachments'),
      choice('add', 'Queue a file path', { continue: true }),
      choice('remove', 'Remove a queued attachment', { continue: true }),
      choice('clear-ui', 'Clear attachments visible in ChatGPT composer'),
      choice('clear', 'Clear all queued attachments'),
    ], current, command, completed);
  }
  if (command === '/files') {
    if (completed.length) return [];
    return filterChoices([
      choice('remove', 'Remove a local file by ID', { continue: true }),
    ], current, command, completed);
  }
  if (command === '/project') {
    if (completed[0] === 'session' && completed.length === 1) {
      return filterChoices([
        choice('new', 'Create a new local project thread'),
        choice('use', 'Select a local project thread', { continue: true }),
      ], current, command, completed);
    }
    if (completed.length) return [];
    return filterChoices([
      choice('open', 'Open or switch project root', { continue: true }),
      choice('scan', 'Build project tree and symbol context'),
      choice('pack', 'Create or reuse a project snapshot ZIP'),
      choice('sync', 'Force-create the current snapshot ZIP'),
      choice('sessions', 'List local project threads'),
      choice('session', 'Manage the project thread', { continue: true }),
    ], current, command, completed);
  }
  if (command === '/recover') return filterChoices([
    choice('list', 'List recent recoverable answers'),
    choice('--apply', 'Apply the recovered ZIP after selection'),
    choice('--force', 'Skip interactive apply confirmation'),
  ], current, command, completed);
  if (command === '/responses') return filterChoices([
    choice('list', 'List saved responses'),
    ...responseChoices(context),
  ], current, command, completed);
  if (command === '/apply') return filterChoices([
    choice('--plan', 'Show apply plan without writing files'),
    choice('--interactive', 'Confirm each unsafe apply decision'),
    choice('--force', 'Apply despite confirmation requirements'),
  ], current, command, completed);
  if (command === '/download' || command === '/open') return filterChoices(artifactChoices(context), current, command, completed);
  return [];
}

function workflowSuggestions({ current, completed, command }) {
  if (completed.length) return [];
  return filterChoices([
    choice('wizard', 'Open the context-sensitive workflow wizard'),
    choice('open', 'Open the context-sensitive workflow wizard'),
    choice('new', 'Start setup for a new workflow'),
    choice('active', 'Open the active workflow'),
    choice('action', 'Open the pending workflow action'),
    choice('settings', 'Open global workflow defaults'),
  ], current, command, completed);
}

function tabSuggestions({ current, completed, context, command }) {
  if (completed[0] === 'drop') {
    if (completed.length > 1) return [];
    return filterChoices(clientChoices(context), current, command, completed);
  }
  if (completed.length) return [];
  return filterChoices([
    choice('current', 'Show the selected browser tab'),
    choice('auto', 'Return to automatic tab selection'),
    choice('drop', 'Disconnect one browser tab', { continue: true }),
    ...clientChoices(context),
  ], current, command, completed);
}

function sessionChoices(context) {
  return [
    choice('new', 'Create and select a new ChatGPT session'),
    ...indexedChoices(context.state?.lastSessions, 'session', (item) => item?.title || item?.id || 'ChatGPT session'),
    choice('current', 'Show the currently selected session'),
    choice('refresh', 'Reload sessions from the ChatGPT sidebar'),
  ];
}

function workflowSessionChoices(context) {
  return [
    choice('current', 'Bind the run to the current interactive session'),
    choice('new', 'Create a new session for this run'),
    choice('pinned', 'Use the workflow pinned session'),
    ...indexedChoices(context.state?.lastSessions, 'session', (item) => item?.title || item?.id || 'ChatGPT session', 'Bind run'),
  ];
}

function themeChoices(context = {}) {
  const current = String(context.state?.themeName || '');
  return [...INTERACTIVE_THEME_PROFILES]
    .sort((a, b) => Number(b.id === current) - Number(a.id === current))
    .map((profile) => choice(profile.id, profile.description, { previewTheme: profile.id }));
}

function modelChoices(context) {
  return [
    choice('default', 'Reset to ChatGPT default model'),
    choice('list', 'Read visible model options from ChatGPT'),
    ...listValues(context.state?.lastModels, (item, index) => {
      const value = String(item?.value || item?.label || item?.name || item?.id || index + 1);
      return {
        value,
        label: value,
        description: item?.label && item.label !== value ? `Select model · ${item.label}` : 'Select this model',
      };
    }),
  ];
}

function clientChoices(context) {
  const clients = context.health?.clients || context.health?.connectedClients || [];
  return indexedChoices(clients, 'tab', (item) => item?.title || item?.url || item?.id || 'ChatGPT tab');
}

function responseChoices(context) {
  return listValues(context.state?.responseHistory, (item, index) => ({
    value: String(index + 1),
    label: String(index + 1),
    description: item?.title ? `Show response · ${item.title}` : 'Show this saved response',
  }));
}

function artifactChoices(context) {
  return listValues(context.state?.lastArtifacts, (item, index) => ({
    value: String(item?.id || item?.artifactId || index + 1),
    label: String(item?.id || item?.artifactId || index + 1),
    description: item?.name ? `Artifact · ${item.name}` : 'Use this artifact',
  }));
}

function filterChoices(items, current, command, completed) {
  const query = String(current || '').toLowerCase();
  const prefix = [command, ...completed].filter(Boolean).join(' ');
  const matches = [];
  for (const item of items) {
    const defaultMatch = !query || item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query);
    const alias = query ? (item.aliases || []).find((value) => String(value).toLowerCase().startsWith(query)) : '';
    if (!defaultMatch && !alias) continue;
    const selectedValue = alias && !defaultMatch ? String(alias) : item.value;
    matches.push({
      cmd: command,
      kind: 'argument',
      label: alias && !defaultMatch ? String(alias) : item.label,
      detail: alias && !defaultMatch ? item.aliasDetail || 'full id' : item.detail || '',
      description: item.description,
      insert: `${prefix}${prefix ? ' ' : ''}${selectedValue}${item.continue ? ' ' : ''}`,
      appendSpace: Boolean(item.continue),
      value: selectedValue,
      previewTheme: item.previewTheme || '',
    });
  }
  return matches;
}

function choice(value, description, options = {}) {
  return {
    value: String(value),
    label: String(options.label || value),
    detail: String(options.detail || ''),
    description: String(description || ''),
    continue: Boolean(options.continue),
    aliases: Array.isArray(options.aliases) ? options.aliases.map(String) : [],
    aliasDetail: String(options.aliasDetail || ''),
    previewTheme: String(options.previewTheme || ''),
  };
}

function indexedChoices(values, kind, titleFor, action = 'Select') {
  return listValues(values, (item, index) => {
    const id = String(item?.id || '');
    const title = String(titleFor(item, index) || id || `${kind} ${index + 1}`);
    return choice(String(index + 1), `${action} ${kind} · ${title}${id ? ` · id ${id}` : ''}`, {
      label: `[${index + 1}] ${title}`,
      aliases: id ? [id] : [],
      aliasDetail: `${kind} id`,
    });
  });
}

function listValues(values, mapper) {
  return Array.isArray(values) ? values.map(mapper).filter((item) => item?.value) : [];
}

function parseCommandInput(value) {
  const match = String(value || '').match(/^(\/\S*)([\s\S]*)$/);
  if (!match) return null;
  return {
    command: match[1],
    hasArgumentSeparator: /^\s/.test(match[2] || ''),
    argumentsText: match[2] || '',
  };
}
