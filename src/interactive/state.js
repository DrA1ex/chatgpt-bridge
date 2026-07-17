import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { DEFAULT_INTERACTIVE_THEME_NAME, isInteractiveThemeName } from './terlioThemes.js';

export const EFFORTS = new Set(['auto', 'instant', 'low', 'medium', 'high', 'xhigh']);
export const EVENT_LEVELS = new Set(['quiet', 'normal', 'verbose']);
export const INTERACTIVE_STATE_FILE = path.join(config.dataDir, 'interactive-state.json');

export function normalizeSelectedResult(value = null) {
  if (!value || typeof value !== 'object') return null;
  const result = {
    turnId: String(value.turnId || ''),
    projectId: String(value.projectId || ''),
    projectRoot: String(value.projectRoot || ''),
    sessionId: String(value.sessionId || ''),
    sourceClientId: String(value.sourceClientId || ''),
    sourceTurnKey: String(value.sourceTurnKey || ''),
    sourceRequestId: String(value.sourceRequestId || ''),
    artifactId: String(value.artifactId || ''),
    fileId: String(value.fileId || ''),
    downloadId: String(value.downloadId || ''),
    name: String(value.name || ''),
    mime: String(value.mime || ''),
    size: Number(value.size) || 0,
    sha256: String(value.sha256 || ''),
    outputType: String(value.outputType || value.type || ''),
    outputStatus: String(value.outputStatus || value.status || ''),
    confidence: String(value.confidence || 'high'),
    source: String(value.source || 'result'),
    selectedAt: String(value.selectedAt || value.createdAt || ''),
    stale: Boolean(value.stale),
    staleReason: String(value.staleReason || ''),
    replacedByTurnId: String(value.replacedByTurnId || ''),
  };
  return result.turnId || result.fileId || result.artifactId ? result : null;
}

export function selectedResultFromTurn(state = {}, turn = {}, { source = 'result', confidence = '' } = {}) {
  const output = turn?.output || {};
  if (output.type !== 'zip' || !output.fileId) return null;
  const sourceClientId = String(output.sourceClientId || '');
  return normalizeSelectedResult({
    turnId: turn.id || '',
    projectId: state.projectId || turn.input?.project?.id || '',
    projectRoot: state.projectRoot || turn.input?.cwd || '',
    sessionId: state.sessionId || turn.input?.sessionId || '',
    sourceClientId,
    sourceTurnKey: output.sourceTurnKey || '',
    sourceRequestId: output.sourceRequestId || output.requestId || turn.id || '',
    artifactId: output.artifactId || '',
    fileId: output.fileId || '',
    downloadId: output.downloadId || '',
    name: output.name || '',
    mime: output.mime || 'application/zip',
    size: output.size || 0,
    sha256: output.sha256 || '',
    outputType: output.type || '',
    outputStatus: output.status || '',
    confidence: confidence || (sourceClientId ? 'high' : 'manual'),
    source,
    selectedAt: new Date().toISOString(),
  });
}

export function selectResultForApply(state = {}, turn = {}, options = {}) {
  const selected = selectedResultFromTurn(state, turn, options);
  state.selectedResult = selected;
  return selected;
}

export function clearSelectedResult(state = {}, reason = 'cleared') {
  const previous = normalizeSelectedResult(state.selectedResult);
  state.selectedResult = null;
  return previous ? { ...previous, stale: true, staleReason: reason, replacedByTurnId: String(state.currentTurnId || '') } : null;
}

export function markSelectedResultStale(state = {}, reason = 'stale', replacementTurnId = '') {
  const previous = normalizeSelectedResult(state.selectedResult) || selectedResultFromTurn(state, state.lastTurn || {}, { source: 'previous-turn' });
  state.selectedResult = previous
    ? { ...previous, stale: true, staleReason: reason, replacedByTurnId: String(replacementTurnId || state.currentTurnId || '') }
    : null;
  return state.selectedResult;
}

export function sameProjectRoot(a = '', b = '') {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right) return true;
  return path.resolve(left) === path.resolve(right);
}


