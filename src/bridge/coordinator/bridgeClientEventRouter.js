import {
  makeEvent,
} from '../requestState.js';
import { hubActivityToCanonicalEvent } from '../adapters/hubObservationAdapter.js';
import { tabObservationToCanonicalEvent } from '../adapters/tabObservationAdapter.js';
import { RequestEventType } from '../state/requestEvents.js';
import { RequestResultAccumulator } from './requestResultAccumulator.js';
import { PassiveObservationRouter } from './passiveObservationRouter.js';
import { RequestReattachmentCoordinator } from './requestReattachmentCoordinator.js';
import { isRequestRuntimeFinished } from './requestRuntimeProjection.js';

export function isCommandResponsePayload(payload = {}) {
  const type = String(payload?.type || '');
  if (!payload?.commandId) return false;
  return type === 'command.result'
    || type === 'command.rejected'
    || type === 'command.error'
    || type === 'lease.released'
    || type === 'lease.quarantined';
}

export function isEffectTerminalPayload(payload = {}) {
  const type = String(payload?.type || '');
  return Boolean(payload?.commandId) && (
    type === 'request.effect.succeeded'
    || type === 'request.effect.failed'
    || type === 'request.effect.uncertain'
    || type === 'request.effect.cancelled'
  );
}

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
    publishObservedTurn,
    registerObservedArtifacts,
    handleCommandResponse,
    sendCommand = null,
  }) {
    this.pending = pending;
    this.commands = commands;
    this.artifacts = artifacts;
    this.lifecycle = lifecycle;
    this.eventBus = eventBus;
    this.publishObservedTurn = publishObservedTurn;
    this.registerObservedArtifacts = registerObservedArtifacts;
    this.handleCommandResponse = handleCommandResponse;
    this.sendCommand = sendCommand;
    this.results = new RequestResultAccumulator();
    this.passive = new PassiveObservationRouter({
      eventBus,
      publishObservedTurn,
      registerObservedArtifacts,
    });
    this.reattachment = new RequestReattachmentCoordinator({
      pending,
      lifecycle,
      eventBus,
      sendCommand,
    });
  }

