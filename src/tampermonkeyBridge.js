import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AsyncMutex } from './mutex.js';
import { config } from './config.js';
import { makeRequestId, appendOnlyDelta } from './protocol.js';
import { log } from './logger.js';
import { selectRequiredZipCompletionCandidate } from './results/artifacts.js';
import {
  browserLaunchMetadataFromUrl,
  browserLaunchUrl,
  safeChatGptUrl,
  safeBridgeServerUrl,
} from './browserLaunch.js';

export { browserLaunchUrl } from './browserLaunch.js';

export function openExternalBrowserUrl(value) {
  const url = safeChatGptUrl(value);
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['explorer.exe', [url]]
      : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to open the system browser with ${command}: ${err.message || String(err)}`));
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({ command, url });
    });
  });
}

function normalizeConversationId(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, 'https://chatgpt.com');
    const id = parsed.pathname.match(/\/c\/([^/?#]+)/)?.[1] || '';
    if (id) return id;
  } catch {}
  return raw.replace(/^\/+c\//, '').replace(/[/?#].*$/, '');
}

function sessionIdFromClient(client = {}) {
  const fromSession = normalizeConversationId(client.session?.id || client.session?.url || '');
  if (fromSession) return fromSession;
  return normalizeConversationId(client.url || '');
}

function clientMatchesSession(client = {}, sessionId = '') {
  const desired = normalizeConversationId(sessionId);
  if (!desired) return false;
  return sessionIdFromClient(client) === desired;
}

function busyClientLabel(client = {}, localServerInstanceId = '') {
  const requestId = client.activeRequest?.requestId || 'local-pending';
  const owner = String(client.activeRequest?.ownerServerInstanceId || '');
  const ownerSuffix = owner && owner !== String(localServerInstanceId || '') ? `@server:${owner}` : '';
  return `${client.id || 'unknown-tab'}:${requestId}${ownerSuffix}`;
}

function clientDisplayLabel(client = {}) {
  const title = String(client.title || client.session?.title || '').replace(/\s+/g, ' ').trim();
  const url = String(client.url || client.session?.url || '').trim();
  const bits = [client.id || 'unknown-tab'];
  if (title) bits.push(title.length > 72 ? `${title.slice(0, 72)}…` : title);
  const sessionId = sessionIdFromClient(client);
  if (sessionId) bits.push(`session ${sessionId}`);
  else if (url) bits.push(url.length > 72 ? `${url.slice(0, 72)}…` : url);
  if (client.focused) bits.push('focused');
  if (client.visibilityState) bits.push(client.visibilityState);
  return bits.filter(Boolean).join(' · ');
}

function makeClientSelectionError(message, candidates = []) {
  const err = new Error(message);
  err.code = 'CLIENT_SELECTION_REQUIRED';
  err.candidates = candidates;
  return err;
}

function normalizeLaunchedClient(client = {}, expectedLaunchToken = '') {
  const metadata = browserLaunchMetadataFromUrl(client.url);
  const launchToken = String(client.launchToken || metadata.launchToken || '');
  if (!launchToken || (expectedLaunchToken && launchToken !== expectedLaunchToken)) return client;
  return {
    ...client,
    launchToken,
    requestedUrl: String(client.requestedUrl || metadata.requestedUrl || ''),
  };
}

function noopCallbacks(callbacks = {}) {
  return {
    onThinkingUpdate: typeof callbacks.onThinkingUpdate === 'function' ? callbacks.onThinkingUpdate : null,
    onAnswerUpdate: typeof callbacks.onAnswerUpdate === 'function' ? callbacks.onAnswerUpdate : null,
    onArtifactUpdate: typeof callbacks.onArtifactUpdate === 'function' ? callbacks.onArtifactUpdate : null,
    onProgressUpdate: typeof callbacks.onProgressUpdate === 'function' ? callbacks.onProgressUpdate : null,
    onEvent: typeof callbacks.onEvent === 'function' ? callbacks.onEvent : null,
    onStatus: typeof callbacks.onStatus === 'function' ? callbacks.onStatus : null,
  };
}

function progressRecordId(item = {}, index = 0) {
  return String(item?.id || item?.key || `${item?.kind || 'progress'}:${item?.structuralHint || index}`);
}

function mergeProgressRecords(...collections) {
  const ordered = [];
  const records = new Map();
  for (const collection of collections) {
    for (const item of Array.isArray(collection) ? collection : []) {
      if (!item || typeof item !== 'object') continue;
      const id = progressRecordId(item, ordered.length);
      const previous = records.get(id);
      if (!previous) {
        ordered.push(id);
        records.set(id, { ...item, id: item.id || id, key: item.key || id });
        continue;
      }
      const previousRevision = Number(previous.revision || 0);
      const nextRevision = Number(item.revision || 0);
      const preferNext = nextRevision >= previousRevision || (!previous.text && item.text);
      const preferred = preferNext ? item : previous;
      const fallback = preferNext ? previous : item;
      records.set(id, {
        ...fallback,
        ...preferred,
        id: preferred.id || fallback.id || id,
        key: preferred.key || fallback.key || id,
        text: preferred.text || fallback.text || '',
        revision: Math.max(previousRevision, nextRevision),
        testIds: Array.isArray(preferred.testIds) ? preferred.testIds : (Array.isArray(fallback.testIds) ? fallback.testIds : []),
      });
    }
  }
  return ordered.map((id) => records.get(id)).filter(Boolean);
}

function completedReasoningRecords(items = []) {
  return (Array.isArray(items) ? items : []).filter((item) => item?.kind === 'thinking' && (item?.state === 'completed' || item?.active === false));
}

function abortError(message = 'Request cancelled') {
  const err = new Error(message);
  err.name = 'AbortError';
  err.statusCode = 499;
  return err;
}

function makeEvent(type, payload = {}) {
  return {
    type,
    time: new Date().toISOString(),
    ...payload,
  };
}

function ageMs(timestamp) {
  const value = Number(timestamp) || 0;
  return value > 0 ? Date.now() - value : null;
}

function responseHasVisibleOutput(response = {}) {
  return Boolean(
    String(response.answer || response.response || '').trim()
    || String(response.thinking || '').trim()
    || String(response.progress || response.progressText || '').trim()
    || (Array.isArray(response.artifacts) && response.artifacts.length)
  );
}

function responseHasTerminalOutput(response = {}) {
  return Boolean(
    String(response.answer || response.response || '').trim()
    || (Array.isArray(response.artifacts) && response.artifacts.length)
  );
}

function artifactSnapshotSignature(artifacts = []) {
  if (!Array.isArray(artifacts) || !artifacts.length) return '';
  return artifacts.map((artifact) => [
    artifact?.id || '',
    artifact?.name || artifact?.filename || '',
    artifact?.url || artifact?.downloadUrl || artifact?.src || '',
    artifact?.size || 0,
    artifact?.mime || '',
    artifact?.kind || '',
    artifact?.phase || '',
    artifact?.state || '',
    artifact?.downloadable ? 'downloadable' : '',
    artifact?.downloadActionPresent ? 'action' : '',
    artifact?.actionLabel || '',
    artifact?.lifecycleObserved ?? '',
  ].join('|')).sort().join('\n');
}

function requiredArtifactExpectation(state) {
  const output = state?.expectedOutput || {};
  if (!output.required) return '';
  const expected = String(output.expected || '').trim().toLowerCase();
  if (expected === 'zip') return 'zip';
  if (['file', 'artifact', 'download'].includes(expected)) return 'file';
  return '';
}

function artifactIsMaterializable(artifact = {}) {
  const phase = String(artifact?.phase || artifact?.state || '').trim().toUpperCase();
  if (phase === 'FAILED') return false;
  if (phase && phase !== 'READY') return false;
  return Boolean(
    artifact?.downloadable
    || artifact?.downloadActionPresent
    || artifact?.url
    || artifact?.downloadUrl
    || artifact?.src
    || phase === 'READY'
  );
}

function artifactMatchesRequiredExpectation(artifact = {}, expectation = '') {
  if (!artifactIsMaterializable(artifact)) return false;
  if (expectation !== 'zip') return true;
  const identity = [
    artifact?.name,
    artifact?.filename,
    artifact?.fileName,
    artifact?.mime,
    artifact?.contentType,
    artifact?.kind,
    artifact?.type,
    artifact?.actionLabel,
    artifact?.blockText,
    artifact?.text,
  ].filter(Boolean).join(' ').trim().toLowerCase();
  return /\.zip(?:$|[?#]|\b)/.test(identity)
    || /(?:application|multipart)\/(?:zip|x-zip-compressed)/.test(identity)
    || /(?:^|\b)(?:zip|zip archive|project archive|archive bundle)(?:\b|$)/.test(identity);
}

function requiredOutputArtifactMissing(state, artifacts = state?.artifacts || []) {
  const expectation = requiredArtifactExpectation(state);
  if (!expectation) return false;
  const candidates = Array.isArray(artifacts) ? artifacts : [];
  if (expectation !== 'zip') return !candidates.some((artifact) => artifactMatchesRequiredExpectation(artifact, expectation));

  const responseScope = {
    requestId: state?.requestId || '',
    turnKey: state?.progress?.assistantTurnKey || state?.deferredDone?.metadata?.turnKey || '',
    candidateIndex: state?.progress?.sourceCandidateIndex || 0,
  };
  return !selectRequiredZipCompletionCandidate(candidates, responseScope).artifact;
}

function preferCompleteText(primary = '', fallback = '') {
  const first = String(primary || '');
  const second = String(fallback || '');
  return second.length > first.length ? second : first;
}

function compactRequestState(state) {
  if (!state) return null;
  return {
    requestId: state.requestId,
    clientId: state.clientId || '',
    accepted: Boolean(state.accepted),
    delivered: Boolean(state.delivered),
    done: Boolean(state.done),
    resumed: Boolean(state.resumed),
    model: state.model || '',
    effort: state.effort || '',
    phase: state.progress?.phase || state.lastActivityReason || 'unknown',
    sourceUrl: state.progress?.url || '',
    sourceTitle: state.progress?.title || '',
    sourceSession: state.progress?.session || state.session || null,
    createdAt: state.createdAt || '',
    startedAt: state.startedAt || 0,
    lastHeartbeatAt: state.lastHeartbeatAt || 0,
    lastActivityAt: state.lastActivityAt || 0,
    lastActivityReason: state.lastActivityReason || '',
    lastMeaningfulProgressAt: state.lastMeaningfulProgressAt || 0,
    lastProgressAt: state.lastProgressAt || 0,
    lastProgressEvent: state.progress || null,
    phaseEnteredAt: state.phaseEnteredAt || state.startedAt || 0,
    phaseAgeMs: ageMs(state.phaseEnteredAt || state.startedAt || 0),
    meaningfulProgressAgoMs: ageMs(state.lastMeaningfulProgressAt),
    hardHeartbeatAgoMs: ageMs(state.lastHeartbeatAt),
    generationActivityAt: state.generationActivityAt || 0,
    currentGenerationActive: Boolean(state.currentGenerationActive),
    generationActivityAgoMs: ageMs(state.generationActivityAt),
    forcedSnapshotCount: state.forcedSnapshotCount || 0,
    lastForcedSnapshotAt: state.lastForcedSnapshotAt || 0,
    lastForcedSnapshotAgoMs: ageMs(state.lastForcedSnapshotAt),
    watchdog: state.watchdog || null,
    answerLength: String(state.answer || '').length,
    thinkingLength: String(state.thinking || '').length,
    artifactCount: Array.isArray(state.artifacts) ? state.artifacts.length : 0,
    progressText: state.progressText || '',
    progressTextLength: String(state.progressText || '').length,
    submittedUserTurnKey: state.progress?.submittedUserTurnKey || '',
    submittedUserTurnIndex: state.progress?.submittedUserTurnIndex ?? -1,
    assistantTurnKey: state.progress?.assistantTurnKey || '',
    assistantTurnIndex: state.progress?.assistantTurnIndex ?? -1,
    anchorConfidence: state.progress?.anchorConfidence || '',
    anchorReason: state.progress?.anchorReason || '',
    visibilityState: state.progress?.visibilityState || '',
    focused: state.progress?.focused ?? null,
    sawGenerating: state.progress?.sawGenerating ?? false,
    sawAnswer: state.progress?.sawAnswer ?? false,
    networkDone: state.progress?.networkDone ?? false,
    stopButtonVisible: state.progress?.stopButtonVisible ?? false,
  };
}

function normalizeOptions(options = {}) {
  return {
    sessionId: typeof options.sessionId === 'string' ? options.sessionId : '',
    newSession: Boolean(options.newSession),
    model: typeof options.model === 'string' ? options.model : '',
    effort: typeof options.effort === 'string' ? options.effort : '',
    attachments: Array.isArray(options.attachments) ? options.attachments : [],
    sourceClientId: typeof options.sourceClientId === 'string' ? options.sourceClientId : typeof options.clientId === 'string' ? options.clientId : '',
    autoOpenTab: typeof options.autoOpenTab === 'boolean' ? options.autoOpenTab : undefined,
    captureDomTimeline: Boolean(options.captureDomTimeline),
    answerSettleMs: config.answerSettleMs,
    answerDoneSettleMs: config.answerDoneSettleMs,
    postStopTerminalSettleMs: config.postStopTerminalSettleMs,
    requiredArtifactSettleMs: config.requiredArtifactSettleMs,
    expectedOutput: options.output && typeof options.output === 'object'
      ? { expected: String(options.output.expected || options.output.format || ''), required: Boolean(options.output.required) }
      : options.expectedOutput && typeof options.expectedOutput === 'object'
        ? { expected: String(options.expectedOutput.expected || options.expectedOutput.format || ''), required: Boolean(options.expectedOutput.required) }
        : { expected: '', required: false },
    ...(options.chatOptions && typeof options.chatOptions === 'object' ? options.chatOptions : {}),
  };
}

async function statFile(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    return stat?.isFile() && !stat.isSymbolicLink() ? stat : null;
  } catch {
    return null;
  }
}

function downloadConflictCandidates(filePath = '', preferredName = '') {
  const absolute = path.resolve(String(filePath || ''));
  const dir = path.dirname(absolute);
  const baseName = path.basename(absolute);
  const names = new Set([baseName]);
  if (preferredName) names.add(path.basename(String(preferredName)));
  const patterns = [];
  for (const name of names) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    if (!stem) continue;
    patterns.push({ stem, ext });
  }
  return { dir, patterns };
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function fileCreationTimestamp(stat = {}) {
  return Number(stat.birthtimeMs) || Number(stat.ctimeMs) || Number(stat.mtimeMs) || 0;
}

function newestFileTimestamp(stat = {}) {
  return Math.max(fileCreationTimestamp(stat), Number(stat.mtimeMs) || 0);
}

function capturedDownloadWindow(identity = {}, now = Date.now()) {
  const startedAt = Math.max(
    timestampMs(identity.browserDownloadStartTime),
    timestampMs(identity.browserCaptureStartedAt),
  );
  const capturedAt = Math.max(
    timestampMs(identity.browserDownloadEndTime),
    timestampMs(identity.browserCapturedAt),
    startedAt,
  );
  // Browser/FS timestamps can differ slightly, but a captured E2E artifact
  // should never resolve to a file that predates the active capture by minutes.
  return {
    minMs: startedAt ? startedAt - 5_000 : now - 120_000,
    maxMs: Math.max(now + 5_000, capturedAt + 5_000),
  };
}

function statIdentity(stat = {}) {
  return {
    dev: Number(stat.dev) || 0,
    ino: Number(stat.ino) || 0,
    size: Number(stat.size) || 0,
    birthtimeMs: Number(stat.birthtimeMs) || 0,
    ctimeMs: Number(stat.ctimeMs) || 0,
    mtimeMs: Number(stat.mtimeMs) || 0,
  };
}

function sameStatIdentity(left = {}, right = {}) {
  if (left.dev && right.dev && left.dev !== right.dev) return false;
  if (left.ino && right.ino && left.ino !== right.ino) return false;
  return left.size === right.size
    && left.birthtimeMs === right.birthtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.mtimeMs === right.mtimeMs;
}

function normalizeConflictDownloadName(value = '') {
  return path.basename(String(value || '')).toLowerCase().replace(/ \([0-9]+\)(?=\.[^.]+$|$)/, '');
}

function validateCapturedDownloadCandidate(candidatePath, stat, identity = {}) {
  const absolute = path.resolve(candidatePath);
  const actualName = path.basename(absolute);
  const capturedActualName = String(identity.browserActualName || '').trim();
  if (capturedActualName && normalizeConflictDownloadName(actualName) !== normalizeConflictDownloadName(capturedActualName)) {
    return { ok: false, reason: `name mismatch (${actualName} != ${capturedActualName})` };
  }
  const expectedSize = Number(identity.size) || 0;
  if (expectedSize && Number(stat.size) !== expectedSize) {
    return { ok: false, reason: `size mismatch (${stat.size} != ${expectedSize})` };
  }
  const { minMs, maxMs } = capturedDownloadWindow(identity);
  const createdAt = fileCreationTimestamp(stat);
  if (!createdAt || createdAt < minMs || createdAt > maxMs) {
    return { ok: false, reason: `file creation timestamp ${createdAt || 0} is outside capture window ${minMs}-${maxMs}` };
  }
  return {
    ok: true,
    path: absolute,
    stat,
    statIdentity: statIdentity(stat),
    minMs,
    maxMs,
    captureIdentity: {
      captureSource: String(identity.captureSource || ''),
      downloadId: identity.downloadId ?? null,
      browserCaptureStartedAt: Number(identity.browserCaptureStartedAt) || 0,
      browserCapturedAt: Number(identity.browserCapturedAt) || 0,
      browserActualName: capturedActualName,
    },
  };
}

export async function resolveBrowserDownloadedPath(filePath = '', preferredName = '', identity = {}) {
  const rawPath = String(filePath || '');
  if (!rawPath || !path.isAbsolute(rawPath)) throw new Error('Captured browser download path is missing or not absolute');
  const absolute = path.resolve(rawPath);
  const exactStat = await statFile(absolute);
  if (exactStat) {
    const exact = validateCapturedDownloadCandidate(absolute, exactStat, identity);
    if (!exact.ok) throw new Error(`Captured browser download failed safety validation at ${absolute}: ${exact.reason}`);
    return { ...exact, resolution: 'exact' };
  }

  const { dir, patterns } = downloadConflictCandidates(absolute, preferredName);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    throw new Error(`Captured browser download is not readable at the exact path: ${absolute}`);
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const matched = patterns.some(({ stem, ext }) => {
      if (name === `${stem}${ext}`) return true;
      const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedExt = ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^${escapedStem} \\([0-9]+\\)${escapedExt}$`).test(name);
    });
    if (!matched) continue;
    const candidatePath = path.join(dir, name);
    const stat = await statFile(candidatePath);
    if (!stat) continue;
    const checked = validateCapturedDownloadCandidate(candidatePath, stat, identity);
    if (checked.ok) candidates.push(checked);
  }

  candidates.sort((a, b) => newestFileTimestamp(b.stat) - newestFileTimestamp(a.stat) || b.stat.size - a.stat.size);
  if (candidates.length !== 1) {
    throw new Error(`Could not safely resolve captured browser download ${absolute}: ${candidates.length} fresh matching files`);
  }
  return { ...candidates[0], resolution: 'conflict-name' };
}

