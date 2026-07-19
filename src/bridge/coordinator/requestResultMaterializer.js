import { config } from '../../config.js';
import { appendOnlyDelta } from '../../protocol.js';
import {
  abortError,
  completedReasoningRecords,
  makeEvent,
  mergeProgressRecords,
  requiredArtifactExpectation,
  requiredOutputArtifactMissing,
} from '../requestState.js';
import {
  ArtifactState,
  RequestEventType,
  RequestTerminalCode,
} from '../state/requestEvents.js';

/**
 * Materializes canonical request outcomes into the public bridge response.
 * It does not decide completion: it consumes accepted canonical transitions
 * and publishes the exact output snapshot selected by the request reducer.
 */
export class RequestResultMaterializer {
  constructor(owner) {
    this.owner = owner;
  }

  ingestTerminalPayload(state, clientId, payload = {}, source = 'browser_terminal_observation') {
    const { artifacts: artifactStore } = this.owner;
    const artifacts = Array.isArray(payload.artifacts)
      ? payload.artifacts.map((artifact) => ({
        ...artifact,
        requestId: state.requestId,
        sourceClientId: artifact.sourceClientId || clientId,
      }))
      : state.artifacts;
    for (const artifact of artifacts) {
      if (artifact.id) artifactStore.set(artifact.id, artifact);
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
    const owner = this.owner;
    if (!state || state.done) return null;
    const artifacts = Array.isArray(metadata.artifacts) ? metadata.artifacts : state.artifacts;
    const missingRequiredArtifact = requiredOutputArtifactMissing(state, artifacts);
    const now = Date.now();
    const artifactWaitStarted = missingRequiredArtifact && !state.requiredArtifactWaitSince;
    state.deferredDone = { answer: String(answer || ''), metadata: { ...metadata, artifacts } };
    state.currentGenerationActive = false;
    if (artifactWaitStarted) state.requiredArtifactWaitSince = now;
    owner.updateProgress(state, {
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
      owner.emitRequestEvent(state, makeEvent('artifact.required_wait_started', {
        requestId: state.requestId,
        expected: requiredArtifactExpectation(state),
        source: 'canonical_completion_guard',
        limitMs: Math.max(1_500, Number(config.requiredArtifactSettleMs) || 30_000),
        sourceClientId: state.clientId || '',
        assistantTurnKey: metadata.turnKey || state.progress?.assistantTurnKey || '',
      }), { canonical: false });
    }

    return owner.ingestRequestTransition(state, owner.canonicalEvent(state, RequestEventType.TERMINAL_SNAPSHOT_OBSERVED, {
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
    }, 'bridge_completion', now));
  }

  async finishFromCanonicalState(state, canonicalState, outcome = {}) {
    const owner = this.owner;
    if (!state || state.done || !canonicalState?.terminal) return;
    const terminal = canonicalState.terminal;
    const code = terminal.code;

    if (state.clientId && state.requestId && typeof owner.hub.beginRequestRelease === 'function') {
      try {
        owner.hub.beginRequestRelease(state.clientId, state.requestId);
      } catch (error) {
        owner.eventBus?.emitDebug({
          type: 'request.release.barrier_error',
          requestId: state.requestId,
          data: { clientId: state.clientId, message: error?.message || String(error) },
        });
      }
    }

    if (code === RequestTerminalCode.COMPLETED) {
      const deferred = state.deferredDone;
      if (!deferred) return;
      state.deferredDone = null;
      if (outcome.previousState?.completion?.pending) {
        owner.emitRequestEvent(state, makeEvent('artifact.required_wait_satisfied', {
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
      owner.emitRequestEvent(state, makeEvent('artifact.required_wait_expired', {
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
        if (state.clientId) owner.hub.sendToClient(state.clientId, {
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

  finish(state, err, answer = '', metadata = {}) {
    const owner = this.owner;
    if (state.done) return;
    state.done = true;
    this.cleanupState(state);
    owner.pending.delete(state.requestId);

    if (err) {
      const eventType = err.recoverable || metadata.finishReason === 'recoverable_failed' ? 'request.recoverable_failed' : 'request.error';
      owner.emitRequestEvent(state, makeEvent(eventType, {
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
    owner.emitRequestEvent(state, makeEvent('request.done', {
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
    this.owner.runtime.clear(state.requestId);
    clearTimeout(state.timer);
    state.timer = null;

    if (state.abortSignal && state.abortHandler) {
      state.abortSignal.removeEventListener('abort', state.abortHandler);
      state.abortHandler = null;
    }
  }
}
