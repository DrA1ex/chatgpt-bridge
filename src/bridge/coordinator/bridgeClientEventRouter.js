import { appendOnlyDelta } from '../../protocol.js';
import {
  completedReasoningRecords,
  makeEvent,
  mergeProgressRecords,
} from '../requestState.js';
import { hubActivityToCanonicalEvent } from '../adapters/hubObservationAdapter.js';
import { tabObservationToCanonicalEvent } from '../adapters/tabObservationAdapter.js';
import { RequestEventType, RequestTerminalCode } from '../state/requestEvents.js';

/**
 * Normalizes extension messages and hub activity into the authoritative request
 * lifecycle. Command-response transport stays in the outer bridge because it
 * has a separate request/response correlation contract.
 */
export class BridgeClientEventRouter {
  constructor({
    pending,
    commands,
    artifacts,
    lifecycle,
    eventBus = null,
    observedTurnListeners,
    registerObservedArtifacts,
    sendPromptToClient,
    handleCommandResponse,
  }) {
    this.pending = pending;
    this.commands = commands;
    this.artifacts = artifacts;
    this.lifecycle = lifecycle;
    this.eventBus = eventBus;
    this.observedTurnListeners = observedTurnListeners;
    this.registerObservedArtifacts = registerObservedArtifacts;
    this.sendPromptToClient = sendPromptToClient;
    this.handleCommandResponse = handleCommandResponse;
  }

handleClientMessage(clientId, payload) {
  const commandId = payload?.commandId;
  if (commandId && this.commands.has(commandId)) {
    this.handleCommandResponse(clientId, payload);
    return;
  }

  if (payload?.type === 'observed.turn.terminal') {
    const sessionId = String(payload.session?.id || '');
    const artifacts = this.registerObservedArtifacts(payload.artifacts || [], {
      sourceClientId: clientId,
      turnKey: payload.turnKey || '',
      sessionId,
    });
    const observed = { ...payload, artifacts, sourceClientId: clientId, sessionId };
    this.eventBus?.emitUser({ type: 'watch.turn.observed', data: { sourceClientId: clientId, sessionId, turnKey: payload.turnKey || '', artifactCount: artifacts.length, answerLength: String(payload.answer || '').length } });
    for (const listener of this.observedTurnListeners) {
      try { listener(observed); } catch (err) { this.eventBus?.emitDebug({ type: 'watch.turn.listener_failed', data: { message: err.message || String(err) } }); }
    }
    return;
  }

  const requestId = payload?.requestId;
  if (!requestId) return;

  const state = this.pending.get(requestId);
  if (!state || (state.clientId && state.clientId !== clientId)) return;

  this.lifecycle.touchState(state, payload.type || 'client.message');

  if (payload.type === 'prompt.accepted') {
    this.lifecycle.markPromptAccepted(state, payload);
    this.lifecycle.updateProgress(state, { phase: 'prompt_accepted_by_content_script', requestId, meaningful: true, clientId });
    return;
  }

  if (!state.accepted) this.lifecycle.markPromptAccepted(state, payload, { implicit: true });

  if (payload.type === 'request.effect.started') {
    this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.EFFECT_STARTED, {
      effectId: payload.effectId || '',
      effectType: payload.effectType || 'browser.operation',
      evidence: payload.evidence || null,
      phase: payload.phase || '',
    }, 'browser_effect'));
    return;
  }

  if (payload.type === 'request.effect.succeeded') {
    this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.EFFECT_SUCCEEDED, {
      effectId: payload.effectId || '',
      effectType: payload.effectType || 'browser.operation',
      result: payload.result || null,
      evidence: payload.evidence || null,
    }, 'browser_effect'));
    return;
  }

  if (payload.type === 'request.effect.failed') {
    this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.EFFECT_FAILED, {
      effectId: payload.effectId || '',
      effectType: payload.effectType || 'browser.operation',
      code: payload.code || 'BROWSER_EFFECT_FAILED',
      message: payload.message || 'Browser operation failed',
      retryable: Boolean(payload.retryable),
      evidence: payload.evidence || null,
    }, 'browser_effect'));
    return;
  }

  if (payload.type === 'request.effect.cancelled') {
    this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.EFFECT_CANCELLED, {
      effectId: payload.effectId || '',
      effectType: payload.effectType || 'browser.operation',
      message: payload.message || 'Browser operation cancelled',
    }, 'browser_effect'));
    return;
  }

  if (payload.type === 'diagnostic') {
    const name = String(payload.name || 'diagnostic');
    const diagnosticEvent = makeEvent(`diagnostic.${name}`, { requestId, clientId, payload });
    this.lifecycle.emitRequestEvent(state, diagnosticEvent);
    this.eventBus?.emitDebug({ type: `diagnostic.${name}`, requestId, clientId, data: payload });
    return;
  }

  if (payload.type === 'request.progress') {
    this.lifecycle.updateProgress(state, { ...payload, requestId, clientId });
    return;
  }

  if (payload.type === 'chat.event') {
    this.lifecycle.emitRequestEvent(state, payload.event || makeEvent('event', { requestId, payload }));
    return;
  }

  if (payload.type === 'status') {
    state.callbacks.onStatus?.(payload.status || 'status', payload);
    const status = payload.status || 'status';
    if (status === 'sent') state.promptSubmitted = true;
    this.lifecycle.updateProgress(state, { phase: status === 'sent' ? 'prompt_submitted' : status === 'generating' ? 'generating' : status, requestId, clientId, meaningful: true, status }, { emit: false });
    this.lifecycle.emitRequestEvent(state, makeEvent(`status.${status || 'unknown'}`, { requestId, payload }));
    return;
  }

  if (payload.type === 'thinking.delta') {
    const delta = String(payload.delta || '');
    if (!delta) return;
    state.thinking += delta;
    this.lifecycle.markMeaningfulProgress(state, 'thinking.delta');
    state.callbacks.onThinkingUpdate?.(state.thinking, payload);
    this.lifecycle.emitRequestEvent(state, makeEvent('thinking.delta', { requestId, delta, thinking: state.thinking }));
    return;
  }

  if (payload.type === 'thinking.snapshot') {
    const text = String(payload.text || '');
    if (text === state.thinking) return;
    const delta = appendOnlyDelta(state.thinking, text);
    state.thinking = text;
    this.lifecycle.markMeaningfulProgress(state, text ? 'thinking.snapshot' : 'thinking.cleared');
    state.callbacks.onThinkingUpdate?.(state.thinking, payload);
    this.lifecycle.emitRequestEvent(state, makeEvent('thinking.snapshot', { requestId, text: state.thinking, delta }));
    return;
  }

  if (payload.type === 'answer.delta') {
    const delta = String(payload.delta || '');
    if (!delta) return;
    state.answer += delta;
    this.lifecycle.markMeaningfulProgress(state, 'answer.delta');
    state.callbacks.onAnswerUpdate?.(state.answer, payload);
    this.lifecycle.emitRequestEvent(state, makeEvent('answer.delta', { requestId, delta, answer: state.answer }));
    return;
  }

  if (payload.type === 'answer.snapshot') {
    const text = String(payload.text || '');
    if (!text || text === state.answer) return;

    const delta = appendOnlyDelta(state.answer, text);
    state.answer = text;
    if (delta) {
      this.lifecycle.markMeaningfulProgress(state, 'answer.snapshot');
      state.callbacks.onAnswerUpdate?.(state.answer, payload);
    }
    this.lifecycle.emitRequestEvent(state, makeEvent('answer.snapshot', { requestId, text: state.answer, delta }));
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
    this.lifecycle.markMeaningfulProgress(state, text || progressItems.length ? 'assistant.progress.snapshot' : 'assistant.progress.cleared');
    state.callbacks.onProgressUpdate?.(state.progressText, payload);
    this.lifecycle.emitRequestEvent(state, makeEvent('assistant.progress.snapshot', {
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
    this.lifecycle.markMeaningfulProgress(state, 'artifact.snapshot');
    for (const artifact of normalized) {
      if (artifact.id) this.artifacts.set(artifact.id, artifact);
    }
    state.callbacks.onArtifactUpdate?.(normalized, payload);
    this.lifecycle.emitRequestEvent(state, makeEvent('artifact.snapshot', {
      requestId,
      artifacts: normalized,
      canonicalArtifactStatus: this.lifecycle.canonicalArtifactStatus(state, normalized),
    }));
    return;
  }

  if (payload.type === 'session.snapshot') {
    state.session = payload.session || null;
    this.lifecycle.emitRequestEvent(state, makeEvent('session.snapshot', { requestId, session: state.session }));
    return;
  }

  if (payload.type === 'request.terminal_snapshot') {
    this.lifecycle.ingestTerminalPayload(state, clientId, payload, 'browser_terminal_observation');
    return;
  }

  // Protocol v2 compatibility: older extensions still send a terminal `done` payload.
  if (payload.type === 'done') {
    this.lifecycle.ingestTerminalPayload(state, clientId, payload, 'legacy_browser_done');
    return;
  }

  if (payload.type === 'request.terminal_failure') {
    this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.TERMINAL_FAILURE_OBSERVED, {
      code: payload.code || RequestTerminalCode.FAILED,
      message: payload.message || 'Browser observer reported a terminal request failure',
      retryable: Boolean(payload.retryable),
      effectId: payload.effectId || '',
      effectType: payload.effectType || '',
      evidence: payload.evidence || null,
      phase: payload.phase || '',
    }, 'browser_terminal_observation'));
    return;
  }

  if (payload.type === 'error') {
    this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.FAILED, {
      code: payload.code || RequestTerminalCode.EXPLICIT_UI_ERROR,
      message: payload.message || 'Browser extension client error',
      payload,
    }, 'extension_error'));
  }
}

