import { config } from '../../config.js';
import { appendOnlyDelta } from '../../protocol.js';
import {
  abortError,
  artifactSnapshotSignature,
  completedReasoningRecords,
  makeEvent,
  mergeProgressRecords,
  requiredArtifactExpectation,
  requiredOutputArtifactMissing,
  responseHasTerminalOutput,
  responseHasVisibleOutput,
} from '../requestState.js';
import { CanonicalRequestState } from '../state/requestRuntime.js';
import {
  ArtifactState,
  GenerationState,
  RequestDeadlineKind,
  RequestEffectType,
  RequestEventType,
  RequestTerminalCode,
  SourceConnection,
  SubmissionState,
  createRequestEvent,
} from '../state/requestEvents.js';
import { EffectRunner } from '../effects/effectRunner.js';
import { CanonicalRequestRuntime } from './canonicalRequestRuntime.js';

/**
 * Owns the single authoritative request lifecycle after transport delivery.
 * The outer bridge supplies source commands and pending-state storage, while
 * this coordinator owns transitions, deadlines, effects, terminal release,
 * canonical state materialization, and promise completion.
 */
export class RequestLifecycleCoordinator {
  constructor({ hub, pending, artifacts, eventBus = null, sendCommand }) {
    if (!hub || !pending || !artifacts || typeof sendCommand !== 'function') {
      throw new TypeError('RequestLifecycleCoordinator requires hub, pending, artifacts, and sendCommand');
    }
    this.hub = hub;
    this.pending = pending;
    this.artifacts = artifacts;
    this.eventBus = eventBus;
    this.sendCommand = sendCommand;
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
    this.runtime = new CanonicalRequestRuntime({
      dispatch: (requestId, event) => {
        const state = this.pending.get(requestId);
        if (state && !state.done) this.ingestRequestTransition(state, event);
      },
      executeEffect: async (state, effect) => await this.executeCanonicalEffect(state, effect),
      onTerminal: async (state, canonicalState, outcome) => await this.finishFromCanonicalState(state, canonicalState, outcome),
      onDeadlineScheduled: (requestId, intent) => this.handleDeadlineScheduled(requestId, intent),
      onDeadlineSuperseded: (requestId, intent, reason) => this.handleDeadlineSuperseded(requestId, intent, reason),
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

canonicalEvent(state, type, data = {}, source = 'bridge_runtime') {
  const at = Date.now();
  return createRequestEvent(type, state.requestId, data, {
    source,
    occurredAt: at,
    receivedAt: at,
  });
}

ingestTerminalPayload(state, clientId, payload = {}, source = 'browser_terminal_observation') {
  const artifacts = Array.isArray(payload.artifacts)
    ? payload.artifacts.map((artifact) => ({
      ...artifact,
      requestId: state.requestId,
      sourceClientId: artifact.sourceClientId || clientId,
    }))
    : state.artifacts;
  for (const artifact of artifacts) {
    if (artifact.id) this.artifacts.set(artifact.id, artifact);
  }
  state.artifacts = artifacts;
  state.session = payload.session || state.session;
  const answer = String(payload.answer ?? state.answer ?? '');
  if (answer && answer !== state.answer) {
    const delta = appendOnlyDelta(state.answer, answer);
    state.answer = answer;
    if (delta) state.callbacks.onAnswerUpdate?.(state.answer, payload);
  }
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
    finishReason: payload.finishReason || source,
    turnKey: payload.turnKey || '',
    turnIndex: payload.turnIndex ?? -1,
    format: payload.format || '',
    reason: payload.reason || '',
    completionEvidence: payload.completionEvidence || null,
  };
  this.requestCanonicalCompletion(state, answer, metadata, source);
}

canonicalArtifactStatus(state, artifacts = state?.artifacts || []) {
  if (!state?.expectedOutput?.required) return ArtifactState.NOT_EXPECTED;
  return requiredOutputArtifactMissing(state, artifacts) ? ArtifactState.PENDING : ArtifactState.READY;
}

requestCanonicalCompletion(state, answer = '', metadata = {}, source = 'browser_terminal_snapshot') {
  if (!state || state.done) return null;
  const artifacts = Array.isArray(metadata.artifacts) ? metadata.artifacts : state.artifacts;
  const missingRequiredArtifact = requiredOutputArtifactMissing(state, artifacts);
  const now = Date.now();
  const artifactWaitStarted = missingRequiredArtifact && !state.requiredArtifactWaitSince;
  state.deferredDone = { answer: String(answer || ''), metadata: { ...metadata, artifacts } };
  state.currentGenerationActive = false;
  if (artifactWaitStarted) state.requiredArtifactWaitSince = now;
  this.updateProgress(state, {
    phase: missingRequiredArtifact ? 'artifact_settle' : 'final_snapshot_ready',
    requestId: state.requestId,
    clientId: state.clientId,
    meaningful: true,
    generating: false,
    stopButtonVisible: false,
    answerLength: String(answer || '').length,
    artifactCount: artifacts.length,
  }, { emit: false });

  if (artifactWaitStarted) {
    this.emitRequestEvent(state, makeEvent('artifact.required_wait_started', {
      requestId: state.requestId,
      expected: requiredArtifactExpectation(state),
      source: 'canonical_completion_guard',
      limitMs: Math.max(1_500, Number(config.requiredArtifactSettleMs) || 30_000),
      sourceClientId: state.clientId || '',
      assistantTurnKey: metadata.turnKey || state.progress?.assistantTurnKey || '',
    }), { canonical: false });
  }

  const outcome = this.ingestRequestTransition(state, this.canonicalEvent(state, RequestEventType.TERMINAL_SNAPSHOT_OBSERVED, {
    authoritative: true,
    completionSource: source,
    answerLength: String(answer || '').length,
    artifactCount: artifacts.length,
    artifacts,
    artifactStatus: this.canonicalArtifactStatus(state, artifacts),
    artifactSettleDeadlineAt: missingRequiredArtifact ? now + Math.max(1_500, Number(config.requiredArtifactSettleMs) || 30_000) : 0,
    artifactProbeAt: missingRequiredArtifact ? now + 500 : 0,
    message: 'Browser response reached an authoritative terminal snapshot',
    finishReason: metadata.finishReason || source,
  }, 'bridge_completion'));

  return outcome;
}

async executeCanonicalEffect(state, effect = {}) {
  if (!state || state.done) return null;
  if (effect.type === RequestEffectType.REQUEST_RELEASE) {
    const sourceClientId = String(effect.data?.sourceClientId || state.clientId || '');
    if (!sourceClientId) return { released: false, reason: 'source_client_missing' };
    this.hub.sendToClient(sourceClientId, {
      type: 'request.release',
      requestId: state.requestId,
      terminalCode: effect.data?.terminalCode || '',
      reason: effect.data?.reason || 'canonical_terminal',
    });
    return { released: true, sourceClientId };
  }
  if (effect.type !== RequestEffectType.RESPONSE_SNAPSHOT && effect.type !== RequestEffectType.ARTIFACT_PROBE) {
    const error = new Error(`No bridge handler exists for canonical effect ${effect.type}`);
    error.code = 'CANONICAL_EFFECT_HANDLER_MISSING';
    throw error;
  }

  const artifactProbe = effect.type === RequestEffectType.ARTIFACT_PROBE;
  const reason = String(effect.data?.reason || (artifactProbe
    ? 'required_artifact_settle'
    : 'watchdog.meaningful_progress_stalled'));
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
        return await this.requestForcedSnapshotForState(state, reason, { force: artifactProbe });
      } catch (error) {
        // Snapshot/probe failures are recoverable while the request or artifact deadline remains active.
        error.retryable = true;
        throw error;
      }
    },
  });
}

