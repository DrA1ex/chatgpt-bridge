import { INTERACTIVE_THEME_PROFILES } from './terlioThemes.js';
import { keyboardHelpText } from './terlioHelp.js';

export const EXIT_COMMANDS = new Set(['/exit', '/quit', 'exit', 'quit']);

export const COMMANDS = [
  { cmd: '/help', category: 'System', usage: '/help', detail: '', description: 'Show command overview' },
  { cmd: '/chat', category: 'Messages', usage: '/chat <text>', detail: '<text>', description: 'Send a direct prompt without project ZIP context' },
  { cmd: '/status', category: 'Connection', usage: '/status', detail: '', description: 'Show bridge, tab, session, file and project state' },
  { cmd: '/connect', category: 'Connection', usage: '/connect', detail: '', description: 'Show setup URL and connection hint' },
  { cmd: '/tab', category: 'Connection', usage: '/tab [list|id|auto|drop id]', detail: '<action>', description: 'List, show, select, or drop a browser tab' },
  { cmd: '/session', category: 'Session', usage: '/session [list|id|new]', detail: '<action>', description: 'List, show, select, or create a ChatGPT session' },
  { cmd: '/model', category: 'Model', usage: '/model [name|default|list]', detail: '<name>', description: 'Show or set model' },
  { cmd: '/effort', category: 'Model', usage: '/effort [value|default|list]', detail: '<value>', description: 'Show or set reasoning effort' },
  { cmd: '/events', category: 'Model', usage: '/events [quiet|normal|verbose]', detail: '<level>', description: 'Show or set event verbosity' },
  { cmd: '/theme', category: 'Appearance', usage: '/theme [list|name]', detail: '<name>', description: 'Show, list, or apply a Terlio theme' },
  { cmd: '/workflow', category: 'Workflow', usage: '/workflow [history|plan|diff|report|checks|fix|preset]', detail: '<action>', bareDetail: '(open workflow)', description: 'Open or inspect the current workflow' },
  { cmd: '/project', category: 'Project', usage: '/project [open|scan|pack|sync|session|skills|agent]', detail: '<action>', description: 'Inspect or manage the current project' },
  { cmd: '/task', category: 'Project', usage: '/task <text>', detail: '<text>', description: 'Run a project task that requires a ZIP result' },
  { cmd: '/resume', category: 'Project', usage: '/resume', detail: '', description: 'Attach to a prompt already running in the active tab' },
  { cmd: '/recover', category: 'Project', usage: '/recover [list|n] [--apply|--force]', detail: '<answer|flag>', description: 'Recover a recent visible ChatGPT answer' },
  { cmd: '/apply', category: 'Project', usage: '/apply [zipPath] [--plan|--interactive]', detail: '<zip|flag>', description: 'Review and apply the selected result or local ZIP' },
  { cmd: '/file', category: 'Files', usage: '/file [list|add|remove|clear|stored|delete]', detail: '<action>', description: 'Manage queued and locally stored files' },
  { cmd: '/artifact', category: 'Artifacts', usage: '/artifact [list|download|open]', detail: '<action>', description: 'List, download, or open answer artifacts' },
  { cmd: '/debug', category: 'System', usage: '/debug [n]', detail: '<count>', description: 'Show recent diagnostic events' },
  { cmd: '/stop', category: 'System', usage: '/stop', detail: '', description: 'Cancel the active request' },
  { cmd: '/reset', category: 'System', usage: '/reset', detail: '', description: 'Reset local interactive scope state' },
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
  ['/workflow', 'Open the current server-backed workflow'],
  ['/file', 'List queued attachments'],
  ['/artifact', 'List artifacts from recent answers'],
  ['/debug', 'Show the default recent diagnostic snapshot'],
  ['/project', 'Show the current project status'],
  ['/recover', 'List recent recoverable ChatGPT answers'],
  ['/apply', 'Apply the currently selected ZIP result'],
]);

const COMMAND_PRIORITY = new Map([
  ['/session', 0],
  ['/workflow', 1],
  ['/project', 2],
  ['/chat', 3],
  ['/help', 4],
]);

const LEGACY_ALIASES = new Map([
  ['/tabs', '/tab list'],
  ['/sessions', '/session list'],
  ['/themes', '/theme list'],
  ['/scan', '/project scan'],
  ['/pack', '/project pack'],
  ['/artifacts', '/artifact list'],
  ['/agent', '/project agent'],
]);

