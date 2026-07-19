import {
  makeEvent,
} from '../requestState.js';
import { hubActivityToCanonicalEvent } from '../adapters/hubObservationAdapter.js';
import { tabObservationToCanonicalEvent } from '../adapters/tabObservationAdapter.js';
import { RequestEventType } from '../state/requestEvents.js';
import { RequestResultAccumulator } from './requestResultAccumulator.js';
import { classifyTurnObservation } from '../observation/turnEvidence.js';

export function isCommandResponsePayload(payload = {}) {
  const type = String(payload?.type || '');
  if (!payload?.commandId) return false;
  return type === 'command.result'
    || type === 'command.rejected'
    || type === 'command.error';
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
  }) {
    this.pending = pending;
    this.commands = commands;
    this.artifacts = artifacts;
    this.lifecycle = lifecycle;
    this.eventBus = eventBus;
    this.publishObservedTurn = publishObservedTurn;
    this.registerObservedArtifacts = registerObservedArtifacts;
    this.handleCommandResponse = handleCommandResponse;
    this.results = new RequestResultAccumulator();
    this.passiveObservations = new Map();
  }

handleClientMessage(clientId, payload, envelope = null) {
  const commandId = payload?.commandId;
  const transport = envelope ? {
    messageId: String(envelope.messageId || ''),
    kind: String(envelope.kind || ''),
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

  if (payload.type === 'prompt.accepted') {
    this.lifecycle.markPromptAccepted(state, payload);
    this.lifecycle.updateProgress(state, { phase: 'prompt_accepted_by_content_script', requestId, meaningful: true, clientId });
    return;
  }

  if (!state.accepted) this.lifecycle.markPromptAccepted(state, payload, { implicit: true });

  if (payload.type === 'request.effect.started') {
    const effectType = payload.effectType || 'browser.operation';
    const transition = this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.EFFECT_STARTED, {
      effectId: payload.effectId || '',
      effectType,
      evidence: payload.evidence || null,
      phase: payload.phase || '',
    }, 'browser_effect'));
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
      result: payload.result || null,
      evidence: payload.evidence || null,
    }, 'browser_effect'));
    if (transition?.accepted && effectType === 'prompt.submit') {
      state.promptSubmitted = true;
      this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.PROMPT_SUBMITTED, {
        clientId,
        effectId: payload.effectId || '',
        submissionSource: 'browser_effect_result',
      }, 'browser_effect'));
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

  if (payload.type === 'request.effect.uncertain') {
    this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.EFFECT_UNCERTAIN, {
      effectId: payload.effectId || '',
      effectType: payload.effectType || 'browser.operation',
      idempotencyKey: payload.idempotencyKey || '',
      code: payload.code || 'BROWSER_EFFECT_UNCERTAIN',
      message: payload.message || 'Browser effect result is uncertain after reload',
      recoveryTimeoutMs: payload.recoveryTimeoutMs,
      recoverable: true,
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



}

handlePassiveObservation(clientId, client = null, payload = {}, envelope = null) {
  const observation = payload?.observation && typeof payload.observation === 'object'
    ? payload.observation
    : payload?.tabObservation && typeof payload.tabObservation === 'object'
      ? payload.tabObservation
      : null;
  if (!observation || observation.activeRequest?.requestId) return;
  const conversationId = String(observation.conversationId || client?.session?.id || payload.session?.id || 'new');
  const turnKey = String(observation.turn?.key || '');
  const userTurnKey = String(observation.turn?.userKey || '');
  const userPrompt = String(observation.turn?.userPrompt || '').trim();
  if (!turnKey || !userTurnKey || !userPrompt) return;
  const key = `${clientId}:${conversationId}`;
  const current = this.passiveObservations.get(key) || {
    baselineTurnKey: '',
    snapshots: new Map(),
    terminal: new Map(),
  };
  this.passiveObservations.set(key, current);
  while (this.passiveObservations.size > 64) this.passiveObservations.delete(this.passiveObservations.keys().next().value);

  const boundary = observation.turn?.promptBoundary || null;
  const afterExplicitBoundary = Boolean(
    boundary
    && (!boundary.submittedUserTurnKey || boundary.submittedUserTurnKey === userTurnKey),
  );
  if (!current.baselineTurnKey) {
    current.baselineTurnKey = turnKey;
    if (!afterExplicitBoundary) return;
  }
  const isNewTurn = turnKey !== current.baselineTurnKey;
  if (!isNewTurn && !afterExplicitBoundary) return;

  const output = observation.output || {};
  const artifacts = Array.isArray(observation.artifacts) ? observation.artifacts : [];
  const evidence = classifyTurnObservation(observation);
  const signature = evidence.semanticSignature;
  if (current.snapshots.get(turnKey) !== signature) {
    current.snapshots.set(turnKey, signature);
    while (current.snapshots.size > 100) current.snapshots.delete(current.snapshots.keys().next().value);
    const emit = this.eventBus?.emitTransient?.bind(this.eventBus) || this.eventBus?.emitUser?.bind(this.eventBus);
    emit?.({
      type: 'watch.turn.snapshot',
      data: {
        sourceClientId: clientId,
        sessionId: conversationId,
        observedAt: new Date(Number(observation.observedAt) || Date.now()).toISOString(),
        observationRevision: Number(observation.revision) || 0,
        turnKey,
        userTurnKey,
        turnIndex: Number(observation.turn?.index ?? -1),
        messageId: String(observation.turn?.messageId || ''),
        modelSlug: String(observation.turn?.modelSlug || ''),
        userPrompt,
        reasoning: String(output.thinking || ''),
        progress: String(output.progress || ''),
        answer: String(output.answer || ''),
        phase: String(observation.turn?.phase || ''),
        terminal: false,
        title: String(observation.title || ''),
        url: String(observation.url || ''),
      },
    });
  }

  if (!evidence.terminalCandidate || current.terminal.get(turnKey) === signature) return;
  current.terminal.set(turnKey, signature);
  while (current.terminal.size > 100) current.terminal.delete(current.terminal.keys().next().value);
  current.baselineTurnKey = turnKey;
  const normalizedArtifacts = this.registerObservedArtifacts(artifacts, {
    sourceClientId: clientId,
    turnKey,
    sessionId: conversationId,
  });
  const observed = {
    sourceClientId: clientId,
    sessionId: conversationId,
    streamSource: {
      messageId: String(envelope?.messageId || ''),
      contentEpoch: String(envelope?.source?.contentEpoch || ''),
      sequence: Number(envelope?.source?.sequence) || 0,
      observationRevision: Number(observation.revision) || 0,
    },
    observedAt: new Date(Number(observation.observedAt) || Date.now()).toISOString(),
    session: client?.session || payload.session || { id: conversationId },
    url: String(observation.url || ''),
    title: String(observation.title || ''),
    turnKey,
    userTurnKey,
    turnIndex: Number(observation.turn?.index ?? -1),
    messageId: String(observation.turn?.messageId || ''),
    modelSlug: String(observation.turn?.modelSlug || ''),
    userPrompt,
    reasoning: String(output.thinking || ''),
    progress: String(output.progress || ''),
    answer: String(output.answer || ''),
    responseBlocks: Array.isArray(output.responseBlocks) ? output.responseBlocks : [],
    parserAudit: output.parserAudit || null,
    artifacts: normalizedArtifacts,
  };
  this.eventBus?.emitUser({
    type: 'watch.turn.observed',
    data: {
      sourceClientId: clientId,
      sessionId: conversationId,
      turnKey,
      artifactCount: normalizedArtifacts.length,
      answerLength: String(output.answer || '').length,
    },
  });
  this.publishObservedTurn?.(observed);
}

handleClientActivity(clientId, client = null, payload = {}, envelope = null) {
  this.handlePassiveObservation(clientId, client, payload, envelope);
  const observation = payload?.observation && typeof payload.observation === 'object'
    ? payload.observation
    : payload?.tabObservation && typeof payload.tabObservation === 'object'
      ? payload.tabObservation
      : null;
  for (const state of this.pending.values()) {
    if (state.done) continue;
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
      const currentlyGenerating = observation
        ? observation.generation?.state === 'active'
        : Boolean(activeRequest.generating || activeRequest.stopButtonVisible || payload.generating || payload.stopButtonVisible);
      state.currentGenerationActive = currentlyGenerating;
      if (currentlyGenerating) state.generationActivityAt = state.lastHeartbeatAt;
      if (activeRequest.sentAt) state.promptSubmitted = true;
    }
  }
}

