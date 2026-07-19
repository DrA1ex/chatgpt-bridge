import { config } from '../../config.js';
import {
  abortError,
  makeEvent,
  requiredArtifactExpectation,
} from '../requestState.js';
import { CanonicalRequestState } from '../state/requestRuntime.js';
import {
  GenerationState,
  RequestEffectType,
  RequestEventType,
  SubmissionState,
  createRequestEvent,
} from '../state/requestEvents.js';
import { EffectRunner } from '../effects/effectRunner.js';
import { CanonicalRequestRuntime } from './canonicalRequestRuntime.js';
import { RequestRecoveryCoordinator } from './requestRecoveryCoordinator.js';
import { RequestResultMaterializer } from './requestResultMaterializer.js';

/**
 * Owns the single authoritative request lifecycle after transport delivery.
 * The outer bridge supplies source commands and pending-state storage, while
 * this coordinator owns transitions, deadlines, effects, terminal release,
 * canonical state materialization, and promise completion.
 */
export class RequestLifecycleCoordinator {
  constructor({ hub, pending, artifacts, eventBus = null, sendCommand, resumePrompt }) {
    if (!hub || !pending || !artifacts || typeof sendCommand !== 'function') {
      throw new TypeError('RequestLifecycleCoordinator requires hub, pending, artifacts, and sendCommand');
    }
    this.hub = hub;
    this.pending = pending;
    this.artifacts = artifacts;
    this.eventBus = eventBus;
    this.sendCommand = sendCommand;
    this.resumePrompt = typeof resumePrompt === 'function' ? resumePrompt : null;
    this.requestState = new CanonicalRequestState({ eventBus });
    this.effectRunner = new EffectRunner({
      handlers: {
        '*': async (_data, context) => {
          if (typeof context.execute !== 'function') throw new TypeError('Bridge effect executor is required');
          return await context.execute(context.signal);
        },
      },
      onEvent: (event) => {
        const state = this.pending.get(event.entityId);
        if (state && !state.done) this.ingestRequestTransition(state, event);
      },
    });
    this.results = new RequestResultMaterializer(this);
    this.recovery = new RequestRecoveryCoordinator(this);
    this.runtime = new CanonicalRequestRuntime({
      dispatch: (requestId, event) => {
        const state = this.pending.get(requestId);
        if (state && !state.done) this.ingestRequestTransition(state, event);
      },
      executeEffect: async (state, effect) => await this.executeCanonicalEffect(state, effect),
      onTerminal: async (state, canonicalState, outcome) => await this.results.finishFromCanonicalState(state, canonicalState, outcome),
      onDeadlineScheduled: (requestId, intent) => this.recovery.handleDeadlineScheduled(requestId, intent),
      onDeadlineSuperseded: (requestId, intent, reason) => this.recovery.handleDeadlineSuperseded(requestId, intent, reason),
      onError: (error, details) => this.eventBus?.emitDebug({
        type: 'request.state.runtime_error',
        requestId: details?.requestId || '',
        data: { message: error?.message || String(error), details },
      }),
      deadlinePolicy: {
        meaningfulProgressTimeoutMs: config.requestMeaningfulProgressTimeoutMs,
        postGenerationTimeoutMs: config.requestPostGenerationProgressTimeoutMs,
        hardLivenessTimeoutMs: config.requestHardLivenessTimeoutMs,
        forcedSnapshotAfterMs: config.forcedSnapshotAfterMs,
        forcedSnapshotCooldownMs: config.forcedSnapshotCooldownMs,
      },
    });
  }

  close() {
    this.runtime.close();
  }

  trackedCount() {
    return this.requestState.diagnostics().length;
  }

  snapshot(requestId) {
    return this.requestState.snapshot(requestId);
  }

  getState(requestId) {
    return this.requestState.store.get(requestId);
  }

  deadlines(requestId = '') {
    return this.runtime.deadlines(requestId);
  }