export function normalizeCommand(line) {
  const raw = String(line || '').trim();
  if (!raw.startsWith('/')) return raw;
  const [cmd, ...restParts] = raw.split(/\s+/);
  const rest = restParts.join(' ');

  if (LEGACY_ALIASES.has(cmd) && !rest) return LEGACY_ALIASES.get(cmd);
  if (cmd === '/download') return `/artifact download${rest ? ` ${rest}` : ''}`;
  if (cmd === '/open') return `/artifact open${rest ? ` ${rest}` : ''}`;
  if (cmd === '/files') {
    if (!rest || rest === 'list') return '/file stored';
    if (rest.startsWith('remove ')) return `/file delete ${rest.slice('remove '.length)}`;
  }
  if (cmd === '/skills') return `/project skills${rest ? ` ${rest}` : ''}`;

  if (cmd === '/tab') {
    if (!rest) return '/tab current';
    if (rest === 'clear') return '/tab auto';
    return raw;
  }
  if (cmd === '/session') {
    if (!rest) return '/session current';
    if (rest === 'refresh') return '/session list';
    if (['new', 'current', 'list'].includes(rest)) return raw;
    if (rest.startsWith('select ')) return raw;
    return `/session select ${rest}`;
  }
  if (cmd === '/theme') {
    if (!rest) return raw;
    return raw;
  }
  if (cmd === '/project') {
    if (!rest) return raw;
    if (rest === 'sessions') return '/project session list';
    if (/^(open|scan|pack|sync|session|skills|agent)\b/.test(rest)) return raw;
    return `/project open ${rest}`;
  }
  if (cmd === '/file') {
    if (!rest) return '/file list';
    if (/^(clear|clear-ui|list|stored)\b/.test(rest)) return raw;
    if (/^(remove|delete|add)\s+/.test(rest)) return raw;
    return `/file add ${rest}`;
  }
  if (cmd === '/artifact') {
    if (!rest) return '/artifact list';
    return raw;
  }
  return raw;
}