export async function removeCapturedBrowserDownload(resolved = {}) {
  const rawPath = String(resolved.path || '');
  if (!rawPath || !path.isAbsolute(rawPath) || !resolved.statIdentity) {
    return { removed: false, reason: 'missing_resolved_identity' };
  }
  const absolute = path.resolve(rawPath);
  const capture = resolved.captureIdentity || {};
  if (capture.captureSource !== 'chrome-downloads') return { removed: false, reason: 'untrusted_capture_source', path: absolute };
  if (capture.downloadId == null || !capture.browserCaptureStartedAt || !capture.browserActualName) {
    return { removed: false, reason: 'incomplete_browser_download_identity', path: absolute };
  }
  if (normalizeConflictDownloadName(path.basename(absolute)) !== normalizeConflictDownloadName(capture.browserActualName)) {
    return { removed: false, reason: 'captured_name_changed', path: absolute };
  }
  const current = await statFile(absolute);
  if (!current) return { removed: true, reason: 'already_missing', path: absolute };
  if (!sameStatIdentity(resolved.statIdentity, statIdentity(current))) {
    return { removed: false, reason: 'identity_changed_after_import', path: absolute };
  }
  await fs.unlink(absolute);
  return { removed: true, reason: 'captured_source_deleted', path: absolute };
}

export class TampermonkeyBridge {
  #hub;
  #fileStore;
  #eventBus;
  #mutex = new AsyncMutex();
  #pending = new Map();
  #commands = new Map();
  #artifacts = new Map();
  #runtimeOptions;

