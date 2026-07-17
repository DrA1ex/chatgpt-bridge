export {
  applyLastTurnResult,
  summarizeAppliedChanges,
} from './apply.js';
export {
  reconcileVisibleProgressSnapshot,
  renderEvent,
  visibleProgressLines,
} from './progress.js';
export {
  INTERACTIVE_STATE_FILE,
  answerTextFromTurn,
  answerTextFromTurnItems,
  autoApplyDecision,
  clearSelectedResult,
  hydrateCurrentScope,
  loadInteractiveState,
  markSelectedResultStale,
  persistCurrentScope,
  rememberResponse,
  saveInteractiveState,
  selectResultForApply,
  switchSessionScope,
} from './state.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { createSpinner } from '../spinner.js';
import { captureConsoleLines } from './consoleCapture.js';
import { bytes, shellSplit, truncate } from './format.js';
import { applyLastTurnResult, applyZipPathResult } from './apply.js';
import { createConsoleStream, reconcileVisibleProgressSnapshot, renderEvent, visibleProgressLines } from './progress.js';
import {
  EFFORTS,
  EVENT_LEVELS,
  INTERACTIVE_STATE_FILE,
  answerTextFromTurn,
  answerTextFromTurnItems,
  clearSelectedResult,
  hydrateCurrentScope,
  loadInteractiveState,
  makeDefaultState,
  markSelectedResultStale,
  persistCurrentScope,
  rememberResponse,
  saveInteractiveState,
  selectResultForApply,
  switchSessionScope,
} from './state.js';
import { exampleWorkflowConfig } from '../workflow/config.js';
import {
  formatWorkflowDashboard,
  formatWorkflowHistory,
  selectWorkflow,
  workflowHistoryFromEvents,
  workflowListLines,
} from '../workflow/ux/workflowView.js';




export function printResponseList(state) {
  const responses = Array.isArray(state.responseHistory) ? state.responseHistory : [];
  if (!responses.length) {
    console.log('No saved assistant responses yet. Run a prompt first, or use /recover list to read visible responses from ChatGPT.');
    return;
  }
  console.log('Saved assistant responses:');
  for (const [index, item] of responses.entries()) {
    const when = item.createdAt ? ` · ${item.createdAt}` : '';
    const artifacts = item.artifactCount ? ` · ${item.artifactCount} artifact(s)` : '';
    console.log(`  [${index + 1}] ${item.title || item.source || 'Assistant response'} · ${item.chars || item.text.length} chars${artifacts}${when}`);
    console.log(`      ${truncate(item.text, 180)}`);
  }
  console.log('Use /responses <n> to show the full text.');
}

export function printResponseByIndex(state, index = 1) {
  const responses = Array.isArray(state.responseHistory) ? state.responseHistory : [];
  const selectedIndex = Math.max(1, Number(index) || 1);
  const item = responses[selectedIndex - 1];
  if (!item) {
    console.log(`No saved assistant response #${selectedIndex}. Use /responses list.`);
    return;
  }
  console.log(`Response #${selectedIndex}: ${item.title || item.source || 'Assistant response'}`);
  if (item.turnId) console.log(`Turn: ${item.turnId}`);
  if (item.createdAt) console.log(`Created: ${item.createdAt}`);
  if (item.artifactCount) console.log(`Artifacts: ${item.artifactCount}`);
  console.log('');
  console.log(item.text);
}



