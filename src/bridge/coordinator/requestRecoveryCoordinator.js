import { config } from '../../config.js';
import { appendOnlyDelta } from '../../protocol.js';
import {
  artifactSnapshotSignature,
  completedReasoningRecords,
  makeEvent,
  mergeProgressRecords,
  requiredArtifactExpectation,
  responseHasVisibleOutput,
} from '../requestState.js';
import {
  RequestDeadlineKind,
  RequestEventType,
  SourceConnection,
  createRequestEvent,
} from '../state/requestEvents.js';
import { canonicalGenerationActive, isRequestRuntimeFinished } from './requestRuntimeProjection.js';

/**
 * Owns request recovery evidence, deadline diagnostics, and read-only source
 * reconciliation. It never materializes a terminal outcome or repeats writes.
 */
export class RequestRecoveryCoordinator {
  constructor(owner) {
    this.owner = owner;
  }

  handleDeadlineScheduled(requestId, intent = {}) {
    const owner = this.owner;
    const state = owner.pending.get(String(requestId || ''));
    if (!state || isRequestRuntimeFinished(state)) return;
    owner.emitRequestEvent(state, makeEvent('request.deadline.scheduled', {
      requestId: state.requestId,
      deadlineId: intent.id,
      kind: intent.kind,
      dueAt: intent.dueAt,
      scheduledRevision: intent.scheduledRevision,
    }), { canonical: false });
    if (intent.kind === RequestDeadlineKind.ARTIFACT_PROBE) {
      const canonicalState = owner.requestState.store.get(state.requestId);
      const completion = canonicalState?.completion || {};
      const scheduleBaseAt = Number(completion.lastProbeAt || completion.requestedAt || Date.now());
      const now = Date.now();
      owner.emitRequestEvent(state, makeEvent('artifact.required_probe_scheduled', {
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
    this.owner.eventBus?.emitDebug({
      type: 'request.deadline.superseded',
      requestId,
      data: { deadlineId: intent.id || '', kind: intent.kind || '', dueAt: intent.dueAt || 0, reason },
    });
  }

  handleClientClosed(client = {}) {
    const owner = this.owner;
    const clientId = String(client.id || '');
    if (!clientId) return;
    for (const state of owner.pending.values()) {
      if (isRequestRuntimeFinished(state) || state.clientId !== clientId) continue;
      const at = Date.now();
      owner.ingestRequestTransition(state, createRequestEvent(RequestEventType.CONNECTION_CHANGED, state.requestId, {
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

  emitWatchdogEvent(state, type, data = {}) {
    const owner = this.owner;
    if (!state || isRequestRuntimeFinished(state)) return;
    const now = Date.now();
    const key = `${type}:${data.phase || state.progress?.phase || ''}`;
    if (state.lastWatchdogEventKey === key && now - (state.lastWatchdogEventAt || 0) < 10_000) return;
    state.lastWatchdogEventKey = key;
    state.lastWatchdogEventAt = now;
    owner.emitRequestEvent(state, makeEvent(type, { requestId: state.requestId, ...data }));
    state.callbacks.onStatus?.('watchdog', { type, requestId: state.requestId, ...data });
  }

  sourceObservationAnchors(state) {
    const canonical = state?.requestId ? this.owner.getState(state.requestId) : null;
    const observationData = canonical?.lastObservation?.data || {};
    const observation = observationData.observation || {};
    return {
      assistantTurnKey: String(
        observationData.turnKey
        || observation.turn?.key
        || observation.activeRequest?.assistantTurnKey
        || state?.progress?.assistantTurnKey
        || '',
      ),
      submittedUserTurnKey: String(
        canonical?.response?.userTurnKey
        || observationData.submittedUserTurnKey
        || observation.activeRequest?.submittedUserTurnKey
        || state?.progress?.submittedUserTurnKey
        || '',
      ),
    };
  }

  async requestForcedSnapshotForState(state, reason = 'watchdog', options = {}) {
    const owner = this.owner;
    if (!state || isRequestRuntimeFinished(state)) return null;
    if (state.forcedSnapshotInFlight && !options.force) return null;
    if (!state.clientId) throw new Error('Cannot request forced snapshot without sourceClientId');

    const anchors = this.sourceObservationAnchors(state);
    state.forcedSnapshotInFlight = true;
    state.lastForcedSnapshotAt = Date.now();
    state.forcedSnapshotCount = (state.forcedSnapshotCount || 0) + 1;
    owner.emitRequestEvent(state, makeEvent('forced_snapshot.requested', {
      requestId: state.requestId,
      phase: state.progress?.phase || 'unknown',
      reason,
      sourceClientId: state.clientId,
      assistantTurnKey: anchors.assistantTurnKey,
      submittedUserTurnKey: anchors.submittedUserTurnKey,
    }));

    try {
      const response = await owner.sendCommand('response.snapshot.request', {
        requestId: state.requestId,
        turnKey: anchors.assistantTurnKey,
        assistantTurnKey: anchors.assistantTurnKey,
        submittedUserTurnKey: anchors.submittedUserTurnKey,
      }, {
        sourceClientId: state.clientId,
        timeoutMs: Number(config.forcedSnapshotTimeoutMs) || 30_000,
        request: owner.requestIdentity(state),
      });
      if (isRequestRuntimeFinished(state)) return response;
      this.ingestForcedSnapshot(state, response || {}, reason);
      return response;
    } finally {
      if (state) state.forcedSnapshotInFlight = false;
    }
  }

  ingestForcedSnapshot(state, response = {}, reason = 'forced_snapshot') {
    const owner = this.owner;
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
    const sourceAnchors = this.sourceObservationAnchors(state);
    const turnKey = response.turnKey || response.assistantTurnKey || sourceAnchors.assistantTurnKey;
    const nextPhase = response.phase || state.progress?.phase || (responseHasVisibleOutput(response) ? 'snapshot_checked_with_output' : 'snapshot_checked');
    const previousPhase = String(state.progress?.phase || '');
    const previousTurnKey = sourceAnchors.assistantTurnKey;
    const previousGenerationActive = canonicalGenerationActive(owner.getState(state.requestId));
    const nextGenerationActive = Boolean(response.generating || response.stopButtonVisible);
    const thinkingChanged = thinking !== state.thinking;
    const progressChanged = progressText !== state.progressText || progressItemsSignature !== state.progressItemsSignature;
    const answerChanged = Boolean(answerProvided && answer !== state.answer);
    const artifactsChanged = Boolean(artifacts.length && artifactSnapshotSignature(artifacts) !== artifactSnapshotSignature(state.artifacts));
    const identityChanged = Boolean(turnKey && turnKey !== previousTurnKey);
    const phaseChanged = Boolean(nextPhase && nextPhase !== previousPhase);
    const generationChanged = nextGenerationActive !== previousGenerationActive;
    const snapshotChanged = thinkingChanged || progressChanged || answerChanged || artifactsChanged || identityChanged || phaseChanged || generationChanged;

    owner.emitRequestEvent(state, makeEvent('forced_snapshot.received', {
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
      owner.markMeaningfulProgress(state, thinking ? 'forced_snapshot.thinking' : 'forced_snapshot.thinking_cleared');
      state.callbacks.onThinkingUpdate?.(state.thinking, response);
      owner.emitRequestEvent(state, makeEvent('thinking.snapshot', { requestId: state.requestId, text: state.thinking, delta, source: 'forced_snapshot' }));
    }

    if (progressChanged) {
      const delta = appendOnlyDelta(state.progressText || '', progressText);
      state.progressText = progressText;
      state.progressItems = progressItems;
      state.progressItemsSignature = progressItemsSignature;
      state.reasoningHistory = mergeProgressRecords(state.reasoningHistory, completedReasoningRecords(progressItems));
      owner.markMeaningfulProgress(state, progressText || progressItems.length ? 'forced_snapshot.progress' : 'forced_snapshot.progress_cleared');
      state.callbacks.onProgressUpdate?.(state.progressText, response);
      owner.emitRequestEvent(state, makeEvent('assistant.progress.snapshot', {
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
      owner.markMeaningfulProgress(state, answer ? 'forced_snapshot.answer' : 'forced_snapshot.answer_cleared');
      state.callbacks.onAnswerUpdate?.(state.answer, response);
      owner.emitRequestEvent(state, makeEvent('answer.snapshot', {
        requestId: state.requestId,
        text: state.answer,
        delta,
        source: 'forced_snapshot',
        cleared: !answer,
      }));
    }

    if (artifactsChanged) {
      state.artifacts = artifacts;
      for (const artifact of artifacts) if (artifact.id) owner.artifacts.set(artifact.id, artifact);
      owner.markMeaningfulProgress(state, 'forced_snapshot.artifacts');
      state.callbacks.onArtifactUpdate?.(artifacts, response);
      owner.emitRequestEvent(state, makeEvent('artifact.snapshot', {
        requestId: state.requestId,
        artifacts,
        source: 'forced_snapshot',
        canonicalArtifactStatus: owner.canonicalArtifactStatus(state, artifacts),
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
      owner.updateProgress(state, {
        phase: nextPhase,
        requestId: state.requestId,
        clientId: state.clientId,
        assistantTurnKey: turnKey,
        meaningful: identityChanged || generationChanged,
        generating: Boolean(response.generating),
        stopButtonVisible: Boolean(response.stopButtonVisible),
        sawGenerating: Boolean(response.generating || response.stopButtonVisible || state.progress?.sawGenerating),
        answerLength: answer.length || String(state.answer || '').length,
        artifactCount: artifacts.length || state.artifacts.length,
      }, { emit: true });
    } else {
      if (nextGenerationActive) state.generationActivityAt = Date.now();
    }
  }
}