  diagnostics(requestId = '') {
    const diagnostics = this.requestState.diagnostics(requestId);
    if (requestId) return { ...diagnostics, deadlines: this.deadlines(requestId) };
    return diagnostics.map((entry) => ({ ...entry, deadlines: this.deadlines(entry.requestId) }));
  }

  ingestTerminalPayload(...args) { return this.results.ingestTerminalPayload(...args); }

  canonicalArtifactStatus(...args) { return this.results.canonicalArtifactStatus(...args); }

  requestCanonicalCompletion(...args) { return this.results.requestCanonicalCompletion(...args); }

  finishFromCanonicalState(...args) { return this.results.finishFromCanonicalState(...args); }

  handleDeadlineScheduled(...args) { return this.recovery.handleDeadlineScheduled(...args); }

  handleDeadlineSuperseded(...args) { return this.recovery.handleDeadlineSuperseded(...args); }

  handleClientClosed(...args) { return this.recovery.handleClientClosed(...args); }

  emitWatchdogEvent(...args) { return this.recovery.emitWatchdogEvent(...args); }

  sourceObservationAnchors(...args) { return this.recovery.sourceObservationAnchors(...args); }

  requestForcedSnapshotForState(...args) { return this.recovery.requestForcedSnapshotForState(...args); }

  ingestForcedSnapshot(...args) { return this.recovery.ingestForcedSnapshot(...args); }

  finish(...args) { return this.results.finish(...args); }

  cleanupState(...args) { return this.results.cleanupState(...args); }

  canonicalEvent(state, type, data = {}, source = 'bridge_runtime', occurredAt = Date.now()) {
  const at = Number(occurredAt) || Date.now();
  return createRequestEvent(type, state.requestId, data, {
    source,
    occurredAt: at,
    receivedAt: at,
  });
}