handleClientReady(client = {}) {
  if (client.compatible === false || client.compatibility?.compatible === false) return;
  const clientId = String(client.id || '');
  if (!clientId) return;
  for (const state of this.pending.values()) {
    if (state.done || state.clientId !== clientId) continue;
    const activeRequest = client.tabObservation?.activeRequest || client.activeRequest || null;
    if (state.promptSubmitted) {
      if (activeRequest?.requestId !== state.requestId) continue;
      const now = Date.now();
      state.lastHeartbeatAt = now;
      const heartbeatEvent = hubActivityToCanonicalEvent(state.requestId, clientId, client, {}, now);
      if (heartbeatEvent) this.lifecycle.ingestRequestTransition(state, heartbeatEvent);
      state.currentGenerationActive = client.tabObservation
        ? client.tabObservation.generation?.state === 'active'
        : Boolean(activeRequest.generating || activeRequest.stopButtonVisible);
      if (state.currentGenerationActive) state.generationActivityAt = now;
      if (now - (state.lastReattachAt || 0) >= 1_000) {
        state.lastReattachAt = now;
        this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.CONNECTION_CHANGED, {
          connected: true,
          connection: 'connected',
          clientId,
        }, 'browser_reconnect'));
        this.lifecycle.emitRequestEvent(state, makeEvent('request.reattached', {
          requestId: state.requestId,
          clientId,
          responseEpoch: Number(this.lifecycle.getState(state.requestId)?.response?.epoch || 0),
        }));
        state.callbacks.onStatus?.('reattached', { requestId: state.requestId, clientId, activeRequest });
      }
      continue;
    }

    // Reload before a proved prompt submission is an uncertain write boundary.
    // Never resend the prompt from readiness handling: reconciliation must prove
    // whether the original effect happened or fail recoverably.
    if (!state.promptPayload) continue;
    const now = Date.now();
    if (now - (state.lastUnsubmittedReloadRecoveryAt || 0) < 1_000) continue;
    state.lastUnsubmittedReloadRecoveryAt = now;
    const canonical = this.lifecycle.getState(state.requestId);
    const effectId = String(canonical?.effect?.activeId || `${state.requestId}:prompt.submit:unconfirmed`);
    const effectType = String(canonical?.effect?.activeType || 'prompt.submit');
    this.lifecycle.ingestRequestTransition(state, this.lifecycle.canonicalEvent(state, RequestEventType.EFFECT_UNCERTAIN, {
      effectId,
      effectType,
      idempotencyKey: effectId,
      code: 'PROMPT_SUBMISSION_UNCERTAIN_AFTER_RELOAD',
      message: 'Content runtime reloaded before prompt submission could be proved; automatic resend is forbidden.',
      recoveryTimeoutMs: 30_000,
      recoverable: true,
      evidence: { clientId, activeRequestId: activeRequest?.requestId || '' },
    }, 'browser_reconnect'));
    this.lifecycle.emitRequestEvent(state, makeEvent('prompt.reconcile_required_after_navigation', {
      requestId: state.requestId,
      clientId,
      effectId,
    }));
  }
}

}
