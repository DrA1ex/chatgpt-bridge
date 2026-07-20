import { config } from './config.js';
import { makeRequestId } from './protocol.js';
import { safeBridgeServerUrl } from './browserLaunch.js';
import { openExternalBrowserUrl } from './bridge/externalBrowser.js';
import {
  compactRequestState,
  makeEvent,
} from './bridge/requestState.js';
import {
  RequestEffectType,
  RequestEventType,
} from './bridge/state/requestEvents.js';
import { BridgeOperations } from './bridge/coordinator/bridgeOperations.js';
import { RequestLifecycleCoordinator } from './bridge/coordinator/requestLifecycleCoordinator.js';
import { BridgeClientEventRouter } from './bridge/coordinator/bridgeClientEventRouter.js';
import { BrowserClientCoordinator } from './bridge/coordinator/browserClientCoordinator.js';
import { ObservedTurnJournal } from './bridge/observedTurns/observedTurnJournal.js';
import { BridgeCommandRegistry } from './bridge/coordinator/bridgeCommandRegistry.js';
import { RequestSubmissionCoordinator } from './bridge/coordinator/requestSubmissionCoordinator.js';
import { waitForSteerReadiness } from './bridge/coordinator/steerReadiness.js';

export { browserLaunchUrl } from './browserLaunch.js';
export { openExternalBrowserUrl } from './bridge/externalBrowser.js';
export {
  removeCapturedBrowserDownload,
  resolveBrowserDownloadedPath,
} from './bridge/browserDownloads.js';

