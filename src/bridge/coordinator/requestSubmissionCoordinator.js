import { randomUUID } from 'node:crypto';
import { AsyncMutex } from '../../mutex.js';
import { makeRequestId } from '../../protocol.js';
import { log } from '../../logger.js';
import {
  abortError,
  makeEvent,
  noopCallbacks,
  normalizeOptions,
} from '../requestState.js';
import {
  RequestEventType,
  RequestTerminalCode,
} from '../state/requestEvents.js';

/**
 * Owns construction and delivery of active bridge requests. The canonical
 * lifecycle remains in RequestLifecycleCoordinator; this class only creates
 * pending runtime records and binds them to a selected browser source.
 */
export class RequestSubmissionCoordinator {
  constructor({ pending, lifecycle, browserClients, eventBus = null, hub, sendCommand, resolveAttachments }) {
    this.pending = pending;
    this.lifecycle = lifecycle;
    this.browserClients = browserClients;
    this.eventBus = eventBus;
    this.hub = hub;
    this.sendCommand = sendCommand;
    this.resolveAttachments = resolveAttachments;
    this.mutex = new AsyncMutex();
  }

  followPendingRequest(state, callbacks = {}, options = {}) {
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
      ? this.pending.get(localRequestId)
      : this.pending.size === 1 ? this.pending.values().next().value : null;
    if (localExisting) return await this.followPendingRequest(localExisting, callbacks, options);

    const target = this.browserClients.resolveResumeTarget(options);
    const active = target.client;
    const activeRequest = target.activeRequest || null;
    const requestId = String(activeRequest.requestId);
    const previousOwnerServerInstanceId = String(activeRequest.ownerServerInstanceId || '');
    const currentOwnerServerInstanceId = String(this.hub.serverInstanceId || previousOwnerServerInstanceId);
    const ownerHandoff = Boolean(previousOwnerServerInstanceId && currentOwnerServerInstanceId
      && previousOwnerServerInstanceId !== currentOwnerServerInstanceId);
    const resumeIdentity = {
      requestId,
      leaseId: ownerHandoff ? randomUUID() : String(activeRequest.leaseId || ''),
      ownerServerInstanceId: currentOwnerServerInstanceId,
      responseEpoch: Math.max(0, Number(activeRequest.responseEpoch) || 0),
    };
    if (expectedRequestId && expectedRequestId !== requestId) {
      throw new Error(`Active ChatGPT prompt belongs to ${requestId}, not ${expectedRequestId}. Use /recover after it finishes, or select the tab/session that is running the expected prompt.`);
    }
    if (this.pending.size) throw new Error('Another local request is already running. Use /stop or wait before /resume.');

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
          this.lifecycle.cancelState(state, String(state.abortSignal.reason || 'Request cancelled'));
        };
        state.abortSignal.addEventListener('abort', state.abortHandler, { once: true });
      }

      this.pending.set(requestId, state);
      this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.CREATED, {
        resumed: true,
        sourceClientId: active.id,
        sessionId: activeRequest.sessionId || active.session?.id || '',
        leaseId: resumeIdentity.leaseId,
        ownerServerInstanceId: resumeIdentity.ownerServerInstanceId,
        responseEpoch: resumeIdentity.responseEpoch,
      }, 'request_resume'));
      this.lifecycle.emitRequestEvent(state, makeEvent('request.resumed', {
        requestId,
        clientId: active.id,
        activeRequest,
        promptPreview: activeRequest.promptPreview || '',
      }));
      state.callbacks.onStatus?.('resumed', { requestId, activeRequest });
      this.lifecycle.touchState(state, 'request.resumed');

      void this.lifecycle.runRequestEffect(state, {
        id: `${requestId}:request-resume`,
        type: 'request.resume',
        data: { sourceClientId: active.id },
        execute: async () => {
          const response = await this.sendCommand('request.resume', {
            requestId,
            previousOwnerServerInstanceId: ownerHandoff ? previousOwnerServerInstanceId : '',
          }, {
            ...options,
            sourceClientId: active.id,
            timeoutMs: options.resumeTimeoutMs || options.timeoutMs || 10_000,
            request: resumeIdentity,
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
        this.lifecycle.emitRequestEvent(state, makeEvent('session.snapshot', { requestId, session: state.session }), { canonical: false });
        this.lifecycle.emitRequestEvent(state, makeEvent('resume.attached', { requestId, activeRequest: remote, promptPreview: remote.promptPreview || '' }), { canonical: false });
        this.lifecycle.touchState(state, 'resume.attached');
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
    return this.mutex.runExclusive(async () => {
      if (options.signal?.aborted) throw abortError(options.signal.reason || 'Request cancelled');

      const requestId = request.requestId || makeRequestId();
      const requestIdentity = {
        requestId,
        leaseId: randomUUID(),
        ownerServerInstanceId: String(this.hub.serverInstanceId || ''),
        responseEpoch: 0,
      };
      const normalizedCallbacks = noopCallbacks(callbacks);
      const started = Date.now();
      const message = String(request.message || '');
      const safePreview = message.slice(0, 120).replaceAll('\n', '\\n');
      const attachments = await this.resolveAttachments(request.attachments || request.fileIds || []);
      const chatOptions = normalizeOptions({ ...request, attachments });
      log(`Incoming prompt ${requestId}: ${JSON.stringify(safePreview)} attachments=${attachments.length}`);

      return await new Promise((resolve, reject) => {
        const state = {
          requestId,
          clientId: null,
          leaseId: requestIdentity.leaseId,
          ownerServerInstanceId: requestIdentity.ownerServerInstanceId,
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
        this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.CREATED, {
          expectedOutput: chatOptions.expectedOutput || { expected: '', required: false },
          sessionId: chatOptions.sessionId || '',
          sourceClientId: '',
          leaseId: requestIdentity.leaseId,
          ownerServerInstanceId: requestIdentity.ownerServerInstanceId,
        }, 'request_start'));
        this.lifecycle.emitRequestEvent(state, startedEvent);
        this.lifecycle.touchState(state, 'request.started');

        if (state.abortSignal) {
          state.abortHandler = () => {
            this.lifecycle.cancelState(state, String(state.abortSignal.reason || 'Request cancelled'));
          };
          state.abortSignal.addEventListener('abort', state.abortHandler, { once: true });
        }

        try {
          this.pending.set(requestId, state);
          this.eventBus?.emitDebug({ type: 'protocol.out.prompt.send', requestId, data: { requestId, messageLength: message.length, attachments: attachments.map(({ contentBase64, ...rest }) => rest), model: chatOptions.model, effort: chatOptions.effort, sessionId: chatOptions.sessionId } });
          const promptPayload = {
            type: 'prompt.send',
            requestId,
            serverInstanceId: this.hub.serverInstanceId || '',
            message,
            options: chatOptions,
            attachments,
          };
          state.promptPayload = promptPayload;
          Promise.resolve(this.browserClients.resolvePromptClient(state, chatOptions, options)).then((target) => {
            const targetClient = target?.client || null;
            const { client, delivered } = this.browserClients.sendPromptToClient(targetClient, promptPayload, { ...options, request: requestIdentity });
            state.clientId = client.id;
            this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.SOURCE_BOUND, {
              clientId: client.id,
              sessionId: chatOptions.sessionId || '',
              url: client.url || '',
              leaseId: requestIdentity.leaseId,
              ownerServerInstanceId: requestIdentity.ownerServerInstanceId,
            }, 'source_selection'));
            this.lifecycle.emitRequestEvent(state, makeEvent('client.target.resolved', {
              requestId,
              clientId: client.id,
              reason: target?.reason || 'active_client',
              sessionId: chatOptions.sessionId || undefined,
              sessionSwitch: Boolean(target?.sessionSwitch),
              sourceUrl: client.url || '',
            }));
            if (target?.sessionSwitch && chatOptions.sessionId) {
              this.lifecycle.emitRequestEvent(state, makeEvent('session.switch.requested', { requestId, clientId: client.id, sessionId: chatOptions.sessionId }));
            }
            void this.lifecycle.runRequestEffect(state, {
              id: `${requestId}:prompt-delivery`,
              type: 'prompt.delivery',
              data: { clientId: client.id },
              execute: async () => await delivered,
            }).then(() => {
              if (state.done) return;
              state.delivered = true;
              this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.PROMPT_DELIVERED, {
                clientId: client.id,
              }, 'prompt_delivery'));
              this.lifecycle.updateProgress(state, { phase: 'prompt_delivered_to_extension', requestId, clientId: client.id, meaningful: true }, { emit: false });
              this.lifecycle.emitRequestEvent(state, makeEvent('prompt.delivered', { requestId, clientId: client.id }));
            }).catch((err) => {
              if (state.done || this.lifecycle.getState(state.requestId)?.terminal) return;
              this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.FAILED, {
                code: err.code || RequestTerminalCode.EFFECT_FAILED,
                message: err.message || String(err),
              }, 'prompt_delivery_fallback'));
            });
          }).catch((err) => {
            if (state.done) return;
            this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.FAILED, {
              code: err.code || RequestTerminalCode.FAILED,
              message: err.message || String(err),
            }, 'prompt_target_resolution'));
          });
        } catch (err) {
          this.lifecycle.cleanupState(state);
          this.pending.delete(requestId);
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
}