function scopeProjectKey(state = {}) {
  return state.projectRoot ? `project:${path.resolve(state.projectRoot)}` : 'global';
}

function scopeSessionKey(state = {}) {
  return state.sessionId ? `session:${state.sessionId}` : 'session:current-tab';
}

function makeScopedFields(source = {}) {
  return {
    sessionId: String(source.sessionId || ''),
    projectThreadId: String(source.projectThreadId || ''),
    lastTurnId: String(source.lastTurnId || ''),
    currentTurnId: String(source.currentTurnId || ''),
    lastAppliedTurnId: String(source.lastAppliedTurnId || ''),
    lastAppliedFileId: String(source.lastAppliedFileId || ''),
    lastApplySummary: source.lastApplySummary || null,
    selectedResult: normalizeSelectedResult(source.selectedResult),
    lastArtifacts: Array.isArray(source.lastArtifacts) ? source.lastArtifacts : [],
    lastSessions: Array.isArray(source.lastSessions) ? source.lastSessions : [],
    lastProjectScan: source.lastProjectScan || null,
    lastProjectPack: source.lastProjectPack || null,
    responseHistory: Array.isArray(source.responseHistory) ? source.responseHistory.slice(0, 30) : [],
  };
}

function ensureProjectScope(state = {}, projectKey = scopeProjectKey(state)) {
  if (!state.scopes || typeof state.scopes !== 'object') state.scopes = {};
  if (!state.scopes[projectKey] || typeof state.scopes[projectKey] !== 'object') {
    state.scopes[projectKey] = { activeSessionId: '', sessions: {} };
  }
  if (!state.scopes[projectKey].sessions || typeof state.scopes[projectKey].sessions !== 'object') state.scopes[projectKey].sessions = {};
  return state.scopes[projectKey];
}

export function persistCurrentScope(state = {}) {
  const projectKey = scopeProjectKey(state);
  const projectScope = ensureProjectScope(state, projectKey);
  projectScope.activeSessionId = String(state.sessionId || '');
  projectScope.projectRoot = state.projectRoot || '';
  projectScope.projectId = state.projectId || '';
  projectScope.enabledSkills = Array.isArray(state.enabledSkills) ? state.enabledSkills : [];
  const sessionKey = scopeSessionKey(state);
  projectScope.sessions[sessionKey] = makeScopedFields(state);
  return projectScope.sessions[sessionKey];
}

export function hydrateCurrentScope(state = {}, { preserveProjectThread = true } = {}) {
  const projectScope = ensureProjectScope(state);
  if (!state.sessionId && projectScope.activeSessionId) state.sessionId = projectScope.activeSessionId;
  const fields = projectScope.sessions?.[scopeSessionKey(state)] || {};
  state.lastTurnId = String(fields.lastTurnId || '');
  state.currentTurnId = String(fields.currentTurnId || '');
  state.lastTurn = null;
  state.lastAppliedTurnId = String(fields.lastAppliedTurnId || '');
  state.lastAppliedFileId = String(fields.lastAppliedFileId || '');
  state.lastApplySummary = fields.lastApplySummary || null;
  state.selectedResult = normalizeSelectedResult(fields.selectedResult);
  state.lastAppliedResult = null;
  state.lastArtifacts = Array.isArray(fields.lastArtifacts) ? fields.lastArtifacts : [];
  state.lastSessions = Array.isArray(fields.lastSessions) ? fields.lastSessions : [];
  state.lastProjectScan = fields.lastProjectScan || null;
  state.lastProjectPack = fields.lastProjectPack || null;
  state.responseHistory = Array.isArray(fields.responseHistory) ? fields.responseHistory.slice(0, 30) : [];
  if (!preserveProjectThread || fields.projectThreadId) state.projectThreadId = String(fields.projectThreadId || '');
  return fields;
}

export function switchSessionScope(state = {}, sessionId = '') {
  persistCurrentScope(state);
  state.sessionId = String(sessionId || '');
  hydrateCurrentScope(state, { preserveProjectThread: true });
}