export class BrowserBridge {
  #hub;
  #fileStore;
  #eventBus;
  #pending = new Map();
  #artifacts = new Map();
  #observedTurnJournal = new ObservedTurnJournal({ limit: 200 });
  #lifecycle;
  #browserClients;
  #clientEvents;
  #operations;
  #commandRegistry;
  #submission;
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
    this.#commandRegistry = new BridgeCommandRegistry({ hub: this.#hub, eventBus: this.#eventBus });
    this.#operations = new BridgeOperations({
      sendCommand: async (type, data, options) => await this.#sendCommand(type, data, options),
      fileStore: this.#fileStore,
      eventBus: this.#eventBus,
      artifacts: this.#artifacts,
    });
    this.#lifecycle = new RequestLifecycleCoordinator({
      hub: this.#hub,
      pending: this.#pending,
      artifacts: this.#artifacts,
      eventBus: this.#eventBus,
      sendCommand: async (type, data, options) => await this.#sendCommand(type, data, options),
      resumePrompt: async (sourceClientId, payload, options = {}) => {
        const client = Array.from(this.#hub.clients || []).find((candidate) => candidate.id === sourceClientId);
        if (!client) throw new Error(`Browser extension client not found for prompt recovery: ${sourceClientId}`);
        const state = this.#pending.get(String(payload.requestId || ''));
        const sent = this.#browserClients.sendPromptToClient(client, payload, { ...options, request: this.#lifecycle.requestIdentity(state) });
        return await sent.delivered;
      },
    });
    this.#browserClients = new BrowserClientCoordinator({
      hub: this.#hub,
      pending: this.#pending,
      lifecycle: this.#lifecycle,
      runtimeOptions: this.#runtimeOptions,
      sendCommand: async (type, data, options) => await this.#sendCommand(type, data, options),
      releaseCoordinator: this.#commandRegistry,
    });
    this.#submission = new RequestSubmissionCoordinator({
      pending: this.#pending,
      lifecycle: this.#lifecycle,
      browserClients: this.#browserClients,
      eventBus: this.#eventBus,
      hub: this.#hub,
      sendCommand: async (type, data, options) => await this.#sendCommand(type, data, options),
      resolveAttachments: async (attachments) => await this.#resolveAttachments(attachments),
    });
    this.#clientEvents = new BridgeClientEventRouter({
      pending: this.#pending,
      commands: this.#commandRegistry.commands,
      artifacts: this.#artifacts,
      lifecycle: this.#lifecycle,
      eventBus: this.#eventBus,
      publishObservedTurn: (turn) => this.#publishObservedTurn(turn),
      registerObservedArtifacts: (artifacts, defaults) => this.registerObservedArtifacts(artifacts, defaults),
      handleCommandResponse: (clientId, payload) => this.#commandRegistry.handleResponse(clientId, payload),
      sendCommand: async (type, data, options) => await this.#sendCommand(type, data, options),
    });
    const canonicalHandler = async ({ eventName, data }) => {
      if (eventName === 'client.message') return await this.#clientEvents.handleClientMessage(data.clientId, data.payload, data.envelope);
      if (eventName === 'client.activity') return await this.#clientEvents.handleClientActivity(data.clientId, data.client, data.payload, data.envelope);
      return undefined;
    };
    if (typeof this.#hub.setCanonicalMessageHandler === 'function') this.#hub.setCanonicalMessageHandler(canonicalHandler);
    else {
      this.#hub.on?.('client.message', (data) => canonicalHandler({ eventName: 'client.message', data }));
      this.#hub.on?.('client.activity', (data) => canonicalHandler({ eventName: 'client.activity', data }));
    }
    this.#hub.on?.('client.ready', (client) => this.#clientEvents.handleClientReady(client));
    this.#hub.on?.('client.closed', (client) => this.#lifecycle.handleClientClosed(client));
  }

  get pageUrl() {
    return this.#hub.activeClient?.url || null;
  }

  canAutoOpenPromptTab(options = {}) {
    return this.#browserClients.canAutoOpenPromptTab(options);
  }

  activeRequestCandidates() {
    return this.#browserClients.activeRequestCandidates();
  }

  findActiveRequest(options = {}) {
    return this.#browserClients.findActiveRequest(options);
  }

  async openBrowserTab(options = {}) {
    return await this.#browserClients.openBrowserTab(options);
  }

  async closeBrowserTab(options = {}) {
    return await this.#browserClients.closeBrowserTab(options);
  }

  async reloadExtension(options = {}) {
    return await this.#browserClients.reloadExtension(options);
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
      pendingCommands: this.#commandRegistry.size,
      artifacts: this.#artifacts.size,
      activeRequests: this.requestDiagnostics(),
      canonicalRequestState: {
        enabled: true,
        tracked: this.#lifecycle.trackedCount(),
        authoritativeLifecycle: true,
        extensionProtocol: 'v4-only',
        scheduledDeadlines: this.#lifecycle.deadlines().length,
      },
      serverInstanceId: this.#hub.serverInstanceId || '',
      autoOpenTab: Boolean(this.#runtimeOptions.autoOpenTab),
    };
  }

  requestDiagnostics() {
    return Array.from(this.#pending.values()).map((state) => {
      const canonicalState = this.#lifecycle.snapshot(state.requestId);
      const observationData = canonicalState?.lastObservation?.data || null;
      const observation = observationData?.observation || null;
      const activeRequest = observation?.activeRequest || null;
      return {
        ...compactRequestState(state),
        phase: canonicalState?.displayPhase || canonicalState?.lifecycle || state.progress?.phase || 'unknown',
        sourceUrl: canonicalState?.source?.url || state.progress?.url || '',
        sourceSession: canonicalState?.source?.conversationId
          ? { id: canonicalState.source.conversationId }
          : state.progress?.session || state.session || null,
        submittedUserTurnKey: String(activeRequest?.submittedUserTurnKey || canonicalState?.response?.userTurnKey || ''),
        submittedUserTurnIndex: Number(activeRequest?.submittedUserTurnIndex ?? -1),
        assistantTurnKey: String(observationData?.turnKey || activeRequest?.assistantTurnKey || ''),
        assistantTurnIndex: Number(observationData?.turnIndex ?? activeRequest?.assistantTurnIndex ?? -1),
        currentGenerationActive: canonicalState?.generation === 'active',
        canonicalState,
        canonicalDeadlines: this.#lifecycle.deadlines(state.requestId),
      };
    });
  }

  requestStateDiagnostics(requestId = '') {
    return this.#lifecycle.diagnostics(requestId);
  }

  async requestForcedSnapshot(requestId, options = {}) {
    const state = this.#pending.get(String(requestId || ''));
    if (!state) throw new Error(`No pending request for forced snapshot: ${requestId}`);
    return await this.#lifecycle.runRequestEffect(state, {
      id: `${state.requestId}:manual-snapshot:${Date.now()}`,
      type: RequestEffectType.RESPONSE_SNAPSHOT,
      data: { reason: options.reason || 'manual_forced_snapshot', manual: true },
      execute: async () => await this.#lifecycle.requestForcedSnapshotForState(
        state,
        options.reason || 'manual_forced_snapshot',
        { manual: true, force: true },
      ),
    });
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

    await waitForSteerReadiness({
      requestId: id,
      state,
      lifecycle: this.#lifecycle,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      steerReadyTimeoutMs: options.steerReadyTimeoutMs,
    });

    this.#lifecycle.emitRequestEvent(state, makeEvent('prompt.steer.requested', { requestId: id, message: text, sourceClientId }), { canonical: false });
    const response = await this.#lifecycle.runRequestEffect(state, {
      id: `${id}:prompt-steer:${Date.now()}`,
      type: 'prompt.steer',
      data: { sourceClientId, messageLength: text.length },
      execute: async () => await this.#sendCommand('prompt.steer', {
        requestId: id,
        message: text,
        responseEpoch: Number(this.#lifecycle.getState(id)?.response?.epoch || 0) + 1,
      }, {
        ...options,
        sourceClientId,
        timeoutMs: Number(options.timeoutMs) || 30_000,
        request: this.#lifecycle.requestIdentity(state, Number(this.#lifecycle.getState(id)?.response?.epoch || 0)),
      }),
    });
    this.#lifecycle.ingestRequestTransition(state, this.#lifecycle.canonicalEvent(state, RequestEventType.STEER_ACCEPTED, {
      messageLength: text.length, sourceClientId, userTurnKey: response?.submittedUserTurnKey || response?.userTurnKey || '',
    }, 'browser_prompt_steer'));
    this.#lifecycle.emitRequestEvent(state, makeEvent('prompt.steer.accepted', { requestId: id, message: text, sourceClientId, responseEpoch: this.#lifecycle.getState(id)?.response?.epoch || 0 }), { canonical: false });
    this.#lifecycle.touchState(state, 'prompt.steer.accepted');
    return response;
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

  listKnownArtifacts() {
    return Array.from(this.#artifacts.values());
  }

  cancelActive(reason = 'Cancelled by user') {
    const pending = Array.from(this.#pending.values());
    for (const state of pending) {
      this.#lifecycle.cancelState(state, reason);
    }
    return pending.length;
  }


  async resumeActiveRequest(callbacks = {}, options = {}) {
    return await this.#submission.resumeActiveRequest(callbacks, options);
  }

  async sendToChatGPT(message, callbacks = {}, options = {}) {
    return await this.#submission.sendToChatGPT(message, callbacks, options);
  }

  async sendRequest(request, callbacks = {}, options = {}) {
    return await this.#submission.sendRequest(request, callbacks, options);
  }

  async deleteSession(sessionId, expectedUrl, options = {}) {
    return await this.#operations.deleteSession(sessionId, expectedUrl, options);
  }

  async listSessions(options = {}) {
    return await this.#operations.listSessions(options);
  }

  async newSession(options = {}) {
    return await this.#operations.newSession(options);
  }

  async selectSession(sessionId, options = {}) {
    return await this.#operations.selectSession(sessionId, options);
  }

  async listModels(options = {}) {
    return await this.#operations.listModels(options);
  }

  async listEfforts(options = {}) {
    return await this.#operations.listEfforts(options);
  }

  async applyIntelligence(values = {}, options = {}) {
    return await this.#operations.applyIntelligence(values, options);
  }

  async clearComposerAttachments(options = {}) {
    return await this.#operations.clearComposerAttachments(options);
  }

  async recoverResponses(options = {}) {
    return await this.#operations.recoverResponses(options);
  }

  async recoverLatestResponse(options = {}) {
    return await this.#operations.recoverLatestResponse(options);
  }

  async recoverResponseByTurnKey(options = {}) {
    return await this.#operations.recoverResponseByTurnKey(options);
  }

  async fetchArtifact(artifactId, options = {}) {
    return await this.#operations.fetchArtifact(artifactId, options);
  }

  onObservedTurn(listener) { return this.#observedTurnJournal.onTurn(listener); }

  onObservedTurnEnvelope(listener) { return this.#observedTurnJournal.onEnvelope(listener); }

  listObservedTurns(options = {}) { return this.#observedTurnJournal.list(options); }

  observedTurnStreamState(options = {}) { return { ...this.#observedTurnJournal.classifyCursor(options), serverInstanceId: this.#hub.serverInstanceId || '' }; }

  registerObservedArtifacts(artifacts = [], metadata = {}) {
    return this.#operations.registerObservedArtifacts(artifacts, metadata);
  }

  async submitPassivePrompt(options = {}) {
    return await this.#operations.submitPassivePrompt(options);
  }

  async reloadBrowserTab(options = {}) {
    const sourceClientId = String(options.sourceClientId || options.clientId || '').trim();
    const active = sourceClientId ? this.findActiveRequest({ sourceClientId }) : null;
    return await this.#operations.reloadBrowserTab({
      ...options,
      sourceClientId,
      requestId: String(options.requestId || active?.activeRequest?.requestId || ''),
    });
  }

  async capturePageLayout(options = {}) {
    const sourceClientId = String(options.sourceClientId || options.clientId || '').trim();
    const active = sourceClientId ? this.findActiveRequest({ sourceClientId }) : null;
    return await this.#operations.capturePageLayout({
      ...options,
      sourceClientId,
      requestId: String(options.requestId || active?.activeRequest?.requestId || ''),
    });
  }

  async close({ cancelPending = true } = {}) {
    if (cancelPending) {
      for (const state of this.#pending.values()) {
        this.#lifecycle.cancelState(state, 'Bridge shutting down');
      }
    }
    this.#pending.clear();
    this.#lifecycle.close();

    this.#commandRegistry.close('Bridge shutting down');
  }

  #publishObservedTurn(turn = {}) {
    const envelope = this.#observedTurnJournal.publish(turn);
    this.#eventBus?.emitDebug?.({
      type: 'watch.turn.journaled',
      data: { streamEpoch: envelope.streamEpoch, sequence: envelope.sequence, turnKey: envelope.turn?.turnKey || '' },
    });
    return envelope;
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
    const url = new URL(`/extension/files/${encodeURIComponent(fileId)}/download`, config.publicBaseUrl);
    url.searchParams.set('token', config.bridgeToken);
    return {
      id: record.id,
      name: record.name,
      mime: record.mime || 'application/octet-stream',
      size: record.size,
      url: url.toString(),
    };
  }

  #sendCommand(type, payload = {}, options = {}) {
    return this.#commandRegistry.send(type, payload, options);
  }

}