async finishFromCanonicalState(state, canonicalState, outcome = {}) {
  if (!state || state.done || !canonicalState?.terminal) return;
  const terminal = canonicalState.terminal;
  const code = terminal.code;

  if (code === RequestTerminalCode.COMPLETED) {
    const deferred = state.deferredDone;
    if (!deferred) return;
    state.deferredDone = null;
    if (outcome.previousState?.completion?.pending) {
      this.emitRequestEvent(state, makeEvent('artifact.required_wait_satisfied', {
        requestId: state.requestId,
        expected: requiredArtifactExpectation(state),
        source: outcome.event?.type || 'canonical_state',
        waitedMs: Date.now() - (state.requiredArtifactWaitSince || Date.now()),
        artifactCount: state.artifacts.length,
      }), { canonical: false });
    }
    this.finish(state, null, String(deferred.answer || state.answer || ''), {
      ...(deferred.metadata || {}),
      artifacts: state.artifacts,
      finishReason: deferred.metadata?.finishReason || 'canonical_completion',
    });
    return;
  }

  if (code === RequestTerminalCode.CANCELLED) {
    this.finish(state, abortError(terminal.message || 'Request cancelled'), '', { finishReason: 'cancelled' });
    return;
  }

  if (code === RequestTerminalCode.REQUIRED_ARTIFACT_MISSING) {
    this.emitRequestEvent(state, makeEvent('artifact.required_wait_expired', {
      requestId: state.requestId,
      expected: requiredArtifactExpectation(state),
      source: 'canonical_deadline',
      waitedMs: Date.now() - (state.requiredArtifactWaitSince || Date.now()),
      limitMs: Number(config.requiredArtifactSettleMs) || 30_000,
      attempts: Number(canonicalState.completion?.probeAttempt || 0),
    }), { canonical: false });
  }

  const error = new Error(String(terminal.message || code || 'Request failed'));
  error.name = 'CanonicalRequestStateError';
  error.code = (code === RequestTerminalCode.EFFECT_FAILED && terminal.evidence?.code ? String(terminal.evidence.code) : '')
    || String(terminal.evidence?.code || '')
    || `CANONICAL_${String(code || 'failed').toUpperCase()}`;
  error.phase = canonicalState.lifecycle || state.progress?.phase || '';
  error.canonicalTerminal = terminal;
  if (code === RequestTerminalCode.SOURCE_LOST) error.recoverable = true;
  if (code === RequestTerminalCode.DEADLINE_EXCEEDED) {
    try {
      if (state.clientId) this.hub.sendToClient(state.clientId, {
        type: 'prompt.cancel',
        requestId: state.requestId,
        reason: terminal.message,
      });
    } catch {}
  }
  this.finish(state, error, '', {
    finishReason: code === RequestTerminalCode.SOURCE_LOST ? 'recoverable_failed' : 'canonical_state_failure',
  });
}