export function rememberResponse(state, entry = {}) {
  if (!state) return null;
  const text = String(entry.text || entry.answer || '').trim();
  if (!text) return null;
  if (!Array.isArray(state.responseHistory)) state.responseHistory = [];
  const createdAt = entry.createdAt || new Date().toISOString();
  const record = {
    id: String(entry.id || entry.turnId || `response_${Date.now()}`),
    turnId: String(entry.turnId || ''),
    source: String(entry.source || 'response'),
    title: String(entry.title || 'Assistant response'),
    text,
    chars: text.length,
    artifactCount: Number(entry.artifactCount) || 0,
    createdAt,
    projectRoot: String(entry.projectRoot || state.projectRoot || ''),
    sessionId: String(entry.sessionId || state.sessionId || ''),
  };
  const duplicateKey = record.turnId ? `turn:${record.turnId}` : `id:${record.id}`;
  state.responseHistory = [record, ...state.responseHistory.filter((item) => {
    const key = item.turnId ? `turn:${item.turnId}` : `id:${item.id}`;
    return key !== duplicateKey;
  })].slice(0, 30);
  return record;
}

export function answerTextFromTurn(turn = {}) {
  const output = turn?.output || {};
  return String(
    output.answer ||
    output.text ||
    output.response?.answer ||
    output.response?.response ||
    output.response?.text ||
    ''
  ).trim();
}

export async function answerTextFromTurnItems(turnManager, turn = {}) {
  const direct = answerTextFromTurn(turn);
  if (direct || !turnManager || !turn?.id) return direct;
  const items = await turnManager.getItems({ turnId: turn.id }).catch(() => []);
  const messages = items
    .filter((item) => item.type === 'agent_message' && item.content?.text)
    .map((item) => String(item.content.text || '').trim())
    .filter(Boolean);
  return messages[messages.length - 1] || '';
}

export function autoApplyDecision(plan = {}) {
  const warnings = plan.safety?.warnings || [];
  if (warnings.length || plan.safety?.safe === false || plan.requiresConfirmation) {
    return { ok: false, reason: warnings[0]?.code || 'requires confirmation' };
  }
  if (plan.hasLocalChangesAfterSnapshot || plan.plan?.filesLocallyChanged || plan.plan?.filesLocallyChangedDelete) {
    return { ok: false, reason: 'local changes after snapshot' };
  }
  if (plan.plan?.filesSkipped) return { ok: false, reason: 'unsafe/internal files were skipped' };
  return { ok: true, reason: 'safe plan' };
}


export function makeDefaultState() {
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
    themeName: DEFAULT_INTERACTIVE_THEME_NAME,
    projectRoot: '',
    projectId: '',
    projectThreadId: '',
    projectThreads: [],
    enabledSkills: [],
    lastProjectScan: null,
    lastProjectPack: null,
    lastTurnId: '',
    currentTurnId: '',
    lastTurn: null,
    selectedResult: null,
    lastAppliedTurnId: '',
    lastAppliedFileId: '',
    lastApplySummary: null,
    lastAppliedResult: null,
    responseHistory: [],
    inputHistories: {},
    focusedWorkflowId: '',
    scopes: {},
  };
}