  async executeCanonicalEffect(state, effect = {}) {
  if (!state) return null;
  if (effect.type === RequestEffectType.REQUEST_RELEASE) {
    const sourceClientId = String(effect.data?.sourceClientId || state.clientId || '');
    if (!sourceClientId) return { released: false, reason: 'source_client_missing' };
    const result = await this.sendCommand('request.release', {
      requestId: state.requestId,
      terminalCode: effect.data?.terminalCode || '',
      reason: effect.data?.reason || 'canonical_terminal',
    }, {
      sourceClientId,
      timeoutMs: 10_000,
    });
    return { released: result?.released !== false, sourceClientId };
  }
  if (state.done) return null;
  if (effect.type === RequestEffectType.PROMPT_PREPARATION_RESUME) {
    if (!this.resumePrompt) throw new Error('Prompt preparation recovery is unavailable');
    if (state.promptSubmitted) return { resumed: false, reason: 'prompt_already_submitted' };
    if (!state.promptPayload) throw new Error(`Request ${state.requestId} has no persisted prompt payload for preparation recovery`);
    const payload = {
      ...state.promptPayload,
      requestId: state.requestId,
      resumeAfterEffectType: String(effect.data?.resumeAfterEffectType || ''),
      recoveryOfEffectId: String(effect.data?.originalEffectId || ''),
    };
    const delivered = await this.resumePrompt(state.clientId, payload, { timeoutMs: config.promptDeliveryTimeoutMs });
    this.emitRequestEvent(state, makeEvent('prompt.preparation.resumed', {
      requestId: state.requestId,
      clientId: state.clientId,
      resumeAfterEffectType: payload.resumeAfterEffectType,
      recoveryOfEffectId: payload.recoveryOfEffectId,
    }));
    return delivered;
  }
  if (effect.type !== RequestEffectType.RESPONSE_SNAPSHOT
    && effect.type !== RequestEffectType.ARTIFACT_PROBE
    && effect.type !== RequestEffectType.EFFECT_RECONCILE) {
    const error = new Error(`No bridge handler exists for canonical effect ${effect.type}`);
    error.code = 'CANONICAL_EFFECT_HANDLER_MISSING';
    throw error;
  }

  const artifactProbe = effect.type === RequestEffectType.ARTIFACT_PROBE;
  const effectReconcile = effect.type === RequestEffectType.EFFECT_RECONCILE;
  if (effectReconcile) {
    const effectType = String(effect.data?.effectType || 'browser.operation');
    let result;
    try {
      result = await this.sendCommand('request.effect.reconcile', {
        requestId: state.requestId,
        effectId: String(effect.data?.effectId || ''),
        effectType,
        idempotencyKey: String(effect.data?.idempotencyKey || ''),
        retryPolicy: String(effect.data?.retryPolicy || 'if_unconfirmed'),
        preconditions: effect.data?.preconditions || {},
        evidence: effect.data?.evidence || null,
        anchors: this.recovery.sourceObservationAnchors(state),
      }, {
        sourceClientId: state.clientId,
        timeoutMs: 15_000,
      });
    } catch (error) {
      result = {
        reconciliationOutcome: 'uncertain',
        reconciliationReason: 'reconcile_command_failed',
        evidence: { message: error?.message || String(error) },
      };
    }
    const outcome = String(result?.reconciliationOutcome || 'uncertain');
    this.ingestRequestTransition(state, this.canonicalEvent(state, RequestEventType.EFFECT_RECONCILED, {
      originalEffectId: String(effect.data?.effectId || ''),
      effectType,
      outcome,
      reason: String(result?.reconciliationReason || ''),
      message: outcome === 'succeeded'
        ? `Browser effect ${effectType} was reconciled successfully`
        : outcome === 'not_started'
          ? `Browser effect ${effectType} was proved not to have started`
          : outcome === 'failed'
            ? `Browser effect ${effectType} was proved to have failed`
            : `Browser effect ${effectType} remains uncertain`,
      evidence: result?.evidence || null,
    }, 'browser_effect_reconcile'));
    return result;
  }
  const reason = String(effect.data?.reason || (artifactProbe
    ? 'required_artifact_settle'
    : effectReconcile ? 'content_reload_effect_reconcile' : 'watchdog.meaningful_progress_stalled'));
  if (!artifactProbe) {
    this.emitWatchdogEvent(state, reason, {
      phase: state.progress?.phase || '',
      meaningfulIdleMs: Date.now() - (state.lastMeaningfulProgressAt || state.startedAt || Date.now()),
      sourceClientId: state.clientId || '',
      message: effect.data?.deadline?.message || 'Requesting a source-bound snapshot.',
    });
  }

  return await this.runRequestEffect(state, {
    id: effect.id,
    type: effect.type,
    data: effect.data || {},
    execute: async () => {
      try {
        return await this.recovery.requestForcedSnapshotForState(state, reason, { force: artifactProbe });
      } catch (error) {
        // Snapshot/probe failures are recoverable while the request or artifact deadline remains active.
        error.retryable = true;
        throw error;
      }
    },
  });
}

  async runRequestEffect(state, effect = {}) {
  const terminalEvent = await this.effectRunner.run(state.requestId, {
    id: effect.id,
    type: String(effect.type || 'bridge.operation'),
    data: effect.data || {},
  }, {
    signal: effect.signal || state.abortSignal || null,
    execute: effect.execute,
  });

  if (terminalEvent.type === RequestEventType.EFFECT_SUCCEEDED) return terminalEvent.data?.result;
  if (terminalEvent.type === RequestEventType.EFFECT_CANCELLED) {
    throw abortError(terminalEvent.data?.message || `${effect.type || 'Bridge effect'} cancelled`);
  }

  const error = new Error(terminalEvent.data?.message || `${effect.type || 'Bridge effect'} failed`);
  error.code = terminalEvent.data?.code || 'EFFECT_FAILED';
  error.retryable = Boolean(terminalEvent.data?.retryable);
  error.evidence = terminalEvent.data?.evidence || null;
  error.phase = this.requestState.snapshot(state.requestId)?.displayPhase || state.progress?.phase || '';
  throw error;
}