export function parseInteractiveRequestCommand(line) {
  const normalized = normalizeCommand(line);
  const match = normalized.match(/^\/(chat|task)(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  return { kind: match[1].toLowerCase(), prompt: String(match[2] || '').trim(), normalized };
}

export function buildHelpText() {
  const groups = new Map();
  for (const item of COMMANDS) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  const lines = [
    'Plain text uses the opened project as context and attaches a fresh project ZIP. Use /chat for a prompt without project ZIP context; /task requires an updated ZIP result.',
    'Type / to see commands. Complete a command to see its parameters. Ctrl+B opens full runtime details.',
    '',
    'Keyboard:',
    keyboardHelpText(),
    '',
  ];
  for (const [category, items] of groups.entries()) {
    lines.push(`${category}:`);
    for (const item of items) lines.push(`  ${item.usage.padEnd(42)} ${item.description}`);
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

  if (command === '/session') return sessionSuggestions({ current, completed, context, command });
  if (command === '/theme') return themeSuggestions({ current, completed, context, command });
  if (command === '/tab') return tabSuggestions({ current, completed, context, command });
  if (command === '/model') {
    if (completed.length) return [];
    return filterChoices(modelChoices(context), current, command, completed);
  }
  if (command === '/effort') {
    if (completed.length) return [];
    return filterChoices([
      choice('auto', 'Use automatic/default reasoning effort'),
      choice('instant', 'Fast response with minimal reasoning'),
      choice('low', 'Low reasoning effort'),
      choice('medium', 'Medium reasoning effort'),
      choice('high', 'High reasoning effort'),
      choice('xhigh', 'Maximum reasoning effort'),
      choice('default', 'Reset to ChatGPT default'),
      choice('list', 'Read visible effort options from ChatGPT'),
    ], current, command, completed);
  }
  if (command === '/events') {
    if (completed.length) return [];
    return filterChoices([
      choice('quiet', 'Only important milestones and errors'),
      choice('normal', 'Normal interactive activity'),
      choice('verbose', 'Include raw diagnostic events'),
    ], current, command, completed);
  }
  if (command === '/workflow') return workflowSuggestions({ current, completed, context, command });
  if (command === '/file') return fileSuggestions({ current, completed, command });
  if (command === '/artifact') return artifactSuggestions({ current, completed, context, command });
  if (command === '/project') return projectSuggestions({ current, completed, command });
  if (command === '/recover') return filterChoices([
    choice('list', 'List recent recoverable answers'),
    choice('--apply', 'Apply the recovered ZIP after selection'),
    choice('--force', 'Skip interactive apply confirmation'),
  ], current, command, completed);
  if (command === '/apply') return filterChoices([
    choice('--plan', 'Open the apply review without dispatching an action'),
    choice('--interactive', 'Open the interactive apply review'),
    ...(!context.zipflowWorkflowRuntime
      ? [choice('--force', 'Apply despite confirmation requirements')]
      : []),
  ], current, command, completed);
  return [];
}

function workflowSuggestions({ current, completed, command, context }) {
  if (context.zipflowWorkflowRuntime) {
    if (completed[0] === 'preset' && completed.length === 1) {
      return filterChoices([
        choice('apply-changes', 'Apply ChatGPT project ZIP results through Zipflow'),
        choice('fix-until-pass', 'Iterate on project checks until they pass'),
        choice('guided-task', 'Configure a server-backed guided task workflow'),
      ], current, command, completed);
    }
    if (completed.length) return [];
    return filterChoices([
      choice('history', 'Show recent workflow history'),
      choice('plan', 'Show the current workflow plan'),
      choice('diff', 'Show a workflow diff for one path', { continue: true }),
      choice('report', 'Print the current workflow report'),
      choice('checks', 'Run configured project checks'),
      choice('fix', 'Repair the project until checks pass'),
      choice('preset', 'Configure a workflow preset', { continue: true }),
    ], current, command, completed);
  }
  if (completed.length) return [];
  return filterChoices([
    choice('open', 'Open the legacy workflow UI'),
    choice('new', 'Start setup for a new legacy workflow'),
    choice('action', 'Open the pending legacy workflow action'),
    choice('settings', 'Open legacy workflow defaults'),
  ], current, command, completed);
}

function tabSuggestions({ current, completed, context, command }) {
  if (completed[0] === 'drop') {
    if (completed.length > 1) return [];
    return filterChoices(clientChoices(context), current, command, completed);
  }
  if (completed.length) return [];
  return filterChoices([
    choice('list', 'List connected browser tabs'),
    choice('current', 'Show the selected browser tab'),
    choice('auto', 'Return to automatic tab selection'),
    choice('drop', 'Disconnect one browser tab', { continue: true }),
    ...clientChoices(context),
  ], current, command, completed);
}

function sessionSuggestions({ current, completed, context, command }) {
  if (completed.length) return [];
  return filterChoices([
    choice('list', 'Refresh and list visible ChatGPT sessions'),
    choice('new', 'Create and select a new ChatGPT session'),
    choice('current', 'Show the currently selected session'),
    ...indexedChoices(context.state?.lastSessions, 'session', (item) => item?.title || item?.id || 'ChatGPT session'),
  ], current, command, completed);
}

function themeSuggestions({ current, completed, context, command }) {
  if (completed.length) return [];
  return filterChoices([
    ...themeChoices(context),
    choice('list', 'List available terminal themes'),
  ], current, command, completed);
}

function fileSuggestions({ current, completed, command }) {
  if (completed.length) return [];
  return filterChoices([
    choice('list', 'List queued attachments'),
    choice('add', 'Queue one or more local paths', { continue: true }),
    choice('remove', 'Remove a queued attachment', { continue: true }),
    choice('clear-ui', 'Clear attachments visible in ChatGPT composer'),
    choice('clear', 'Clear all queued attachments'),
    choice('stored', 'List files stored by Bridge'),
    choice('delete', 'Delete a stored file by ID', { continue: true }),
  ], current, command, completed);
}

function artifactSuggestions({ current, completed, context, command }) {
  if (!completed.length) {
    return filterChoices([
      choice('list', 'List artifacts from recent answers'),
      choice('download', 'Download an artifact', { continue: true }),
      choice('open', 'Open an artifact with the OS', { continue: true }),
    ], current, command, completed);
  }
  if (['download', 'open'].includes(completed[0]) && completed.length === 1) {
    return filterChoices(artifactChoices(context), current, command, completed);
  }
  return [];
}

function projectSuggestions({ current, completed, command }) {
  if (completed[0] === 'session' && completed.length === 1) {
    return filterChoices([
      choice('list', 'List local project threads'),
      choice('new', 'Create a new local project thread'),
      choice('use', 'Select a local project thread', { continue: true }),
    ], current, command, completed);
  }
  if (completed[0] === 'skills' && completed.length === 1) {
    return filterChoices([
      choice('list', 'List available and enabled skills'),
      choice('enable', 'Enable project skills', { continue: true }),
      choice('disable', 'Disable project skills', { continue: true }),
    ], current, command, completed);
  }
  if (completed.length) return [];
  return filterChoices([
    choice('open', 'Open or switch project root', { continue: true }),
    choice('scan', 'Build project tree and symbol context'),
    choice('pack', 'Create or reuse a project snapshot ZIP'),
    choice('sync', 'Force-create the current snapshot ZIP'),
    choice('session', 'Manage local project threads', { continue: true }),
    choice('skills', 'Manage project skills', { continue: true }),
    choice('agent', 'Show AGENT.md discovery status'),
  ], current, command, completed);
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