handleDeadlineScheduled(requestId, intent = {}) {
  const state = this.pending.get(String(requestId || ''));
  if (!state || state.done) return;
  this.emitRequestEvent(state, makeEvent('request.deadline.scheduled', {
    requestId: state.requestId,
    deadlineId: intent.id,
    kind: intent.kind,
    dueAt: intent.dueAt,
    scheduledRevision: intent.scheduledRevision,
  }), { canonical: false });
  if (intent.kind === RequestDeadlineKind.ARTIFACT_PROBE) {
    const canonicalState = this.requestState.store.get(state.requestId);
    const completion = canonicalState?.completion || {};
    const scheduleBaseAt = Number(completion.lastProbeAt || completion.requestedAt || Date.now());
    const now = Date.now();
    this.emitRequestEvent(state, makeEvent('artifact.required_probe_scheduled', {
      requestId: state.requestId,
      expected: requiredArtifactExpectation(state),
      attempt: Number(intent.attempt) || Number(completion.probeAttempt || 0) + 1,
      delayMs: Number.isFinite(Number(intent.delayMs))
        ? Math.max(0, Number(intent.delayMs))
        : Math.max(0, Number(intent.dueAt) - scheduleBaseAt),
      waitedMs: Math.max(0, now - Number(completion.requestedAt || state.requiredArtifactWaitSince || now)),
      limitMs: Number(config.requiredArtifactSettleMs) || 30_000,
    }), { canonical: false });
  }
}

handleDeadlineSuperseded(requestId, intent = {}, reason = 'superseded') {
  this.eventBus?.emitDebug({
    type: 'request.deadline.superseded',
    requestId,
    data: { deadlineId: intent.id || '', kind: intent.kind || '', dueAt: intent.dueAt || 0, reason },
  });
}