  ingestRequestTransition(state, event) {
  try {
    const previousCanonicalState = this.requestState.store.get(state.requestId);
    const outcome = this.requestState.transition(state.requestId, event);
    if (outcome?.accepted) {
      if (outcome.state?.completion?.pending && !previousCanonicalState?.completion?.pending) {
        const now = Date.now();
        state.requiredArtifactWaitSince = Number(outcome.state.completion.requestedAt) || now;
        this.emitRequestEvent(state, makeEvent('artifact.required_wait_started', {
          requestId: state.requestId,
          expected: requiredArtifactExpectation(state),
          source: event?.type || 'canonical_transition',
          limitMs: Math.max(1_500, Number(config.requiredArtifactSettleMs) || 30_000),
          sourceClientId: state.clientId || '',
          assistantTurnKey: this.recovery.sourceObservationAnchors(state).assistantTurnKey,
        }), { canonical: false });
      }
      this.runtime.accept(state, outcome);
    }
    return outcome;
  } catch (err) {
    this.eventBus?.emitDebug({
      type: 'request.state.transition_failed',
      requestId: state.requestId,
      data: {
        eventType: event?.type || '',
        message: err.message || String(err),
      },
    });
    return null;
  }
}

  emitRequestEvent(state, event) {
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
  this.eventBus?.emitUser({
    type: normalized.type || 'event',
    requestId: state.requestId,
    sessionId: normalized.sessionId || state.session?.id || '',
    data: normalized,
  });
}

  markPromptAccepted(state, payload = {}, options = {}) {
  if (!state || state.done || state.accepted) return false;
  state.accepted = true;
  state.callbacks.onStatus?.('accepted', payload);
  const event = { requestId: state.requestId };
  if (options.implicit) {
    event.implicit = true;
    event.via = payload.type || 'unknown';
  }
  this.markMeaningfulProgress(state, 'prompt.accepted');
  this.ingestRequestTransition(state, this.canonicalEvent(state, RequestEventType.PROMPT_ACCEPTED, event, 'browser_prompt_acceptance'));
  this.emitRequestEvent(state, makeEvent('prompt.accepted', event));
  return true;
}

  markMeaningfulProgress(state, reason = 'meaningful.progress') {
  if (!state || state.done) return;
  state.lastMeaningfulProgressAt = Date.now();
  state.lastMeaningfulProgressReason = reason || 'meaningful.progress';
}

  updateProgress(state, payload = {}, options = {}) {
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
  if (payload.meaningful !== false) this.markMeaningfulProgress(state, `request.progress:${phase}`);
  const progressEvent = makeEvent('request.progress', { requestId: state.requestId, ...progress });
  if (options.emit !== false) this.emitRequestEvent(state, progressEvent);

  const canonical = this.requestState.store.get(state.requestId);
  if (canonical) {
    state.currentGenerationActive = canonical.generation === GenerationState.ACTIVE;
    state.promptSubmitted = state.promptSubmitted || canonical.submission === SubmissionState.SUBMITTED;
  } else if (Object.hasOwn(payload, 'generating') || Object.hasOwn(payload, 'stopButtonVisible')) {
    state.currentGenerationActive = Boolean(payload.generating || payload.stopButtonVisible);
  }
  if (state.currentGenerationActive) state.generationActivityAt = now;
}

  touchState(state, reason = 'activity') {
  if (!state || state.done) return;
  state.lastActivityAt = Date.now();
  state.lastActivityReason = reason || 'activity';
}

  cancelState(state, reason = 'Cancelled') {
  if (!state || state.done) return;

  try {
    if (state.clientId) {
      this.hub.sendToClient(state.clientId, {
        type: 'prompt.cancel',
        requestId: state.requestId,
        reason,
      });
    }
  } catch {
    // The tab may already be gone. The local request still needs to finish.
  }

  this.ingestRequestTransition(state, this.canonicalEvent(state, RequestEventType.CANCELLED, {
    message: reason,
  }, 'bridge_cancellation'));

}


}