handleClientActivity(clientId, client = null, payload = {}) {
  for (const state of this.pending.values()) {
    if (state.done) continue;
    if (state.clientId && state.clientId !== clientId) continue;
    const activeRequest = client?.activeRequest || payload?.activeRequest || null;
    const tabObservationEvent = tabObservationToCanonicalEvent(
      state.requestId,
      clientId,
      payload,
      this.lifecycle.getState(state.requestId),
      Date.now(),
    );
    if (tabObservationEvent) this.lifecycle.ingestRequestTransition(state, tabObservationEvent);
    if (activeRequest?.requestId === state.requestId) {
      state.lastHeartbeatAt = Date.now();
      const heartbeatEvent = hubActivityToCanonicalEvent(state.requestId, clientId, client, payload, state.lastHeartbeatAt);
      if (heartbeatEvent) this.lifecycle.ingestRequestTransition(state, heartbeatEvent);
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
    }
  }
}

handleClientReady(client = {}) {
  if (client.compatible === false || client.compatibility?.compatible === false) return;
  const clientId = String(client.id || '');
  if (!clientId) return;
  for (const state of this.pending.values()) {
    if (state.done || state.clientId !== clientId) continue;
    if (state.promptSubmitted) {
      if (client.activeRequest?.requestId === state.requestId) {
        const now = Date.now();
        state.lastHeartbeatAt = now;
        const heartbeatEvent = hubActivityToCanonicalEvent(state.requestId, clientId, client, {}, now);
        if (heartbeatEvent) this.lifecycle.ingestRequestTransition(state, heartbeatEvent);
        state.currentGenerationActive = Boolean(client.activeRequest.generating || client.activeRequest.stopButtonVisible);
        if (state.currentGenerationActive) state.generationActivityAt = now;
        this.lifecycle.updateProgress(state, {
          phase: client.activeRequest.phase || state.progress?.phase || 'reattached',
          requestId: state.requestId,
          clientId,
          visibilityState: client.visibilityState || '',
          focused: client.focused ?? null,
          meaningful: false,
        }, { emit: false });
        if (now - (state.lastReattachAt || 0) >= 1_000) {
          state.lastReattachAt = now;
          this.lifecycle.emitRequestEvent(state, makeEvent('request.reattached', {
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
          void this.lifecycle.requestForcedSnapshotForState(state, 'client.ready.reattach', { force: true }).catch((err) => {
            if (!state.done) this.lifecycle.emitRequestEvent(state, makeEvent('request.reattach_snapshot_failed', {
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
      this.lifecycle.emitRequestEvent(state, makeEvent('prompt.resend.blocked_busy', {
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
      this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.FAILED, {
        code: 'PROMPT_RESEND_LIMIT_REACHED',
        message: `ChatGPT tab reloaded before prompt submission and resend limit was reached for ${state.requestId}.`,
        resendCount: state.promptResendCount || 0,
        clientId,
      }, 'prompt_resend'));
      continue;
    }
    state.lastPromptResendAt = now;
    state.promptResendCount = (state.promptResendCount || 0) + 1;
    try {
      const { delivered } = this.sendPromptToClient(client, state.promptPayload);
      this.lifecycle.emitRequestEvent(state, makeEvent('prompt.resent_after_navigation', {
        requestId: state.requestId,
        clientId,
        resendCount: state.promptResendCount,
        sessionId: state.promptPayload.options?.sessionId || '',
      }));
      Promise.resolve(delivered).catch((err) => {
        if (!state.done) this.lifecycle.emitRequestEvent(state, makeEvent('prompt.resend.delivery_failed', { requestId: state.requestId, clientId, message: err.message || String(err) }));
      });
    } catch (err) {
      this.lifecycle.emitRequestEvent(state, makeEvent('prompt.resend.delivery_failed', { requestId: state.requestId, clientId, message: err.message || String(err) }));
    }
  }
}
}