export function printModels(state) {
  console.log(`Current model: ${state.currentModel || '(not read yet)'}`);
  console.log(`Project preference: ${state.model || '(ChatGPT default)'}`);
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

export function printEfforts(state) {
  console.log(`Current effort: ${state.currentEffort || '(not read yet)'}`);
  console.log(`Project preference: ${state.effort || '(ChatGPT default)'}`);
  if (!state.lastEfforts.length) {
    console.log('No effort list loaded. Use /effort list to ask the ChatGPT tab for visible effort options.');
    return;
  }
  console.log('Known effort options:');
  for (const [index, effort] of state.lastEfforts.entries()) {
    const label = effort.label || effort.name || effort.id || String(effort);
    const internal = effort.value || effort.id || '';
    const suffix = internal && String(internal).toLowerCase() !== String(label).toLowerCase() ? ` (${internal})` : '';
    const marker = effort.selected ? '*' : ' ';
    console.log(` ${marker} [${index + 1}] ${label}${suffix}`);
  }
}

export function resolveModelToken(token, list, { preferValue = false } = {}) {
  const value = String(token || '').trim();
  const numeric = Number.parseInt(value, 10);
  if (Number.isInteger(numeric) && String(numeric) === value && numeric >= 1 && numeric <= list.length) {
    const item = list[numeric - 1];
    if (preferValue) return item.value || item.id || item.label || item.name || value;
    return item.label || item.name || item.value || item.id || value;
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



export function promptForBridge(bridge) {
  const health = bridge.health();
  if (health.ok) return 'bridge> ';
  if (health.needsSelection) return 'bridge:select-tab> ';
  return 'bridge:not-connected> ';
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
  } else if (health.clients.some((client) => client.compatible === false || client.compatibility?.compatible === false)) {
    const incompatible = health.clients.find((client) => client.compatible === false || client.compatibility?.compatible === false);
    console.log(`Extension update required: ${incompatible?.compatibility?.message || 'install the extension packaged with this bridge.'}`);
  } else if (health.needsSelection) {
    console.log('Multiple compatible ChatGPT tabs connected. Use /tabs and /tab <clientId>.');
  } else {
    console.log('No compatible ChatGPT tab connected yet.');
  }
}

export function printClients(bridge) {
  const health = bridge.health();
  if (!health.clients.length) {
    console.log('No connected ChatGPT tabs.');
    return;
  }
  for (const [index, client] of health.clients.entries()) {
    const marker = client.selected || health.activeClient?.id === client.id ? '*' : ' ';
    const presence = [client.visibilityState, client.focused ? 'focused' : ''].filter(Boolean).join(', ');
    const active = client.activeRequest?.requestId ? ` · active request: ${client.activeRequest.requestId}` : '';
    const compatibility = client.compatible === false || client.compatibility?.compatible === false ? ' · INCOMPATIBLE' : '';
    console.log(`${marker} [${index + 1}] ${client.id}${presence ? ` · ${presence}` : ''}${active}${compatibility}`);
    console.log(`    ${client.url || '(unknown url)'}`);
    if (client.title) console.log(`    ${client.title}`);
    console.log(`    transport: ${client.transport || 'unknown'} · extension: ${client.extensionVersion || '?'} · content: ${client.clientVersion || '?'} · queued: ${client.queuedCommands || 0} · last seen: ${client.lastSeenAt}`);
    if (client.compatibility?.compatible === false) console.log(`    compatibility: ${client.compatibility.message || client.compatibility.status || 'update required'}`);
  }
  if (health.needsSelection) console.log('Multiple tabs are connected. Use /tab <index> or /tab <clientId>.');
}

export function resolveClientSelector(bridge, selector) {
  const value = String(selector || '').trim();
  const health = bridge.health();
  if (!value) throw new Error('No client selector provided');

  if (['active', 'current', 'selected'].includes(value)) {
    const client = health.activeClient || health.clients.find((item) => item.selected);
    if (!client) throw new Error('No active client. Use /tabs and /tab <index|clientId>.');
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
  if (prefixMatches.length > 1) throw new Error(`Client selector is ambiguous: ${value}. Use a longer id or an index from /tabs.`);

  throw new Error(`Client not found: ${value}. Use /tabs to see connected tabs.`);
}

export function printCurrentClient(bridge) {
  const health = bridge.health();
  const client = health.activeClient || health.clients.find((item) => item.selected);
  if (!client) {
    if (health.needsSelection) console.log('No active tab because multiple tabs are connected. Use /tabs then /tab <index>.');
    else console.log('No active ChatGPT tab connected yet.');
    return;
  }
  console.log(`Current client: ${client.id}`);
  console.log(`URL: ${client.url || '(unknown)'}`);
  if (client.title) console.log(`Title: ${client.title}`);
  console.log(`Transport: ${client.transport || 'unknown'} · ${client.visibilityState || 'visibility unknown'}${client.focused ? ' · focused' : ''}`);
  if (client.activeRequest?.requestId) console.log(`Active request: ${client.activeRequest.requestId}`);
}

export function printDebugEvents(bridge, limit = 20) {
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

export function printSessions(state) {
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

export function printAttachments(state) {
  if (!state.pendingAttachments.length) {
    console.log('No queued attachments.');
    return;
  }
  console.log('Queued attachments for next message:');
  for (const [index, file] of state.pendingAttachments.entries()) {
    console.log(`  [${index + 1}] ${file.name} · ${file.id} · ${bytes(file.size)}`);
  }
}

export async function listFiles(fileStore) {
  const files = await fileStore.listFiles();
  if (!files.length) {
    console.log('No local files in bridge storage.');
    return;
  }
  console.log('Local files:');
  for (const file of files) console.log(`  ${file.id} · ${file.name} · ${bytes(file.size)} · ${file.createdAt}`);
}

export async function listArtifacts(bridge, fileStore, state) {
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

export function resolveFromList(token, list, label) {
  const value = String(token || '').trim();
  if (!value) throw new Error(`No ${label} provided`);
  const numeric = Number.parseInt(value, 10);
  if (Number.isInteger(numeric) && String(numeric) === value && numeric >= 1 && numeric <= list.length) return list[numeric - 1];
  return list.find((item) => item.id === value || item.fileId === value || item.artifactId === value) || { id: value };
}

export async function downloadArtifact(bridge, fileStore, state, args) {
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

export async function openArtifact(bridge, fileStore, state, args) {
  if (!args.length) {
    console.log('Usage: /open <index|artifactId>');
    return;
  }
  const target = await downloadArtifact(bridge, fileStore, state, [args[0]]);
  if (!target) return;
  const opened = openPathWithSystem(target);
  console.log(`[artifact] opened ${opened}`);
}


export async function printWorkflowStatus(workflowManager, options = {}) {
  if (!workflowManager) {
    console.log('Workflow manager is not available.');
    return;
  }
  const workflows = workflowManager.list();
  const approvals = await workflowManager.approvals();
  if (!workflows.length) {
    console.log('No workflow is loaded. Create bridge.workflow.json and restart, or use /workflow load <path>.');
    return;
  }
  const selected = selectWorkflow(workflows, options.workflowId || '');
  if (!selected) return;
  console.log(formatWorkflowDashboard(selected, {
    currentSessionId: options.currentSessionId || '',
    approvals,
  }));
}

export async function printWorkflowList(workflowManager) {
  if (!workflowManager) {
    console.log('Workflow manager is not available.');
    return;
  }
  console.log(workflowListLines(workflowManager.list()).join('\n'));
}

export async function printWorkflowHistory(workflowManager, workflowId = '', limit = 10) {
  if (!workflowManager) {
    console.log('Workflow manager is not available.');
    return;
  }
  const selected = selectWorkflow(workflowManager.list(), workflowId);
  if (!selected) throw new Error('No workflow is loaded.');
  const history = workflowHistoryFromEvents(await workflowManager.events(selected.id, 500), limit);
  console.log(formatWorkflowHistory(history));
}

export function resolveWorkflowId(workflowManager, token = '') {
  const workflow = selectWorkflow(workflowManager?.list?.() || [], token);
  if (!workflow) throw new Error('No workflows are loaded.');
  return workflow.id;
}

export function printProjectStatus(state) {
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

export async function openProject(projectService, turnManager, state, projectPath, { createThread = false } = {}) {
  if (!projectService) throw new Error('Project service is not available');
  persistCurrentScope(state);
  const project = await projectService.open(projectPath);
  state.projectRoot = project.root;
  state.projectId = project.id;
  state.enabledSkills = project.enabledSkills || state.enabledSkills || [];
  state.projectThreadId = project.currentThreadId || '';
  hydrateCurrentScope(state, { preserveProjectThread: true });
  if (!state.projectThreadId) state.projectThreadId = project.currentThreadId || '';
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

export function printProjectThreads(state) {
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

export async function printSkills(projectService, state) {
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

export async function printAgent(projectService, state) {
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
  if (type === 'turn/resumed') return `[turn] resumed ${data.turnId || ''}`.trim();
  if (type === 'project/scanStarted') return `[project] scanning ${data.cwd || ''}`.trim();
  if (type === 'project/scanCompleted') return `[project] snapshot ${data.snapshotId?.slice?.(0, 12) || ''} · ${data.files ?? 0} files · ${data.ignored ?? 0} ignored`;
  if (type === 'project/packageCreated') return `[project] package ${data.name || ''} · ${bytes(data.size)} · ${data.attached ? 'attached' : 'reused; not re-uploading'}`;
  if (type === 'project/packageReusedFromAssistantArtifact') return `[project] current package matches assistant artifact; future tasks will reference it instead of re-uploading`;
  if (type === 'files.attach.started') return `[file] attaching ${data.count ?? ''} file(s)`.trim();
  if (type === 'files.attach.done') return `[file] attached ${(data.names || []).join(', ') || `${data.count ?? ''} file(s)`}`;
  if (type === 'request.resumed') return `[resume] attached to ${data.requestId || 'active request'}`;
  if (type === 'client.auto_open.requested') return `[open-tab] opening an isolated ChatGPT tab · ${data.reason || 'no safe tab available'}`;
  if (type === 'client.auto_open.completed') return `[open-tab] connected ${data.clientId || 'new tab'} · ${data.openedBy || 'browser'}`;
  if (type === 'client.auto_open.failed') return `[open-tab] failed: ${data.message || 'unknown error'}`;
  if (type === 'client.selection.confirmation_required') return `[select-tab] ${data.message || 'choose an available ChatGPT tab'}`;
  if (type === 'client.target.resolved') return `[select-tab] using ${data.clientId || 'selected tab'}${data.reason ? ` · ${data.reason}` : ''}${data.sessionSwitch ? ' · will switch session' : ''}`;
  if (type === 'session.switch.requested') return `[session] switching ${data.clientId || 'tab'} to ${data.sessionId || 'requested session'}`;
  if (type === 'prompt.resent_after_navigation') return `[session] tab reloaded; prompt resent${data.sessionId ? ` to ${data.sessionId}` : ''}${data.resendCount ? ` · attempt ${data.resendCount}` : ''}`;
  if (type === 'prompt.resend.blocked_busy') return `[error] prompt resend blocked: tab is running ${data.activeRequestId || 'another request'}`;
  if (type === 'prompt.resend.delivery_failed') return `[warn] prompt resend delivery failed: ${data.message || 'unknown error'}`;
  if (type === 'resume.attached') return `[resume] receiving events from active tab`;
  if (type === 'prompt.delivered') return `[chat] prompt delivered to ${data.clientId || 'selected tab'}`;
  if (type === 'prompt.accepted') return data.implicit ? `[chat] prompt accepted implicitly via ${data.via || 'client event'}` : '[chat] prompt accepted';
  if (type === 'prompt.sent') return '[chat] prompt sent';
  if (type === 'generation.started') return '[chat] generation started';
  if (type === 'assistant.progress.snapshot') return visibleProgressLines(data).join('\n');
  if (type === 'watchdog.generation_active_no_visible_change') return `[watchdog] generation active, no visible changes${data.meaningfulIdleMs ? ` · ${Math.round(data.meaningfulIdleMs / 1000)}s` : ''}`;
  if (type === 'watchdog.meaningful_progress_stalled') return `[watchdog] no meaningful progress${data.meaningfulIdleMs ? ` · ${Math.round(data.meaningfulIdleMs / 1000)}s` : ''}; requesting snapshot`;
  if (type === 'watchdog.source_disconnected') return `[watchdog] source tab disconnected${data.phase ? ` · ${data.phase}` : ''}`;
  if (type === 'forced_snapshot.requested') return `[watchdog] requesting source snapshot${data.assistantTurnKey ? ` · ${data.assistantTurnKey}` : ''}`;
  if (type === 'forced_snapshot.received') return `[watchdog] snapshot received${data.answerLength ? ` · answer ${data.answerLength}` : ''}${data.artifactCount ? ` · artifacts ${data.artifactCount}` : ''}`;
  if (type === 'forced_snapshot.failed') return `[watchdog] snapshot failed: ${data.message || 'unknown error'}`;
  if (type === 'request.recoverable_failed') return `[recoverable] ${data.message || 'request needs recovery'}`;
  if (type === 'normal.pipeline.started') return `[result] processing final response${data.expected ? ` · expected ${data.expected}` : ''}`;
  if (type === 'artifact.required_wait_started') return `[artifact] final answer is ready; waiting for required ZIP${data.limitMs ? ` · up to ${Math.round(data.limitMs / 1000)}s` : ''}`;
  if (type === 'artifact.required_wait_expired') return '[artifact] required ZIP did not appear before the settle window expired';
  if (type === 'normal.pipeline.missing_after_done') return `[recoverable] final response arrived, but result processing did not start: ${data.message || 'unknown error'}`;
  if (type === 'normal.pipeline.failed' || type === 'recovery.pipeline.failed') return `[error] result processing failed: ${data.message || 'unknown error'}`;
  if (type === 'item/artifact/created') return `[artifact] ${data.artifact?.name || data.artifact?.id || 'created'}`;
  if (type === 'result/resolving') return `[result] resolving ${data.expected || 'result'}`;
  if (type === 'artifact.downloading') return `[artifact] downloading ${data.name || data.artifactId || 'artifact'}${data.sourceClientId ? ` · source ${data.sourceClientId}` : ''}`;
  if (type === 'artifact.downloaded') return `[artifact] downloaded ${data.name || data.fileId || data.artifactId || 'artifact'}${data.size ? ` · ${bytes(data.size)}` : ''}`;
  if (type === 'result.validating') return `[result] selecting ZIP artifact${data.artifactId ? ` · ${data.artifactId}` : ''}${data.artifactCount != null ? ` · ${data.artifactCount} candidate(s)` : ''}`;
  if (type === 'result.artifact.metadata_fallback_selected') return `[result] ZIP filename missing in DOM; validating scoped file action${data.selected?.name ? ` · ${data.selected.name}` : ''}`;
  if (type === 'result.artifact.metadata_fallback_ambiguous') return `[result] multiple file actions are visible, but none is an unambiguous ZIP`;
  if (type === 'result.validation.started') return `[result] validating ZIP ${data.name || data.fileId || data.artifactId || ''}${data.size ? ` · ${bytes(data.size)}` : ''}`;
  if (type === 'result.validated') return `[result] ZIP validation passed · ${data.entries ?? 0} entries${data.totalUncompressedSize ? ` · ${bytes(data.totalUncompressedSize)} unpacked` : ''}`;
  if (type === 'result.validation_failed') return `[result] ZIP validation failed: ${data.message || data.code || 'unknown error'}`;
  if (type === 'result.ready') return `[result] ready ${data.name || ''} · ${bytes(data.size)}${data.zip?.entries ? ` · ${data.zip.entries} entries` : ''}`;
  if (type === 'result.artifact.retry') return `[result] waiting for artifact link (${data.attempt || 1}/${data.maxAttempts || '?'})`;
  if (type === 'result.artifact.retry_found') return `[result] artifact appeared: ${data.name || data.artifactId || 'zip'}`;
  if (type === 'result/missing_required_artifact') return `[result] expected ${data.expected || 'zip'} artifact, but current response did not expose one`;
  if (type === 'turn/completed_without_artifact') return '[turn] completed without required artifact';
  if (type === 'turn/completed') return '[turn] completed';
  if (type === 'turn/failed') return `[error] ${data.error?.message || 'turn failed'}`;
  if (type === 'turn/interrupted') return '[turn] interrupted';
  if (state.eventLevel === 'verbose' && !type.includes('/delta')) return `[event] ${type}`;
  return '';
}


async function runWithStreamedConsole(fn, context = {}, consoleStream = null) {
  if (!context.captureConsoleForStream || !consoleStream) return await fn();
  let result;
  await captureConsoleLines(async () => {
    result = await fn();
  }, (line) => consoleStream.status(line));
  return result;
}

export async function waitForTurn(turnManager, turnId, state, consoleStream) {
  let lastThinking = '';
  let lastAnswer = '';
  let progressSnapshotState = { records: {} };
  const doneStatuses = new Set(['completed', 'completed_without_artifact', 'failed', 'interrupted', 'cancelled']);
  const terminalEvents = new Set(['turn/completed', 'turn/completed_without_artifact', 'turn/failed', 'turn/interrupted', 'turn/cancelled']);
  const seenEvents = new Set();
  const eventKey = (event = {}) => String(event.id || `${event.type || ''}|${event.time || event.createdAt || ''}|${event.sequence ?? ''}`);
  const printProgressSnapshot = (data = {}) => {
    const reconciled = reconcileVisibleProgressSnapshot(data, progressSnapshotState);
    progressSnapshotState = reconciled.state;
    consoleStream.onProgressUpdate(reconciled.liveText);
    for (const line of reconciled.completedLines) consoleStream.status(line);
  };
  const printEvent = (event) => {
    const key = eventKey(event);
    if (key && seenEvents.has(key)) return;
    if (key) seenEvents.add(key);
    if (event.type === 'item/reasoning/delta') {
      const text = event.data?.text || '';
      if (text !== lastThinking) {
        lastThinking = text;
        consoleStream.onThinkingUpdate(text);
      }
      return;
    }
    if (event.type === 'item/agentMessage/delta') {
      const text = event.data?.text || '';
      if (text !== lastAnswer) {
        lastAnswer = text;
        consoleStream.onAnswerUpdate(text);
      }
      return;
    }
    if (event.type === 'assistant.progress.snapshot') {
      printProgressSnapshot(event.data || {});
      return;
    }
    const line = renderTurnEvent(event, state);
    if (line) consoleStream.status(line);
  };

  return await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => turnManager.off(`turn:${turnId}`, handler);
    const settleFromStore = async () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(await turnManager.getTurn(turnId));
      } catch (err) {
        reject(err);
      }
    };
    const handler = (event) => {
      printEvent(event);
      if (terminalEvents.has(event.type)) void settleFromStore();
    };

    // Subscribe before reading history/status. A terminal event can otherwise
    // arrive between getTurn() and on(), leaving the interactive client waiting
    // forever even though the turn already completed.
    turnManager.on(`turn:${turnId}`, handler);
    void (async () => {
      try {
        const recent = await turnManager.getTurnEvents(turnId, { limit: 1000 });
        for (const event of recent) printEvent(event);
        const current = await turnManager.getTurn(turnId);
        if (current && doneStatuses.has(current.status)) {
          if (!settled) {
            settled = true;
            cleanup();
            resolve(current);
          }
        }
      } catch (err) {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      }
    })();
  });
}

export async function runProjectTask(message, context) {
  const { state, projectService, turnManager, fileStore, confirm } = context;
  if (!projectService || !turnManager) throw new Error('Project turns are not available');
  const threadId = await ensureProjectThread(projectService, turnManager, state);
  const spinner = context.createConsoleStream ? null : createSpinner('Running project task', process.stdout);
  const consoleStream = context.createConsoleStream ? context.createConsoleStream('Running project task') : createConsoleStream(spinner, process.stdout);
  spinner?.start();
  const writeStatus = (line = '') => consoleStream.status(line);
  const { turn } = await turnManager.startTurn({
    threadId,
    cwd: state.projectRoot,
    message,
    model: state.model,
    effort: state.effort,
    sessionId: state.sessionId,
    project: {
      mode: 'package',
      useGitignore: true,
      useAgentFile: true,
      skills: state.enabledSkills,
      snapshotPolicy: 'reuse-if-unchanged',
    },
    output: { expected: 'zip', required: true },
  }, {
    confirmClientSelection: typeof confirm === 'function' ? ({ message: question }) => confirm(question) : null,
  });
  markSelectedResultStale(state, 'superseded_by_new_task', turn.id);
  state.lastTurnId = turn.id;
  state.currentTurnId = turn.id;
  state.lastTurn = null;
  state.lastArtifacts = [];
  const finalTurn = await waitForTurn(turnManager, turn.id, state, consoleStream);
  state.lastTurn = finalTurn;
  if (finalTurn?.status === 'completed' || finalTurn?.status === 'completed_without_artifact') {
    const answerText = await answerTextFromTurnItems(turnManager, finalTurn);
    rememberResponse(state, {
      id: finalTurn.id,
      turnId: finalTurn.id,
      source: 'task',
      title: `Project task ${finalTurn.id}`,
      text: answerText,
      artifactCount: Array.isArray(finalTurn.output?.artifacts) ? finalTurn.output.artifacts.length : 0,
      createdAt: finalTurn.completedAt || finalTurn.updatedAt || finalTurn.createdAt,
    });
    consoleStream.finish(answerText);
    if (finalTurn.input?.output?.required && finalTurn.output?.type !== 'zip') {
      clearSelectedResult(state, 'completed_without_zip');
      writeStatus('[result] expected a ZIP artifact, but the completed turn did not produce one.');
    } else if (finalTurn.output?.type === 'zip') {
      const selectedResult = selectResultForApply(state, finalTurn, { source: 'task' });
      writeStatus(`[result] ZIP artifact ready: ${finalTurn.output.name || finalTurn.output.fileId || 'result.zip'}${finalTurn.output.size ? ` · ${bytes(finalTurn.output.size)}` : ''}`);
      writeStatus(`[result] selected for /apply: turn ${selectedResult.turnId}${selectedResult.fileId ? ` · file ${selectedResult.fileId}` : ''}`);
      if (finalTurn.output.fileId) {
        if (fileStore && state.lastAppliedTurnId !== finalTurn.id) {
          writeStatus('[task] planning apply decision for downloaded ZIP.');
          try {
            await runWithStreamedConsole(() => applyLastTurnResult(fileStore, state, { auto: true, confirm, projectService, turnManager }), context, consoleStream);
          } catch (err) {
            writeStatus(`[apply] automatic apply failed: ${err.message || String(err)}. Result remains selected for /apply.`);
          }
        } else {
          writeStatus('[result] use /apply --force to apply it without prompts, or /apply --interactive to select changes.');
        }
      }
    }
  } else {
    const answerText = await answerTextFromTurnItems(turnManager, finalTurn);
    if (answerText) {
      rememberResponse(state, {
        id: finalTurn?.id || turn.id,
        turnId: finalTurn?.id || turn.id,
        source: 'task-failed',
        title: `Project task ${finalTurn?.id || turn.id} · result processing failed`,
        text: answerText,
        artifactCount: Array.isArray(finalTurn?.output?.artifacts) ? finalTurn.output.artifacts.length : 0,
        createdAt: finalTurn?.completedAt || finalTurn?.updatedAt || finalTurn?.createdAt,
      });
      consoleStream.finish(answerText);
      writeStatus('[recoverable] ChatGPT final answer was preserved, but result processing failed. The answer is shown above; use diagnostics or /recover if an artifact is visible in the browser.');
    } else {
      consoleStream.fail();
    }
    throw new Error(finalTurn?.error?.message || `Turn ended with status: ${finalTurn?.status}`);
  }
}

export async function runDirectPrompt(message, context) {
  const { bridge, projectService, state } = context;
  const prompt = state.projectRoot && projectService
    ? await projectService.buildAskMessage(state.projectRoot, message, { skills: state.enabledSkills })
    : message;
  const spinner = context.createConsoleStream ? null : createSpinner('Waiting for ChatGPT answer', process.stdout);
  const consoleStream = context.createConsoleStream ? context.createConsoleStream('Waiting for ChatGPT answer') : createConsoleStream(spinner, process.stdout);
  spinner?.start();
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
    onProgressUpdate: (text) => consoleStream.onProgressUpdate(text),
    onAnswerUpdate: (text) => consoleStream.onAnswerUpdate(text),
    onArtifactUpdate: (artifacts) => {
      state.lastArtifacts = artifacts;
      consoleStream.onArtifactUpdate(artifacts);
    },
  }, { fullResponse: true, confirmClientSelection: typeof context.confirm === 'function' ? ({ message: question }) => context.confirm(question) : null });
  if (response.session?.id) state.sessionId = response.session.id;
  const answerText = String(response.answer || response.response || '');
  rememberResponse(state, {
    id: response.requestId || response.id || '',
    source: 'chat',
    title: 'Assistant answer',
    text: answerText,
    artifactCount: Array.isArray(response.artifacts) ? response.artifacts.length : 0,
  });
  consoleStream.finish(answerText);
}

export async function runResume(context) {
  const { bridge, state, turnManager, fileStore, projectService, confirm } = context;
  let resumeTarget = null;
  try {
    resumeTarget = typeof bridge.findActiveRequest === 'function'
      ? bridge.findActiveRequest({ preferredRequestId: state.lastTurnId || '' })
      : null;
  } catch (err) {
    console.log(`[resume] ${err.message || String(err)}`);
    return null;
  }
  if (!resumeTarget && typeof bridge.activeRequestCandidates === 'function') {
    const candidates = bridge.activeRequestCandidates();
    if (candidates.length > 1) {
      console.log('[resume] multiple ChatGPT prompts are running; select the source tab first:');
      for (const candidate of candidates) console.log(`  - ${candidate.clientId}: ${candidate.activeRequest?.requestId || ''}`);
      return null;
    }
  }
  const health = bridge.health();
  const localTracked = Array.isArray(health.activeRequests)
    ? health.activeRequests.find((item) => item?.requestId === state.lastTurnId)
      || (health.activeRequests.length === 1 ? health.activeRequests[0] : null)
    : null;
  const activeRequest = resumeTarget?.activeRequest || health.activeClient?.activeRequest || localTracked || null;
  if (!activeRequest?.requestId) {
    console.log('[resume] no active or locally tracked ChatGPT prompt is available');
    return null;
  }
  const resumeClientId = resumeTarget?.clientId || activeRequest.clientId || '';
  if (resumeClientId) console.log(`[resume] source tab: ${resumeClientId}`);
  console.log(`[resume] attaching to active request ${activeRequest.requestId}`);
  if (activeRequest.promptPreview) console.log(`[resume] user prompt: ${activeRequest.promptPreview}`);

  if (turnManager) {
    try {
      const spinner = context.createConsoleStream ? null : createSpinner('Resuming project task', process.stdout);
      const consoleStream = context.createConsoleStream ? context.createConsoleStream('Resuming project task') : createConsoleStream(spinner, process.stdout);
      spinner?.start();
      const alreadyTracked = typeof turnManager.isTurnTracked === 'function'
        && turnManager.isTurnTracked(activeRequest.requestId);
      if (alreadyTracked) {
        consoleStream.status(`[resume] request ${activeRequest.requestId} is already tracked locally; following the existing turn`);
      }
      const turn = alreadyTracked
        ? await waitForTurn(turnManager, activeRequest.requestId, state, consoleStream)
        : await turnManager.resumeActiveTurn(state.lastTurnId || '', { timeoutMs: 10_000 });
      state.lastTurnId = turn.id;
      state.lastTurn = turn;
      if (turn.status === 'completed' || turn.status === 'completed_without_artifact') {
        const answerText = await answerTextFromTurnItems(turnManager, turn);
        rememberResponse(state, {
          id: turn.id,
          turnId: turn.id,
          source: 'resume',
          title: `Resumed response ${turn.id}`,
          text: answerText,
          artifactCount: Array.isArray(turn.output?.artifacts) ? turn.output.artifacts.length : 0,
          createdAt: turn.completedAt || turn.updatedAt || turn.createdAt,
        });
        consoleStream.finish(answerText);
        if (turn.input?.output?.required && turn.output?.type !== 'zip') {
          clearSelectedResult(state, 'resume_without_zip');
          console.log('[resume] expected a ZIP artifact, but the completed turn did not produce one. Use /recover list if the browser shows a downloadable artifact.');
        } else if (turn.output?.type === 'zip') {
          selectResultForApply(state, turn, { source: 'resume' });
          console.log(`[resume] ZIP artifact selected for /apply: ${turn.output.name || turn.output.fileId || 'result.zip'}`);
          if (turn.output.fileId) console.log('[resume] applying resumed ZIP result...');
          if (turn.output.fileId && state.lastAppliedTurnId !== turn.id) await applyLastTurnResult(fileStore, state, { auto: true, confirm, projectService, turnManager });
        }
        return turn;
      }
      consoleStream.fail();
      throw new Error(turn?.error?.message || `Turn ended with status: ${turn?.status}`);
    } catch (err) {
      if (err.code !== 'NO_MATCHING_TURN') throw err;
      console.log(`[resume] active prompt is not a known project turn: ${activeRequest.requestId}; resuming as plain chat`);
    }
  }

  const spinner = context.createConsoleStream ? null : createSpinner('Resuming ChatGPT answer', process.stdout);
  const consoleStream = context.createConsoleStream ? context.createConsoleStream('Resuming ChatGPT answer') : createConsoleStream(spinner, process.stdout);
  spinner?.start();
  const response = await bridge.resumeActiveRequest({
    onEvent: (event) => {
      const line = renderEvent(event, state.eventLevel);
      if (line) consoleStream.status(line);
    },
    onThinkingUpdate: (text) => consoleStream.onThinkingUpdate(text),
    onProgressUpdate: (text) => consoleStream.onProgressUpdate(text),
    onAnswerUpdate: (text) => consoleStream.onAnswerUpdate(text),
    onArtifactUpdate: (artifacts) => {
      state.lastArtifacts = artifacts;
      consoleStream.onArtifactUpdate(artifacts);
    },
  }, { fullResponse: true, expectedRequestId: activeRequest.requestId, sourceClientId: resumeClientId, timeoutMs: 10_000 });
  if (response.session?.id) switchSessionScope(state, response.session.id);
  const answerText = String(response.answer || response.response || '');
  rememberResponse(state, {
    id: response.requestId || response.id || '',
    source: 'resume',
    title: 'Resumed assistant answer',
    text: answerText,
    artifactCount: Array.isArray(response.artifacts) ? response.artifacts.length : 0,
  });
  if (Array.isArray(response.artifacts) && response.artifacts.length) state.lastArtifacts = response.artifacts;
  consoleStream.finish(answerText);
  return response;
}

export async function recoverLatestResponse(context, { force = false, apply = false, index = 1, list = false } = {}) {
  const { bridge, turnManager, fileStore, state, projectService, confirm } = context;

  if (list) {
    console.log('[recover] requesting recent assistant responses from the active ChatGPT tab...');
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
    console.log(`[recover] requesting assistant response #${selectedIndex} from the active ChatGPT tab...`);
    const expectedOutput = state.projectRoot ? { expected: 'zip', required: true } : { expected: 'text', required: false };
    const turn = await turnManager.recoverTurnFromLatestResponse(state.lastTurnId || '', {
      force,
      index: selectedIndex,
      timeoutMs: 30_000,
      allowAdoptedTurn: true,
      threadId: state.projectThreadId || '',
      cwd: state.projectRoot || '',
      sessionId: state.sessionId || '',
      expectedOutput,
    });
    state.lastTurnId = turn.id;
    state.lastTurn = turn;
    if (turn.threadId) state.projectThreadId = turn.threadId;
    console.log(`[recover] recovered ${turn.id} from assistant response #${selectedIndex} · ${turn.status}`);
    if (turn.output) {
      console.log(`[recover] result: ${turn.output.type || 'unknown'} · ${turn.output.name || ''} · ${bytes(turn.output.size)}`);
      if (turn.output.fileId) console.log(`[recover] file: ${turn.output.fileId}`);
      if (turn.output.reconstructedFrom) console.log(`[recover] reconstructed from: ${turn.output.reconstructedFrom}`);
      if (turn.output.type === 'zip' && turn.output.fileId) selectResultForApply(state, turn, { source: 'recover' });
      else if (apply) clearSelectedResult(state, 'recover_without_zip');
    }
    const recoveredText = await answerTextFromTurnItems(turnManager, turn);
    rememberResponse(state, {
      id: turn.id,
      turnId: turn.id,
      source: 'recover',
      title: `Recovered response ${turn.id}`,
      text: recoveredText,
      artifactCount: Array.isArray(turn.output?.artifacts) ? turn.output.artifacts.length : 0,
      createdAt: turn.completedAt || turn.updatedAt || turn.createdAt,
    });
    if (apply && turn.output?.type === 'zip') {
      console.log('[recover] applying recovered ZIP result...');
      await applyLastTurnResult(fileStore, state, { force, confirm, projectService, turnManager });
    } else if (apply) {
      console.log('[recover] recovered response is not a ZIP result; nothing to apply');
    }
    return turn;
  }

  console.log(`[recover] requesting assistant response #${selectedIndex} from the active ChatGPT tab...`);
  const response = await bridge.recoverLatestResponse({ index: selectedIndex, timeoutMs: 30_000 });
  state.lastArtifacts = response.artifacts || [];
  console.log(`[recover] assistant response #${selectedIndex} · ${response.answer.length} chars · ${state.lastArtifacts.length} artifact(s)`);
  rememberResponse(state, {
    id: `recovered-${selectedIndex}-${Date.now()}`,
    source: 'recover',
    title: `Recovered assistant response #${selectedIndex}`,
    text: response.answer || response.response || '',
    artifactCount: state.lastArtifacts.length,
    createdAt: response.recoveredAt,
  });
  if (response.answer) console.log(response.answer.slice(0, 2000));
  if (state.lastArtifacts.length) {
    for (const [artifactIndex, artifact] of state.lastArtifacts.entries()) console.log(`  [${artifactIndex + 1}] ${artifact.name || artifact.id || 'artifact'} · ${artifact.id || ''}`);
  }
  return response;
}

export async function downloadLastTurnResult(fileStore, state, targetArg = '') {
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