handleClientClosed(client = {}) {
  const clientId = String(client.id || '');
  if (!clientId) return;
  for (const state of this.pending.values()) {
    if (state.done || state.clientId !== clientId) continue;
    const at = Date.now();
    this.ingestRequestTransition(state, createRequestEvent(RequestEventType.CONNECTION_CHANGED, state.requestId, {
      connected: false,
      connection: SourceConnection.DISCONNECTED,
      definitive: false,
      clientId,
      message: 'Source ChatGPT tab/client disconnected',
    }, {
      source: 'hub_client_lifecycle',
      occurredAt: at,
      receivedAt: at,
    }));
  }
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
    const outcome = this.requestState.transition(state.requestId, event);
    if (outcome?.accepted) this.runtime.accept(state, outcome);
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

emitWatchdogEvent(state, type, data = {}) {
  if (!state || state.done) return;
  const now = Date.now();
  const key = `${type}:${data.phase || state.progress?.phase || ''}`;
  if (state.lastWatchdogEventKey === key && now - (state.lastWatchdogEventAt || 0) < 10_000) return;
  state.lastWatchdogEventKey = key;
  state.lastWatchdogEventAt = now;
  this.emitRequestEvent(state, makeEvent(type, { requestId: state.requestId, ...data }));
  state.callbacks.onStatus?.('watchdog', { type, requestId: state.requestId, ...data });
}

async requestForcedSnapshotForState(state, reason = 'watchdog', options = {}) {
  if (!state || state.done) return null;
  if (state.forcedSnapshotInFlight && !options.force) return null;
  if (!state.clientId) throw new Error('Cannot request forced snapshot without sourceClientId');

  state.forcedSnapshotInFlight = true;
  state.lastForcedSnapshotAt = Date.now();
  state.forcedSnapshotCount = (state.forcedSnapshotCount || 0) + 1;
  this.emitRequestEvent(state, makeEvent('forced_snapshot.requested', {
    requestId: state.requestId,
    phase: state.progress?.phase || 'unknown',
    reason,
    sourceClientId: state.clientId,
    assistantTurnKey: state.progress?.assistantTurnKey || '',
    submittedUserTurnKey: state.progress?.submittedUserTurnKey || '',
  }));

  try {
    const response = await this.sendCommand('response.snapshot.request', {
      requestId: state.requestId,
      turnKey: state.progress?.assistantTurnKey || '',
      assistantTurnKey: state.progress?.assistantTurnKey || '',
      submittedUserTurnKey: state.progress?.submittedUserTurnKey || '',
    }, {
      sourceClientId: state.clientId,
      timeoutMs: Number(config.forcedSnapshotTimeoutMs) || 30_000,
    });
    if (state.done) return response;
    this.ingestForcedSnapshot(state, response || {}, reason);
    return response;
  } finally {
    if (state) state.forcedSnapshotInFlight = false;
  }
}

ingestForcedSnapshot(state, response = {}, reason = 'forced_snapshot') {
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

  this.emitRequestEvent(state, makeEvent('forced_snapshot.received', {
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
    this.markMeaningfulProgress(state, thinking ? 'forced_snapshot.thinking' : 'forced_snapshot.thinking_cleared');
    state.callbacks.onThinkingUpdate?.(state.thinking, response);
    this.emitRequestEvent(state, makeEvent('thinking.snapshot', { requestId: state.requestId, text: state.thinking, delta, source: 'forced_snapshot' }));
  }

  if (progressChanged) {
    const delta = appendOnlyDelta(state.progressText || '', progressText);
    state.progressText = progressText;
    state.progressItems = progressItems;
    state.progressItemsSignature = progressItemsSignature;
    state.reasoningHistory = mergeProgressRecords(state.reasoningHistory, completedReasoningRecords(progressItems));
    this.markMeaningfulProgress(state, progressText || progressItems.length ? 'forced_snapshot.progress' : 'forced_snapshot.progress_cleared');
    state.callbacks.onProgressUpdate?.(state.progressText, response);
    this.emitRequestEvent(state, makeEvent('assistant.progress.snapshot', {
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
    this.markMeaningfulProgress(state, answer ? 'forced_snapshot.answer' : 'forced_snapshot.answer_cleared');
    state.callbacks.onAnswerUpdate?.(state.answer, response);
    this.emitRequestEvent(state, makeEvent('answer.snapshot', {
      requestId: state.requestId,
      text: state.answer,
      delta,
      source: 'forced_snapshot',
      cleared: !answer,
    }));
  }

  if (artifactsChanged) {
    state.artifacts = artifacts;
    for (const artifact of artifacts) if (artifact.id) this.artifacts.set(artifact.id, artifact);
    this.markMeaningfulProgress(state, 'forced_snapshot.artifacts');
    state.callbacks.onArtifactUpdate?.(artifacts, response);
    this.emitRequestEvent(state, makeEvent('artifact.snapshot', {
      requestId: state.requestId,
      artifacts,
      source: 'forced_snapshot',
      canonicalArtifactStatus: this.canonicalArtifactStatus(state, artifacts),
    }));
  }

  if (state.deferredDone) {
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
  }

  if (turnKey || response.phase || generationChanged) {
    this.updateProgress(state, {
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
  if (terminalConfirmed && hasTerminalOutput && !generationActive && !state.deferredDone) {
    this.requestCanonicalCompletion(state, state.answer || answer, {
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
    }, 'forced_snapshot');
  }
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

finish(state, err, answer = '', metadata = {}) {
  if (state.done) return;
  state.done = true;
  this.cleanupState(state);
  this.pending.delete(state.requestId);

  if (err) {
    const eventType = err.recoverable || metadata.finishReason === 'recoverable_failed' ? 'request.recoverable_failed' : 'request.error';
    this.emitRequestEvent(state, makeEvent(eventType, {
      requestId: state.requestId,
      message: err.message,
      phase: err.phase || state.progress?.phase || '',
      recoverable: Boolean(err.recoverable),
      finishReason: metadata.finishReason || '',
      code: err.code || '',
      name: err.name || '',
    }), { canonical: false });
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
  this.emitRequestEvent(state, makeEvent('request.done', {
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
  }), { canonical: false });
  response.events = state.events;
  for (const follower of state.followers || []) {
    if (follower.done) continue;
    follower.detach?.();
    follower.resolve(response);
  }
  state.followers?.clear();
  state.resolve(response);
}

cleanupState(state) {
  this.runtime.clear(state.requestId);
  clearTimeout(state.timer);
  state.timer = null;

  if (state.abortSignal && state.abortHandler) {
    state.abortSignal.removeEventListener('abort', state.abortHandler);
    state.abortHandler = null;
  }
}
}
