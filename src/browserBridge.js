import { AsyncMutex } from './mutex.js';
import { config } from './config.js';
import { makeRequestId } from './protocol.js';
import { log } from './logger.js';
import { safeBridgeServerUrl } from './browserLaunch.js';
import { openExternalBrowserUrl } from './bridge/externalBrowser.js';
import {
  abortError,
  compactRequestState,
  makeEvent,
  noopCallbacks,
  normalizeOptions,
} from './bridge/requestState.js';
import {
  RequestEffectType,
  RequestEventType,
  RequestTerminalCode,
} from './bridge/state/requestEvents.js';
import { BridgeOperations } from './bridge/coordinator/bridgeOperations.js';
import { RequestLifecycleCoordinator } from './bridge/coordinator/requestLifecycleCoordinator.js';
import { BridgeClientEventRouter } from './bridge/coordinator/bridgeClientEventRouter.js';
import { BrowserClientCoordinator } from './bridge/coordinator/browserClientCoordinator.js';

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
  #mutex = new AsyncMutex();
  #pending = new Map();
  #commands = new Map();
  #artifacts = new Map();
  #observedTurnListeners = new Set();
  #observedTurnEnvelopeListeners = new Set();
  #observedTurns = [];
  #observedTurnSequence = 0;
  #lifecycle;
  #browserClients;
  #clientEvents;
  #operations;
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
    });
    this.#browserClients = new BrowserClientCoordinator({
      hub: this.#hub,
      pending: this.#pending,
      lifecycle: this.#lifecycle,
      runtimeOptions: this.#runtimeOptions,
      sendCommand: async (type, data, options) => await this.#sendCommand(type, data, options),
    });
    this.#clientEvents = new BridgeClientEventRouter({
      pending: this.#pending,
      commands: this.#commands,
      artifacts: this.#artifacts,
      lifecycle: this.#lifecycle,
      eventBus: this.#eventBus,
      publishObservedTurn: (turn) => this.#publishObservedTurn(turn),
      registerObservedArtifacts: (artifacts, defaults) => this.registerObservedArtifacts(artifacts, defaults),
      sendPromptToClient: (client, payload, options) => this.#browserClients.sendPromptToClient(client, payload, options),
      handleCommandResponse: (clientId, payload) => this.#handleCommandResponse(clientId, payload),
    });
    this.#hub.on('client.message', ({ clientId, payload }) => this.#clientEvents.handleClientMessage(clientId, payload));
    this.#hub.on?.('client.activity', ({ clientId, client, payload }) => this.#clientEvents.handleClientActivity(clientId, client, payload));
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
      pendingCommands: this.#commands.size,
      artifacts: this.#artifacts.size,
      activeRequests: this.requestDiagnostics(),
      canonicalRequestState: {
        enabled: true,
        tracked: this.#lifecycle.trackedCount(),
        authoritativeLifecycle: true,
        compatibilityInput: true,
        scheduledDeadlines: this.#lifecycle.deadlines().length,
      },
      serverInstanceId: this.#hub.serverInstanceId || '',
      autoOpenTab: Boolean(this.#runtimeOptions.autoOpenTab),
    };
  }

  requestDiagnostics() {
    return Array.from(this.#pending.values()).map((state) => ({
      ...compactRequestState(state),
      canonicalState: this.#lifecycle.snapshot(state.requestId),
      canonicalDeadlines: this.#lifecycle.deadlines(state.requestId),
    }));
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
    this.#lifecycle.emitRequestEvent(state, makeEvent('prompt.steer.requested', { requestId: id, message: text, sourceClientId }), { canonical: false });
    const response = await this.#lifecycle.runRequestEffect(state, {
      id: `${id}:prompt-steer:${Date.now()}`,
      type: 'prompt.steer',
      data: { sourceClientId, messageLength: text.length },
      execute: async () => await this.#sendCommand('prompt.steer', { requestId: id, message: text }, {
        ...options,
        sourceClientId,
        timeoutMs: Number(options.timeoutMs) || 30_000,
      }),
    });
    this.#lifecycle.emitRequestEvent(state, makeEvent('prompt.steer.accepted', { requestId: id, message: text, sourceClientId }), { canonical: false });
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

    const target = this.#browserClients.resolveResumeTarget(options);
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
          this.#lifecycle.cancelState(state, String(state.abortSignal.reason || 'Request cancelled'));
        };
        state.abortSignal.addEventListener('abort', state.abortHandler, { once: true });
      }

      this.#pending.set(requestId, state);
      this.#lifecycle.ingestRequestTransition(state, this.#lifecycle.canonicalEvent(state, RequestEventType.CREATED, {
        resumed: true,
        sourceClientId: active.id,
        sessionId: activeRequest.sessionId || active.session?.id || '',
      }, 'request_resume'));
      this.#lifecycle.emitRequestEvent(state, makeEvent('request.resumed', {
        requestId,
        clientId: active.id,
        activeRequest,
        promptPreview: activeRequest.promptPreview || '',
      }));
      state.callbacks.onStatus?.('resumed', { requestId, activeRequest });
      this.#lifecycle.touchState(state, 'request.resumed');

      void this.#lifecycle.runRequestEffect(state, {
        id: `${requestId}:request-resume`,
        type: 'request.resume',
        data: { sourceClientId: active.id },
        execute: async () => {
          const response = await this.#sendCommand('request.resume', { requestId }, {
            ...options,
            sourceClientId: active.id,
            timeoutMs: options.resumeTimeoutMs || options.timeoutMs || 10_000,
          });
          const remote = response?.activeRequest || null;
          if (!remote?.requestId) {
            const error = new Error('Selected tab reported no active prompt to resume.');
            error.code = 'RESUME_ACTIVE_REQUEST_MISSING';
            throw error;
          }
          if (remote.requestId !== requestId) {
            const error = new Error(`Selected tab is running ${remote.requestId}, not ${requestId}.`);
            error.code = 'RESUME_REQUEST_MISMATCH';
            throw error;
          }
          return response;
        },
      }).then((response) => {
        if (state.done) return;
        const remote = response.activeRequest;
        state.session = response.session || state.session;
        this.#lifecycle.emitRequestEvent(state, makeEvent('session.snapshot', { requestId, session: state.session }), { canonical: false });
        this.#lifecycle.emitRequestEvent(state, makeEvent('resume.attached', { requestId, activeRequest: remote, promptPreview: remote.promptPreview || '' }), { canonical: false });
        this.#lifecycle.touchState(state, 'resume.attached');
      }).catch(() => {
        // EffectRunner has already reported the typed failure to the canonical request machine.
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
          abortSignal: options.signal || null,
          abortHandler: null,
        };

        const startedEvent = makeEvent('request.started', {
          requestId,
          model: chatOptions.model || undefined,
          effort: chatOptions.effort || undefined,
          sessionId: chatOptions.sessionId || undefined,
          newSession: chatOptions.newSession || undefined,
          expectedOutput: chatOptions.expectedOutput || { expected: '', required: false },
          attachments: attachments.map(({ contentBase64, ...attachment }) => attachment),
        });
        this.#lifecycle.ingestRequestTransition(state, this.#lifecycle.canonicalEvent(state, RequestEventType.CREATED, {
          expectedOutput: chatOptions.expectedOutput || { expected: '', required: false },
          sessionId: chatOptions.sessionId || '',
          sourceClientId: '',
        }, 'request_start'));
        this.#lifecycle.emitRequestEvent(state, startedEvent);

        this.#lifecycle.touchState(state, 'request.started');

        if (state.abortSignal) {
          state.abortHandler = () => {
            this.#lifecycle.cancelState(state, String(state.abortSignal.reason || 'Request cancelled'));
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
          Promise.resolve(this.#browserClients.resolvePromptClient(state, chatOptions, options)).then((target) => {
            const targetClient = target?.client || null;
            const { client, delivered } = this.#browserClients.sendPromptToClient(targetClient, promptPayload, options);
            state.clientId = client.id;
            this.#lifecycle.ingestRequestTransition(state, this.#lifecycle.canonicalEvent(state, RequestEventType.SOURCE_BOUND, {
              clientId: client.id,
              sessionId: chatOptions.sessionId || '',
              url: client.url || '',
            }, 'source_selection'));
            this.#lifecycle.emitRequestEvent(state, makeEvent('client.target.resolved', {
              requestId,
              clientId: client.id,
              reason: target?.reason || 'active_client',
              sessionId: chatOptions.sessionId || undefined,
              sessionSwitch: Boolean(target?.sessionSwitch),
              sourceUrl: client.url || '',
            }));
            if (target?.sessionSwitch && chatOptions.sessionId) {
              this.#lifecycle.emitRequestEvent(state, makeEvent('session.switch.requested', { requestId, clientId: client.id, sessionId: chatOptions.sessionId }));
            }
            void this.#lifecycle.runRequestEffect(state, {
              id: `${requestId}:prompt-delivery`,
              type: 'prompt.delivery',
              data: { clientId: client.id },
              execute: async () => await delivered,
            }).then(() => {
              if (state.done) return;
              state.delivered = true;
              this.#lifecycle.ingestRequestTransition(state, this.#lifecycle.canonicalEvent(state, RequestEventType.PROMPT_DELIVERED, {
                clientId: client.id,
              }, 'prompt_delivery'));
              this.#lifecycle.updateProgress(state, { phase: 'prompt_delivered_to_extension', requestId, clientId: client.id, meaningful: true }, { emit: false });
              this.#lifecycle.emitRequestEvent(state, makeEvent('prompt.delivered', { requestId, clientId: client.id }));
            }).catch((err) => {
              if (state.done || this.#lifecycle.getState(state.requestId)?.terminal) return;
              this.#lifecycle.ingestRequestTransition(state, this.#lifecycle.canonicalEvent(state, RequestEventType.FAILED, {
                code: err.code || RequestTerminalCode.EFFECT_FAILED,
                message: err.message || String(err),
              }, 'prompt_delivery_fallback'));
            });
          }).catch((err) => {
            if (state.done) return;
            this.#lifecycle.ingestRequestTransition(state, this.#lifecycle.canonicalEvent(state, RequestEventType.FAILED, {
              code: err.code || RequestTerminalCode.FAILED,
              message: err.message || String(err),
            }, 'prompt_target_resolution'));
          });
        } catch (err) {
          this.#lifecycle.cleanupState(state);
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

  onObservedTurn(listener) {
    if (typeof listener !== 'function') return () => {};
    this.#observedTurnListeners.add(listener);
    return () => this.#observedTurnListeners.delete(listener);
  }

  onObservedTurnEnvelope(listener) {
    if (typeof listener !== 'function') return () => {};
    this.#observedTurnEnvelopeListeners.add(listener);
    return () => this.#observedTurnEnvelopeListeners.delete(listener);
  }

  listObservedTurns({ afterSequence = 0, limit = 100 } = {}) {
    const after = Math.max(0, Number(afterSequence) || 0);
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    return this.#observedTurns.filter((entry) => entry.sequence > after).slice(-safeLimit).map((entry) => ({ ...entry, turn: { ...entry.turn } }));
  }

  registerObservedArtifacts(artifacts = [], metadata = {}) {
    return this.#operations.registerObservedArtifacts(artifacts, metadata);
  }

  async submitPassivePrompt(options = {}) {
    return await this.#operations.submitPassivePrompt(options);
  }

  async reloadBrowserTab(options = {}) {
    return await this.#operations.reloadBrowserTab(options);
  }

  async close({ cancelPending = true } = {}) {
    if (cancelPending) {
      for (const state of this.#pending.values()) {
        this.#lifecycle.cancelState(state, 'Bridge shutting down');
      }
    }
    this.#pending.clear();
    this.#lifecycle.close();

    for (const command of this.#commands.values()) {
      clearTimeout(command.timer);
      command.reject(new Error('Bridge shutting down'));
    }
    this.#commands.clear();
  }

  #publishObservedTurn(turn = {}) {
    const envelope = {
      sequence: ++this.#observedTurnSequence,
      observedAt: new Date().toISOString(),
      turn: { ...turn },
    };
    this.#observedTurns.push(envelope);
    if (this.#observedTurns.length > 200) this.#observedTurns.splice(0, this.#observedTurns.length - 200);
    for (const listener of this.#observedTurnListeners) {
      try { listener(envelope.turn); } catch (err) { this.#eventBus?.emitDebug({ type: 'watch.turn.listener_failed', data: { message: err.message || String(err) } }); }
    }
    for (const listener of this.#observedTurnEnvelopeListeners) {
      try { listener(envelope); } catch (err) { this.#eventBus?.emitDebug({ type: 'watch.turn.envelope_listener_failed', data: { message: err.message || String(err) } }); }
    }
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
      const timer = setTimeout(() => {
        this.#commands.delete(commandId);
        reject(new Error(`Timed out waiting for ${type} response after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      const command = { commandId, requestType: type, clientId: '', resolve, reject, timer, chunks: null, chunkMeta: null, sourceClientId };
      this.#commands.set(commandId, command);

      let client;
      try {
        if (sourceClientId && options.allowIncompatible === true && typeof this.#hub.sendControlToClient === 'function') {
          client = this.#hub.sendControlToClient(sourceClientId, { type, commandId, ...payload });
        } else if (sourceClientId && typeof this.#hub.sendToClient === 'function') {
          client = this.#hub.sendToClient(sourceClientId, { type, commandId, ...payload });
        } else {
          client = this.#hub.sendToActive({ type, commandId, ...payload });
        }
        command.clientId = client.id;
        command.sourceClientId = sourceClientId || client.id;
      } catch (err) {
        clearTimeout(timer);
        this.#commands.delete(commandId);
        reject(err);
        return;
      }

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

}