  constructor(hub, fileStore = null, eventBus = null, runtimeOptions = {}) {
    this.#hub = hub;
    this.#fileStore = fileStore;
    this.#eventBus = eventBus;
    this.#runtimeOptions = {
      autoOpenTab: typeof runtimeOptions.autoOpenTab === 'boolean' ? runtimeOptions.autoOpenTab : config.autoOpenTab,
      autoOpenTabTimeoutMs: Math.max(5_000, Number(runtimeOptions.autoOpenTabTimeoutMs) || config.autoOpenTabTimeoutMs),
      autoOpenTabBootstrapWaitMs: Math.max(0, Number(runtimeOptions.autoOpenTabBootstrapWaitMs ?? config.autoOpenTabBootstrapWaitMs) || 0),
      openExternalUrl: typeof runtimeOptions.openExternalUrl === 'function' ? runtimeOptions.openExternalUrl : openExternalBrowserUrl,
      publicBaseUrl: safeBridgeServerUrl(runtimeOptions.publicBaseUrl || config.publicBaseUrl),
    };
    this.#hub.on('client.message', ({ clientId, payload }) => this.#handleClientMessage(clientId, payload));
    this.#hub.on?.('client.activity', ({ clientId, client, payload }) => this.#handleClientActivity(clientId, client, payload));
    this.#hub.on?.('client.ready', (client) => this.#handleClientReady(client));
  }

  get pageUrl() {
    return this.#hub.activeClient?.url || null;
  }

  canAutoOpenPromptTab(options = {}) {
    if (typeof options.autoOpenTab === 'boolean') return options.autoOpenTab;
    return Boolean(this.#runtimeOptions.autoOpenTab);
  }

  async connectBrowser() {
    if (!this.#hub.activeClient) {
      const incompatibleClients = Array.from(this.#hub.clients || []).filter((client) => client.compatible === false || client.compatibility?.compatible === false);
      if (incompatibleClients.length) {
        const details = incompatibleClients.map((client) => `${client.id}: ${client.compatibility?.message || 'extension update required'}`).join('; ');
        throw new Error(`Connected browser extension is incompatible. ${details}`);
      }
      throw new Error('No browser extension client connected. Open ChatGPT with the ChatGPT Bridge extension enabled.');
    }
  }

  health() {
    const active = this.#hub.activeClient;
    return {
      ok: Boolean(active),
      transport: active ? `${active.runtime === 'extension' || active.transport === 'extension' ? 'extension' : 'browser'}:${active.transport || 'unknown'}` : 'extension:disconnected',
      clients: this.#hub.clients,
      activeClient: active ? this.#hub.clients.find((client) => client.id === active.id) : null,
      selectedClientId: this.#hub.selectedClientId,
      needsSelection: this.#hub.needsSelection,
      pendingRequests: this.#pending.size,
      pendingCommands: this.#commands.size,
      artifacts: this.#artifacts.size,
      activeRequests: this.requestDiagnostics(),
      serverInstanceId: this.#hub.serverInstanceId || '',
      autoOpenTab: Boolean(this.#runtimeOptions.autoOpenTab),
    };
  }

  requestDiagnostics() {
    return Array.from(this.#pending.values()).map((state) => compactRequestState(state));
  }

  async requestForcedSnapshot(requestId, options = {}) {
    const state = this.#pending.get(String(requestId || ''));
    if (!state) throw new Error(`No pending request for forced snapshot: ${requestId}`);
    return await this.#requestForcedSnapshotForState(state, options.reason || 'manual_forced_snapshot', { manual: true, force: true });
  }


  async steerRequest(requestId, message, options = {}) {
    const id = String(requestId || '').trim();
    const text = String(message || '').trim();
    if (!id) throw new Error('No requestId provided for steer');
    if (!text) throw new Error('No steer message provided');
    const state = this.#pending.get(id);
    if (!state || state.done) throw new Error(`No active tracked request for steer: ${id}`);
    const sourceClientId = String(options.sourceClientId || state.clientId || '');
    if (!sourceClientId) throw new Error(`Active request ${id} has no source browser client`);
    this.#emitRequestEvent(state, makeEvent('prompt.steer.requested', { requestId: id, message: text, sourceClientId }));
    const response = await this.#sendCommand('prompt.steer', { requestId: id, message: text }, {
      ...options,
      sourceClientId,
      timeoutMs: Number(options.timeoutMs) || 30_000,
    });
    this.#emitRequestEvent(state, makeEvent('prompt.steer.accepted', { requestId: id, message: text, sourceClientId }));
    this.#touchState(state, 'prompt.steer.accepted');
    return response;
  }


  activeRequestCandidates() {
    return Array.from(this.#hub.clients || [])
      .filter((client) => client?.ready && client.compatible !== false && client.compatibility?.compatible !== false && client.activeRequest?.requestId)
      .map((client) => ({
        clientId: client.id,
        client,
        activeRequest: client.activeRequest,
        selected: Boolean(client.selected),
      }));
  }

  findActiveRequest(options = {}) {
    return this.#resolveResumeTarget(options, { throwOnMissing: false });
  }

  selectClient(clientId) {
    return this.#hub.selectClient(clientId);
  }

  clearSelectedClient() {
    this.#hub.clearSelectedClient();
  }

  dropClient(clientId) {
    return this.#hub.dropClient(clientId);
  }


  #pendingUsesClient(clientId = '') {
    const id = String(clientId || '');
    if (!id) return false;
    return Array.from(this.#pending.values()).some((state) => !state.done && state.clientId === id);
  }

  #isPromptClientIdle(client = {}) {
    if (!client?.ready && client.ready !== undefined) return false;
    if (client.compatible === false || client.compatibility?.compatible === false) return false;
    if (client.activeRequest?.requestId) return false;
    if (this.#pendingUsesClient(client.id)) return false;
    return true;
  }

  #rankPromptClients(clients = []) {
    return clients.slice().sort((a, b) => {
      const selectedScore = Number(Boolean(b.selected)) - Number(Boolean(a.selected));
      if (selectedScore) return selectedScore;
      const focusedScore = Number(Boolean(b.focused)) - Number(Boolean(a.focused));
      if (focusedScore) return focusedScore;
      const visibleScore = Number(b.visibilityState === 'visible') - Number(a.visibilityState === 'visible');
      if (visibleScore) return visibleScore;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
  }

  async #confirmPromptClient(state, client, details = {}) {
    const confirm = details.options?.confirmClientSelection;
    const sessionId = normalizeConversationId(details.sessionId || '');
    const message = details.message || `Use available ChatGPT tab ${clientDisplayLabel(client)}${sessionId ? ` and switch it to session ${sessionId}` : ''}? [y/N] `;
    this.#emitRequestEvent(state, makeEvent('client.selection.confirmation_required', {
      requestId: state.requestId,
      clientId: client.id,
      sessionId: sessionId || undefined,
      reason: details.reason || 'idle_fallback',
      message,
    }));
    if (typeof confirm !== 'function') {
      throw makeClientSelectionError(`${message}\nRun /clients and /select <clientId>, or retry from interactive mode to confirm this tab.`, [client]);
    }
    const accepted = await confirm({ message, client, sessionId, reason: details.reason || 'idle_fallback' });
    if (!accepted) throw makeClientSelectionError('No ChatGPT tab selected for this request.', [client]);
    return client;
  }

  #autoOpenPromptEnabled(chatOptions = {}, options = {}) {
    if (typeof options.autoOpenTab === 'boolean') return options.autoOpenTab;
    if (typeof chatOptions.autoOpenTab === 'boolean') return chatOptions.autoOpenTab;
    return Boolean(this.#runtimeOptions.autoOpenTab);
  }

  #promptTargetUrl(chatOptions = {}) {
    const sessionId = !chatOptions.newSession ? normalizeConversationId(chatOptions.sessionId || '') : '';
    return sessionId
      ? `https://chatgpt.com/c/${encodeURIComponent(sessionId)}`
      : 'https://chatgpt.com/';
  }

  async #autoOpenPromptClient(state, chatOptions = {}, options = {}, reason = 'no_prompt_client') {
    const timeoutMs = Math.max(5_000, Number(options.autoOpenTabTimeoutMs) || this.#runtimeOptions.autoOpenTabTimeoutMs);
    const launchToken = `bridge-auto-${makeRequestId()}`;
    const url = this.#promptTargetUrl(chatOptions);
    this.#emitRequestEvent(state, makeEvent('client.auto_open.requested', {
      requestId: state.requestId,
      reason,
      url,
      launchToken,
    }));
    try {
      const opened = await this.openBrowserTab({
        url,
        active: options.autoOpenTabActive !== false,
        launchToken,
        timeoutMs,
        bootstrapWaitMs: Number(options.autoOpenTabBootstrapWaitMs ?? this.#runtimeOptions.autoOpenTabBootstrapWaitMs),
        allowSystemFallback: true,
      });
      const client = opened.client;
      if (!client?.id || !this.#isPromptClientIdle(client)) {
        throw new Error(`Auto-opened ChatGPT tab is not idle: ${client?.id || 'unknown client'}`);
      }
      this.#emitRequestEvent(state, makeEvent('client.auto_open.completed', {
        requestId: state.requestId,
        reason,
        clientId: client.id,
        launchToken,
        openedBy: opened.openedBy || 'extension',
        sourceClientId: opened.sourceClientId || '',
        url: client.url || url,
      }));
      return {
        client,
        reason: opened.openedBy === 'system' ? 'auto_opened_system_tab' : 'auto_opened_extension_tab',
        sessionSwitch: false,
        autoOpened: true,
        launchToken,
      };
    } catch (err) {
      this.#emitRequestEvent(state, makeEvent('client.auto_open.failed', {
        requestId: state.requestId,
        reason,
        url,
        launchToken,
        message: err.message || String(err),
      }));
      throw new Error(`Could not automatically open a ChatGPT tab: ${err.message || String(err)}`);
    }
  }

  async #resolvePromptClient(state, chatOptions = {}, options = {}) {
    const explicitClientId = String(options.sourceClientId || options.clientId || chatOptions.sourceClientId || chatOptions.clientId || '').trim();
    const allClients = Array.from(this.#hub.clients || []).filter((client) => client?.ready || client?.id);
    const incompatibleClients = allClients.filter((client) => client.compatible === false || client.compatibility?.compatible === false);
    const clients = allClients.filter((client) => client.compatible !== false && client.compatibility?.compatible !== false);
    const idleClients = clients.filter((client) => this.#isPromptClientIdle(client));
    const desiredSessionId = !chatOptions.newSession ? normalizeConversationId(chatOptions.sessionId || '') : '';
    const autoOpenEnabled = this.#autoOpenPromptEnabled(chatOptions, options);

    if (explicitClientId) {
      const client = clients.find((candidate) => candidate.id === explicitClientId);
      if (!client) throw new Error(`Browser extension client not found or not ready: ${explicitClientId}`);
      if (!this.#isPromptClientIdle(client)) throw new Error(`Browser extension client ${explicitClientId} is busy with ${client.activeRequest?.requestId || 'another local request'}.`);
      return { client, reason: 'explicit_client', sessionSwitch: Boolean(desiredSessionId && !clientMatchesSession(client, desiredSessionId)) };
    }

    if (desiredSessionId) {
      const exactIdle = this.#rankPromptClients(idleClients.filter((client) => clientMatchesSession(client, desiredSessionId)));
      if (exactIdle.length === 1) return { client: exactIdle[0], reason: 'session_match', sessionSwitch: false };
      if (exactIdle.length > 1) {
        const selected = exactIdle.find((client) => client.selected) || exactIdle.find((client) => client.focused) || null;
        if (selected) return { client: selected, reason: selected.selected ? 'selected_session_match' : 'focused_session_match', sessionSwitch: false };
        throw makeClientSelectionError(`Multiple idle ChatGPT tabs already have session ${desiredSessionId}. Use /select <clientId>.`, exactIdle);
      }

      const exactBusy = clients.filter((client) => clientMatchesSession(client, desiredSessionId) && !this.#isPromptClientIdle(client));
      if (autoOpenEnabled && exactBusy.length) {
        const busy = exactBusy.map((client) => busyClientLabel(client, this.#hub.serverInstanceId)).join(', ');
        throw new Error(`Session ${desiredSessionId} is open, but its tab is busy (${busy}). Wait or /resume; auto-open will not duplicate an actively used conversation.`);
      }
      if (!clients.length && incompatibleClients.length) {
        const details = incompatibleClients.map((client) => `${client.id}: ${client.compatibility?.message || 'extension update required'}`).join('; ');
        throw new Error(`Connected browser extension is incompatible. ${details}`);
      }
      if (autoOpenEnabled) return await this.#autoOpenPromptClient(state, chatOptions, options, 'requested_session_not_connected');

      const selectedIdle = idleClients.find((client) => client.selected);
      if (selectedIdle) {
        const client = await this.#confirmPromptClient(state, selectedIdle, {
          options,
          sessionId: desiredSessionId,
          reason: 'selected_idle_session_switch',
          message: `Selected tab ${clientDisplayLabel(selectedIdle)} is not on session ${desiredSessionId}. Switch this idle tab before sending? [y/N] `,
        });
        return { client, reason: 'confirmed_selected_session_switch', sessionSwitch: true };
      }

      const fallbackIdle = this.#rankPromptClients(idleClients);
      if (fallbackIdle.length === 1) {
        const client = await this.#confirmPromptClient(state, fallbackIdle[0], {
          options,
          sessionId: desiredSessionId,
          reason: 'idle_session_switch',
          message: `No connected tab is currently on session ${desiredSessionId}. Use available idle tab ${clientDisplayLabel(fallbackIdle[0])} and switch it before sending? [y/N] `,
        });
        return { client, reason: 'confirmed_idle_session_switch', sessionSwitch: true };
      }
      if (fallbackIdle.length > 1) {
        throw makeClientSelectionError(`No connected tab is currently on session ${desiredSessionId}, and multiple idle tabs are available. Use /clients and /select <clientId>.`, fallbackIdle);
      }
      if (exactBusy.length) {
        const busy = exactBusy.map((client) => busyClientLabel(client, this.#hub.serverInstanceId)).join(', ');
        throw new Error(`Session ${desiredSessionId} is open, but its tab is busy (${busy}). Wait, /resume, or select another idle tab to switch.`);
      }

    }

    const active = this.#hub.activeClient;
    if (active && this.#isPromptClientIdle(active)) return { client: active, reason: active.selected ? 'selected_client' : 'active_client', sessionSwitch: false };

    const rankedIdle = this.#rankPromptClients(idleClients);
    if (rankedIdle.length === 1 && clients.length === 1) return { client: rankedIdle[0], reason: 'single_client', sessionSwitch: false };
    if (!clients.length && incompatibleClients.length) {
      const details = incompatibleClients.map((client) => `${client.id}: ${client.compatibility?.message || 'extension update required'}`).join('; ');
      throw new Error(`Connected browser extension is incompatible. ${details}`);
    }
    if (autoOpenEnabled && (rankedIdle.length !== 1 || clients.length !== 1)) {
      const reason = rankedIdle.length > 1
        ? 'multiple_unselected_idle_tabs'
        : rankedIdle.length === 1
          ? 'unselected_idle_tab'
          : clients.length
            ? 'all_connected_tabs_busy'
            : 'no_connected_tabs';
      return await this.#autoOpenPromptClient(state, chatOptions, options, reason);
    }
    if (rankedIdle.length === 1) {
      const client = await this.#confirmPromptClient(state, rankedIdle[0], {
        options,
        reason: 'idle_fallback',
        message: `No ChatGPT tab is selected. Use available idle tab ${clientDisplayLabel(rankedIdle[0])}? [y/N] `,
      });
      return { client, reason: 'confirmed_idle_fallback', sessionSwitch: false };
    }
    if (rankedIdle.length > 1) {
      throw makeClientSelectionError('Multiple idle ChatGPT tabs are connected. Use /clients and /select <clientId>.', rankedIdle);
    }

    const busy = clients.filter((client) => !this.#isPromptClientIdle(client));
    if (busy.length) {
      const details = busy.map((client) => busyClientLabel(client, this.#hub.serverInstanceId)).join(', ');
      throw new Error(`No idle ChatGPT tab is available. Busy tabs: ${details}. Wait for the current request, use /resume, or open another ChatGPT tab.`);
    }
    if (incompatibleClients.length) {
      const details = incompatibleClients.map((client) => `${client.id}: ${client.compatibility?.message || 'extension update required'}`).join('; ');
      throw new Error(`Connected browser extension is incompatible. ${details}`);
    }
    throw new Error('No browser extension client connected. Open ChatGPT with the ChatGPT Bridge extension enabled.');
  }

  #sendPromptToClient(client, payload, options = {}) {
    if (!client?.id) throw new Error('No idle browser extension client was resolved for this prompt.');
    if (typeof this.#hub.sendToClientWithDelivery === 'function') {
      return this.#hub.sendToClientWithDelivery(client.id, payload, { timeoutMs: config.promptDeliveryTimeoutMs });
    }
    if (typeof this.#hub.sendToClient === 'function') {
      const sentClient = this.#hub.sendToClient(client.id, payload);
      return { client: sentClient && typeof sentClient === 'object' ? sentClient : client, delivered: Promise.resolve({ clientId: client.id, deliveredAt: Date.now() }) };
    }
    throw new Error(`Browser extension transport cannot send directly to resolved client ${client.id}.`);
  }

  debugEvents() {
    return this.#hub.debugEvents;
  }

  onClientLifecycle(handler) {
    if (typeof handler !== 'function') return () => {};
    const events = ['client.ready', 'client.changed', 'client.closed'];
    for (const event of events) this.#hub.on(event, handler);
    return () => {
      for (const event of events) this.#hub.off(event, handler);
    };
  }


  validateBridgeToken(token) {
    return this.#hub.validateToken(token);
  }

  isLocalRequest(req) {
    return this.#hub.isLocalRequest(req);
  }

  registerPollingClient(hello, req = null) {
    return this.#hub.registerPollingClient(hello, req);
  }

  receivePollingPayload(clientId, payload = {}) {
    return this.#hub.receivePollingPayload(clientId, payload);
  }

  async pollClient(clientId, req = null, timeoutMs = undefined) {
    return await this.#hub.poll(clientId, req, timeoutMs);
  }

  listKnownArtifacts() {
    return Array.from(this.#artifacts.values());
  }

  cancelActive(reason = 'Cancelled by user') {
    const pending = Array.from(this.#pending.values());
    for (const state of pending) {
      this.#cancelState(state, reason);
    }
    return pending.length;
  }


  #resolveResumeTarget(options = {}, { throwOnMissing = true } = {}) {
    const sourceClientId = String(options.sourceClientId || options.clientId || '').trim();
    const expectedRequestId = String(options.expectedRequestId || '').trim();
    const preferredRequestId = String(options.preferredRequestId || '').trim();
    const clients = Array.from(this.#hub.clients || []).filter((client) => client.compatible !== false && client.compatibility?.compatible !== false);
    const candidates = clients
      .filter((client) => client?.ready && client.activeRequest?.requestId)
      .map((client) => ({ clientId: client.id, client, activeRequest: client.activeRequest, selected: Boolean(client.selected) }));

    const fail = (message) => {
      if (!throwOnMissing) return null;
      throw new Error(message);
    };

    if (sourceClientId) {
      const client = clients.find((candidate) => candidate.id === sourceClientId && candidate.ready);
      if (!client) return fail(`Browser extension client not found or not ready: ${sourceClientId}`);
      if (!client.activeRequest?.requestId) return fail(`Browser extension client ${sourceClientId} has no active ChatGPT prompt to resume.`);
      if (expectedRequestId && client.activeRequest.requestId !== expectedRequestId) {
        return fail(`Client ${sourceClientId} is running ${client.activeRequest.requestId}, not ${expectedRequestId}.`);
      }
      return { clientId: client.id, client, activeRequest: client.activeRequest, selected: Boolean(client.selected) };
    }

    if (expectedRequestId) {
      const matches = candidates.filter((candidate) => candidate.activeRequest.requestId === expectedRequestId);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return fail(`Multiple browser extension clients report active prompt ${expectedRequestId}; select one with /select <clientId>.`);
      return fail(`No connected ChatGPT tab reports active prompt ${expectedRequestId}.`);
    }

    if (preferredRequestId) {
      const preferred = candidates.filter((candidate) => candidate.activeRequest.requestId === preferredRequestId);
      if (preferred.length === 1) return preferred[0];
      if (preferred.length > 1) return fail(`Multiple browser extension clients report active prompt ${preferredRequestId}; select one with /select <clientId>.`);
    }

    const active = this.#hub.activeClient;
    if (active?.activeRequest?.requestId) return { clientId: active.id, client: active, activeRequest: active.activeRequest, selected: true };

    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      const list = candidates.map((candidate) => `${candidate.clientId}:${candidate.activeRequest.requestId}`).join(', ');
      return fail(`Multiple ChatGPT prompts are running (${list}). Select the source tab with /select <clientId> or use /resume after closing other running prompts.`);
    }

    return fail('No active ChatGPT prompt is running in any connected tab.');
  }

  #followPendingRequest(state, callbacks = {}, options = {}) {
    if (!state || state.done) return Promise.reject(new Error('The tracked request has already finished.'));
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal.reason || 'Request follow cancelled'));
    const normalizedCallbacks = noopCallbacks(callbacks);

    return new Promise((resolve, reject) => {
      const follower = {
        callbacks: normalizedCallbacks,
        resolve,
        reject,
        signal: options.signal || null,
        abortHandler: null,
        done: false,
      };
      state.followers ||= new Set();
      state.followers.add(follower);

      const detach = () => {
        if (follower.done) return;
        follower.done = true;
        state.followers?.delete(follower);
        if (follower.signal && follower.abortHandler) follower.signal.removeEventListener('abort', follower.abortHandler);
      };
      follower.detach = detach;
      if (follower.signal) {
        follower.abortHandler = () => {
          detach();
          reject(abortError(String(follower.signal.reason || 'Request follow cancelled')));
        };
        follower.signal.addEventListener('abort', follower.abortHandler, { once: true });
      }

      try {
        normalizedCallbacks.onStatus?.('tracked', { requestId: state.requestId, clientId: state.clientId, phase: state.progress?.phase || '' });
        for (const event of state.events || []) normalizedCallbacks.onEvent?.(event);
        if (state.thinking) normalizedCallbacks.onThinkingUpdate?.(state.thinking, { requestId: state.requestId, replay: true });
        if (state.progressText || state.progressItems?.length) normalizedCallbacks.onProgressUpdate?.(state.progressText, { requestId: state.requestId, replay: true, items: state.progressItems || [], progressItems: state.progressItems || [] });
        if (state.answer) normalizedCallbacks.onAnswerUpdate?.(state.answer, { requestId: state.requestId, replay: true });
        if (Array.isArray(state.artifacts) && state.artifacts.length) normalizedCallbacks.onArtifactUpdate?.(state.artifacts, { requestId: state.requestId, replay: true });
      } catch (err) {
        detach();
        reject(err);
      }
    });
  }

  async resumeActiveRequest(callbacks = {}, options = {}) {
    if (options.signal?.aborted) throw abortError(options.signal.reason || 'Request cancelled');

    const expectedRequestId = String(options.expectedRequestId || '');
    const preferredRequestId = String(options.preferredRequestId || '');
    const localRequestId = expectedRequestId || preferredRequestId;
    const localExisting = localRequestId
      ? this.#pending.get(localRequestId)
      : this.#pending.size === 1 ? this.#pending.values().next().value : null;
    if (localExisting) return await this.#followPendingRequest(localExisting, callbacks, options);

    const target = this.#resolveResumeTarget(options);
    const active = target.client;
    const activeRequest = target.activeRequest || null;
    const requestId = String(activeRequest.requestId);
    if (expectedRequestId && expectedRequestId !== requestId) {
      throw new Error(`Active ChatGPT prompt belongs to ${requestId}, not ${expectedRequestId}. Use /recover after it finishes, or select the tab/session that is running the expected prompt.`);
    }
    if (this.#pending.size) throw new Error('Another local request is already running. Use /stop or wait before /resume.');

    const normalizedCallbacks = noopCallbacks(callbacks);
    const started = Date.now();

    return await new Promise((resolve, reject) => {
      const state = {
        requestId,
        clientId: active.id,
        resolve,
        reject,
        callbacks: normalizedCallbacks,
        answer: '',
        thinking: '',
        artifacts: [],
        progressText: '',
        session: null,
        model: '',
        effort: '',
        events: [],
        timer: null,
        accepted: true,
        delivered: true,
        done: false,
        resumed: true,
        startedAt: started,
        createdAt: new Date(started).toISOString(),
        lastActivityAt: started,
        lastHeartbeatAt: 0,
        lastMeaningfulProgressAt: started,
        lastProgressAt: 0,
        lastActivityReason: 'request.resumed',
        progress: { phase: 'resumed', requestId },
        abortSignal: options.signal || null,
        abortHandler: null,
      };

      if (state.abortSignal) {
        state.abortHandler = () => {
          this.#cancelState(state, String(state.abortSignal.reason || 'Request cancelled'));
        };
        state.abortSignal.addEventListener('abort', state.abortHandler, { once: true });
      }

      this.#pending.set(requestId, state);
      this.#emitRequestEvent(state, makeEvent('request.resumed', {
        requestId,
        clientId: active.id,
        activeRequest,
        promptPreview: activeRequest.promptPreview || '',
      }));
      state.callbacks.onStatus?.('resumed', { requestId, activeRequest });
      this.#touchState(state, 'request.resumed');

      this.#sendCommand('request.resume', { requestId }, { ...options, sourceClientId: active.id, timeoutMs: options.resumeTimeoutMs || options.timeoutMs || 10_000 })
        .then((response) => {
          if (state.done) return;
          const remote = response?.activeRequest || null;
          if (!remote?.requestId) {
            this.#finish(state, new Error('Selected tab reported no active prompt to resume.'));
            return;
          }
          if (remote.requestId !== requestId) {
            this.#finish(state, new Error(`Selected tab is running ${remote.requestId}, not ${requestId}.`));
            return;
          }
          state.session = response.session || state.session;
          this.#emitRequestEvent(state, makeEvent('session.snapshot', { requestId, session: state.session }));
          this.#emitRequestEvent(state, makeEvent('resume.attached', { requestId, activeRequest: remote, promptPreview: remote.promptPreview || '' }));
          this.#touchState(state, 'resume.attached');
        })
        .catch((err) => {
          if (!state.done) this.#finish(state, err);
        });
    }).then((response) => {
      const elapsedSec = (Date.now() - started) / 1000;
      const answerPreview = response.answer.slice(0, 120).replaceAll('\n', '\\n');
      log(`Resumed answer ${requestId} received in ${elapsedSec.toFixed(2)}s: ${JSON.stringify(answerPreview)}`);
      return response;
    });
  }

  async sendToChatGPT(message, callbacks = {}, options = {}) {
    const response = await this.sendRequest({ message, ...options, fullResponse: true }, callbacks, options);
    return options.fullResponse ? response : response.answer;
  }

  async sendRequest(request, callbacks = {}, options = {}) {
    return this.#mutex.runExclusive(async () => {
      if (options.signal?.aborted) throw abortError(options.signal.reason || 'Request cancelled');

      const requestId = request.requestId || makeRequestId();
      const normalizedCallbacks = noopCallbacks(callbacks);
      const started = Date.now();
      const message = String(request.message || '');
      const safePreview = message.slice(0, 120).replaceAll('\n', '\\n');
      const attachments = await this.#resolveAttachments(request.attachments || request.fileIds || []);
      const chatOptions = normalizeOptions({ ...request, attachments });
      log(`Incoming prompt ${requestId}: ${JSON.stringify(safePreview)} attachments=${attachments.length}`);

      return await new Promise((resolve, reject) => {
        const state = {
          requestId,
          clientId: null,
          resolve,
          reject,
          callbacks: normalizedCallbacks,
          answer: '',
          thinking: '',
          artifacts: [],
          progressText: '',
          progressItems: [],
          progressItemsSignature: '[]',
          reasoningHistory: [],
          responseBlocks: [],
          codeBlocks: [],
          codeBlockDiagnostics: [],
          parserAudit: null,
          session: null,
          model: chatOptions.model,
          effort: chatOptions.effort,
          expectedOutput: chatOptions.expectedOutput || { expected: '', required: false },
          requiredArtifactWaitSince: 0,
          requiredArtifactTimer: null,
          requiredArtifactProbeAttempt: 0,
          deferredDone: null,
          events: [],
          timer: null,
          accepted: false,
          delivered: false,
          done: false,
          startedAt: started,
          createdAt: new Date(started).toISOString(),
          lastActivityAt: started,
          lastHeartbeatAt: 0,
          lastMeaningfulProgressAt: started,
          lastProgressAt: 0,
          lastActivityReason: 'request.started',
          progress: { phase: 'created', requestId },
          phaseEnteredAt: started,
          generationActivityAt: 0,
          currentGenerationActive: false,
          promptPayload: null,
          promptSubmitted: false,
          promptResendCount: 0,
          lastPromptResendAt: 0,
          lastForcedSnapshotAt: 0,
          forcedSnapshotCount: 0,
          forcedSnapshotInFlight: false,
          watchdog: null,
          abortSignal: options.signal || null,
          abortHandler: null,
        };

        const startedEvent = makeEvent('request.started', {
          requestId,
          model: chatOptions.model || undefined,
          effort: chatOptions.effort || undefined,
          sessionId: chatOptions.sessionId || undefined,
          newSession: chatOptions.newSession || undefined,
          attachments: attachments.map(({ contentBase64, ...attachment }) => attachment),
        });
        this.#emitRequestEvent(state, startedEvent);

        this.#touchState(state, 'request.started');

        if (state.abortSignal) {
          state.abortHandler = () => {
            this.#cancelState(state, String(state.abortSignal.reason || 'Request cancelled'));
          };
          state.abortSignal.addEventListener('abort', state.abortHandler, { once: true });
        }

        try {
          this.#pending.set(requestId, state);
          this.#eventBus?.emitDebug({ type: 'protocol.out.prompt.send', requestId, data: { requestId, messageLength: message.length, attachments: attachments.map(({ contentBase64, ...rest }) => rest), model: chatOptions.model, effort: chatOptions.effort, sessionId: chatOptions.sessionId } });
          const promptPayload = {
            type: 'prompt.send',
            requestId,
            serverInstanceId: this.#hub.serverInstanceId || '',
            message,
            options: chatOptions,
            attachments,
          };
          state.promptPayload = promptPayload;
          Promise.resolve(this.#resolvePromptClient(state, chatOptions, options)).then((target) => {
            const targetClient = target?.client || null;
            const { client, delivered } = this.#sendPromptToClient(targetClient, promptPayload, options);
            state.clientId = client.id;
            this.#emitRequestEvent(state, makeEvent('client.target.resolved', {
              requestId,
              clientId: client.id,
              reason: target?.reason || 'active_client',
              sessionId: chatOptions.sessionId || undefined,
              sessionSwitch: Boolean(target?.sessionSwitch),
              sourceUrl: client.url || '',
            }));
            if (target?.sessionSwitch && chatOptions.sessionId) {
              this.#emitRequestEvent(state, makeEvent('session.switch.requested', { requestId, clientId: client.id, sessionId: chatOptions.sessionId }));
            }
            delivered.then(() => {
            if (state.done) return;
            state.delivered = true;
            this.#updateProgress(state, { phase: 'prompt_delivered_to_extension', requestId, clientId: client.id, meaningful: true }, { emit: false });
            this.#emitRequestEvent(state, makeEvent('prompt.delivered', { requestId, clientId: client.id }));
            }).catch((err) => {
              if (state.done) return;
              this.#finish(state, new Error(err.message || `Timed out delivering prompt to ${client.id}`));
            });
          }).catch((err) => {
            if (state.done) return;
            this.#finish(state, err);
          });
        } catch (err) {
          this.#cleanupState(state);
          this.#pending.delete(requestId);
          reject(err);
        }
      }).then((response) => {
        const elapsedSec = (Date.now() - started) / 1000;
        const answerPreview = response.answer.slice(0, 120).replaceAll('\n', '\\n');
        log(`Answer ${requestId} received in ${elapsedSec.toFixed(2)}s: ${JSON.stringify(answerPreview)}`);
        return response;
      });
    });
  }

  #browserControlClients() {
    return Array.from(this.#hub.clients || [])
      .filter((client) => client?.ready
        && client.compatible !== false
        && client.compatibility?.compatible !== false
        && client.capabilities?.browserTabs === true);
  }

  #browserControlClient(options = {}) {
    const explicitClientId = String(options.sourceClientId || options.clientId || '').trim();
    const clients = Array.from(this.#hub.clients || [])
      .filter((client) => client?.ready && client.compatible !== false && client.compatibility?.compatible !== false);
    if (explicitClientId) {
      const client = clients.find((candidate) => candidate.id === explicitClientId);
      if (!client) throw new Error(`Browser extension client not found or not ready: ${explicitClientId}`);
      if (client.capabilities?.browserTabs !== true) {
        throw new Error(`Browser extension client ${explicitClientId} does not support browser tab automation. Reload the extension packaged with this bridge.`);
      }
      return client;
    }
    const capable = clients.filter((client) => client.capabilities?.browserTabs === true);
    if (!capable.length) {
      if (clients.length) throw new Error('Connected extension does not support browser tab automation. Reload the extension packaged with this bridge.');
      throw new Error('No browser extension client connected.');
    }
    return this.#rankPromptClients(capable)[0];
  }

  async #waitForBrowserClient(predicate, timeoutMs = 20_000) {
    const find = () => Array.from(this.#hub.clients || []).find(predicate) || null;
    const existing = find();
    if (existing) return existing;
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const event of events) this.#hub.off(event, handler);
        if (err) reject(err);
        else resolve(value);
      };
      const handler = () => {
        const match = find();
        if (match) finish(null, match);
      };
      const events = ['client.ready', 'client.changed', 'client.activity'];
      for (const event of events) this.#hub.on(event, handler);
      const timer = setTimeout(() => finish(new Error(`Timed out waiting for the new ChatGPT browser tab after ${timeoutMs}ms`)), Math.max(250, Number(timeoutMs) || 20_000));
      timer.unref?.();
      handler();
    });
  }

  async #waitForBrowserControlClient(timeoutMs = 0) {
    const existing = this.#rankPromptClients(this.#browserControlClients())[0] || null;
    if (existing || timeoutMs <= 0) return existing;
    try {
      return await this.#waitForBrowserClient(
        (client) => client?.ready
          && client.compatible !== false
          && client.compatibility?.compatible !== false
          && client.capabilities?.browserTabs === true,
        timeoutMs,
      );
    } catch {
      return null;
    }
  }

  async #openSystemBrowserTab({ url, launchToken, timeoutMs, bridgeServerUrl }) {
    const targetUrl = browserLaunchUrl(url, launchToken, { bridgeServerUrl: bridgeServerUrl || this.#runtimeOptions.publicBaseUrl });
    await this.#runtimeOptions.openExternalUrl(targetUrl);
    const client = await this.#waitForBrowserClient(
      (candidate) => candidate?.ready
        && candidate.compatible !== false
        && candidate.compatibility?.compatible !== false
        && (candidate.launchToken === launchToken || browserLaunchMetadataFromUrl(candidate.url).launchToken === launchToken),
      timeoutMs,
    ).catch((err) => {
      const observed = Array.from(this.#hub.clients || []).map((candidate) => {
        const urlToken = browserLaunchMetadataFromUrl(candidate.url).launchToken;
        return `${candidate.id || 'unknown'} url=${candidate.url || '(empty)'} reportedToken=${candidate.launchToken ? 'yes' : 'no'} urlToken=${urlToken ? 'yes' : 'no'} extension=${candidate.extensionVersion || '?'} content=${candidate.clientVersion || '?'}`;
      });
      const suffix = observed.length ? ` Observed clients: ${observed.join('; ')}` : ' No clients connected to this bridge instance.';
      throw new Error(`${err.message}. The default browser must have the current ChatGPT Bridge extension installed and configured for this server. For isolated E2E ports, reload extension 0.4.0+; older content scripts ignore the per-tab bridge URL and reconnect to port 8080. If the ChatGPT address bar still contains #chatgpt-bridge-launch after load, the tab is running stale extension code.${suffix}`);
    });
    const launchedClient = normalizeLaunchedClient(client, launchToken);
    return {
      tabId: launchedClient.browserTabId ?? null,
      launchToken,
      requestedUrl: url,
      targetUrl,
      active: true,
      openedBy: 'system',
      sourceClientId: '',
      client: launchedClient,
    };
  }

  async openBrowserTab(options = {}) {
    const url = safeChatGptUrl(options.url || 'https://chatgpt.com/');
    const launchToken = String(options.launchToken || `bridge-tab-${makeRequestId()}`);
    const timeoutMs = Math.max(5_000, Number(options.timeoutMs) || this.#runtimeOptions.autoOpenTabTimeoutMs || 30_000);
    const explicitClientId = String(options.sourceClientId || options.clientId || '').trim();
    let source = null;

    if (explicitClientId) {
      source = this.#browserControlClient({ sourceClientId: explicitClientId });
    } else {
      source = this.#rankPromptClients(this.#browserControlClients())[0] || null;
      if (!source && options.allowSystemFallback) {
        const bootstrapWaitMs = Math.max(0, Math.min(timeoutMs, Number(options.bootstrapWaitMs ?? this.#runtimeOptions.autoOpenTabBootstrapWaitMs) || 0));
        source = await this.#waitForBrowserControlClient(bootstrapWaitMs);
      }
      if (!source && !options.allowSystemFallback) source = this.#browserControlClient(options);
    }

    if (!source) return await this.#openSystemBrowserTab({
      url,
      launchToken,
      timeoutMs,
      bridgeServerUrl: options.bridgeServerUrl || this.#runtimeOptions.publicBaseUrl,
    });

    const response = await this.#sendCommand('browser.tab.open', {
      url,
      active: options.active !== false,
      launchToken,
      timeoutMs,
      bridgeServerUrl: options.bridgeServerUrl || this.#runtimeOptions.publicBaseUrl,
    }, { sourceClientId: source.id, timeoutMs: Math.min(timeoutMs, 15_000) });
    const client = await this.#waitForBrowserClient(
      (candidate) => candidate?.ready
        && candidate.compatible !== false
        && candidate.compatibility?.compatible !== false
        && (candidate.launchToken === launchToken || browserLaunchMetadataFromUrl(candidate.url).launchToken === launchToken),
      timeoutMs,
    );
    return { ...response, launchToken, client: normalizeLaunchedClient(client, launchToken), sourceClientId: source.id, openedBy: 'extension' };
  }

  async closeBrowserTab(options = {}) {
    const sourceClientId = String(options.sourceClientId || options.clientId || '').trim();
    if (!sourceClientId) throw new Error('sourceClientId is required to close a browser tab safely');
    return await this.#sendCommand('browser.tab.close', {
      expectedLaunchToken: String(options.expectedLaunchToken || ''),
      expectedUrl: String(options.expectedUrl || ''),
      timeoutMs: Number(options.timeoutMs) || 10_000,
    }, { sourceClientId, timeoutMs: Number(options.timeoutMs) || 10_000 });
  }

  async deleteSession(sessionId, expectedUrl, options = {}) {
    const normalizedSessionId = normalizeConversationId(sessionId);
    if (!normalizedSessionId) throw new Error('A concrete ChatGPT sessionId is required for deletion');
    if (!String(expectedUrl || '').trim()) throw new Error('expectedUrl is required for safe ChatGPT session deletion');
    return await this.#sendCommand('sessions.delete', {
      sessionId: normalizedSessionId,
      expectedUrl: String(expectedUrl),
    }, { ...options, timeoutMs: Number(options.timeoutMs) || 30_000 });
  }

  async listSessions(options = {}) {
    const response = await this.#sendCommand('sessions.list', {}, options);
    return response.sessions || [];
  }

  async newSession(options = {}) {
    return await this.#sendCommand('sessions.new', {}, options);
  }

  async selectSession(sessionId, options = {}) {
    if (!sessionId) throw new Error('No sessionId provided');
    return await this.#sendCommand('sessions.select', { sessionId }, options);
  }

  async listModels(options = {}) {
    const response = await this.#sendCommand('models.list', {}, options);
    return { models: response.models || [], current: response.current || null, intelligence: response.intelligence || null };
  }

  async listEfforts(options = {}) {
    const response = await this.#sendCommand('efforts.list', {}, options);
    return { efforts: response.efforts || [], current: response.current || null, intelligence: response.intelligence || null };
  }

  async clearComposerAttachments(options = {}) {
    return await this.#sendCommand('composer.attachments.clear', {}, options);
  }

  #normalizeRecoveredResponse(response = {}, options = {}) {
    const sourceClientId = String(options.sourceClientId || options.clientId || response.sourceClientId || '');
    const artifacts = Array.isArray(response.artifacts) ? response.artifacts.map((artifact) => ({
      ...artifact,
      requestId: options.requestId || response.requestId || 'recovered',
      sourceClientId: artifact.sourceClientId || sourceClientId,
    })) : [];
    for (const artifact of artifacts) {
      if (artifact.id) this.#artifacts.set(artifact.id, artifact);
    }
    return {
      id: options.requestId || response.requestId || makeRequestId(),
      requestId: options.requestId || response.requestId || '',
      answer: String(response.answer || ''),
      response: String(response.answer || ''),
      thinking: String(response.thinking || ''),
      reasoningHistory: mergeProgressRecords(response.reasoningHistory, completedReasoningRecords(response.progressItems)),
      progressItems: Array.isArray(response.progressItems) ? response.progressItems : [],
      responseBlocks: Array.isArray(response.responseBlocks) ? response.responseBlocks : [],
      codeBlocks: Array.isArray(response.codeBlocks) ? response.codeBlocks : [],
      codeBlockDiagnostics: Array.isArray(response.codeBlockDiagnostics) ? response.codeBlockDiagnostics : [],
      parserAudit: response.parserAudit && typeof response.parserAudit === 'object' ? response.parserAudit : null,
      artifacts,
      session: response.session || null,
      url: response.url || '',
      title: response.title || '',
      sourceClientId,
      finishReason: 'recovered',
      recovered: true,
      recoveredAt: response.recoveredAt || new Date().toISOString(),
      source: response.source || 'latest-assistant-turn',
      format: response.format || '',
      reason: response.reason || '',
      turnKey: response.turnKey || '',
      turnIndex: response.turnIndex ?? -1,
      candidateIndex: response.candidateIndex ?? options.index ?? 1,
      events: [],
      createdAt: new Date().toISOString(),
    };
  }

  async recoverResponses(options = {}) {
    const limit = Math.max(1, Math.min(10, Number(options.limit) || 5));
    const response = await this.#sendCommand('response.recover.list', { limit }, { ...options, timeoutMs: options.timeoutMs || 30_000 });
    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    return candidates.map((candidate, index) => this.#normalizeRecoveredResponse({ ...candidate, candidateIndex: index + 1, session: response.session || candidate.session, url: response.url || candidate.url, title: response.title || candidate.title }, options));
  }

  async recoverLatestResponse(options = {}) {
    const index = Math.max(1, Number(options.index) || 1);
    const response = await this.#sendCommand('response.recover.latest', { index, limit: Math.max(index, Number(options.limit) || 5) }, { ...options, timeoutMs: options.timeoutMs || 30_000 });
    return this.#normalizeRecoveredResponse(response, { ...options, index });
  }

  async recoverResponseByTurnKey(options = {}) {
    const turnKey = String(options.turnKey || '');
    if (!turnKey) throw new Error('No turnKey provided for response recovery');
    const response = await this.#sendCommand('response.recover.turnKey', { turnKey }, { ...options, timeoutMs: options.timeoutMs || 30_000 });
    return this.#normalizeRecoveredResponse(response, { ...options, turnKey });
  }

  async fetchArtifact(artifactId, options = {}) {
    const artifact = this.#artifacts.get(artifactId);
    if (!artifact) throw new Error(`Unknown artifact: ${artifactId}`);

    if (artifact.storedFileId && this.#fileStore && !options.force) {
      const existing = await this.#fileStore.getReadable(artifact.storedFileId).catch(() => null);
      if (existing?.absolutePath) {
        const stat = await fs.stat(existing.absolutePath).catch(() => null);
        if (stat?.isFile()) return existing;
      }
    }

    const sourceClientId = String(options.sourceClientId || options.clientId || artifact.sourceClientId || '');
    this.#eventBus?.emitUser({ type: 'artifact.download.started', data: { artifactId, name: artifact.name || '', kind: artifact.kind || '', sourceClientId } });
    const response = await this.#sendCommand('artifact.fetch', { artifact: { ...artifact, chunkSize: 256 * 1024 } }, { ...options, sourceClientId, timeoutMs: options.timeoutMs || config.artifactChunkTimeoutMs });

    if (response.filePath) {
      const resolvedDownload = await resolveBrowserDownloadedPath(
        response.filePath,
        response.name || artifact.name || artifactId,
        {
          size: response.size || 0,
          browserDownloadStartTime: response.browserDownloadStartTime || '',
          browserDownloadEndTime: response.browserDownloadEndTime || '',
          browserCaptureStartedAt: response.browserCaptureStartedAt || 0,
          browserCapturedAt: response.browserCapturedAt || 0,
          browserActualName: response.name || '',
          browserExpectedNames: Array.isArray(response.browserExpectedNames) ? response.browserExpectedNames : [],
          captureSource: response.captureSource || '',
          downloadId: response.downloadId ?? null,
        },
      );
      const resolvedFilePath = resolvedDownload.path;
      const resolvedName = path.basename(resolvedFilePath) || response.name || artifact.name || artifactId;
      if (resolvedFilePath !== path.resolve(response.filePath)) {
        this.#eventBus?.emitUser({ type: 'artifact.download.renamed', data: { artifactId, requestedPath: response.filePath, resolvedPath: resolvedFilePath, resolution: resolvedDownload.resolution } });
      }
      if (!this.#fileStore) {
        return {
          id: artifactId,
          name: resolvedName,
          mime: response.mime || artifact.mime || 'application/octet-stream',
          filePath: resolvedFilePath,
          requestedFilePath: response.filePath,
          size: response.size || 0,
        };
      }
      const storedFromPath = await this.#fileStore.importArtifactPath({
        artifactId,
        filePath: resolvedFilePath,
        name: resolvedName,
        mime: response.mime || artifact.mime || 'application/octet-stream',
        source: { url: artifact.url || artifact.src || artifact.downloadUrl || '', requestId: artifact.requestId || '', browserDownloadPath: resolvedFilePath, requestedBrowserDownloadPath: response.filePath, captureSource: response.captureSource || 'chrome-downloads' },
        metadata: artifact,
        removeSource: false,
      });
      const sourceCleanup = await removeCapturedBrowserDownload(resolvedDownload).catch((err) => ({ removed: false, reason: err.message || String(err), path: resolvedFilePath }));
      this.#eventBus?.emitUser({
        type: sourceCleanup.removed ? 'artifact.download.source_removed' : 'artifact.download.source_cleanup_skipped',
        data: {
          artifactId,
          fileId: storedFromPath.id,
          path: sourceCleanup.path || resolvedFilePath,
          reason: sourceCleanup.reason || '',
          downloadId: response.downloadId ?? null,
          sourceClientId,
        },
      });
      artifact.storedFileId = storedFromPath.id;
      this.#artifacts.set(artifactId, { ...artifact, storedFileId: storedFromPath.id });
      this.#eventBus?.emitUser({ type: 'artifact.download.done', data: { artifactId, fileId: storedFromPath.id, name: storedFromPath.name, size: storedFromPath.size, source: response.captureSource || 'chrome-downloads', sourceClientId, requestId: artifact.requestId || '' } });
      return storedFromPath;
    }

    if (!response.contentBase64) throw new Error(`Artifact did not return downloadable content or file path: ${artifactId}`);

    if (!this.#fileStore) {
      return {
        id: artifactId,
        name: response.name || artifact.name || artifactId,
        mime: response.mime || artifact.mime || 'application/octet-stream',
        contentBase64: response.contentBase64,
      };
    }

    const stored = await this.#fileStore.putArtifact({
      artifactId,
      name: response.name || artifact.name || artifactId,
      mime: response.mime || artifact.mime || 'application/octet-stream',
      contentBase64: response.contentBase64,
      source: { url: artifact.url || artifact.src || artifact.downloadUrl || '', requestId: artifact.requestId || '', captureSource: response.captureSource || 'direct-fetch' },
      metadata: artifact,
    });
    artifact.storedFileId = stored.id;
    this.#artifacts.set(artifactId, { ...artifact, storedFileId: stored.id });
    this.#eventBus?.emitUser({ type: 'artifact.download.done', data: { artifactId, fileId: stored.id, name: stored.name, size: stored.size, source: response.captureSource || 'direct-fetch', sourceClientId, requestId: artifact.requestId || '' } });
    return stored;
  }

  async close() {
    for (const state of this.#pending.values()) {
      this.#cancelState(state, 'Bridge shutting down');
    }
    this.#pending.clear();

    for (const command of this.#commands.values()) {
      clearTimeout(command.timer);
      command.reject(new Error('Bridge shutting down'));
    }
    this.#commands.clear();
  }

  async #resolveAttachments(rawAttachments) {
    const result = [];
    for (const raw of rawAttachments) {
      if (!raw) continue;
      if (typeof raw === 'string') {
        if (!this.#fileStore) throw new Error('FileStore is not configured');
        result.push(await this.#readAttachmentForTransport(raw));
        continue;
      }

      if (typeof raw === 'object') {
        const fileId = raw.fileId || raw.id;
        if (fileId && !raw.contentBase64 && !raw.content && this.#fileStore) {
          result.push(await this.#readAttachmentForTransport(fileId));
          continue;
        }
        if (raw.url && !raw.contentBase64 && !raw.content) {
          result.push({
            id: raw.id || raw.fileId || `url_${makeRequestId()}`,
            name: raw.name || 'attachment',
            mime: raw.mime || raw.type || 'application/octet-stream',
            size: raw.size || 0,
            url: raw.url,
          });
          continue;
        }
        if (raw.contentBase64 || raw.content) {
          result.push({
            id: raw.id || raw.fileId || `inline_${makeRequestId()}`,
            name: raw.name || 'attachment',
            mime: raw.mime || raw.type || 'application/octet-stream',
            contentBase64: raw.contentBase64 || Buffer.from(String(raw.content || ''), 'utf8').toString('base64'),
          });
        }
      }
    }
    return result;
  }

  async #readAttachmentForTransport(fileId) {
    const record = await this.#fileStore.get(fileId);
    if (!record) throw new Error(`File not found: ${fileId}`);
    if (config.attachmentTransport === 'base64') return await this.#fileStore.readForTransport(fileId);
    const url = new URL(`/tm/files/${encodeURIComponent(fileId)}/download`, config.publicBaseUrl);
    url.searchParams.set('token', config.bridgeToken);
    return {
      id: record.id,
      name: record.name,
      mime: record.mime || 'application/octet-stream',
      size: record.size,
      url: url.toString(),
    };
  }

  #handleClientMessage(clientId, payload) {
    const commandId = payload?.commandId;
    if (commandId && this.#commands.has(commandId)) {
      this.#handleCommandResponse(clientId, payload);
      return;
    }

    const requestId = payload?.requestId;
    if (!requestId) return;

    const state = this.#pending.get(requestId);
    if (!state || (state.clientId && state.clientId !== clientId)) return;

    this.#touchState(state, payload.type || 'client.message');

    if (payload.type === 'prompt.accepted') {
      this.#markPromptAccepted(state, payload);
      this.#updateProgress(state, { phase: 'prompt_accepted_by_content_script', requestId, meaningful: true, clientId });
      return;
    }

    if (!state.accepted) this.#markPromptAccepted(state, payload, { implicit: true });

    if (payload.type === 'diagnostic') {
      const name = String(payload.name || 'diagnostic');
      const diagnosticEvent = makeEvent(`diagnostic.${name}`, { requestId, clientId, payload });
      this.#emitRequestEvent(state, diagnosticEvent);
      this.#eventBus?.emitDebug({ type: `diagnostic.${name}`, requestId, clientId, data: payload });
      return;
    }

    if (payload.type === 'request.progress') {
      this.#updateProgress(state, { ...payload, requestId, clientId });
      return;
    }

    if (payload.type === 'chat.event') {
      this.#emitRequestEvent(state, payload.event || makeEvent('event', { requestId, payload }));
      return;
    }

    if (payload.type === 'status') {
      state.callbacks.onStatus?.(payload.status || 'status', payload);
      const status = payload.status || 'status';
      if (status === 'sent') state.promptSubmitted = true;
      this.#updateProgress(state, { phase: status === 'sent' ? 'prompt_submitted' : status === 'generating' ? 'generating' : status, requestId, clientId, meaningful: true, status }, { emit: false });
      this.#emitRequestEvent(state, makeEvent(`status.${status || 'unknown'}`, { requestId, payload }));
      return;
    }

    if (payload.type === 'thinking.delta') {
      const delta = String(payload.delta || '');
      if (!delta) return;
      state.thinking += delta;
      this.#markMeaningfulProgress(state, 'thinking.delta');
      state.callbacks.onThinkingUpdate?.(state.thinking, payload);
      this.#emitRequestEvent(state, makeEvent('thinking.delta', { requestId, delta, thinking: state.thinking }));
      return;
    }

    if (payload.type === 'thinking.snapshot') {
      const text = String(payload.text || '');
      if (text === state.thinking) return;
      const delta = appendOnlyDelta(state.thinking, text);
      state.thinking = text;
      this.#markMeaningfulProgress(state, text ? 'thinking.snapshot' : 'thinking.cleared');
      state.callbacks.onThinkingUpdate?.(state.thinking, payload);
      this.#emitRequestEvent(state, makeEvent('thinking.snapshot', { requestId, text: state.thinking, delta }));
      return;
    }

    if (payload.type === 'answer.delta') {
      const delta = String(payload.delta || '');
      if (!delta) return;
      state.answer += delta;
      this.#markMeaningfulProgress(state, 'answer.delta');
      state.callbacks.onAnswerUpdate?.(state.answer, payload);
      this.#emitRequestEvent(state, makeEvent('answer.delta', { requestId, delta, answer: state.answer }));
      return;
    }

    if (payload.type === 'answer.snapshot') {
      const text = String(payload.text || '');
      if (!text || text === state.answer) return;

      const delta = appendOnlyDelta(state.answer, text);
      state.answer = text;
      if (delta) {
        this.#markMeaningfulProgress(state, 'answer.snapshot');
        state.callbacks.onAnswerUpdate?.(state.answer, payload);
      }
      this.#emitRequestEvent(state, makeEvent('answer.snapshot', { requestId, text: state.answer, delta }));
      return;
    }

    if (payload.type === 'assistant.progress.snapshot' || payload.type === 'visible_progress.snapshot') {
      const text = String(payload.text || payload.progress || '');
      const progressItems = Array.isArray(payload.items) ? payload.items : [];
      const progressItemsSignature = JSON.stringify(progressItems.map((item) => [
        item?.id || item?.key || '',
        item?.revision || 0,
        item?.kind || '',
        item?.text || '',
        item?.state || '',
        item?.active ? 'active' : '',
        item?.visible ? 'visible' : '',
      ]));
      const textChanged = text !== state.progressText;
      const itemsChanged = progressItemsSignature !== state.progressItemsSignature;
      if (!textChanged && !itemsChanged) return;
      const delta = appendOnlyDelta(state.progressText || '', text);
      state.progressText = text;
      state.progressItems = progressItems;
      state.progressItemsSignature = progressItemsSignature;
      state.reasoningHistory = mergeProgressRecords(state.reasoningHistory, completedReasoningRecords(progressItems));
      this.#markMeaningfulProgress(state, text || progressItems.length ? 'assistant.progress.snapshot' : 'assistant.progress.cleared');
      state.callbacks.onProgressUpdate?.(state.progressText, payload);
      this.#emitRequestEvent(state, makeEvent('assistant.progress.snapshot', {
        requestId,
        text: state.progressText,
        delta,
        progressLength: state.progressText.length,
        items: progressItems,
        itemCount: progressItems.length,
        sourceClientId: payload.sourceClientId || clientId,
        assistantTurnKey: payload.assistantTurnKey || payload.turnKey || state.progress?.assistantTurnKey || '',
        kind: payload.kind || 'visible_progress',
      }));
      return;
    }

    if (payload.type === 'artifact.snapshot') {
      const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
      const normalized = artifacts.map((artifact) => ({ ...artifact, requestId, sourceClientId: artifact.sourceClientId || clientId }));
      state.artifacts = normalized;
      this.#markMeaningfulProgress(state, 'artifact.snapshot');
      for (const artifact of normalized) {
        if (artifact.id) this.#artifacts.set(artifact.id, artifact);
      }
      state.callbacks.onArtifactUpdate?.(normalized, payload);
      this.#emitRequestEvent(state, makeEvent('artifact.snapshot', { requestId, artifacts: normalized }));
      if (state.deferredDone && normalized.length) this.#finishDeferredDoneIfReady(state, 'artifact.snapshot');
      return;
    }

    if (payload.type === 'session.snapshot') {
      state.session = payload.session || null;
      this.#emitRequestEvent(state, makeEvent('session.snapshot', { requestId, session: state.session }));
      return;
    }

    if (payload.type === 'done') {
      const artifacts = Array.isArray(payload.artifacts)
        ? payload.artifacts.map((artifact) => ({ ...artifact, requestId, sourceClientId: artifact.sourceClientId || clientId }))
        : state.artifacts;
      for (const artifact of artifacts) {
        if (artifact.id) this.#artifacts.set(artifact.id, artifact);
      }
      state.artifacts = artifacts;
      state.session = payload.session || state.session;
      const doneAnswer = String(payload.answer ?? state.answer ?? '');
      const finalProgressItems = mergeProgressRecords(state.progressItems, payload.progressItems);
      state.progressItems = finalProgressItems;
      state.reasoningHistory = mergeProgressRecords(
        state.reasoningHistory,
        payload.reasoningHistory,
        completedReasoningRecords(finalProgressItems),
      );
      state.responseBlocks = Array.isArray(payload.responseBlocks) ? payload.responseBlocks : state.responseBlocks;
      state.codeBlocks = Array.isArray(payload.codeBlocks) ? payload.codeBlocks : state.codeBlocks;
      state.codeBlockDiagnostics = Array.isArray(payload.codeBlockDiagnostics) ? payload.codeBlockDiagnostics : state.codeBlockDiagnostics;
      state.parserAudit = payload.parserAudit && typeof payload.parserAudit === 'object' ? payload.parserAudit : state.parserAudit;
      const metadata = {
        thinking: String(payload.thinking ?? state.thinking ?? ''),
        reasoningHistory: state.reasoningHistory,
        progressItems: finalProgressItems,
        responseBlocks: state.responseBlocks,
        codeBlocks: state.codeBlocks,
        codeBlockDiagnostics: state.codeBlockDiagnostics,
        parserAudit: state.parserAudit,
        artifacts,
        session: state.session,
        url: payload.url,
        title: payload.title,
        finishReason: payload.finishReason || 'stop',
        turnKey: payload.turnKey || '',
        turnIndex: payload.turnIndex ?? -1,
        format: payload.format || '',
        reason: payload.reason || '',
      };

      if (requiredOutputArtifactMissing(state, artifacts)) {
        this.#deferDoneForRequiredArtifact(state, doneAnswer, metadata);
        return;
      }

      this.#updateProgress(state, { phase: 'final_snapshot_ready', requestId, clientId, meaningful: true, answerLength: doneAnswer.length, artifactCount: artifacts.length }, { emit: false });
      this.#finish(state, null, doneAnswer, metadata);
      return;
    }

    if (payload.type === 'error') {
      this.#finish(state, new Error(payload.message || 'Browser extension client error'));
    }
  }

  #handleClientActivity(clientId, client = null, payload = {}) {
    for (const state of this.#pending.values()) {
      if (state.done) continue;
      if (state.clientId && state.clientId !== clientId) continue;
      const activeRequest = client?.activeRequest || payload?.activeRequest || null;
      if (activeRequest?.requestId === state.requestId) {
        state.lastHeartbeatAt = Date.now();
        state.heartbeat = { clientId, activeRequest, url: client?.url || payload?.url || '', time: state.lastHeartbeatAt };
        const currentlyGenerating = Boolean(
          activeRequest.generating
          || activeRequest.stopButtonVisible
          || payload.generating
          || payload.stopButtonVisible
        );
        state.currentGenerationActive = currentlyGenerating;
        if (currentlyGenerating) state.generationActivityAt = state.lastHeartbeatAt;
        if (activeRequest.sentAt || activeRequest.phase === 'prompt_submitted') state.promptSubmitted = true;
        this.#scheduleStateIdleTimer(state);
      }
    }
  }

  #handleClientReady(client = {}) {
    if (client.compatible === false || client.compatibility?.compatible === false) return;
    const clientId = String(client.id || '');
    if (!clientId) return;
    for (const state of this.#pending.values()) {
      if (state.done || state.clientId !== clientId) continue;
      if (state.promptSubmitted) {
        if (client.activeRequest?.requestId === state.requestId) {
          const now = Date.now();
          state.lastHeartbeatAt = now;
          state.currentGenerationActive = Boolean(client.activeRequest.generating || client.activeRequest.stopButtonVisible);
          if (state.currentGenerationActive) state.generationActivityAt = now;
          this.#updateProgress(state, {
            phase: client.activeRequest.phase || state.progress?.phase || 'reattached',
            requestId: state.requestId,
            clientId,
            visibilityState: client.visibilityState || '',
            focused: client.focused ?? null,
            meaningful: false,
          }, { emit: false });
          if (now - (state.lastReattachAt || 0) >= 1_000) {
            state.lastReattachAt = now;
            this.#emitRequestEvent(state, makeEvent('request.reattached', {
              requestId: state.requestId,
              clientId,
              phase: client.activeRequest.phase || state.progress?.phase || '',
              visibilityState: client.visibilityState || '',
              focused: client.focused ?? null,
            }));
            state.callbacks.onStatus?.('reattached', { requestId: state.requestId, clientId, activeRequest: client.activeRequest });
          }
          if (now - (state.lastReattachSnapshotAt || 0) >= 5_000) {
            state.lastReattachSnapshotAt = now;
            void this.#requestForcedSnapshotForState(state, 'client.ready.reattach', { force: true }).catch((err) => {
              if (!state.done) this.#emitRequestEvent(state, makeEvent('request.reattach_snapshot_failed', {
                requestId: state.requestId,
                clientId,
                message: err.message || String(err),
              }));
            });
          }
        }
        continue;
      }
      if (!state.promptPayload) continue;
      if (client.activeRequest?.requestId === state.requestId) continue;
      if (client.activeRequest?.requestId && client.activeRequest.requestId !== state.requestId) {
        this.#emitRequestEvent(state, makeEvent('prompt.resend.blocked_busy', {
          requestId: state.requestId,
          clientId,
          activeRequestId: client.activeRequest.requestId,
          ownerServerInstanceId: client.activeRequest.ownerServerInstanceId || '',
        }));
        continue;
      }
      const now = Date.now();
      if (now - (state.lastPromptResendAt || 0) < 750) continue;
      if ((state.promptResendCount || 0) >= 3) {
        this.#finish(state, new Error(`ChatGPT tab reloaded before prompt submission and resend limit was reached for ${state.requestId}.`));
        continue;
      }
      state.lastPromptResendAt = now;
      state.promptResendCount = (state.promptResendCount || 0) + 1;
      try {
        const { delivered } = this.#sendPromptToClient(client, state.promptPayload);
        this.#emitRequestEvent(state, makeEvent('prompt.resent_after_navigation', {
          requestId: state.requestId,
          clientId,
          resendCount: state.promptResendCount,
          sessionId: state.promptPayload.options?.sessionId || '',
        }));
        Promise.resolve(delivered).catch((err) => {
          if (!state.done) this.#emitRequestEvent(state, makeEvent('prompt.resend.delivery_failed', { requestId: state.requestId, clientId, message: err.message || String(err) }));
        });
      } catch (err) {
        this.#emitRequestEvent(state, makeEvent('prompt.resend.delivery_failed', { requestId: state.requestId, clientId, message: err.message || String(err) }));
      }
    }
  }

  #handleCommandResponse(clientId, payload) {
    const command = this.#commands.get(payload.commandId);
    if (!command || (command.clientId && command.clientId !== clientId)) return;

    if (payload.type === 'artifact.data.started') {
      command.chunks = [];
      command.chunkMeta = {
        name: payload.name,
        mime: payload.mime,
        artifactId: payload.artifactId,
        totalChunks: payload.totalChunks,
        encodedSize: payload.encodedSize,
        filePath: payload.filePath || payload.filename || '',
        size: payload.size || 0,
        downloadId: payload.downloadId ?? null,
        browserDownloadStartTime: payload.browserDownloadStartTime || '',
        browserDownloadEndTime: payload.browserDownloadEndTime || '',
        browserCaptureStartedAt: payload.browserCaptureStartedAt || 0,
        browserCapturedAt: payload.browserCapturedAt || 0,
        browserExpectedNames: Array.isArray(payload.browserExpectedNames) ? payload.browserExpectedNames : [],
        captureSource: payload.captureSource || '',
      };
      this.#eventBus?.emitDebug({ type: 'protocol.in.artifact.data.started', data: { commandId: payload.commandId, artifactId: payload.artifactId, totalChunks: payload.totalChunks, encodedSize: payload.encodedSize } });
      return;
    }

    if (payload.type === 'artifact.data.chunk') {
      if (!command.chunks) command.chunks = [];
      command.chunks[Number(payload.index) || 0] = String(payload.contentBase64 || '');
      if ((Number(payload.index) || 0) % 10 === 0) {
        this.#eventBus?.emitDebug({ type: 'protocol.in.artifact.data.chunk', data: { commandId: payload.commandId, index: payload.index, totalChunks: payload.totalChunks, size: String(payload.contentBase64 || '').length } });
      }
      return;
    }

    if (payload.type === 'artifact.data.done') {
      clearTimeout(command.timer);
      this.#commands.delete(payload.commandId);
      const contentBase64 = (command.chunks && command.chunks.length ? command.chunks.join('') : String(payload.contentBase64 || ''));
      command.resolve({
        type: 'artifact.data',
        sourceClientId: payload.sourceClientId || command.sourceClientId || command.clientId,
        commandClientId: command.clientId,
        commandId: payload.commandId,
        artifactId: payload.artifactId || command.chunkMeta?.artifactId,
        name: payload.name || command.chunkMeta?.name,
        mime: payload.mime || command.chunkMeta?.mime,
        contentBase64,
        encodedSize: contentBase64.length,
        filePath: payload.filePath || payload.filename || command.chunkMeta?.filePath || '',
        size: payload.size || command.chunkMeta?.size || 0,
        captureSource: payload.captureSource || command.chunkMeta?.captureSource || '',
        downloadId: payload.downloadId ?? command.chunkMeta?.downloadId ?? null,
        browserDownloadStartTime: payload.browserDownloadStartTime || command.chunkMeta?.browserDownloadStartTime || '',
        browserDownloadEndTime: payload.browserDownloadEndTime || command.chunkMeta?.browserDownloadEndTime || '',
        browserCaptureStartedAt: payload.browserCaptureStartedAt || command.chunkMeta?.browserCaptureStartedAt || 0,
        browserCapturedAt: payload.browserCapturedAt || command.chunkMeta?.browserCapturedAt || 0,
        browserExpectedNames: Array.isArray(payload.browserExpectedNames) ? payload.browserExpectedNames : command.chunkMeta?.browserExpectedNames || [],
      });
      return;
    }

    clearTimeout(command.timer);
    this.#commands.delete(payload.commandId);

    if (payload.type === 'command.error' || payload.error) {
      command.reject(new Error(payload.message || payload.error || 'Browser extension command failed'));
      return;
    }

    command.resolve({ ...payload, sourceClientId: payload.sourceClientId || command.sourceClientId || command.clientId, commandClientId: command.clientId });
  }

  #sendCommand(type, payload = {}, options = {}) {
    if (options.signal?.aborted) throw abortError(options.signal.reason || 'Command cancelled');

    const commandId = options.commandId || makeRequestId();
    const timeoutMs = Number(options.timeoutMs) || 30_000;
    const sourceClientId = String(options.sourceClientId || options.clientId || payload.sourceClientId || '');

    return new Promise((resolve, reject) => {
      let client;
      try {
        if (sourceClientId && typeof this.#hub.sendToClient === 'function') {
          client = this.#hub.sendToClient(sourceClientId, { type, commandId, ...payload });
        } else {
          client = this.#hub.sendToActive({ type, commandId, ...payload });
        }
      } catch (err) {
        reject(err);
        return;
      }

      const timer = setTimeout(() => {
        this.#commands.delete(commandId);
        reject(new Error(`Timed out waiting for ${type} response after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      const command = { commandId, clientId: client.id, resolve, reject, timer, chunks: null, chunkMeta: null, sourceClientId: sourceClientId || client.id };
      this.#commands.set(commandId, command);

      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          if (!this.#commands.has(commandId)) return;
          clearTimeout(timer);
          this.#commands.delete(commandId);
          reject(abortError(String(options.signal.reason || 'Command cancelled')));
        }, { once: true });
      }
    });
  }

  #emitRequestEvent(state, event) {
    const normalized = event.time ? event : makeEvent(event.type || 'event', event);
    state.events.push(normalized);
    state.callbacks.onEvent?.(normalized);
    for (const follower of state.followers || []) {
      if (follower.done) continue;
      const callbacks = follower.callbacks;
      try {
        callbacks.onEvent?.(normalized);
        if (normalized.type === 'thinking.delta' || normalized.type === 'thinking.snapshot') callbacks.onThinkingUpdate?.(state.thinking, normalized);
        else if (normalized.type === 'answer.delta' || normalized.type === 'answer.snapshot') callbacks.onAnswerUpdate?.(state.answer, normalized);
        else if (normalized.type === 'assistant.progress.snapshot') callbacks.onProgressUpdate?.(state.progressText, normalized);
        else if (normalized.type === 'artifact.snapshot') callbacks.onArtifactUpdate?.(state.artifacts, normalized);
        else if (normalized.type.startsWith('status.')) callbacks.onStatus?.(normalized.type.slice('status.'.length), normalized);
        else if (normalized.type === 'request.reattached') callbacks.onStatus?.('reattached', normalized);
      } catch (err) {
        follower.detach?.();
        follower.reject(err);
      }
    }
    this.#eventBus?.emitUser({
      type: normalized.type || 'event',
      requestId: state.requestId,
      sessionId: normalized.sessionId || state.session?.id || '',
      data: normalized,
    });
  }

  #markPromptAccepted(state, payload = {}, options = {}) {
    if (!state || state.done || state.accepted) return false;
    state.accepted = true;
    state.callbacks.onStatus?.('accepted', payload);
    const event = { requestId: state.requestId };
    if (options.implicit) {
      event.implicit = true;
      event.via = payload.type || 'unknown';
    }
    this.#markMeaningfulProgress(state, 'prompt.accepted');
    this.#emitRequestEvent(state, makeEvent('prompt.accepted', event));
    return true;
  }

  #markMeaningfulProgress(state, reason = 'meaningful.progress') {
    if (!state || state.done) return;
    state.lastMeaningfulProgressAt = Date.now();
    state.lastMeaningfulProgressReason = reason || 'meaningful.progress';
    this.#scheduleStateIdleTimer(state);
  }

  #updateProgress(state, payload = {}, options = {}) {
    if (!state || state.done) return;
    const now = Date.now();
    const previousPhase = String(state.progress?.phase || '');
    const phase = String(payload.phase || payload.status || previousPhase || 'unknown');
    const progress = {
      ...state.progress,
      ...payload,
      phase,
      requestId: state.requestId,
      clientId: payload.clientId || state.clientId || '',
      time: payload.time || now,
    };
    delete progress.type;
    delete progress.meaningful;
    state.progress = progress;
    state.lastProgressAt = now;
    if (phase && phase !== previousPhase) state.phaseEnteredAt = now;
    const hasCurrentGenerationSignal = Object.hasOwn(payload, 'generating') || Object.hasOwn(payload, 'stopButtonVisible');
    if (hasCurrentGenerationSignal) {
      state.currentGenerationActive = Boolean(payload.generating || payload.stopButtonVisible);
    } else if (phase === 'generating' || /generat|stream/i.test(phase)) {
      state.currentGenerationActive = true;
    } else if (/post_stop|artifact_settle|final_snapshot|result_|download_|apply_|completed|failed|cancel/i.test(phase)) {
      state.currentGenerationActive = false;
    }
    if (state.currentGenerationActive) state.generationActivityAt = now;
    if (phase === 'prompt_submitted' || /waiting_for_|generat|post_stop|artifact_settle|final_snapshot|result_/i.test(phase)) state.promptSubmitted = true;
    if (payload.meaningful !== false) this.#markMeaningfulProgress(state, `request.progress:${phase}`);
    else this.#scheduleStateIdleTimer(state);
    if (options.emit !== false) {
      this.#emitRequestEvent(state, makeEvent('request.progress', { requestId: state.requestId, ...progress }));
    }
  }

  #touchState(state, reason = 'activity') {
    if (!state || state.done) return;
    state.lastActivityAt = Date.now();
    state.lastActivityReason = reason || 'activity';
    this.#scheduleStateIdleTimer(state);
  }

  #watchdogIntervalMs() {
    const interval = Number(config.requestWatchdogIntervalMs) || 5_000;
    return Math.max(25, Math.min(interval, Number(config.answerTimeoutMs) || interval));
  }

  #meaningfulTimeoutMs() {
    return Math.max(50, Number(config.requestMeaningfulProgressTimeoutMs || config.answerTimeoutMs) || 120_000);
  }

  #postGenerationTimeoutMs() {
    return Math.max(50, Number(config.requestPostGenerationProgressTimeoutMs) || 60_000);
  }

  #isPostGenerationPhase(phase = '') {
    return /(?:post_stop|artifact_settle|final_snapshot|result_|download_|apply_|completed|failed|cancel)/i.test(String(phase || ''));
  }

  #nonGeneratingTimeoutMs(phase = '') {
    return this.#isPostGenerationPhase(phase) ? this.#postGenerationTimeoutMs() : this.#meaningfulTimeoutMs();
  }

  #forcedSnapshotAfterMs() {
    return Math.max(1_000, Number(config.forcedSnapshotAfterMs) || 90_000);
  }

  #isGenerationActive(state) {
    if (state?.currentGenerationActive) return true;
    const graceMs = Math.max(250, Number(config.requestGenerationActivityGraceMs) || 30_000);
    const lastActivity = Number(state?.generationActivityAt) || 0;
    return Boolean(lastActivity && Date.now() - lastActivity <= graceMs);
  }

  #sourceClientIsAlive(state) {
    if (!state?.clientId) return false;
    const client = this.#hub.clients?.find?.((item) => item.id === state.clientId);
    if (!client) return false;
    if (client.ready === false) return false;
    if (!state.lastHeartbeatAt) return true;
    const hardTimeout = Number(config.requestHardLivenessTimeoutMs) || Math.max(60_000, Number(config.clientStaleMs || 30_000));
    return Date.now() - state.lastHeartbeatAt <= hardTimeout;
  }

  #scheduleStateIdleTimer(state) {
    if (!state || state.done || state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      this.#runStateWatchdog(state);
    }, this.#watchdogIntervalMs());
  }

  #runStateWatchdog(state) {
    if (!state || state.done) return;

    const now = Date.now();
    const meaningfulIdleMs = now - (state.lastMeaningfulProgressAt || state.startedAt || now);
    const hardIdleMs = state.lastHeartbeatAt ? now - state.lastHeartbeatAt : null;
    const phase = String(state.progress?.phase || 'unknown');
    const generationActive = this.#isGenerationActive(state);
    const sourceAlive = this.#sourceClientIsAlive(state);
    state.watchdog = {
      phase,
      meaningfulIdleMs,
      hardIdleMs,
      sourceAlive,
      generationActive,
      lastMeaningfulProgressReason: state.lastMeaningfulProgressReason || state.lastActivityReason || '',
      checkedAt: now,
    };

    if (state.clientId && !sourceAlive) {
      this.#emitWatchdogEvent(state, 'watchdog.source_disconnected', {
        phase,
        hardIdleMs,
        sourceClientId: state.clientId,
        message: 'Source ChatGPT tab/client is disconnected; request is recoverable only from visible browser state if the tab returns.',
      });
      const timeoutMs = this.#nonGeneratingTimeoutMs(phase);
      if (meaningfulIdleMs >= timeoutMs) {
        const err = new Error(`Source ChatGPT tab/client disconnected while request was in phase ${phase}. Use /recover after reconnecting the source tab if the answer is visible.`);
        err.recoverable = true;
        err.phase = phase;
        this.#finish(state, err, '', { finishReason: 'recoverable_failed' });
        return;
      }
      this.#scheduleStateIdleTimer(state);
      return;
    }

    const forceAfterMs = this.#forcedSnapshotAfterMs();
    const forceCooldownMs = Math.max(1_000, Number(config.forcedSnapshotCooldownMs) || 60_000);
    if (meaningfulIdleMs >= forceAfterMs && now - (state.lastForcedSnapshotAt || 0) >= forceCooldownMs) {
      const type = generationActive ? 'watchdog.generation_active_no_visible_change' : 'watchdog.meaningful_progress_stalled';
      this.#emitWatchdogEvent(state, type, {
        phase,
        meaningfulIdleMs,
        sourceClientId: state.clientId || '',
        message: generationActive
          ? 'Generation still appears active, but no visible answer/progress/artifact change was observed recently. Requesting a source-bound snapshot.'
          : 'No meaningful request progress was observed recently. Requesting a source-bound snapshot.',
      });
      void this.#requestForcedSnapshotForState(state, type).catch((err) => {
        this.#emitWatchdogEvent(state, 'forced_snapshot.failed', {
          phase,
          message: err.message || String(err),
          sourceClientId: state.clientId || '',
        });
      });
    }

    const timeoutMs = this.#nonGeneratingTimeoutMs(phase);
    if (!generationActive && meaningfulIdleMs >= timeoutMs) {
      const reason = state.lastMeaningfulProgressReason ? `; last meaningful progress: ${state.lastMeaningfulProgressReason}` : '';
      this.#cancelState(state, `Timed out waiting for ChatGPT request progress after ${timeoutMs}ms in phase ${phase}${reason}`);
      return;
    }

    this.#scheduleStateIdleTimer(state);
  }

  #emitWatchdogEvent(state, type, data = {}) {
    if (!state || state.done) return;
    const now = Date.now();
    const key = `${type}:${data.phase || state.progress?.phase || ''}`;
    if (state.lastWatchdogEventKey === key && now - (state.lastWatchdogEventAt || 0) < 10_000) return;
    state.lastWatchdogEventKey = key;
    state.lastWatchdogEventAt = now;
    this.#emitRequestEvent(state, makeEvent(type, { requestId: state.requestId, ...data }));
    state.callbacks.onStatus?.('watchdog', { type, requestId: state.requestId, ...data });
  }

  async #requestForcedSnapshotForState(state, reason = 'watchdog', options = {}) {
    if (!state || state.done) return null;
    if (state.forcedSnapshotInFlight && !options.force) return null;
    if (!state.clientId) throw new Error('Cannot request forced snapshot without sourceClientId');

    state.forcedSnapshotInFlight = true;
    state.lastForcedSnapshotAt = Date.now();
    state.forcedSnapshotCount = (state.forcedSnapshotCount || 0) + 1;
    this.#emitRequestEvent(state, makeEvent('forced_snapshot.requested', {
      requestId: state.requestId,
      phase: state.progress?.phase || 'unknown',
      reason,
      sourceClientId: state.clientId,
      assistantTurnKey: state.progress?.assistantTurnKey || '',
      submittedUserTurnKey: state.progress?.submittedUserTurnKey || '',
    }));

    try {
      const response = await this.#sendCommand('response.snapshot.request', {
        requestId: state.requestId,
        turnKey: state.progress?.assistantTurnKey || '',
        assistantTurnKey: state.progress?.assistantTurnKey || '',
        submittedUserTurnKey: state.progress?.submittedUserTurnKey || '',
      }, {
        sourceClientId: state.clientId,
        timeoutMs: Number(config.forcedSnapshotTimeoutMs) || 30_000,
      });
      if (state.done) return response;
      this.#ingestForcedSnapshot(state, response || {}, reason);
      return response;
    } finally {
      if (state) state.forcedSnapshotInFlight = false;
      if (state && !state.done) this.#scheduleStateIdleTimer(state);
    }
  }

  #ingestForcedSnapshot(state, response = {}, reason = 'forced_snapshot') {
    const answerProvided = Object.prototype.hasOwnProperty.call(response, 'answer')
      || Object.prototype.hasOwnProperty.call(response, 'response');
    const answer = String(response.answer ?? response.response ?? '');
    const thinking = String(response.thinking || '');
    const progressText = String(response.progress || response.progressText || '');
    const progressItems = Array.isArray(response.progressItems) ? response.progressItems : [];
    const progressItemsSignature = JSON.stringify(progressItems.map((item) => [
      item?.id || item?.key || '',
      item?.revision || 0,
      item?.kind || '',
      item?.state || '',
      item?.text || '',
      item?.active ? 'active' : '',
      item?.visible ? 'visible' : '',
    ]));
    const artifacts = Array.isArray(response.artifacts)
      ? response.artifacts.map((artifact) => ({ ...artifact, requestId: state.requestId, sourceClientId: artifact.sourceClientId || response.sourceClientId || state.clientId }))
      : [];
    if (Array.isArray(response.responseBlocks)) state.responseBlocks = response.responseBlocks;
    if (Array.isArray(response.codeBlocks)) state.codeBlocks = response.codeBlocks;
    if (Array.isArray(response.codeBlockDiagnostics)) state.codeBlockDiagnostics = response.codeBlockDiagnostics;
    if (response.parserAudit && typeof response.parserAudit === 'object') state.parserAudit = response.parserAudit;
    state.reasoningHistory = mergeProgressRecords(
      state.reasoningHistory,
      response.reasoningHistory,
      completedReasoningRecords(progressItems),
    );
    const turnKey = response.turnKey || response.assistantTurnKey || state.progress?.assistantTurnKey || '';
    const nextPhase = response.phase || state.progress?.phase || (responseHasVisibleOutput(response) ? 'snapshot_checked_with_output' : 'snapshot_checked');
    const previousPhase = String(state.progress?.phase || '');
    const previousTurnKey = String(state.progress?.assistantTurnKey || '');
    const previousGenerationActive = Boolean(state.currentGenerationActive);
    const nextGenerationActive = Boolean(response.generating || response.stopButtonVisible);
    const thinkingChanged = thinking !== state.thinking;
    const progressChanged = progressText !== state.progressText || progressItemsSignature !== state.progressItemsSignature;
    const answerChanged = Boolean(answerProvided && answer !== state.answer);
    const artifactsChanged = Boolean(artifacts.length && artifactSnapshotSignature(artifacts) !== artifactSnapshotSignature(state.artifacts));
    const identityChanged = Boolean(turnKey && turnKey !== previousTurnKey);
    const phaseChanged = Boolean(nextPhase && nextPhase !== previousPhase);
    const generationChanged = nextGenerationActive !== previousGenerationActive;
    const snapshotChanged = thinkingChanged || progressChanged || answerChanged || artifactsChanged || identityChanged || phaseChanged || generationChanged;

    this.#emitRequestEvent(state, makeEvent('forced_snapshot.received', {
      requestId: state.requestId,
      reason,
      sourceClientId: response.sourceClientId || state.clientId,
      active: Boolean(response.active),
      generating: nextGenerationActive,
      changed: snapshotChanged,
      answerLength: answer.length,
      thinkingLength: thinking.length,
      progressLength: progressText.length,
      artifactCount: artifacts.length,
      turnKey,
    }));

    if (thinkingChanged) {
      const delta = appendOnlyDelta(state.thinking || '', thinking);
      state.thinking = thinking;
      this.#markMeaningfulProgress(state, thinking ? 'forced_snapshot.thinking' : 'forced_snapshot.thinking_cleared');
      state.callbacks.onThinkingUpdate?.(state.thinking, response);
      this.#emitRequestEvent(state, makeEvent('thinking.snapshot', { requestId: state.requestId, text: state.thinking, delta, source: 'forced_snapshot' }));
    }

    if (progressChanged) {
      const delta = appendOnlyDelta(state.progressText || '', progressText);
      state.progressText = progressText;
      state.progressItems = progressItems;
      state.progressItemsSignature = progressItemsSignature;
      state.reasoningHistory = mergeProgressRecords(state.reasoningHistory, completedReasoningRecords(progressItems));
      this.#markMeaningfulProgress(state, progressText || progressItems.length ? 'forced_snapshot.progress' : 'forced_snapshot.progress_cleared');
      state.callbacks.onProgressUpdate?.(state.progressText, response);
      this.#emitRequestEvent(state, makeEvent('assistant.progress.snapshot', {
        requestId: state.requestId,
        text: state.progressText,
        delta,
        items: progressItems,
        itemCount: progressItems.length,
        source: 'forced_snapshot',
        assistantTurnKey: turnKey,
      }));
    }

    if (answerChanged) {
      const delta = appendOnlyDelta(state.answer || '', answer);
      state.answer = answer;
      this.#markMeaningfulProgress(state, answer ? 'forced_snapshot.answer' : 'forced_snapshot.answer_cleared');
      state.callbacks.onAnswerUpdate?.(state.answer, response);
      this.#emitRequestEvent(state, makeEvent('answer.snapshot', {
        requestId: state.requestId,
        text: state.answer,
        delta,
        source: 'forced_snapshot',
        cleared: !answer,
      }));
    }

    if (artifactsChanged) {
      state.artifacts = artifacts;
      for (const artifact of artifacts) if (artifact.id) this.#artifacts.set(artifact.id, artifact);
      this.#markMeaningfulProgress(state, 'forced_snapshot.artifacts');
      state.callbacks.onArtifactUpdate?.(artifacts, response);
      this.#emitRequestEvent(state, makeEvent('artifact.snapshot', { requestId: state.requestId, artifacts, source: 'forced_snapshot' }));
    }

    if (state.deferredDone && state.artifacts.length) {
      state.deferredDone.metadata = {
        ...state.deferredDone.metadata,
        session: response.session || state.deferredDone.metadata?.session,
        url: response.url || state.deferredDone.metadata?.url,
        title: response.title || state.deferredDone.metadata?.title,
        turnKey: turnKey || state.deferredDone.metadata?.turnKey,
        turnIndex: response.turnIndex ?? state.deferredDone.metadata?.turnIndex ?? -1,
        format: response.format || state.deferredDone.metadata?.format || '',
        responseBlocks: state.responseBlocks,
        codeBlocks: state.codeBlocks,
        codeBlockDiagnostics: state.codeBlockDiagnostics,
        parserAudit: state.parserAudit,
        progressItems: state.progressItems,
        reasoningHistory: state.reasoningHistory,
        reason: response.reason || state.deferredDone.metadata?.reason || '',
      };
      if (this.#finishDeferredDoneIfReady(state, 'forced_snapshot')) return;
    }

    if (turnKey || response.phase || generationChanged) {
      this.#updateProgress(state, {
        phase: nextPhase,
        requestId: state.requestId,
        clientId: state.clientId,
        assistantTurnKey: turnKey,
        meaningful: phaseChanged || identityChanged || generationChanged,
        generating: Boolean(response.generating),
        stopButtonVisible: Boolean(response.stopButtonVisible),
        sawGenerating: Boolean(response.generating || response.stopButtonVisible || state.progress?.sawGenerating),
        answerLength: answer.length || String(state.answer || '').length,
        artifactCount: artifacts.length || state.artifacts.length,
      }, { emit: true });
    } else {
      state.currentGenerationActive = nextGenerationActive;
      if (nextGenerationActive) state.generationActivityAt = Date.now();
    }

    const generationActive = state.currentGenerationActive;
    const terminalConfirmed = response.terminal === true;
    const hasTerminalOutput = responseHasTerminalOutput(response);
    const requiredArtifactMissing = requiredOutputArtifactMissing(state, artifacts.length ? artifacts : state.artifacts);
    if (terminalConfirmed && hasTerminalOutput && !generationActive && !requiredArtifactMissing) {
      this.#updateProgress(state, { phase: 'final_snapshot_ready', requestId: state.requestId, clientId: state.clientId, meaningful: phaseChanged || snapshotChanged }, { emit: false });
      this.#finish(state, null, state.answer || answer, {
        thinking: state.thinking || thinking,
        reasoningHistory: state.reasoningHistory,
        progressItems: state.progressItems,
        responseBlocks: state.responseBlocks,
        codeBlocks: state.codeBlocks,
        codeBlockDiagnostics: state.codeBlockDiagnostics,
        parserAudit: state.parserAudit,
        progressText: state.progressText || progressText,
        artifacts: state.artifacts.length ? state.artifacts : artifacts,
        session: response.session || state.session,
        url: response.url,
        title: response.title,
        finishReason: 'forced_snapshot',
        turnKey,
        turnIndex: response.turnIndex ?? -1,
        format: response.format || '',
        reason: response.reason || 'forced_snapshot',
      });
    }
  }

  #deferDoneForRequiredArtifact(state, answer = '', metadata = {}) {
    if (!state || state.done) return;
    const now = Date.now();
    if (!state.requiredArtifactWaitSince) state.requiredArtifactWaitSince = now;
    state.requiredArtifactProbeAttempt = 0;
    state.deferredDone = { answer: String(answer || ''), metadata: { ...metadata } };
    state.currentGenerationActive = false;
    this.#updateProgress(state, {
      phase: 'artifact_settle',
      requestId: state.requestId,
      clientId: state.clientId,
      meaningful: true,
      answerLength: String(answer || '').length,
      artifactCount: state.artifacts.length,
    }, { emit: false });
    this.#emitRequestEvent(state, makeEvent('artifact.required_wait_started', {
      requestId: state.requestId,
      expected: requiredArtifactExpectation(state),
      source: 'server_done_guard',
      limitMs: Number(config.requiredArtifactSettleMs) || 30_000,
      sourceClientId: state.clientId || '',
      assistantTurnKey: metadata.turnKey || state.progress?.assistantTurnKey || '',
    }));
    this.#scheduleRequiredArtifactProbe(state, 500);
  }

  #scheduleRequiredArtifactProbe(state, delayMs = 500) {
    if (!state || state.done || !state.deferredDone) return;
    clearTimeout(state.requiredArtifactTimer);
    const limitMs = Math.max(1_500, Number(config.requiredArtifactSettleMs) || 30_000);
    const waitedBeforeSchedule = Date.now() - (state.requiredArtifactWaitSince || Date.now());
    const remainingMs = Math.max(0, limitMs - waitedBeforeSchedule);
    const boundedDelayMs = Math.max(100, Math.min(Number(delayMs) || 500, remainingMs || 100));
    const attempt = Number(state.requiredArtifactProbeAttempt || 0) + 1;
    state.requiredArtifactProbeAttempt = attempt;
    this.#emitRequestEvent(state, makeEvent('artifact.required_probe_scheduled', {
      requestId: state.requestId,
      expected: requiredArtifactExpectation(state),
      attempt,
      delayMs: boundedDelayMs,
      waitedMs: waitedBeforeSchedule,
      limitMs,
    }));
    state.requiredArtifactTimer = setTimeout(async () => {
      if (!state || state.done || !state.deferredDone) return;
      const waitedMs = Date.now() - (state.requiredArtifactWaitSince || Date.now());
      if (waitedMs >= limitMs) {
        const deferred = state.deferredDone;
        state.deferredDone = null;
        state.requiredArtifactProbeAttempt = 0;
        this.#emitRequestEvent(state, makeEvent('artifact.required_wait_expired', {
          requestId: state.requestId,
          expected: requiredArtifactExpectation(state),
          source: 'server_done_guard',
          waitedMs,
          limitMs,
          attempts: attempt,
        }));
        this.#finish(state, null, preferCompleteText(state.answer, deferred.answer), {
          ...(deferred.metadata || {}),
          artifacts: state.artifacts,
          finishReason: deferred.metadata?.finishReason || 'artifact_settle_expired',
        });
        return;
      }

      try {
        await this.#requestForcedSnapshotForState(state, 'required_artifact_settle', { force: true });
      } catch (err) {
        if (!state.done) {
          this.#emitRequestEvent(state, makeEvent('forced_snapshot.failed', {
            requestId: state.requestId,
            reason: 'required_artifact_settle',
            message: err.message || String(err),
          }));
        }
      }
      if (!state.done && state.deferredDone) {
        const nextDelayMs = Math.min(5_000, 500 * (2 ** Math.min(attempt, 4)));
        this.#scheduleRequiredArtifactProbe(state, nextDelayMs);
      }
    }, boundedDelayMs);
    state.requiredArtifactTimer.unref?.();
  }

  #finishDeferredDoneIfReady(state, source = 'artifact.snapshot') {
    if (!state || state.done || !state.deferredDone || requiredOutputArtifactMissing(state, state.artifacts)) return false;
    const deferred = state.deferredDone;
    state.deferredDone = null;
    clearTimeout(state.requiredArtifactTimer);
    state.requiredArtifactTimer = null;
    state.requiredArtifactProbeAttempt = 0;
    this.#emitRequestEvent(state, makeEvent('artifact.required_wait_satisfied', {
      requestId: state.requestId,
      expected: requiredArtifactExpectation(state),
      source,
      waitedMs: Date.now() - (state.requiredArtifactWaitSince || Date.now()),
      artifactCount: state.artifacts.length,
    }));
    this.#finish(state, null, preferCompleteText(state.answer, deferred.answer), {
      ...(deferred.metadata || {}),
      artifacts: state.artifacts,
      finishReason: deferred.metadata?.finishReason || 'artifact_settle',
    });
    return true;
  }

  #cancelState(state, reason = 'Cancelled') {
    if (!state || state.done) return;

    try {
      if (state.clientId) {
        this.#hub.sendToClient(state.clientId, {
          type: 'prompt.cancel',
          requestId: state.requestId,
          reason,
        });
      }
    } catch {
      // The tab may already be gone. The local request still needs to finish.
    }

    this.#finish(state, abortError(reason), '', { finishReason: 'cancelled' });
  }

  #finish(state, err, answer = '', metadata = {}) {
    if (state.done) return;
    state.done = true;
    this.#cleanupState(state);
    this.#pending.delete(state.requestId);

    if (err) {
      const eventType = err.recoverable || metadata.finishReason === 'recoverable_failed' ? 'request.recoverable_failed' : 'request.error';
      this.#emitRequestEvent(state, makeEvent(eventType, {
        requestId: state.requestId,
        message: err.message,
        phase: err.phase || state.progress?.phase || '',
        recoverable: Boolean(err.recoverable),
      }));
      for (const follower of state.followers || []) {
        if (follower.done) continue;
        follower.detach?.();
        follower.reject(err);
      }
      state.followers?.clear();
      state.reject(err);
      return;
    }

    const finalAnswer = answer || state.answer;
    state.answer = finalAnswer;
    state.thinking = metadata.thinking || state.thinking;
    state.progressText = metadata.progressText || metadata.progress || state.progressText || '';
    const response = {
      id: state.requestId,
      requestId: state.requestId,
      answer: finalAnswer,
      response: finalAnswer,
      thinking: state.thinking,
      reasoningHistory: mergeProgressRecords(state.reasoningHistory, metadata.reasoningHistory),
      progressItems: mergeProgressRecords(state.progressItems, metadata.progressItems),
      responseBlocks: Array.isArray(metadata.responseBlocks) ? metadata.responseBlocks : state.responseBlocks || [],
      codeBlocks: Array.isArray(metadata.codeBlocks) ? metadata.codeBlocks : state.codeBlocks || [],
      codeBlockDiagnostics: Array.isArray(metadata.codeBlockDiagnostics) ? metadata.codeBlockDiagnostics : state.codeBlockDiagnostics || [],
      parserAudit: metadata.parserAudit && typeof metadata.parserAudit === 'object' ? metadata.parserAudit : state.parserAudit || null,
      progressText: state.progressText || '',
      artifacts: metadata.artifacts || state.artifacts,
      session: metadata.session || state.session,
      model: state.model || undefined,
      effort: state.effort || undefined,
      url: metadata.url,
      title: metadata.title,
      finishReason: metadata.finishReason || 'stop',
      turnKey: metadata.turnKey || '',
      turnIndex: metadata.turnIndex ?? -1,
      format: metadata.format || '',
      reason: metadata.reason || '',
      progress: state.progress || null,
      sourceClientId: state.clientId || '',
      events: state.events,
      createdAt: new Date().toISOString(),
    };
    this.#emitRequestEvent(state, makeEvent('request.done', {
      requestId: state.requestId,
      answerLength: finalAnswer.length,
      thinkingLength: state.thinking.length,
      progressLength: state.progressText.length,
      artifactCount: Array.isArray(response.artifacts) ? response.artifacts.length : 0,
      artifacts: response.artifacts,
      sourceClientId: response.sourceClientId || state.clientId || '',
      turnKey: response.turnKey || '',
      progressText: state.progressText || '',
      session: response.session,
      finishReason: response.finishReason,
    }));
    response.events = state.events;
    for (const follower of state.followers || []) {
      if (follower.done) continue;
      follower.detach?.();
      follower.resolve(response);
    }
    state.followers?.clear();
    state.resolve(response);
  }

  #cleanupState(state) {
    clearTimeout(state.timer);
    state.timer = null;
    clearTimeout(state.requiredArtifactTimer);
    state.requiredArtifactTimer = null;
    state.requiredArtifactProbeAttempt = 0;

    if (state.abortSignal && state.abortHandler) {
      state.abortSignal.removeEventListener('abort', state.abortHandler);
      state.abortHandler = null;
    }
  }
}
