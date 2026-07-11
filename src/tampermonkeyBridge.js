import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncMutex } from './mutex.js';
import { config } from './config.js';
import { makeRequestId, appendOnlyDelta } from './protocol.js';
import { log } from './logger.js';

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
  ].join('|')).sort().join('\n');
}

function requiredZipOutputMissing(state, artifacts = state?.artifacts || []) {
  const output = state?.expectedOutput || {};
  return Boolean(
    output.required
    && String(output.expected || '').toLowerCase() === 'zip'
    && (!Array.isArray(artifacts) || artifacts.length === 0)
  );
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
    answerSettleMs: config.answerSettleMs,
    answerDoneSettleMs: config.answerDoneSettleMs,
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
    const stat = await fs.stat(filePath);
    return stat?.isFile() ? stat : null;
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

async function resolveBrowserDownloadedPath(filePath = '', preferredName = '') {
  const absolute = path.resolve(String(filePath || ''));
  if (await statFile(absolute)) return absolute;

  const { dir, patterns } = downloadConflictCandidates(absolute, preferredName);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return absolute;
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
    const candidate = path.join(dir, name);
    const stat = await statFile(candidate);
    if (stat) candidates.push({ path: candidate, mtimeMs: stat.mtimeMs, size: stat.size });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
  return candidates[0]?.path || absolute;
}

export class TampermonkeyBridge {
  #hub;
  #fileStore;
  #eventBus;
  #mutex = new AsyncMutex();
  #pending = new Map();
  #commands = new Map();
  #artifacts = new Map();

  constructor(hub, fileStore = null, eventBus = null) {
    this.#hub = hub;
    this.#fileStore = fileStore;
    this.#eventBus = eventBus;
    this.#hub.on('client.message', ({ clientId, payload }) => this.#handleClientMessage(clientId, payload));
    this.#hub.on?.('client.activity', ({ clientId, client, payload }) => this.#handleClientActivity(clientId, client, payload));
    this.#hub.on?.('client.ready', (client) => this.#handleClientReady(client));
  }

  get pageUrl() {
    return this.#hub.activeClient?.url || null;
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

  async #resolvePromptClient(state, chatOptions = {}, options = {}) {
    const explicitClientId = String(options.sourceClientId || options.clientId || chatOptions.sourceClientId || chatOptions.clientId || '').trim();
    const allClients = Array.from(this.#hub.clients || []).filter((client) => client?.ready || client?.id);
    const incompatibleClients = allClients.filter((client) => client.compatible === false || client.compatibility?.compatible === false);
    const clients = allClients.filter((client) => client.compatible !== false && client.compatibility?.compatible !== false);
    const idleClients = clients.filter((client) => this.#isPromptClientIdle(client));
    const desiredSessionId = !chatOptions.newSession ? normalizeConversationId(chatOptions.sessionId || '') : '';

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

      const exactBusy = clients.filter((client) => clientMatchesSession(client, desiredSessionId));
      if (exactBusy.length) {
        const busy = exactBusy.map((client) => busyClientLabel(client, this.#hub.serverInstanceId)).join(', ');
        throw new Error(`Session ${desiredSessionId} is open, but its tab is busy (${busy}). Wait, /resume, or select another idle tab to switch.`);
      }
    }

    const active = this.#hub.activeClient;
    if (active && this.#isPromptClientIdle(active)) return { client: active, reason: active.selected ? 'selected_client' : 'active_client', sessionSwitch: false };

    const rankedIdle = this.#rankPromptClients(idleClients);
    if (rankedIdle.length === 1 && clients.length === 1) return { client: rankedIdle[0], reason: 'single_client', sessionSwitch: false };
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

  async resumeActiveRequest(callbacks = {}, options = {}) {
    if (options.signal?.aborted) throw abortError(options.signal.reason || 'Request cancelled');

    const target = this.#resolveResumeTarget(options);
    const active = target.client;
    const activeRequest = target.activeRequest || null;
    const requestId = String(activeRequest.requestId);
    const expectedRequestId = String(options.expectedRequestId || '');
    if (expectedRequestId && expectedRequestId !== requestId) {
      throw new Error(`Active ChatGPT prompt belongs to ${requestId}, not ${expectedRequestId}. Use /recover after it finishes, or select the tab/session that is running the expected prompt.`);
    }
    if (this.#pending.has(requestId)) throw new Error(`Request is already tracked locally: ${requestId}`);
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
          session: null,
          model: chatOptions.model,
          effort: chatOptions.effort,
          expectedOutput: chatOptions.expectedOutput || { expected: '', required: false },
          requiredArtifactWaitSince: 0,
          requiredArtifactTimer: null,
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
    return { models: response.models || [], current: response.current || null };
  }

  async listEfforts(options = {}) {
    const response = await this.#sendCommand('efforts.list', {}, options);
    return { efforts: response.efforts || [], current: response.current || null };
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
      reasoningHistory: Array.isArray(response.reasoningHistory) ? response.reasoningHistory : [],
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
      const resolvedFilePath = await resolveBrowserDownloadedPath(response.filePath, response.name || artifact.name || artifactId);
      const resolvedName = path.basename(resolvedFilePath) || response.name || artifact.name || artifactId;
      if (resolvedFilePath !== path.resolve(response.filePath)) {
        this.#eventBus?.emitUser({ type: 'artifact.download.renamed', data: { artifactId, requestedPath: response.filePath, resolvedPath: resolvedFilePath } });
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
        removeSource: true,
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
      const metadata = {
        thinking: String(payload.thinking ?? state.thinking ?? ''),
        reasoningHistory: Array.isArray(payload.reasoningHistory) ? payload.reasoningHistory : [],
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

      if (requiredZipOutputMissing(state, artifacts)) {
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
      if (state.done || state.clientId !== clientId || state.promptSubmitted || !state.promptPayload) continue;
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
      const timeoutMs = this.#meaningfulTimeoutMs();
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

    const timeoutMs = this.#meaningfulTimeoutMs();
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
    const requiredArtifactMissing = requiredZipOutputMissing(state, artifacts.length ? artifacts : state.artifacts);
    if (terminalConfirmed && hasTerminalOutput && !generationActive && !requiredArtifactMissing) {
      this.#updateProgress(state, { phase: 'final_snapshot_ready', requestId: state.requestId, clientId: state.clientId, meaningful: phaseChanged || snapshotChanged }, { emit: false });
      this.#finish(state, null, state.answer || answer, {
        thinking: state.thinking || thinking,
        reasoningHistory: Array.isArray(response.reasoningHistory) ? response.reasoningHistory : [],
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
      expected: 'zip',
      source: 'server_done_guard',
      limitMs: Number(config.requiredArtifactSettleMs) || 30_000,
      sourceClientId: state.clientId || '',
      assistantTurnKey: metadata.turnKey || state.progress?.assistantTurnKey || '',
    }));
    this.#scheduleRequiredArtifactProbe(state, 750);
  }

  #scheduleRequiredArtifactProbe(state, delayMs = 2_000) {
    if (!state || state.done || !state.deferredDone) return;
    clearTimeout(state.requiredArtifactTimer);
    state.requiredArtifactTimer = setTimeout(async () => {
      if (!state || state.done || !state.deferredDone) return;
      const limitMs = Math.max(1_500, Number(config.requiredArtifactSettleMs) || 30_000);
      const waitedMs = Date.now() - (state.requiredArtifactWaitSince || Date.now());
      if (waitedMs >= limitMs) {
        const deferred = state.deferredDone;
        state.deferredDone = null;
        this.#emitRequestEvent(state, makeEvent('artifact.required_wait_expired', {
          requestId: state.requestId,
          expected: 'zip',
          source: 'server_done_guard',
          waitedMs,
          limitMs,
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
      if (!state.done && state.deferredDone) this.#scheduleRequiredArtifactProbe(state, 2_000);
    }, Math.max(100, Number(delayMs) || 2_000));
    state.requiredArtifactTimer.unref?.();
  }

  #finishDeferredDoneIfReady(state, source = 'artifact.snapshot') {
    if (!state || state.done || !state.deferredDone || !state.artifacts.length) return false;
    const deferred = state.deferredDone;
    state.deferredDone = null;
    clearTimeout(state.requiredArtifactTimer);
    state.requiredArtifactTimer = null;
    this.#emitRequestEvent(state, makeEvent('artifact.required_wait_satisfied', {
      requestId: state.requestId,
      expected: 'zip',
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
      reasoningHistory: Array.isArray(metadata.reasoningHistory) ? metadata.reasoningHistory : [],
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
    state.resolve(response);
  }

  #cleanupState(state) {
    clearTimeout(state.timer);
    state.timer = null;
    clearTimeout(state.requiredArtifactTimer);
    state.requiredArtifactTimer = null;

    if (state.abortSignal && state.abortHandler) {
      state.abortSignal.removeEventListener('abort', state.abortHandler);
      state.abortHandler = null;
    }
  }
}