handleClientMessage(clientId, payload, envelope = null) {
  const commandId = payload?.commandId;
  const transport = envelope ? {
    messageId: String(envelope.messageId || ''),
    messageType: String(envelope.messageType || ''),
    source: envelope.source ? { ...envelope.source } : null,
    causationId: String(envelope.causationId || ''),
  } : null;
  if (commandId && this.commands.has(commandId) && isCommandResponsePayload(payload)) {
    this.handleCommandResponse(clientId, payload);
    return;
  }
  if (commandId && this.commands.has(commandId) && payload?.type === 'command.progress') {
    this.handleCommandResponse(clientId, payload);
    return;
  }
  if (commandId && this.commands.has(commandId) && isEffectTerminalPayload(payload)) {
    // Effect-backed commands settle from the one physical BrowserEffect
    // outcome, but the same message must still reach the canonical request
    // reducer. Command correlation and request lifecycle are separate owners.
    this.handleCommandResponse(clientId, payload);
  }


  const requestId = payload?.requestId;
  if (!requestId) return;

  const state = this.pending.get(requestId);
  if (!state || (state.clientId && state.clientId !== clientId)) return;

  if (payload.type === 'command.accepted') return;
  if (payload.type === 'command.result') return;
  if (payload.type === 'command.error' || payload.type === 'command.rejected') {
    this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.FAILED, {
      code: String(payload.code || 'BROWSER_COMMAND_REJECTED'),
      message: String(payload.message || payload.error || 'Browser command was rejected'),
      retryable: false,
    }, 'browser_command'));
    return;
  }

  this.lifecycle.touchState(state, payload.type || 'client.message');
  if (transport) state.lastTransportEnvelope = transport;

  if (this.lifecycle.getState(state.requestId)?.submission === 'pending') {
    this.lifecycle.markPromptAccepted(state, payload, { implicit: true });
  }

  if (payload.type === 'request.effect.started') {
    const effectType = payload.effectType || 'browser.operation';
    const transition = this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.EFFECT_STARTED, {
      effectId: payload.effectId || '',
      effectType,
      effectDomain: 'browser',
      evidence: payload.evidence || null,
      phase: payload.phase || '',
    }, 'browser_effect'));
    if (transition?.accepted) {
      this.lifecycle.emitRequestEvent(state, makeEvent('request.effect.started', {
        requestId,
        effectId: String(payload.effectId || ''),
        effectType,
        phase: String(payload.phase || ''),
        evidence: payload.evidence || null,
      }));
    }
    if (transition?.accepted
      && effectType === 'model.apply'
      && !state.events.some((event) => event.type === 'model.apply.started' && event.effectId === payload.effectId)) {
      this.lifecycle.emitRequestEvent(state, makeEvent('model.apply.started', {
        requestId,
        effectId: String(payload.effectId || ''),
        model: String(payload.evidence?.model || ''),
        effort: String(payload.evidence?.effort || ''),
      }));
    }
    return;
  }

  if (payload.type === 'request.effect.succeeded') {
    const effectType = payload.effectType || 'browser.operation';
    const transition = this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.EFFECT_SUCCEEDED, {
      effectId: payload.effectId || '',
      effectType,
      effectDomain: 'browser',
      result: payload.result || null,
      evidence: payload.evidence || null,
      message: String(payload.message || ''),
    }, 'browser_effect'));
    if (transition?.accepted) {
      this.lifecycle.emitRequestEvent(state, makeEvent('request.effect.succeeded', {
        requestId,
        effectId: String(payload.effectId || ''),
        effectType,
        result: payload.result || null,
        evidence: payload.evidence || null,
        message: String(payload.message || ''),
      }));
    }
    if (transition?.accepted && effectType === 'prompt.submit') {
      const promptTransition = this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.PROMPT_SUBMITTED, {
        clientId,
        effectId: payload.effectId || '',
        submissionSource: 'browser_effect_result',
      }, 'browser_effect'));
      if (promptTransition?.accepted) {
        this.lifecycle.emitRequestEvent(state, makeEvent('prompt.sent', {
          requestId,
          clientId,
          effectId: String(payload.effectId || ''),
          effectType,
          submissionSource: 'browser_effect_result',
        }));
      }
    }
    if (transition?.accepted
      && effectType === 'model.apply'
      && !state.events.some((event) => event.type === 'model.apply.done' && event.effectId === payload.effectId)) {
      const result = payload.result && typeof payload.result === 'object' ? payload.result : {};
      this.lifecycle.emitRequestEvent(state, makeEvent('model.apply.done', {
        requestId,
        effectId: String(payload.effectId || ''),
        ...result,
      }));
    }
    return;
  }

  if (payload.type === 'request.effect.failed') {
    const effectType = payload.effectType || 'browser.operation';
    const transition = this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.EFFECT_FAILED, {
      effectId: payload.effectId || '',
      effectType,
      effectDomain: 'browser',
      code: payload.code || 'BROWSER_EFFECT_FAILED',
      message: payload.message || 'Browser operation failed',
      retryable: Boolean(payload.retryable),
      evidence: payload.evidence || null,
    }, 'browser_effect'));
    if (transition?.accepted) {
      this.lifecycle.emitRequestEvent(state, makeEvent('request.effect.failed', {
        requestId,
        effectId: String(payload.effectId || ''),
        effectType,
        code: String(payload.code || 'BROWSER_EFFECT_FAILED'),
        message: String(payload.message || 'Browser operation failed'),
        retryable: Boolean(payload.retryable),
        evidence: payload.evidence || null,
      }));
    }
    return;
  }

  if (payload.type === 'request.effect.uncertain') {
    const effectType = payload.effectType || 'browser.operation';
    const transition = this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.EFFECT_UNCERTAIN, {
      effectId: payload.effectId || '',
      effectType,
      effectDomain: 'browser',
      idempotencyKey: payload.idempotencyKey || '',
      retryPolicy: payload.retryPolicy || 'if_unconfirmed',
      preconditions: payload.preconditions || {},
      preconditionsHash: String(payload.preconditionsHash || ''),
      attempt: Math.max(1, Number(payload.attempt) || 1),
      evidence: payload.evidence || payload.reconciliationEvidence || null,
      responseEpoch: Math.max(0, Number(payload.responseEpoch) || 0),
      code: payload.code || 'BROWSER_EFFECT_UNCERTAIN',
      message: payload.message || 'Browser effect result is uncertain after reload',
      recoveryTimeoutMs: payload.recoveryTimeoutMs,
      recoverable: true,
    }, 'browser_effect'));
    if (transition?.accepted) {
      this.lifecycle.emitRequestEvent(state, makeEvent('request.effect.uncertain', {
        requestId,
        effectId: String(payload.effectId || ''),
        effectType,
        idempotencyKey: String(payload.idempotencyKey || ''),
        code: String(payload.code || 'BROWSER_EFFECT_UNCERTAIN'),
        message: String(payload.message || 'Browser effect result is uncertain after reload'),
      }));
    }
    return;
  }

  if (payload.type === 'request.effect.cancelled') {
    const effectType = payload.effectType || 'browser.operation';
    const transition = this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.EFFECT_CANCELLED, {
      effectId: payload.effectId || '',
      effectType,
      message: payload.message || 'Browser operation cancelled',
    }, 'browser_effect'));
    if (transition?.accepted) {
      this.lifecycle.emitRequestEvent(state, makeEvent('request.effect.cancelled', {
        requestId,
        effectId: String(payload.effectId || ''),
        effectType,
        message: String(payload.message || 'Browser operation cancelled'),
      }));
    }
    return;
  }

  if (payload.type === 'diagnostic') {
    const name = String(payload.name || 'diagnostic');
    const diagnosticEvent = makeEvent(`diagnostic.${name}`, { requestId, clientId, payload });
    this.lifecycle.emitRequestEvent(state, diagnosticEvent);
    this.eventBus?.emitDebug({ type: `diagnostic.${name}`, requestId, clientId, data: payload });
    return;
  }



}

