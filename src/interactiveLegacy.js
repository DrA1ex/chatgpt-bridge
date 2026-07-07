import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { clearLine, cursorTo } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { config } from './config.js';
import { createSpinner } from './spinner.js';
import { applyZipToProject, planZipApply } from './projectApply.js';

const EXIT_COMMANDS = new Set(['/exit', '/quit', 'exit', 'quit']);
const EFFORTS = new Set(['auto', 'instant', 'low', 'medium', 'high', 'xhigh']);
const EVENT_LEVELS = new Set(['quiet', 'normal', 'verbose']);
export const INTERACTIVE_STATE_FILE = path.join(config.dataDir, 'interactive-state.json');

function bytes(value) {
  const n = Number(value) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function truncate(text, limit = 120) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function shellSplit(raw) {
  const args = [];
  let current = '';
  let quote = '';
  let escape = false;

  for (const char of String(raw || '')) {
    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}


function makeDefaultState() {
  return {
    model: '',
    effort: '',
    sessionId: '',
    pendingAttachments: [],
    lastArtifacts: [],
    lastSessions: [],
    lastModels: [],
    lastEfforts: [],
    eventLevel: 'normal',
    projectRoot: '',
    projectId: '',
    projectThreadId: '',
    projectThreads: [],
    enabledSkills: [],
    lastProjectScan: null,
    lastProjectPack: null,
    lastTurnId: '',
    lastTurn: null,
    lastAppliedTurnId: '',
    lastAppliedResult: null,
  };
}

export async function loadInteractiveState(fileStore) {
  const state = makeDefaultState();
  try {
    const raw = await fs.readFile(INTERACTIVE_STATE_FILE, 'utf8');
    const saved = JSON.parse(raw);
    if (typeof saved.model === 'string') state.model = saved.model;
    if (typeof saved.effort === 'string' && (!saved.effort || EFFORTS.has(saved.effort))) state.effort = saved.effort;
    if (typeof saved.sessionId === 'string') state.sessionId = saved.sessionId;
    if (typeof saved.eventLevel === 'string' && EVENT_LEVELS.has(saved.eventLevel)) state.eventLevel = saved.eventLevel;
    if (typeof saved.projectRoot === 'string') state.projectRoot = saved.projectRoot;
    if (typeof saved.projectId === 'string') state.projectId = saved.projectId;
    if (typeof saved.projectThreadId === 'string') state.projectThreadId = saved.projectThreadId;
    if (Array.isArray(saved.enabledSkills)) state.enabledSkills = saved.enabledSkills.map(String).filter(Boolean);
    if (typeof saved.lastTurnId === 'string') state.lastTurnId = saved.lastTurnId;
    if (typeof saved.lastAppliedTurnId === 'string') state.lastAppliedTurnId = saved.lastAppliedTurnId;

    const attachmentIds = Array.isArray(saved.pendingAttachmentIds) ? saved.pendingAttachmentIds : [];
    for (const fileId of attachmentIds) {
      const file = await fileStore.get(fileId).catch(() => null);
      if (file) state.pendingAttachments.push(file);
    }
  } catch {
    // First run or invalid local state; start clean.
  }
  return state;
}

export async function saveInteractiveState(state) {
  await fs.mkdir(config.dataDir, { recursive: true });
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    model: state.model || '',
    effort: state.effort || '',
    sessionId: state.sessionId || '',
    eventLevel: state.eventLevel || 'normal',
    pendingAttachmentIds: state.pendingAttachments.map((file) => file.id).filter(Boolean),
    projectRoot: state.projectRoot || '',
    projectId: state.projectId || '',
    projectThreadId: state.projectThreadId || '',
    enabledSkills: state.enabledSkills || [],
    lastTurnId: state.lastTurnId || '',
    lastAppliedTurnId: state.lastAppliedTurnId || '',
  };
  await fs.writeFile(INTERACTIVE_STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

function printModels(state) {
  console.log(`Model: ${state.model || '(ChatGPT default)'}`);
  if (!state.lastModels.length) {
    console.log('No model list loaded. Use /model list to ask the ChatGPT tab for visible model options.');
    return;
  }
  console.log('Known model options:');
  for (const [index, model] of state.lastModels.entries()) {
    const label = model.label || model.name || model.id || String(model);
    const marker = model.selected ? '*' : ' ';
    console.log(` ${marker} [${index + 1}] ${label}`);
  }
}

function printEfforts(state) {
  console.log(`Effort: ${state.effort || '(ChatGPT default)'}`);
  if (!state.lastEfforts.length) {
    console.log('No effort list loaded. Use /effort list to ask the ChatGPT tab for visible effort options.');
    return;
  }
  console.log('Known effort options:');
  for (const [index, effort] of state.lastEfforts.entries()) {
    const label = effort.label || effort.name || effort.id || String(effort);
    const marker = effort.selected ? '*' : ' ';
    console.log(` ${marker} [${index + 1}] ${label}`);
  }
}

function resolveModelToken(token, list) {
  const value = String(token || '').trim();
  const numeric = Number.parseInt(value, 10);
  if (Number.isInteger(numeric) && String(numeric) === value && numeric >= 1 && numeric <= list.length) {
    const item = list[numeric - 1];
    return item.label || item.name || item.id || value;
  }
  return value;
}

function openPathWithSystem(targetPath) {
  const absolute = path.resolve(targetPath);
  let command;
  let args;
  if (process.platform === 'darwin') {
    command = 'open';
    args = [absolute];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', absolute];
  } else {
    command = 'xdg-open';
    args = [absolute];
  }

  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return absolute;
}

function appendIncremental(previous, next, stream = process.stdout) {
  if (!previous) {
    stream.write(next);
    return next;
  }
  if (next.startsWith(previous)) {
    stream.write(next.slice(previous.length));
    return next;
  }
  stream.write(`\n${next}`);
  return next;
}

function createConsoleStream(spinner, stream = process.stdout) {
  let activeSection = null;
  let printedThinking = '';
  let printedAnswer = '';
  let printedAnything = false;
  let spinnerCleared = false;

  function clearSpinnerOnce() {
    if (spinnerCleared) return;
    spinner.stop();
    spinnerCleared = true;
  }

  function switchSection(sectionName) {
    clearSpinnerOnce();
    if (activeSection === sectionName) return;
    if (printedAnything) stream.write('\n\n');
    stream.write(`${sectionName}:\n`);
    activeSection = sectionName;
    printedAnything = true;
  }

  return {
    status(line) {
      if (!line) return;
      clearSpinnerOnce();
      if (printedAnything && activeSection) stream.write('\n');
      stream.write(`${line}\n`);
      printedAnything = true;
    },

    onThinkingUpdate(text) {
      if (!text || text === printedThinking) return;
      switchSection('Thinking');
      printedThinking = appendIncremental(printedThinking, text, stream);
    },

    onAnswerUpdate(text) {
      if (!text || text === printedAnswer) return;
      switchSection('Answer');
      printedAnswer = appendIncremental(printedAnswer, text, stream);
    },

    onArtifactUpdate(artifacts) {
      clearSpinnerOnce();
      for (const [index, artifact] of artifacts.entries()) {
        stream.write(`\n[artifact] #${index + 1} ${artifact.kind || 'artifact'} ${artifact.name || artifact.id || ''}\n`);
      }
      printedAnything = true;
    },

    finish(answer) {
      const finalAnswer = String(answer || '').trim();
      clearSpinnerOnce();
      if (!finalAnswer) {
        if (printedAnything) stream.write('\n');
        return;
      }
      if (!printedAnything) {
        stream.write(`Answer:\n${finalAnswer}\n`);
        return;
      }
      if (printedAnswer.trim() !== finalAnswer) {
        stream.write(`\n\nFinal answer:\n${finalAnswer}\n`);
        return;
      }
      stream.write('\n');
    },

    fail() {
      clearSpinnerOnce();
      if (printedAnything) stream.write('\n');
    },
  };
}

export function renderEvent(event, level = 'normal') {
  if (level === 'quiet') return '';
  const type = String(event?.type || '');
  const data = event || {};

  if (type === 'request.started') {
    const bits = [];
    if (data.sessionId) bits.push(`session=${data.sessionId}`);
    if (data.model) bits.push(`model=${data.model}`);
    if (data.effort) bits.push(`effort=${data.effort}`);
    if (Array.isArray(data.attachments) && data.attachments.length) bits.push(`files=${data.attachments.length}`);
    return `[request] started${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
  }
  if (type === 'prompt.delivered') return `[chat] prompt delivered to ${data.clientId || 'selected tab'}`;
  if (type === 'prompt.accepted') return data.implicit ? `[chat] prompt accepted implicitly via ${data.via || 'client event'}` : '[chat] prompt accepted';
  if (type === 'prompt.sent' || type === 'chat.prompt.sent') return '[chat] prompt sent';
  if (type === 'generation.started' || type === 'chat.generation.started') return '[chat] generation started';
  if (type === 'generation.stopped' || type === 'chat.generation.stopped') return '[chat] generation stopped';
  if (type === 'files.attach.started') return `[file] attaching ${data.count ?? ''} file(s)`.trim();
  if (type === 'files.attach.done') return `[file] attached ${(data.names || []).join(', ') || `${data.count ?? ''} file(s)`}`;
  if (type === 'files.attach.failed' || type === 'files.attach.warning') return `[file] ${data.message || 'attachment warning'}`;
  if (type === 'model.apply.started') return `[model] applying ${[data.model, data.effort].filter(Boolean).join(' / ')}`;
  if (type === 'model.apply.done') {
    const warnings = Array.isArray(data.warnings) && data.warnings.length ? ` · ${data.warnings.join('; ')}` : '';
    return `[model] applied${warnings}`;
  }
  if (type === 'session.snapshot') return data.session?.id ? `[session] ${data.session.title || data.session.id}` : '';
  if (type === 'artifact.snapshot') return Array.isArray(data.artifacts) && data.artifacts.length ? `[artifact] discovered ${data.artifacts.length}` : '';
  if (type === 'request.done') return `[done] ${data.answerLength ?? 0} chars · ${Array.isArray(data.artifacts) ? data.artifacts.length : 0} artifact(s)`;
  if (type === 'request.error') return `[error] ${data.message || 'request failed'}`;

  if (level === 'verbose' && !/^(thinking|answer)\./.test(type)) {
    return `[event] ${type}${data.message ? ` · ${data.message}` : ''}`;
  }

  return '';
}

function printHelp() {
  console.log('Commands:');
  console.log('  /help                         Show this help');
  console.log('  /health                       Show bridge status');
  console.log('  /setup                        Show userscript setup URL and token hint');
  console.log('  /diagnostics                  Show live userscript diagnostics URL');
  console.log('  /clients                      List connected ChatGPT tabs/connections');
  console.log('  /client current               Show the selected/active tab');
  console.log('  /client drop <id|index>       Drop a stale/unused tab connection locally');
  console.log('  /select <id|index|clear|auto> Select the tab used for prompts');
  console.log('  /stop                         Cancel the active request');
  console.log('  /reset                        Clear local interactive state');
  console.log(`  /state                        Show saved interactive state path`);
  console.log('  /events [quiet|normal|verbose] Show/set event rendering level');
  console.log('');
  console.log('Sessions:');
  console.log('  /sessions                     List visible ChatGPT sessions');
  console.log('  /session new                  Open a new ChatGPT session');
  console.log('  /session current              Show selected session in CLI');
  console.log('  /session refresh              Refresh session list');
  console.log('  /session select <id|index>    Select session by id or list index');
  console.log('');
  console.log('Model / effort:');
  console.log('  /model                        Show current model setting');
  console.log('  /model list                   Read visible model options from ChatGPT UI');
  console.log('  /model <name|index>           Set model for next prompts');
  console.log('  /effort                       Show current effort setting');
  console.log('  /effort list                  Read visible effort options from ChatGPT UI');
  console.log('  /effort <auto|instant|low|medium|high|xhigh>');
  console.log('  /mode                         Show current session/model/files state');
  console.log('');
  console.log('Project mode:');
  console.log('  /project                      Show current project status');
  console.log('  /project open <path>          Open/switch project root');
  console.log('  /project scan                 Build tree/symbol context');
  console.log('  /project pack                 Create/reuse project snapshot zip');
  console.log('  /project sync                 Force-create current snapshot zip');
  console.log('  /project sessions             List local threads for this project');
  console.log('  /project session new          Create new thread for this project');
  console.log('  /project session use <id|n>   Use existing project thread');
  console.log('  /skills                       List available/enabled skills');
  console.log('  /skills enable <name...>      Enable skills for project tasks');
  console.log('  /skills disable <name...>     Disable skills');
  console.log('  /agent                        Show AGENT.md discovery status');
  console.log('  /task <prompt>                Run project task, expects ZIP result');
  console.log('  /ask <prompt>                 Ask without project ZIP, with agent context only');
  console.log('  /result                       Show last turn result');
  console.log('  /result recover [list|n] [--force|--apply] Recover recent ChatGPT answer into the last turn');
  console.log('  /recover [list|n] [--apply|--force] Shortcut for /result recover');
  console.log('  /result download [path]       Download last ZIP result');
  console.log('  /result apply [zipPath] [--plan|--interactive|--force] Sync last/user ZIP into project');
  console.log('');
  console.log('Files and artifacts:');
  console.log('  /attach <path> [path...]      Upload local file(s) and attach to next message');
  console.log('  /attachments                  List queued attachments');
  console.log('  /detach <index|fileId|all>    Remove queued attachment(s)');
  console.log('  /attachments clear-ui         Clear visible attachments in ChatGPT composer');
  console.log('  /files                        List local uploaded files');
  console.log('  /file add <path>              Upload file without attaching');
  console.log('  /file remove <fileId>         Remove local uploaded file/artifact from index');
  console.log('  /artifacts                    List known output artifacts');
  console.log('  /download <index|artifactId> [path] Download artifact to local path');
  console.log('  /open <index|artifactId>      Download artifact if needed and open it');
  console.log('  /debug [n]                    Show recent debug events snapshot');
  console.log('  /exit, /quit                  Stop interactive mode');
}

export function promptForBridge(bridge) {
  const health = bridge.health();
  if (health.ok) return 'bridge> ';
  if (health.needsSelection) return 'bridge:select-tab> ';
  return 'bridge:not-connected> ';
}

function rewritePendingPrompt(rl, stream, prompt) {
  if (!stream?.isTTY) return false;
  try {
    const currentLine = rl.line || '';
    clearLine(stream, 0);
    cursorTo(stream, 0);
    stream.write(`${prompt}${currentLine}`);
    return true;
  } catch {
    return false;
  }
}

export function printHealth(bridge, state) {
  const health = bridge.health();
  console.log(`Transport: ${health.transport}`);
  console.log(`Connected clients: ${health.clients.length}`);
  console.log(`Selected client: ${health.selectedClientId || '(auto if exactly one tab)'}`);
  console.log(`Pending requests: ${health.pendingRequests}`);
  console.log(`Session: ${state.sessionId || '(current tab)'}`);
  console.log(`Model: ${state.model || '(ChatGPT default)'}`);
  console.log(`Effort: ${state.effort || '(ChatGPT default)'}`);
  console.log(`Queued attachments: ${state.pendingAttachments.length}`);
  if (state.projectRoot) {
    console.log(`Project: ${state.projectRoot}`);
    console.log(`Project thread: ${state.projectThreadId || '(none)'}`);
  }
  if (health.activeClient) {
    console.log(`Active tab: ${health.activeClient.url || '(unknown url)'}`);
    console.log(`Client id: ${health.activeClient.id}`);
  } else if (health.needsSelection) {
    console.log('Multiple ChatGPT tabs connected. Use /clients and /select <clientId>.');
  } else {
    console.log('No active ChatGPT tab connected yet.');
  }
}

function printClients(bridge) {
  const health = bridge.health();
  if (!health.clients.length) {
    console.log('No connected ChatGPT tabs.');
    return;
  }
  for (const [index, client] of health.clients.entries()) {
    const marker = client.selected || health.activeClient?.id === client.id ? '*' : ' ';
    const presence = [client.visibilityState, client.focused ? 'focused' : ''].filter(Boolean).join(', ');
    const active = client.activeRequest?.requestId ? ` · active request: ${client.activeRequest.requestId}` : '';
    console.log(`${marker} [${index + 1}] ${client.id}${presence ? ` · ${presence}` : ''}${active}`);
    console.log(`    ${client.url || '(unknown url)'}`);
    if (client.title) console.log(`    ${client.title}`);
    console.log(`    transport: ${client.transport || 'unknown'} · queued: ${client.queuedCommands || 0} · last seen: ${client.lastSeenAt}`);
  }
  if (health.needsSelection) console.log('Multiple tabs are connected. Use /select <index> or /select <clientId>.');
}

function resolveClientSelector(bridge, selector) {
  const value = String(selector || '').trim();
  const health = bridge.health();
  if (!value) throw new Error('No client selector provided');

  if (['active', 'current', 'selected'].includes(value)) {
    const client = health.activeClient || health.clients.find((item) => item.selected);
    if (!client) throw new Error('No active client. Use /clients and /select <index|clientId>.');
    return client;
  }

  const index = Number.parseInt(value, 10);
  if (Number.isInteger(index) && String(index) === value && index >= 1 && index <= health.clients.length) {
    return health.clients[index - 1];
  }

  const exact = health.clients.find((client) => client.id === value);
  if (exact) return exact;

  const prefixMatches = health.clients.filter((client) => client.id.startsWith(value));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) throw new Error(`Client selector is ambiguous: ${value}. Use a longer id or an index from /clients.`);

  throw new Error(`Client not found: ${value}. Use /clients to see connected tabs.`);
}

function printCurrentClient(bridge) {
  const health = bridge.health();
  const client = health.activeClient || health.clients.find((item) => item.selected);
  if (!client) {
    if (health.needsSelection) console.log('No active tab because multiple tabs are connected. Use /clients then /select <index>.');
    else console.log('No active ChatGPT tab connected yet.');
    return;
  }
  console.log(`Current client: ${client.id}`);
  console.log(`URL: ${client.url || '(unknown)'}`);
  if (client.title) console.log(`Title: ${client.title}`);
  console.log(`Transport: ${client.transport || 'unknown'} · ${client.visibilityState || 'visibility unknown'}${client.focused ? ' · focused' : ''}`);
  if (client.activeRequest?.requestId) console.log(`Active request: ${client.activeRequest.requestId}`);
}

function printDebugEvents(bridge, limit = 20) {
  const events = bridge.debugEvents().slice(-limit);
  if (!events.length) {
    console.log('No debug events yet.');
    return;
  }
  for (const event of events) {
    const requestId = event.payload?.requestId ? ` request=${event.payload.requestId}` : '';
    const status = event.payload?.status ? ` status=${event.payload.status}` : '';
    const message = event.payload?.message ? ` message=${JSON.stringify(event.payload.message)}` : '';
    console.log(`${event.time} ${event.clientId} ${event.type}${requestId}${status}${message}`);
  }
}

function printSessions(state) {
  if (!state.lastSessions.length) {
    console.log('No sessions found. Use /session refresh or open the ChatGPT sidebar.');
    return;
  }
  console.log('Sessions:');
  for (const [index, session] of state.lastSessions.entries()) {
    const active = session.active || state.sessionId === session.id ? '*' : ' ';
    console.log(` ${active} [${index + 1}] ${session.title || session.id}`);
    console.log(`     id: ${session.id}`);
    if (session.url) console.log(`     ${session.url}`);
  }
}

function printAttachments(state) {
  if (!state.pendingAttachments.length) {
    console.log('No queued attachments.');
    return;
  }
  console.log('Queued attachments for next message:');
  for (const [index, file] of state.pendingAttachments.entries()) {
    console.log(`  [${index + 1}] ${file.name} · ${file.id} · ${bytes(file.size)}`);
  }
}

async function listFiles(fileStore) {
  const files = await fileStore.listFiles();
  if (!files.length) {
    console.log('No local files in bridge storage.');
    return;
  }
  console.log('Local files:');
  for (const file of files) console.log(`  ${file.id} · ${file.name} · ${bytes(file.size)} · ${file.createdAt}`);
}

async function listArtifacts(bridge, fileStore, state) {
  const known = bridge.listKnownArtifacts();
  const stored = await fileStore.listArtifacts();
  const map = new Map();
  for (const artifact of known) map.set(artifact.id, artifact);
  for (const artifact of stored) map.set(artifact.id, { ...artifact, stored: true });
  const artifacts = Array.from(map.values());
  state.lastArtifacts = artifacts;

  if (!artifacts.length) {
    console.log('No known artifacts yet.');
    return;
  }
  console.log('Artifacts:');
  for (const [index, artifact] of artifacts.entries()) {
    const storedMarker = artifact.stored || artifact.storedFileId ? ' stored' : '';
    console.log(`  [${index + 1}] ${artifact.kind || 'artifact'} · ${artifact.name || artifact.id} · ${artifact.id}${storedMarker}`);
    if (artifact.downloadUrl || artifact.url || artifact.src) console.log(`      ${artifact.downloadUrl || artifact.url || artifact.src}`);
  }
}

function resolveFromList(token, list, label) {
  const value = String(token || '').trim();
  if (!value) throw new Error(`No ${label} provided`);
  const numeric = Number.parseInt(value, 10);
  if (Number.isInteger(numeric) && String(numeric) === value && numeric >= 1 && numeric <= list.length) return list[numeric - 1];
  return list.find((item) => item.id === value || item.fileId === value || item.artifactId === value) || { id: value };
}

async function downloadArtifact(bridge, fileStore, state, args) {
  if (!args.length) {
    console.log('Usage: /download <index|artifactId> [path]');
    return;
  }
  if (!state.lastArtifacts.length) await listArtifacts(bridge, fileStore, state);
  const artifact = resolveFromList(args[0], state.lastArtifacts, 'artifact');
  const stored = await bridge.fetchArtifact(artifact.id);
  const readable = await fileStore.getReadable(stored.id || artifact.id);
  if (!readable?.absolutePath) throw new Error(`Downloaded artifact is not readable: ${artifact.id}`);

  let target = args[1] || '';
  if (!target) target = path.join(config.dataDir, 'downloads', readable.name || stored.name || artifact.name || artifact.id);
  target = path.resolve(target);

  try {
    const stat = await fs.stat(target).catch(() => null);
    if (stat?.isDirectory()) target = path.join(target, readable.name || stored.name || artifact.name || artifact.id);
  } catch {
    // ignore
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(readable.absolutePath, target);
  console.log(`[artifact] downloaded ${readable.name || stored.name || artifact.id} → ${target}`);
  return target;
}

async function openArtifact(bridge, fileStore, state, args) {
  if (!args.length) {
    console.log('Usage: /open <index|artifactId>');
    return;
  }
  const target = await downloadArtifact(bridge, fileStore, state, [args[0]]);
  if (!target) return;
  const opened = openPathWithSystem(target);
  console.log(`[artifact] opened ${opened}`);
}


function printProjectStatus(state) {
  if (!state.projectRoot) {
    console.log('No project opened. Start with --project <path> or use /project open <path>.');
    return;
  }
  console.log(`Project: ${state.projectId || '(not opened)'} · ${state.projectRoot}`);
  console.log(`Thread: ${state.projectThreadId || '(none; use /project session new or /project session use)'}`);
  console.log(`Enabled skills: ${state.enabledSkills.length ? state.enabledSkills.join(', ') : '(none)'}`);
  if (state.lastProjectScan) {
    console.log(`Last snapshot: ${state.lastProjectScan.snapshotId}`);
    console.log(`Files: ${state.lastProjectScan.files?.length ?? 0} included · ${state.lastProjectScan.ignored?.length ?? 0} ignored`);
  }
  if (state.lastTurnId) console.log(`Last turn: ${state.lastTurnId}`);
  if (state.lastAppliedTurnId) console.log(`Last applied turn: ${state.lastAppliedTurnId}`);
}

async function openProject(projectService, turnManager, state, projectPath, { createThread = false } = {}) {
  if (!projectService) throw new Error('Project service is not available');
  const project = await projectService.open(projectPath);
  state.projectRoot = project.root;
  state.projectId = project.id;
  state.enabledSkills = project.enabledSkills || state.enabledSkills || [];
  state.projectThreadId = project.currentThreadId || state.projectThreadId || '';
  state.projectThreads = turnManager ? await projectService.listThreadsForProject(project.root, turnManager) : [];
  if (createThread && turnManager && !state.projectThreadId) {
    const thread = await turnManager.createThread({ title: project.name, cwd: project.root, metadata: { project: true, projectId: project.id } });
    state.projectThreadId = thread.id;
    await projectService.setCurrentThread(project.root, thread.id);
    state.projectThreads = [thread, ...state.projectThreads];
  }
  return project;
}

async function ensureProjectThread(projectService, turnManager, state) {
  if (!state.projectRoot) throw new Error('No project opened. Use /project open <path> or start with --project <path>.');
  if (state.projectThreadId) return state.projectThreadId;
  if (!turnManager) throw new Error('Turn manager is not available');
  const title = state.projectRoot.split(/[\/]/).filter(Boolean).pop() || 'Project';
  const thread = await turnManager.createThread({ title, cwd: state.projectRoot, metadata: { project: true, projectId: state.projectId } });
  state.projectThreadId = thread.id;
  await projectService.setCurrentThread(state.projectRoot, thread.id);
  console.log(`[project] created thread: ${thread.id}`);
  return thread.id;
}

function printProjectThreads(state) {
  if (!state.projectThreads.length) {
    console.log('No local threads for this project yet. Use /project session new.');
    return;
  }
  console.log('Project threads:');
  for (const [index, thread] of state.projectThreads.entries()) {
    const marker = thread.id === state.projectThreadId ? '*' : ' ';
    console.log(` ${marker} [${index + 1}] ${thread.title || thread.id}`);
    console.log(`     id: ${thread.id}`);
    console.log(`     updated: ${thread.updatedAt || thread.createdAt || ''}`);
  }
}

async function printSkills(projectService, state) {
  if (!state.projectRoot) { console.log('No project opened.'); return; }
  const skills = await projectService.listSkills(state.projectRoot);
  if (!skills.length) {
    console.log('No skills found in .bridge/skills or ~/.chatgpt-bridge/skills.');
    return;
  }
  console.log('Skills:');
  for (const skill of skills) {
    const marker = state.enabledSkills.includes(skill.name) ? '*' : ' ';
    console.log(` ${marker} ${skill.name} · ${skill.scope}`);
  }
}

async function printAgent(projectService, state) {
  if (!state.projectRoot) { console.log('No project opened.'); return; }
  const agent = await projectService.readAgent(state.projectRoot);
  if (!agent.path) {
    console.log('No AGENT.md found. Checked AGENTS.md, AGENT.md, agent.md, .bridge/AGENT.md.');
    return;
  }
  console.log(`Agent: ${agent.path} · ${agent.content.length} chars`);
  if (agent.found?.length > 1) console.log(`Additional agent files found: ${agent.found.slice(1).map((item) => item.path).join(', ')}`);
}

function renderTurnEvent(event, state) {
  const type = event?.type || '';
  const data = event?.data || {};
  if (state.eventLevel === 'quiet') return '';
  if (type === 'turn/queued') return '[turn] queued';
  if (type === 'turn/started') return '[turn] started';
  if (type === 'project/scanStarted') return `[project] scanning ${data.cwd || ''}`.trim();
  if (type === 'project/scanCompleted') return `[project] snapshot ${data.snapshotId?.slice?.(0, 12) || ''} · ${data.files ?? 0} files · ${data.ignored ?? 0} ignored`;
  if (type === 'project/packageCreated') return `[project] package ${data.name || ''} · ${bytes(data.size)} · ${data.attached ? 'attached' : 'reused'}`;
  if (type === 'files.attach.started') return `[file] attaching ${data.count ?? ''} file(s)`.trim();
  if (type === 'files.attach.done') return `[file] attached ${(data.names || []).join(', ') || `${data.count ?? ''} file(s)`}`;
  if (type === 'prompt.delivered') return `[chat] prompt delivered to ${data.clientId || 'selected tab'}`;
  if (type === 'prompt.accepted') return data.implicit ? `[chat] prompt accepted implicitly via ${data.via || 'client event'}` : '[chat] prompt accepted';
  if (type === 'prompt.sent') return '[chat] prompt sent';
  if (type === 'generation.started') return '[chat] generation started';
  if (type === 'item/artifact/created') return `[artifact] ${data.artifact?.name || data.artifact?.id || 'created'}`;
  if (type === 'result/resolving') return `[result] resolving ${data.expected || 'result'}`;
  if (type === 'artifact.downloading') return `[artifact] downloading ${data.name || data.artifactId || ''}`;
  if (type === 'result.validating') return '[result] validating zip';
  if (type === 'result.ready') return `[result] ready ${data.name || ''} · ${bytes(data.size)}`;
  if (type === 'turn/completed') return '[turn] completed';
  if (type === 'turn/failed') return `[error] ${data.error?.message || 'turn failed'}`;
  if (type === 'turn/interrupted') return '[turn] interrupted';
  if (state.eventLevel === 'verbose' && !type.includes('/delta')) return `[event] ${type}`;
  return '';
}

async function waitForTurn(turnManager, turnId, state, consoleStream) {
  let lastThinking = '';
  let lastAnswer = '';
  const doneStatuses = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
  const printEvent = (event) => {
    if (event.type === 'item/reasoning/delta') {
      const text = event.data?.text || '';
      if (text && text !== lastThinking) {
        lastThinking = text;
        consoleStream.onThinkingUpdate(text);
      }
      return;
    }
    if (event.type === 'item/agentMessage/delta') {
      const text = event.data?.text || '';
      if (text && text !== lastAnswer) {
        lastAnswer = text;
        consoleStream.onAnswerUpdate(text);
      }
      return;
    }
    const line = renderTurnEvent(event, state);
    if (line) consoleStream.status(line);
  };

  const recent = await turnManager.getTurnEvents(turnId, { limit: 1000 });
  for (const event of recent) printEvent(event);
  let current = await turnManager.getTurn(turnId);
  if (current && doneStatuses.has(current.status)) return current;

  return await new Promise((resolve) => {
    const handler = async (event) => {
      printEvent(event);
      if (['turn/completed', 'turn/failed', 'turn/interrupted', 'turn/cancelled'].includes(event.type)) {
        turnManager.off(`turn:${turnId}`, handler);
        resolve(await turnManager.getTurn(turnId));
      }
    };
    turnManager.on(`turn:${turnId}`, handler);
  });
}

export async function runProjectTask(message, context) {
  const { state, projectService, turnManager } = context;
  if (!projectService || !turnManager) throw new Error('Project turns are not available');
  const threadId = await ensureProjectThread(projectService, turnManager, state);
  const spinner = createSpinner('Running project task', process.stdout);
  const consoleStream = createConsoleStream(spinner, process.stdout);
  spinner.start();
  const { turn } = await turnManager.startTurn({
    threadId,
    cwd: state.projectRoot,
    message,
    model: state.model,
    effort: state.effort,
    project: {
      mode: 'package',
      useGitignore: true,
      useAgentFile: true,
      skills: state.enabledSkills,
      snapshotPolicy: 'reuse-if-unchanged',
    },
    output: { expected: 'zip', required: true },
  });
  state.lastTurnId = turn.id;
  const finalTurn = await waitForTurn(turnManager, turn.id, state, consoleStream);
  state.lastTurn = finalTurn;
  if (finalTurn?.status === 'completed') {
    consoleStream.finish(finalTurn.output?.answer || finalTurn.output?.text || '');
  } else {
    consoleStream.fail();
    throw new Error(finalTurn?.error?.message || `Turn ended with status: ${finalTurn?.status}`);
  }
}

async function runAsk(message, context) {
  const { bridge, projectService, state } = context;
  const prompt = state.projectRoot && projectService
    ? await projectService.buildAskMessage(state.projectRoot, message, { skills: state.enabledSkills })
    : message;
  const spinner = createSpinner('Waiting for ChatGPT answer', process.stdout);
  const consoleStream = createConsoleStream(spinner, process.stdout);
  spinner.start();
  const response = await bridge.sendRequest({
    message: prompt,
    sessionId: state.sessionId,
    model: state.model,
    effort: state.effort,
    attachments: [],
  }, {
    onEvent: (event) => {
      const line = renderEvent(event, state.eventLevel);
      if (line) consoleStream.status(line);
    },
    onThinkingUpdate: (text) => consoleStream.onThinkingUpdate(text),
    onAnswerUpdate: (text) => consoleStream.onAnswerUpdate(text),
    onArtifactUpdate: (artifacts) => {
      state.lastArtifacts = artifacts;
      consoleStream.onArtifactUpdate(artifacts);
    },
  }, { fullResponse: true });
  if (response.session?.id) state.sessionId = response.session.id;
  consoleStream.finish(response.answer);
}

async function recoverLatestResponse(context, { force = false, apply = false, index = 1, list = false } = {}) {
  const { bridge, turnManager, fileStore, state, projectService, confirm } = context;

  if (list) {
    const responses = await bridge.recoverResponses({ limit: 5, timeoutMs: 30_000 });
    if (!responses.length) {
      console.log('[recover] no visible assistant responses found');
      return null;
    }
    console.log('[recover] recent assistant responses:');
    for (const item of responses) {
      const preview = truncate(item.answer || item.thinking || '(empty)', 160);
      console.log(`  [${item.candidateIndex || '?'}] turn ${item.turnIndex ?? '?'} · ${item.answer.length} chars · ${item.artifacts.length} artifact(s) · ${preview}`);
    }
    console.log('Use /recover <n> or /recover <n> --apply to pick one.');
    return responses;
  }

  const selectedIndex = Math.max(1, Number(index) || 1);
  if (turnManager) {
    const turn = await turnManager.recoverTurnFromLatestResponse(state.lastTurnId || '', { force, index: selectedIndex, timeoutMs: 30_000 });
    state.lastTurnId = turn.id;
    state.lastTurn = turn;
    console.log(`[recover] recovered ${turn.id} from assistant response #${selectedIndex} · ${turn.status}`);
    if (turn.output) {
      console.log(`[recover] result: ${turn.output.type || 'unknown'} · ${turn.output.name || ''} · ${bytes(turn.output.size)}`);
      if (turn.output.fileId) console.log(`[recover] file: ${turn.output.fileId}`);
      if (turn.output.reconstructedFrom) console.log(`[recover] reconstructed from: ${turn.output.reconstructedFrom}`);
    }
    if (apply && turn.output?.type === 'zip') {
      await applyLastTurnResult(fileStore, state, { force, confirm, projectService });
    } else if (apply) {
      console.log('[recover] recovered response is not a ZIP result; nothing to apply');
    }
    return turn;
  }

  const response = await bridge.recoverLatestResponse({ index: selectedIndex, timeoutMs: 30_000 });
  state.lastArtifacts = response.artifacts || [];
  console.log(`[recover] assistant response #${selectedIndex} · ${response.answer.length} chars · ${state.lastArtifacts.length} artifact(s)`);
  if (response.answer) console.log(response.answer.slice(0, 2000));
  if (state.lastArtifacts.length) {
    for (const [artifactIndex, artifact] of state.lastArtifacts.entries()) console.log(`  [${artifactIndex + 1}] ${artifact.name || artifact.id || 'artifact'} · ${artifact.id || ''}`);
  }
  return response;
}

async function downloadLastTurnResult(fileStore, state, targetArg = '') {
  const turn = state.lastTurn;
  const fileId = turn?.output?.fileId;
  if (!fileId) {
    console.log('No downloadable ZIP result in the last turn.');
    return;
  }
  const readable = await fileStore.getReadable(fileId);
  if (!readable?.absolutePath) throw new Error(`Result file is not readable: ${fileId}`);
  let target = targetArg ? path.resolve(targetArg) : path.join(config.dataDir, 'downloads', readable.name || `result-${turn.id}.zip`);
  const stat = await fs.stat(target).catch(() => null);
  if (stat?.isDirectory()) target = path.join(target, readable.name || `result-${turn.id}.zip`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(readable.absolutePath, target);
  console.log(`[result] downloaded → ${target}`);
}


async function getLastTurnResultReadable(fileStore, state) {
  const turn = state.lastTurn;
  const fileId = turn?.output?.fileId;
  if (!fileId) throw new Error('No downloadable ZIP result in the last turn.');
  const readable = await fileStore.getReadable(fileId);
  if (!readable?.absolutePath) throw new Error(`Result file is not readable: ${fileId}`);
  return { turn, file: readable };
}

function printPreview(title, items, prefix, limit = 12) {
  if (!items?.length) return;
  console.log(`${title}:`);
  for (const item of items.slice(0, limit)) console.log(`  ${prefix} ${item.path}${item.size ? ` · ${bytes(item.size)}` : ''}`);
  if (items.length > limit) console.log(`  ... ${items.length - limit} more`);
}

function printApplyPlan(plan) {
  const warnings = plan.safety?.warnings || [];
  if (warnings.length) {
    console.log('Safety warnings:');
    for (const warning of warnings) {
      console.log(`  - ${warning.code}: ${warning.message}`);
      for (const line of warning.preview || []) console.log(`      ${line}`);
    }
  } else {
    console.log('[git] clean worktree detected');
  }
  console.log(`[apply] +${plan.plan.filesToCreate} create, ~${plan.plan.filesToUpdate} update, -${plan.plan.filesToDelete} delete, =${plan.plan.filesUnchanged} unchanged${plan.plan.stripPrefix ? ` · strip ${plan.plan.stripPrefix}` : ''}`);
  if (plan.plan.filesLocallyChanged || plan.plan.filesLocallyChangedDelete) {
    console.log(`[apply] !${plan.plan.filesLocallyChanged} locally changed update conflict(s), !${plan.plan.filesLocallyChangedDelete} locally changed delete conflict(s)`);
  }
  printPreview('Create', plan.plan.create, '+');
  printPreview('Update', plan.plan.update, '~');
  printPreview('Delete', plan.plan.delete, '-');
  printPreview('Locally changed updates', plan.plan.localChanged, '!');
  printPreview('Locally changed deletes', plan.plan.localChangedDelete, '!');
  if (plan.plan.filesSkipped) console.log(`[apply] ${plan.plan.filesSkipped} unsafe/internal file(s) skipped`);
}

async function buildApplyReference(projectService, state) {
  if (state.lastProjectScan?.manifest?.files?.length) return state.lastProjectScan.manifest;
  if (projectService && state.projectRoot) {
    const manifest = await projectService.getLatestSnapshotManifest(state.projectRoot).catch(() => null);
    if (manifest?.files?.length) return manifest;
  }
  return null;
}

async function askInteractiveApplySelection(plan, confirm) {
  const selectedWritePaths = [];
  const selectedDeletePaths = [];
  if (!confirm) {
    return { selectedWritePaths: [...plan.plan.update, ...plan.plan.localChanged].map((item) => item.path), selectedDeletePaths: [...plan.plan.delete, ...plan.plan.localChangedDelete].map((item) => item.path) };
  }
  const updateCandidates = [...(plan.plan.update || []), ...(plan.plan.localChanged || [])];
  const deleteCandidates = [...(plan.plan.delete || []), ...(plan.plan.localChangedDelete || [])];
  if (updateCandidates.length) console.log('Changed files:');
  for (const item of updateCandidates) {
    const local = item.localChange ? ' Local changes after snapshot will be overwritten.' : '';
    const ok = await confirm(`Apply update to ${item.path}?${local} [y/N] `);
    if (ok) selectedWritePaths.push(item.path);
  }
  if (deleteCandidates.length) console.log('Deleted files:');
  for (const item of deleteCandidates) {
    const local = item.localChange ? ' Local changes after snapshot will be deleted.' : '';
    const ok = await confirm(`Delete ${item.path}?${local} [y/N] `);
    if (ok) selectedDeletePaths.push(item.path);
  }
  return { selectedWritePaths, selectedDeletePaths };
}

async function applyZipPathResult(zipPathArg, state, { force = false, planOnly = false, interactive = false, confirm = null, projectService = null } = {}) {
  if (!state.projectRoot) throw new Error('No project opened. Use --project <path> or /project open <path>.');
  const zipPath = path.resolve(zipPathArg || '');
  const stat = await fs.stat(zipPath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`ZIP file not found: ${zipPath}`);
  const referenceManifest = await buildApplyReference(projectService, state);
  const options = { sync: true, referenceManifest };
  const plan = await planZipApply({ zipPath, projectRoot: state.projectRoot, options });
  printApplyPlan(plan);
  if (planOnly) return plan;

  if (!force && !interactive) {
    const question = plan.safety.safe
      ? 'Apply this ZIP to the project? [y/N] '
      : 'Apply this ZIP despite warnings/local changes? [y/N] ';
    const ok = confirm ? await confirm(question) : false;
    if (!ok) {
      console.log('[apply] cancelled');
      return null;
    }
  }

  let selectedWritePaths = null;
  let selectedDeletePaths = null;
  if (interactive && !force) {
    const selection = await askInteractiveApplySelection(plan, confirm);
    selectedWritePaths = selection.selectedWritePaths;
    selectedDeletePaths = selection.selectedDeletePaths;
    const ok = confirm ? await confirm('Apply selected changes now? [y/N] ') : false;
    if (!ok) {
      console.log('[apply] cancelled');
      return null;
    }
  }

  const result = await applyZipToProject({
    zipPath,
    projectRoot: state.projectRoot,
    options: {
      ...options,
      conflictPolicy: 'overwrite',
      ...(selectedWritePaths ? { selectedWritePaths } : {}),
      ...(selectedDeletePaths ? { selectedDeletePaths } : {}),
    },
  });
  state.lastAppliedResult = result;
  console.log(`[apply] applied ${path.basename(zipPath)} · wrote ${result.written.length} file(s), deleted ${result.deleted.length} file(s) in ${result.projectRoot}`);
  if (result.skipped.length) console.log(`[apply] skipped ${result.skipped.length} file(s)`);
  return result;
}

export async function applyLastTurnResult(fileStore, state, { force = false, planOnly = false, interactive = false, confirm = null, projectService = null } = {}) {
  if (!state.projectRoot) throw new Error('No project opened. Use --project <path> or /project open <path>.');
  if (!state.lastTurn && state.lastTurnId) throw new Error('Last turn is not loaded. Use /result first after running a task.');
  const { turn, file } = await getLastTurnResultReadable(fileStore, state);
  if (state.lastAppliedTurnId === turn.id && !force && !planOnly) {
    console.log(`Result for ${turn.id} was already applied. Use /result apply --force to apply again.`);
    return null;
  }

  const referenceManifest = await buildApplyReference(projectService, state);
  const options = { sync: true, referenceManifest };
  const plan = await planZipApply({ zipPath: file.absolutePath, projectRoot: state.projectRoot, options });
  printApplyPlan(plan);
  if (planOnly) return plan;

  if (!force && !interactive) {
    const question = plan.safety.safe
      ? 'Apply this sync plan to the project? [y/N] '
      : 'Apply this sync plan despite warnings/local changes? [y/N] ';
    const ok = confirm ? await confirm(question) : false;
    if (!ok) {
      console.log('[apply] cancelled');
      return null;
    }
  }

  let selectedWritePaths = null;
  let selectedDeletePaths = null;
  if (interactive && !force) {
    const selection = await askInteractiveApplySelection(plan, confirm);
    selectedWritePaths = selection.selectedWritePaths;
    selectedDeletePaths = selection.selectedDeletePaths;
    const ok = confirm ? await confirm('Apply selected changes now? [y/N] ') : false;
    if (!ok) {
      console.log('[apply] cancelled');
      return null;
    }
  }

  const result = await applyZipToProject({
    zipPath: file.absolutePath,
    projectRoot: state.projectRoot,
    options: {
      ...options,
      conflictPolicy: 'overwrite',
      ...(selectedWritePaths ? { selectedWritePaths } : {}),
      ...(selectedDeletePaths ? { selectedDeletePaths } : {}),
    },
  });
  state.lastAppliedTurnId = turn.id;
  state.lastAppliedResult = result;
  console.log(`[apply] wrote ${result.written.length} file(s), deleted ${result.deleted.length} file(s) in ${result.projectRoot}`);
  if (result.skipped.length) console.log(`[apply] skipped ${result.skipped.length} file(s)`);
  return result;
}

export async function handleCommand(message, context) {
  const { bridge, fileStore, state, projectService, turnManager, confirm } = context;
  const [command, ...tokens] = shellSplit(message);
  const rest = message.slice(command.length).trim();

  if (message === '/help') { printHelp(); return true; }

  if (message === '/setup') {
    console.log(`Setup page: ${config.publicBaseUrl}/setup`);
    console.log(`Server URL: ${config.publicBaseUrl}`);
    console.log(`Bridge token: ${config.bridgeToken}`);
    console.log('Open ChatGPT, click the floating Bridge button, paste the token, and use HTTP polling if WebSocket is blocked by CSP.');
    console.log(`Diagnostics: ${config.publicBaseUrl}/diagnostics`);
    return true;
  }
  if (message === '/diagnostics') {
    console.log(`Diagnostics page: ${config.publicBaseUrl}/diagnostics`);
    console.log('Keep it open while pressing Test / Save & Connect in the userscript panel.');
    return true;
  }
  if (message === '/health') { printHealth(bridge, state); return true; }
  if (message === '/clients' || message === '/connections') { printClients(bridge); return true; }
  if (message === '/state') {
    console.log(`Interactive state file: ${INTERACTIVE_STATE_FILE}`);
    console.log(`Session: ${state.sessionId || '(current tab)'}`);
    console.log(`Model: ${state.model || '(ChatGPT default)'}`);
    console.log(`Effort: ${state.effort || '(ChatGPT default)'}`);
    console.log(`Queued attachments: ${state.pendingAttachments.length}`);
    console.log(`Event level: ${state.eventLevel}`);
    return true;
  }

  if (command === '/select') {
    const clientId = tokens.join(' ').trim();
    if (!clientId) console.log('Usage: /select <id|index|clear|auto>');
    else if (clientId === 'clear' || clientId === 'auto') { bridge.clearSelectedClient(); console.log('Client selection cleared. Auto-selection is used only when exactly one tab is connected.'); }
    else {
      const target = resolveClientSelector(bridge, clientId);
      const selected = bridge.selectClient(target.id);
      console.log(`Selected client: ${selected.id}`);
      if (selected.url) console.log(selected.url);
    }
    return true;
  }

  if (command === '/client') {
    const sub = tokens[0] || 'current';
    if (sub === 'current') { printCurrentClient(bridge); return true; }
    if (sub === 'list') { printClients(bridge); return true; }
    if (sub === 'select') {
      const selector = tokens.slice(1).join(' ').trim();
      if (!selector) { console.log('Usage: /client select <id|index>'); return true; }
      const target = resolveClientSelector(bridge, selector);
      const selected = bridge.selectClient(target.id);
      console.log(`Selected client: ${selected.id}`);
      if (selected.url) console.log(selected.url);
      return true;
    }
    if (sub === 'clear' || sub === 'auto') {
      bridge.clearSelectedClient();
      console.log('Client selection cleared. Auto-selection is used only when exactly one tab is connected.');
      return true;
    }
    if (sub === 'drop' || sub === 'disconnect') {
      const selector = tokens.slice(1).join(' ').trim();
      if (!selector) { console.log('Usage: /client drop <id|index>'); return true; }
      const target = resolveClientSelector(bridge, selector);
      const dropped = bridge.dropClient(target.id);
      console.log(`Dropped client locally: ${dropped.id}`);
      return true;
    }
    console.log('Usage: /client current|list|select <id|index>|clear|drop <id|index>');
    return true;
  }

  if (message === '/stop') {
    const cancelled = bridge.cancelActive('Cancelled from interactive /stop');
    console.log(`Cancelled requests: ${cancelled}`);
    return true;
  }

  if (message === '/reset') {
    Object.assign(state, makeDefaultState());
    console.log('Interactive state reset. Active ChatGPT tab was not modified.');
    return true;
  }

  if (command === '/events') {
    const level = tokens[0];
    if (!level) console.log(`Events: ${state.eventLevel}`);
    else if (!EVENT_LEVELS.has(level)) console.log('Usage: /events quiet|normal|verbose');
    else { state.eventLevel = level; console.log(`Events: ${level}`); }
    return true;
  }

  if (message === '/sessions' || message === '/session refresh') {
    state.lastSessions = await bridge.listSessions({ timeoutMs: 10_000 });
    printSessions(state);
    return true;
  }

  if (message === '/session current') {
    console.log(`Session: ${state.sessionId || '(current tab)'}`);
    return true;
  }

  if (message === '/session new') {
    const result = await bridge.newSession();
    const session = result.session || result.current || null;
    if (session?.id) state.sessionId = session.id;
    state.lastSessions = result.sessions || (session ? [session] : []);
    console.log(`New session: ${session?.title || session?.id || '(unknown)'}`);
    if (session?.url) console.log(session.url);
    return true;
  }

  if (command === '/session') {
    const sub = tokens[0];
    const target = sub === 'select' ? tokens.slice(1).join(' ') : tokens.join(' ');
    if (!target) { console.log('Usage: /session select <id|index>'); return true; }
    if (!state.lastSessions.length && /^\d+$/.test(target)) state.lastSessions = await bridge.listSessions({ timeoutMs: 10_000 });
    const session = resolveFromList(target, state.lastSessions, 'session');
    const result = await bridge.selectSession(session.id);
    const selected = result.session || session;
    state.sessionId = selected.id || session.id;
    state.lastSessions = result.sessions || state.lastSessions;
    console.log(`Selected session: ${selected.title || selected.id}`);
    if (selected.url) console.log(selected.url);
    return true;
  }

  if (command === '/model') {
    if (tokens[0] === 'list') {
      const result = await bridge.listModels({ timeoutMs: 10_000 });
      state.lastModels = result.models || [];
      if (result.current?.label && !state.model) state.model = result.current.label;
      printModels(state);
      return true;
    }
    if (tokens[0] === 'default' || tokens[0] === 'clear' || tokens[0] === 'auto') {
      state.model = '';
      console.log('Model reset to ChatGPT default');
      return true;
    }
    const modelName = resolveModelToken(tokens.join(' '), state.lastModels);
    if (!modelName) printModels(state);
    else { state.model = modelName; console.log(`Model set: ${state.model}`); }
    return true;
  }

  if (command === '/effort') {
    if (tokens[0] === 'list') {
      const result = await bridge.listEfforts({ timeoutMs: 10_000 });
      state.lastEfforts = result.efforts || [];
      printEfforts(state);
      return true;
    }
    if (tokens[0] === 'default' || tokens[0] === 'clear') {
      state.effort = '';
      console.log('Effort reset to ChatGPT default');
      return true;
    }
    const effort = resolveModelToken(tokens.join(' '), state.lastEfforts).toLowerCase();
    if (!effort) printEfforts(state);
    else if (!EFFORTS.has(effort)) console.log('Usage: /effort auto|instant|low|medium|high|xhigh');
    else { state.effort = effort === 'auto' ? '' : effort; console.log(`Effort set: ${state.effort || 'auto'}`); }
    return true;
  }

  if (message === '/mode') {
    console.log(`Session: ${state.sessionId || '(current tab)'}`);
    console.log(`Model: ${state.model || '(ChatGPT default)'}`);
    console.log(`Effort: ${state.effort || '(ChatGPT default)'}`);
    console.log(`Queued attachments: ${state.pendingAttachments.length}`);
    console.log(`Event level: ${state.eventLevel}`);
    return true;
  }



  if (command === '/project') {
    const sub = tokens[0] || '';
    if (!sub) { printProjectStatus(state); return true; }
    if (sub === 'open') {
      const projectPath = tokens.slice(1).join(' ');
      if (!projectPath) { console.log('Usage: /project open <path>'); return true; }
      const project = await openProject(projectService, turnManager, state, projectPath);
      console.log(`[project] opened ${project.name} · ${project.root}`);
      if (state.projectThreads.length) {
        console.log('Existing local threads:');
        printProjectThreads(state);
      } else {
        console.log('No local thread yet. Use /project session new.');
      }
      return true;
    }
    if (sub === 'scan') {
      if (!state.projectRoot) { console.log('No project opened.'); return true; }
      const scan = await projectService.scan(state.projectRoot, { skills: state.enabledSkills });
      state.lastProjectScan = scan;
      state.projectId = scan.project.id;
      console.log(`[project] snapshot ${scan.snapshotId}`);
      console.log(`[project] ${scan.files.length} files included · ${scan.ignored.length} ignored · ${bytes(scan.totalBytes)}`);
      console.log(scan.agent.path ? `[agent] ${scan.agent.path}` : '[agent] not found');
      if (scan.skills.length) console.log(`[skills] available: ${scan.skills.map((skill) => skill.name).join(', ')}`);
      return true;
    }
    if (sub === 'pack' || sub === 'sync') {
      if (!state.projectRoot) { console.log('No project opened.'); return true; }
      const pack = await projectService.pack(state.projectRoot, { threadId: state.projectThreadId, skills: state.enabledSkills, force: sub === 'sync', snapshotPolicy: sub === 'sync' ? 'always' : 'reuse-if-unchanged' });
      state.lastProjectPack = pack;
      state.lastProjectScan = pack.scan;
      state.projectId = pack.project.id;
      console.log(`[project] packed ${pack.file.name} · ${pack.file.id} · ${bytes(pack.file.size)}`);
      console.log(`[project] snapshot ${pack.snapshotId} · ${pack.shouldAttach ? 'will attach on next task' : 'already uploaded for this thread'}`);
      return true;
    }
    if (sub === 'sessions') {
      if (!state.projectRoot) { console.log('No project opened.'); return true; }
      state.projectThreads = await projectService.listThreadsForProject(state.projectRoot, turnManager);
      printProjectThreads(state);
      return true;
    }
    if (sub === 'session') {
      const action = tokens[1] || '';
      if (action === 'new') {
        if (!state.projectRoot) { console.log('No project opened.'); return true; }
        const title = state.projectRoot.split(/[\/]/).filter(Boolean).pop() || 'Project';
        const thread = await turnManager.createThread({ title, cwd: state.projectRoot, metadata: { project: true, projectId: state.projectId } });
        state.projectThreadId = thread.id;
        await projectService.setCurrentThread(state.projectRoot, thread.id);
        state.projectThreads = await projectService.listThreadsForProject(state.projectRoot, turnManager);
        console.log(`[project] new thread: ${thread.title} · ${thread.id}`);
        return true;
      }
      if (action === 'use' || action === 'select') {
        if (!state.projectRoot) { console.log('No project opened.'); return true; }
        const target = tokens.slice(2).join(' ');
        if (!target) { console.log('Usage: /project session use <id|index>'); return true; }
        if (!state.projectThreads.length) state.projectThreads = await projectService.listThreadsForProject(state.projectRoot, turnManager);
        const thread = resolveFromList(target, state.projectThreads, 'thread');
        state.projectThreadId = thread.id;
        await projectService.setCurrentThread(state.projectRoot, thread.id);
        console.log(`[project] using thread: ${thread.title || thread.id} · ${thread.id}`);
        return true;
      }
      console.log('Usage: /project session new | /project session use <id|index>');
      return true;
    }
    console.log('Usage: /project | /project open <path> | /project scan | /project pack | /project sync | /project sessions | /project session new | /project session use <id|index>');
    return true;
  }

  if (command === '/skills') {
    const sub = tokens[0] || '';
    if (!sub || sub === 'list' || sub === 'reload') { await printSkills(projectService, state); return true; }
    if (sub === 'enable') {
      const names = tokens.slice(1);
      if (!names.length) { console.log('Usage: /skills enable <name...>'); return true; }
      state.enabledSkills = Array.from(new Set([...(state.enabledSkills || []), ...names])).sort();
      if (state.projectRoot) await projectService.setEnabledSkills(state.projectRoot, state.enabledSkills);
      console.log(`[skills] enabled: ${state.enabledSkills.join(', ')}`);
      return true;
    }
    if (sub === 'disable') {
      const names = new Set(tokens.slice(1));
      if (!names.size) { console.log('Usage: /skills disable <name...>'); return true; }
      state.enabledSkills = (state.enabledSkills || []).filter((name) => !names.has(name));
      if (state.projectRoot) await projectService.setEnabledSkills(state.projectRoot, state.enabledSkills);
      console.log(`[skills] enabled: ${state.enabledSkills.length ? state.enabledSkills.join(', ') : '(none)'}`);
      return true;
    }
    console.log('Usage: /skills | /skills enable <name...> | /skills disable <name...>');
    return true;
  }

  if (command === '/agent') {
    await printAgent(projectService, state);
    return true;
  }

  if (command === '/ask') {
    const prompt = rest;
    if (!prompt) { console.log('Usage: /ask <question>'); return true; }
    await runAsk(prompt, context);
    return true;
  }

  if (command === '/task') {
    const prompt = rest;
    if (!prompt) { console.log('Usage: /task <prompt>'); return true; }
    await runProjectTask(prompt, context);
    if (state.lastTurn?.status === 'completed' && state.lastTurn?.output?.type === 'zip' && state.lastAppliedTurnId !== state.lastTurn.id) {
      await applyLastTurnResult(fileStore, state, { confirm, projectService });
    }
    return true;
  }

  if (command === '/apply') {
    const pathArg = tokens.find((token) => !token.startsWith('--')) || '';
    if (pathArg) {
      await applyZipPathResult(pathArg, state, { force: tokens.includes('--force'), planOnly: tokens.includes('--plan'), interactive: tokens.includes('--interactive'), confirm, projectService });
    } else {
      if (!state.lastTurn && state.lastTurnId && turnManager) state.lastTurn = await turnManager.getTurn(state.lastTurnId);
      await applyLastTurnResult(fileStore, state, { force: tokens.includes('--force'), planOnly: tokens.includes('--plan'), interactive: tokens.includes('--interactive'), confirm, projectService });
    }
    return true;
  }

  if (command === '/recover') {
    const indexToken = tokens.find((token) => /^\d+$/.test(token));
    await recoverLatestResponse(context, { force: tokens.includes('--force'), apply: tokens.includes('--apply'), list: tokens.includes('list') || tokens.includes('--list'), index: indexToken ? Number(indexToken) : 1 });
    return true;
  }

  if (command === '/result') {
    const sub = tokens[0] || '';
    if (!sub) {
      if (!state.lastTurn && state.lastTurnId && turnManager) state.lastTurn = await turnManager.getTurn(state.lastTurnId);
      if (!state.lastTurn) { console.log('No last turn result.'); return true; }
      console.log(`Turn: ${state.lastTurn.id} · ${state.lastTurn.status}`);
      if (state.lastTurn.output) {
        console.log(`Result: ${state.lastTurn.output.type || 'unknown'} · ${state.lastTurn.output.name || ''} · ${bytes(state.lastTurn.output.size)}`);
        if (state.lastTurn.output.fileId) console.log(`File: ${state.lastTurn.output.fileId}`);
        if (state.lastTurn.output.downloadUrl) console.log(`Download URL: ${state.lastTurn.output.downloadUrl}`);
      }
      if (state.lastTurn.error) console.log(`Error: ${state.lastTurn.error.message}`);
      return true;
    }
    if (sub === 'recover') {
      const indexToken = tokens.slice(1).find((token) => /^\d+$/.test(token));
      await recoverLatestResponse(context, { force: tokens.includes('--force'), apply: tokens.includes('--apply'), list: tokens.includes('list') || tokens.includes('--list'), index: indexToken ? Number(indexToken) : 1 });
      return true;
    }
    if (sub === 'download') {
      if (!state.lastTurn && state.lastTurnId && turnManager) state.lastTurn = await turnManager.getTurn(state.lastTurnId);
      await downloadLastTurnResult(fileStore, state, tokens.slice(1).join(' '));
      return true;
    }
    if (sub === 'apply') {
      const pathArg = tokens.slice(1).find((token) => !token.startsWith('--')) || '';
      if (pathArg) {
        await applyZipPathResult(pathArg, state, { force: tokens.includes('--force'), planOnly: tokens.includes('--plan'), interactive: tokens.includes('--interactive'), confirm, projectService });
      } else {
        if (!state.lastTurn && state.lastTurnId && turnManager) state.lastTurn = await turnManager.getTurn(state.lastTurnId);
        await applyLastTurnResult(fileStore, state, { force: tokens.includes('--force'), planOnly: tokens.includes('--plan'), interactive: tokens.includes('--interactive'), confirm, projectService });
      }
      return true;
    }
    console.log('Usage: /result | /result recover [list|n] [--force|--apply] | /result download [path] | /result apply [zipPath] [--plan|--interactive|--force]');
    return true;
  }

  if (command === '/attach') {
    const paths = tokens;
    if (!paths.length) { console.log('Usage: /attach <path> [path...]'); return true; }
    for (const filePath of paths) {
      const file = await fileStore.importLocalPath({ filePath });
      state.pendingAttachments.push(file);
      console.log(`[file] added and queued ${file.name} · ${file.id} · ${bytes(file.size)}`);
    }
    return true;
  }

  if (message === '/attachments') { printAttachments(state); return true; }

  if (message === '/attachments clear-ui') {
    const result = await bridge.clearComposerAttachments({ timeoutMs: 10_000 });
    console.log(`Composer attachments cleared: ${result.removed ?? 0}`);
    if (result.message) console.log(result.message);
    return true;
  }

  if (command === '/detach') {
    const target = tokens[0];
    if (!target) { console.log('Usage: /detach <index|fileId|all>'); return true; }
    if (target === 'all') { state.pendingAttachments = []; console.log('Queued attachments cleared.'); return true; }
    const before = state.pendingAttachments.length;
    const index = Number.parseInt(target, 10);
    if (Number.isInteger(index) && String(index) === target && index >= 1 && index <= state.pendingAttachments.length) {
      const [removed] = state.pendingAttachments.splice(index - 1, 1);
      console.log(`Detached: ${removed.name}`);
    } else {
      state.pendingAttachments = state.pendingAttachments.filter((file) => file.id !== target);
      console.log(before === state.pendingAttachments.length ? `No queued attachment matched: ${target}` : `Detached: ${target}`);
    }
    return true;
  }

  if (message === '/files') { await listFiles(fileStore); return true; }

  if (command === '/file') {
    const sub = tokens[0];
    if (sub === 'add') {
      const paths = tokens.slice(1);
      if (!paths.length) { console.log('Usage: /file add <path>'); return true; }
      for (const filePath of paths) {
        const file = await fileStore.importLocalPath({ filePath });
        console.log(`[file] added ${file.name} · ${file.id} · ${bytes(file.size)}`);
      }
      return true;
    }
    if (sub === 'remove') {
      const fileId = tokens[1];
      if (!fileId) { console.log('Usage: /file remove <fileId>'); return true; }
      const removed = await fileStore.remove(fileId);
      state.pendingAttachments = state.pendingAttachments.filter((file) => file.id !== fileId);
      console.log(removed ? `Removed: ${fileId}` : `Not found: ${fileId}`);
      console.log('If this file was already visible in the ChatGPT composer, use /attachments clear-ui to remove composer chips.');
      return true;
    }
    console.log('Usage: /file add <path> | /file remove <fileId>');
    return true;
  }

  if (message === '/artifacts') { await listArtifacts(bridge, fileStore, state); return true; }

  if (command === '/download') {
    await downloadArtifact(bridge, fileStore, state, tokens);
    return true;
  }

  if (command === '/open') {
    await openArtifact(bridge, fileStore, state, tokens);
    return true;
  }

  if (command === '/debug') {
    const limit = Number.parseInt(tokens[0] || '20', 10);
    printDebugEvents(bridge, Number.isFinite(limit) ? limit : 20);
    return true;
  }

  return false;
}

export async function runLegacyInteractive({ bridge, fileStore, turnManager = null, projectService = null, projectPath = '' }) {
  const state = await loadInteractiveState(fileStore);
  if (projectPath) {
    try {
      const project = await openProject(projectService, turnManager, state, projectPath);
      console.log(`[project] opened ${project.name} · ${project.root}`);
    } catch (err) {
      console.error(`[project] failed to open ${projectPath}: ${err.message}`);
    }
  }

  console.log('Interactive mode. Type a message and press Enter. Use /help for commands.');
  console.log(`Server: ${config.publicBaseUrl}`);
  console.log(`Setup:  ${config.publicBaseUrl}/setup`);
  console.log('Browser agent: open https://chatgpt.com, install/update the userscript, click the floating Bridge button, paste BRIDGE_TOKEN, and connect.');
  console.log(`Recommended userscript transport: ${config.tmTransport} (WebSocket remains available but may be blocked by ChatGPT CSP).`);
  if (!config.apiToken) console.log('API_TOKEN is not set. HTTP API is not protected; keep HOST bound to 127.0.0.1.');
  printHealth(bridge, state);

  const rl = createInterface({ input, output });
  const askYesNo = async (question) => {
    const answer = await rl.question(question);
    return /^(y|yes)$/i.test(String(answer || '').trim());
  };
  let activeAbortController = null;
  let shouldExit = false;
  let waitingForInput = false;
  let renderedPrompt = '';

  const refreshInteractivePrompt = () => {
    if (!waitingForInput || shouldExit) return;
    const nextPrompt = promptForBridge(bridge);
    if (nextPrompt === renderedPrompt) return;
    renderedPrompt = nextPrompt;
    rewritePendingPrompt(rl, output, renderedPrompt);
  };

  const unsubscribeClientLifecycle = typeof bridge.onClientLifecycle === 'function'
    ? bridge.onClientLifecycle(refreshInteractivePrompt)
    : () => {};

  const sigintHandler = () => {
    if (activeAbortController && !activeAbortController.signal.aborted) {
      activeAbortController.abort('Cancelled by Ctrl+C');
      process.stdout.write('\nCancelling active request...\n');
      return;
    }
    shouldExit = true;
    rl.close();
  };

  process.on('SIGINT', sigintHandler);

  async function close() {
    unsubscribeClientLifecycle();
    process.off('SIGINT', sigintHandler);
    rl.close();
    await bridge.close();
  }

  try {
    while (!shouldExit) {
      const prompt = promptForBridge(bridge);
      renderedPrompt = prompt;
      waitingForInput = true;
      const line = await rl.question(prompt).catch(() => null);
      waitingForInput = false;
      if (line == null) break;
      const message = line.trim();
      if (!message) continue;
      if (EXIT_COMMANDS.has(message.toLowerCase())) break;

      try {
        if (await handleCommand(message, { bridge, fileStore, state, projectService, turnManager, confirm: askYesNo })) {
          await saveInteractiveState(state).catch(() => {});
          continue;
        }
      } catch (err) {
        console.error(`ERROR: ${err.message}`);
        continue;
      }

      if (!bridge.health().ok) {
        console.log('No ChatGPT browser agent connected yet.');
        console.log(`Open ${config.publicBaseUrl}/setup, install/update the userscript, then open https://chatgpt.com and use the floating Bridge panel.`);
        console.log(`Diagnostics: ${config.publicBaseUrl}/diagnostics`);
        continue;
      }

      if (state.projectRoot && !message.startsWith('/ask ')) {
        try {
          await runProjectTask(message, { bridge, fileStore, state, projectService, turnManager });
          if (state.lastTurn?.status === 'completed' && state.lastTurn?.output?.type === 'zip' && state.lastAppliedTurnId !== state.lastTurn.id) {
            await applyLastTurnResult(fileStore, state, { confirm: askYesNo, projectService }).catch((err) => console.error(`APPLY ERROR: ${err.message}`));
          }
          await saveInteractiveState(state).catch(() => {});
        } catch (err) {
          console.error(`ERROR: ${err.message}`);
          await saveInteractiveState(state).catch(() => {});
        }
        continue;
      }

      const spinner = createSpinner('Waiting for ChatGPT answer', process.stdout);
      const consoleStream = createConsoleStream(spinner, process.stdout);
      const abortController = new AbortController();
      activeAbortController = abortController;
      spinner.start();

      const attachments = state.pendingAttachments.map((file) => file.id);
      if (attachments.length) {
        consoleStream.status(`Sending with attachments: ${state.pendingAttachments.map((file) => file.name).join(', ')}`);
      }

      try {
        const response = await bridge.sendRequest({
          message,
          sessionId: state.sessionId,
          model: state.model,
          effort: state.effort,
          attachments,
        }, {
          onEvent: (event) => {
            const line = renderEvent(event, state.eventLevel);
            if (line) consoleStream.status(line);
          },
          onThinkingUpdate: (text) => consoleStream.onThinkingUpdate(text),
          onAnswerUpdate: (text) => consoleStream.onAnswerUpdate(text),
          onArtifactUpdate: (artifacts) => {
            state.lastArtifacts = artifacts;
            consoleStream.onArtifactUpdate(artifacts);
          },
        }, { signal: abortController.signal, fullResponse: true });

        if (response.session?.id) state.sessionId = response.session.id;
        if (Array.isArray(response.artifacts) && response.artifacts.length) state.lastArtifacts = response.artifacts;
        consoleStream.finish(response.answer);
        state.pendingAttachments = [];
        await saveInteractiveState(state).catch(() => {});
      } catch (err) {
        consoleStream.fail();
        console.error(`ERROR: ${err.message}`);
        console.error('Queued attachments were kept for retry. Use /detach all to clear them.');
        await saveInteractiveState(state).catch(() => {});
      } finally {
        activeAbortController = null;
      }
    }
  } finally {
    await close();
  }
}