export async function loadInteractiveState(fileStore) {
  const state = makeDefaultState();
  try {
    const raw = await fs.readFile(INTERACTIVE_STATE_FILE, 'utf8');
    const saved = JSON.parse(raw);
    if (saved.scopes && typeof saved.scopes === 'object') state.scopes = saved.scopes;
    if (saved.inputHistories && typeof saved.inputHistories === 'object') state.inputHistories = saved.inputHistories;
    if (typeof saved.model === 'string') state.model = saved.model;
    if (typeof saved.effort === 'string' && (!saved.effort || EFFORTS.has(saved.effort))) state.effort = saved.effort;
    if (typeof saved.sessionId === 'string') state.sessionId = saved.sessionId;
    if (typeof saved.eventLevel === 'string' && EVENT_LEVELS.has(saved.eventLevel)) state.eventLevel = saved.eventLevel;
    if (typeof saved.themeName === 'string' && isInteractiveThemeName(saved.themeName)) state.themeName = saved.themeName;
    if (typeof saved.projectRoot === 'string') state.projectRoot = saved.projectRoot;
    if (typeof saved.projectId === 'string') state.projectId = saved.projectId;
    if (typeof saved.projectThreadId === 'string') state.projectThreadId = saved.projectThreadId;
    if (typeof saved.focusedWorkflowId === 'string') state.focusedWorkflowId = saved.focusedWorkflowId;
    if (Array.isArray(saved.enabledSkills)) state.enabledSkills = saved.enabledSkills.map(String).filter(Boolean);
    if (typeof saved.lastTurnId === 'string') state.lastTurnId = saved.lastTurnId;
    if (typeof saved.currentTurnId === 'string') state.currentTurnId = saved.currentTurnId;
    if (saved.selectedResult && typeof saved.selectedResult === 'object') state.selectedResult = normalizeSelectedResult(saved.selectedResult);
    if (typeof saved.lastAppliedTurnId === 'string') state.lastAppliedTurnId = saved.lastAppliedTurnId;
    if (typeof saved.lastAppliedFileId === 'string') state.lastAppliedFileId = saved.lastAppliedFileId;
    if (saved.lastApplySummary && typeof saved.lastApplySummary === 'object') state.lastApplySummary = saved.lastApplySummary;
    if (Array.isArray(saved.responseHistory)) state.responseHistory = saved.responseHistory
      .filter((item) => item && typeof item.text === 'string')
      .map((item) => ({
        id: String(item.id || item.turnId || item.createdAt || ''),
        turnId: String(item.turnId || ''),
        source: String(item.source || 'response'),
        title: String(item.title || item.source || 'Assistant response'),
        text: String(item.text || ''),
        chars: Number(item.chars) || String(item.text || '').length,
        artifactCount: Number(item.artifactCount) || 0,
        createdAt: String(item.createdAt || ''),
        projectRoot: String(item.projectRoot || ''),
        sessionId: String(item.sessionId || ''),
      }))
      .filter((item) => item.text.trim())
      .slice(0, 30);

    if (saved.scopes && typeof saved.scopes === 'object') {
      hydrateCurrentScope(state, { preserveProjectThread: true });
    } else {
      persistCurrentScope(state);
    }

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
  persistCurrentScope(state);
  await fs.mkdir(config.dataDir, { recursive: true });
  const payload = {
    version: 2,
    updatedAt: new Date().toISOString(),
    model: state.model || '',
    effort: state.effort || '',
    sessionId: state.sessionId || '',
    eventLevel: state.eventLevel || 'normal',
    themeName: isInteractiveThemeName(state.themeName) ? state.themeName : DEFAULT_INTERACTIVE_THEME_NAME,
    pendingAttachmentIds: state.pendingAttachments.map((file) => file.id).filter(Boolean),
    projectRoot: state.projectRoot || '',
    projectId: state.projectId || '',
    projectThreadId: state.projectThreadId || '',
    enabledSkills: state.enabledSkills || [],
    lastTurnId: state.lastTurnId || '',
    currentTurnId: state.currentTurnId || '',
    selectedResult: normalizeSelectedResult(state.selectedResult),
    lastAppliedTurnId: state.lastAppliedTurnId || '',
    lastAppliedFileId: state.lastAppliedFileId || '',
    lastApplySummary: state.lastApplySummary || null,
    responseHistory: Array.isArray(state.responseHistory) ? state.responseHistory.slice(0, 30) : [],
    inputHistories: state.inputHistories && typeof state.inputHistories === 'object' ? state.inputHistories : {},
    focusedWorkflowId: state.focusedWorkflowId || '',
    scopes: state.scopes || {},
  };
  await fs.writeFile(INTERACTIVE_STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
}