handlePassiveObservation(clientId, client = null, payload = {}, envelope = null) {
  this.passive.handle(clientId, client, payload, envelope);
}

handleClientActivity(clientId, client = null, payload = {}, envelope = null) {
  this.handlePassiveObservation(clientId, client, payload, envelope);
  const observation = payload?.observation && typeof payload.observation === 'object'
    ? payload.observation
    : payload?.tabObservation && typeof payload.tabObservation === 'object'
      ? payload.tabObservation
      : null;
  for (const state of this.pending.values()) {
    if (isRequestRuntimeFinished(state)) continue;
    if (state.clientId && state.clientId !== clientId) continue;
    const currentCanonical = this.lifecycle.getState(state.requestId);
    const tabObservationEvent = tabObservationToCanonicalEvent(
      state.requestId,
      clientId,
      payload,
      currentCanonical,
      Date.now(),
      envelope,
    );
    if (tabObservationEvent) {
      const data = tabObservationEvent.data || {};
      const responseMatches = Number(data.responseEpoch ?? 0) === Number(currentCanonical?.response?.epoch || 0);
      if (data.scopedToRequest && responseMatches && observation) {
        const output = observation.output || {};
        const thinkingUpdate = this.results.thinkingSnapshot(state, output.thinking);
        if (thinkingUpdate) {
          state.callbacks.onThinkingUpdate?.(state.thinking, { type: 'tab.observation', observation });
          this.lifecycle.emitRequestEvent(state, makeEvent('thinking.snapshot', {
            requestId: state.requestId,
            text: thinkingUpdate.text,
            delta: thinkingUpdate.delta,
            source: 'tab.observation',
            observationRevision: Number(observation.revision) || 0,
          }));
        }
        const answerUpdate = this.results.answerSnapshot(state, output.answer);
        if (answerUpdate) {
          state.callbacks.onAnswerUpdate?.(state.answer, { type: 'tab.observation', observation });
          this.lifecycle.emitRequestEvent(state, makeEvent('answer.snapshot', {
            requestId: state.requestId,
            text: answerUpdate.text,
            delta: answerUpdate.delta,
            source: 'tab.observation',
            observationRevision: Number(observation.revision) || 0,
          }));
        }
        const progressUpdate = this.results.progressSnapshot(state, {
          text: output.progress,
          items: output.progressItems,
        });
        if (progressUpdate) {
          state.callbacks.onProgressUpdate?.(state.progressText, { type: 'tab.observation', observation });
          this.lifecycle.emitRequestEvent(state, makeEvent('assistant.progress.snapshot', {
            requestId: state.requestId,
            text: progressUpdate.text,
            delta: progressUpdate.delta,
            items: progressUpdate.items,
            itemCount: progressUpdate.items.length,
            source: 'tab.observation',
            assistantTurnKey: String(observation.turn?.key || ''),
            observationRevision: Number(observation.revision) || 0,
          }));
        }
        const normalizedArtifacts = this.results.artifactSnapshot(
          state,
          observation.artifacts,
          state.requestId,
          clientId,
        );
        for (const artifact of normalizedArtifacts) {
          if (artifact.id) this.artifacts.set(artifact.id, artifact);
        }
        if (normalizedArtifacts.length || state.artifacts?.length) {
          state.callbacks.onArtifactUpdate?.(normalizedArtifacts, { type: 'tab.observation', observation });
          this.lifecycle.emitRequestEvent(state, makeEvent('artifact.snapshot', {
            requestId: state.requestId,
            artifacts: normalizedArtifacts,
            count: normalizedArtifacts.length,
            source: 'tab.observation',
            observationRevision: Number(observation.revision) || 0,
          }));
        }
        state.reasoningHistory = Array.isArray(output.reasoningHistory) ? output.reasoningHistory : state.reasoningHistory;
        state.responseBlocks = Array.isArray(output.responseBlocks) ? output.responseBlocks : state.responseBlocks;
        state.codeBlocks = Array.isArray(output.codeBlocks) ? output.codeBlocks : state.codeBlocks;
        state.codeBlockDiagnostics = Array.isArray(output.codeBlockDiagnostics) ? output.codeBlockDiagnostics : state.codeBlockDiagnostics;
        state.parserAudit = output.parserAudit && typeof output.parserAudit === 'object' ? output.parserAudit : state.parserAudit;
        state.session = payload.session || client?.session || state.session;
        data.artifacts = normalizedArtifacts;
        data.artifactCount = normalizedArtifacts.length;
        data.artifactStatus = this.lifecycle.canonicalArtifactStatus(state, normalizedArtifacts);
        if (data.completionCandidate === true) {
          state.deferredDone = {
            answer: String(output.answer || state.answer || ''),
            metadata: {
              thinking: String(output.thinking || state.thinking || ''),
              reasoningHistory: state.reasoningHistory,
              progressItems: state.progressItems,
              responseBlocks: state.responseBlocks,
              codeBlocks: state.codeBlocks,
              codeBlockDiagnostics: state.codeBlockDiagnostics,
              parserAudit: state.parserAudit,
              artifacts: normalizedArtifacts,
              session: state.session,
              url: String(observation.url || ''),
              title: String(observation.title || ''),
              finishReason: 'stable_normalized_observation',
              turnKey: String(observation.turn?.key || ''),
              turnIndex: Number(observation.turn?.index ?? -1),
              format: String(output.format || ''),
              completionEvidence: data.completionEvidence || null,
            },
          };
        }
      }
      this.lifecycle.ingestRequestTransition(state, tabObservationEvent);
    }

    const activeRequest = observation?.activeRequest || client?.activeRequest || payload?.activeRequest || null;
    if (activeRequest?.requestId === state.requestId) {
      state.lastHeartbeatAt = Date.now();
      const heartbeatEvent = hubActivityToCanonicalEvent(state.requestId, clientId, client, payload, state.lastHeartbeatAt);
      if (heartbeatEvent) this.lifecycle.ingestRequestTransition(state, heartbeatEvent);
      state.heartbeat = { clientId, activeRequest, url: client?.url || payload?.url || '', time: state.lastHeartbeatAt };
      const currentlyGenerating = observation?.generation?.state === 'active';
      if (currentlyGenerating) state.generationActivityAt = state.lastHeartbeatAt;
    }
  }
}


handleClientReady(client = {}) {
  this.reattachment.handleClientReady(client);
}


}
