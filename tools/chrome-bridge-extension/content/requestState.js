// Canonical content-runtime request projection construction and recovery.
// Loaded before executionState.js and requestCommands.js.
(() => {
  'use strict';

  function setFrom(value) {
    if (value instanceof Set) return new Set(value);
    if (Array.isArray(value)) return new Set(value);
    return new Set();
  }


  function createRequestState(requestId, options = {}, ownerServerInstanceId = '', leaseId = '', overrides = {}) {
    const startedAt = Number(overrides.startedAt) || Date.now();
    return {
      requestId: String(requestId || ''),
      leaseId: String(leaseId || ''),
      startedAt,
      options: options && typeof options === 'object' ? { ...options } : {},
      ownerServerInstanceId: String(ownerServerInstanceId || ''),
      commandId: String(overrides.commandId || ''),
      responseEpoch: Math.max(0, Number(overrides.responseEpoch) || 0),
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
      steerWaitStartedAt: 0,
      steerWaitExpiredAt: 0,
      observerRootMissingLogged: false,
      generationStartWarningSent: false,
      firstOutputWarningSent: false,
      maxRequestTimeoutWarningSent: false,
      sentAt: 0,
      recovering: false,
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
    const recoverableFields = [
      'commandId', 'responseEpoch', 'baselineAssistantCount', 'turnBaselineReady', 'turnCaptureArmed',
      'promptSubmissionStartedAt', 'submittedUserTurnKey', 'submittedUserTurnIndex',
      'submittedUserTurnLogged', 'assistantTurnKey', 'assistantTurnIndex',
      'pendingSubmittedTurnKind', 'pendingSubmittedTurnExpectedText', 'promptHash',
      'promptPreview', 'sentAt', 'lastObservationRevision', 'lastObservationEpoch',
      'lastObservationAt', 'lastProgressSentAt', 'lastMeaningfulProgressAt',
      'lastMeaningfulProgressReason', 'lastUserTurnMismatchSignature',
      'assistantTurnLogged', 'assistantTurnMissingLogged', 'assistantTurnMissingSince',
      'observerRootMissingLogged', 'generationStartWarningSent', 'firstOutputWarningSent',
      'maxRequestTimeoutWarningSent', 'steerWaitStartedAt', 'steerWaitExpiredAt',
    ];
    const recovered = { ...base };
    for (const field of recoverableFields) {
      if (Object.prototype.hasOwnProperty.call(existingRequest || {}, field)) recovered[field] = existingRequest[field];
    }
    recovered.requestId = requestId;
    recovered.leaseId = String(lease?.leaseId || existingRequest?.leaseId || '');
    recovered.ownerServerInstanceId = String(lease?.ownerServerInstanceId || existingRequest?.ownerServerInstanceId || '');
    recovered.phase = 'reconciling';
    recovered.recovering = true;
    recovered.baselineTurnKeys = setFrom(existingRequest?.baselineTurnKeys);
    recovered.pendingSubmittedTurnBaseline = existingRequest?.pendingSubmittedTurnBaseline == null
      ? null
      : setFrom(existingRequest.pendingSubmittedTurnBaseline);
    return recovered;
  }

  function publicRequestStatus(request, runtime = {}) {
    if (!request) return null;
    return {
      requestId: String(request.requestId || ''),
      leaseId: String(request.leaseId || ''),
      ownerServerInstanceId: String(request.ownerServerInstanceId || ''),
      responseEpoch: Math.max(0, Number(request.responseEpoch) || 0),
      startedAt: Number(request.startedAt) || 0,
      sentAt: Number(request.sentAt) || 0,
      submittedUserTurnKey: String(request.submittedUserTurnKey || ''),
      submittedUserTurnIndex: Number.isInteger(request.submittedUserTurnIndex) ? request.submittedUserTurnIndex : -1,
      assistantTurnKey: String(request.assistantTurnKey || ''),
      assistantTurnIndex: Number.isInteger(request.assistantTurnIndex) ? request.assistantTurnIndex : -1,
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
