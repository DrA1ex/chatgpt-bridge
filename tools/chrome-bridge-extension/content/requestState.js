// Canonical content-runtime request projection construction and recovery.
// Loaded before executionState.js and requestCommands.js.
(() => {
  'use strict';

  function setFrom(value) {
    if (value instanceof Set) return new Set(value);
    if (Array.isArray(value)) return new Set(value);
    return new Set();
  }

  function arrayFrom(value) {
    return Array.isArray(value) ? value.slice() : [];
  }

  function createRequestState(requestId, options = {}, ownerServerInstanceId = '', leaseId = '', overrides = {}) {
    const startedAt = Number(overrides.startedAt) || Date.now();
    return {
      requestId: String(requestId || ''),
      leaseId: String(leaseId || ''),
      startedAt,
      options: options && typeof options === 'object' ? { ...options } : {},
      ownerServerInstanceId: String(ownerServerInstanceId || ''),
      phase: 'created',
      lastProgressSentAt: 0,
      lastMeaningfulProgressAt: startedAt,
      lastMeaningfulProgressReason: 'request.created',
      baselineAssistantCount: 0,
      baselineTurnKeys: new Set(),
      turnBaselineReady: false,
      turnCaptureArmed: false,
      promptSubmissionStartedAt: 0,
      submittedUserTurnKey: '',
      submittedUserTurnIndex: -1,
      submittedUserTurnLogged: false,
      assistantTurnKey: '',
      assistantTurnIndex: -1,
      pendingSubmittedTurnBaseline: null,
      pendingSubmittedTurnKind: '',
      pendingSubmittedTurnExpectedText: '',
      lastUserTurnMismatchSignature: '',
      assistantTurnLogged: false,
      assistantTurnMissingLogged: false,
      assistantTurnMissingSince: 0,
      promptHash: '',
      promptPreview: '',
      lastAnswer: '',
      lastThinking: '',
      lastProgressText: '',
      lastProgressItemsFingerprint: '',
      lastProgressItems: [],
      lastRaw: '',
      lastDomSignature: '',
      lastVisibleThinking: '',
      reasoningHistory: [],
      lastUnknownTestIdsSignature: '',
      lastArtifactsFingerprint: '',
      lastIgnoredArtifactFingerprint: '',
      artifacts: [],
      stableSince: 0,
      generationIdleSince: 0,
      sawAnswer: false,
      sawGenerating: false,
      generationStoppedSent: false,
      steerWaitStartedAt: 0,
      terminalCandidateSince: 0,
      terminalSnapshotSignature: '',
      terminalFailureSignature: '',
      releaseFallbackTimer: null,
      effectSequence: 0,
      steerWaitExpiredAt: 0,
      lastSnapshotChangedAt: 0,
      collectScheduled: false,
      collectTimer: null,
      collecting: false,
      networkDone: false,
      observer: null,
      observerRoot: null,
      observerRootMissingLogged: false,
      pollTimer: null,
      generationStartWarningSent: false,
      firstOutputWarningSent: false,
      maxRequestTimeoutWarningSent: false,
      sentAt: 0,
      finished: false,
      recovering: false,
      ...overrides,
    };
  }

  function recoverRequestState(existingRequest, recovery = {}) {
    const lease = recovery?.lease;
    const requestId = String(lease?.requestId || existingRequest?.requestId || '');
    if (!requestId) throw new Error('Recovered request lease is missing requestId');
    const base = createRequestState(
      requestId,
      existingRequest?.options || {},
      lease?.ownerServerInstanceId || existingRequest?.ownerServerInstanceId || '',
      lease?.leaseId || existingRequest?.leaseId || '',
      { startedAt: Number(existingRequest?.startedAt) || Number(lease?.claimedAt) || Date.now() },
    );
    const recovered = {
      ...base,
      ...(existingRequest || {}),
      requestId,
      leaseId: String(lease?.leaseId || existingRequest?.leaseId || ''),
      ownerServerInstanceId: String(lease?.ownerServerInstanceId || existingRequest?.ownerServerInstanceId || ''),
      phase: 'reconciling',
      recovering: true,
      effectSequence: Math.max(Number(existingRequest?.effectSequence) || 0, arrayFrom(recovery.effects).length),
      baselineTurnKeys: setFrom(existingRequest?.baselineTurnKeys),
      lastProgressItems: arrayFrom(existingRequest?.lastProgressItems),
      reasoningHistory: arrayFrom(existingRequest?.reasoningHistory),
      artifacts: arrayFrom(existingRequest?.artifacts),
      lastAnswer: String(existingRequest?.lastAnswer || ''),
      lastThinking: String(existingRequest?.lastThinking || ''),
      lastProgressText: String(existingRequest?.lastProgressText || ''),
      lastRaw: String(existingRequest?.lastRaw || ''),
      submittedUserTurnIndex: Number.isInteger(existingRequest?.submittedUserTurnIndex) ? existingRequest.submittedUserTurnIndex : -1,
      assistantTurnIndex: Number.isInteger(existingRequest?.assistantTurnIndex) ? existingRequest.assistantTurnIndex : -1,
      releaseFallbackTimer: null,
      collectTimer: null,
      observer: null,
      observerRoot: null,
      pollTimer: null,
      collectScheduled: false,
      collecting: false,
    };
    return recovered;
  }

  function publicRequestStatus(request, runtime = {}) {
    if (!request) return null;
    return {
      requestId: String(request.requestId || ''),
      startedAt: Number(request.startedAt) || 0,
      sentAt: Number(request.sentAt) || 0,
      sawGenerating: Boolean(request.sawGenerating),
      generating: Boolean(runtime.generating),
      stopButtonVisible: Boolean(runtime.stopButtonVisible),
      ownerServerInstanceId: String(request.ownerServerInstanceId || ''),
      phase: String(request.phase || 'created'),
      sawAnswer: Boolean(request.sawAnswer),
      lastAnswerLength: String(request.lastAnswer || '').length,
      lastThinkingLength: String(request.lastThinking || '').length,
      lastProgressLength: String(request.lastProgressText || '').length,
      artifactCount: arrayFrom(request.artifacts).length,
      submittedUserTurnKey: String(request.submittedUserTurnKey || ''),
      submittedUserTurnIndex: Number.isInteger(request.submittedUserTurnIndex) ? request.submittedUserTurnIndex : -1,
      promptPreview: String(request.promptPreview || ''),
      promptHash: String(request.promptHash || ''),
      assistantTurnKey: String(request.assistantTurnKey || ''),
      assistantTurnIndex: Number.isInteger(request.assistantTurnIndex) ? request.assistantTurnIndex : -1,
      lastMeaningfulProgressAt: Number(request.lastMeaningfulProgressAt) || 0,
      lastMeaningfulProgressReason: String(request.lastMeaningfulProgressReason || ''),
      url: String(runtime.url || ''),
      title: String(runtime.title || ''),
    };
  }

  globalThis.ChatGptRequestState = Object.freeze({
    createRequestState,
    publicRequestStatus,
    recoverRequestState,
  });
})();
