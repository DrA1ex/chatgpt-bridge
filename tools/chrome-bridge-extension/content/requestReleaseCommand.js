// Exact request-lease release command handler.
(() => {
  'use strict';

  function createRequestReleaseCommand(deps = {}) {
    const {
      diagnostic,
      findStopButton,
      getActiveRequest,
      isGenerating,
      releaseRequest,
      settleReleaseCleanup,
    } = deps;

    async function handleRequestRelease(payload) {
      const requestId = String(payload.requestId || '');
      const commandId = String(payload.commandId || '');
      const releaseIdentity = {
        leaseId: String(payload.leaseId || ''),
        ownerServerInstanceId: String(payload.ownerServerInstanceId || ''),
      };
      if (payload.recoveryMode === 'stale_lease') {
        let generationEvidence;
        if (typeof findStopButton !== 'function' || typeof isGenerating !== 'function') {
          generationEvidence = { state: 'unknown', reason: 'probe_unavailable', stopButtonVisible: null, isGenerating: null };
        } else {
          try {
            const stopButton = findStopButton();
            const generating = isGenerating();
            const stopButtonKnown = stopButton === null || (typeof stopButton === 'object' && stopButton !== null) || typeof stopButton === 'function';
            if (!stopButtonKnown || typeof generating !== 'boolean') {
              generationEvidence = { state: 'unknown', reason: 'probe_invalid_result', stopButtonVisible: null, isGenerating: null };
            } else {
              const stopButtonVisible = stopButton !== null;
              generationEvidence = {
                state: stopButtonVisible || generating ? 'active' : 'idle',
                stopButtonVisible,
                isGenerating: generating,
              };
            }
          } catch {
            generationEvidence = { state: 'unknown', reason: 'probe_failed', stopButtonVisible: null, isGenerating: null };
          }
        }
        if (generationEvidence.state !== 'idle') {
          await settleReleaseCleanup({
            commandId, requestId, status: 'failed',
            code: generationEvidence.state === 'active' ? 'STALE_RELEASE_GENERATION_ACTIVE' : 'STALE_RELEASE_GENERATION_UNKNOWN',
            message: 'Stale request release requires a proven idle ChatGPT generation',
            evidence: { type: 'request.release.generation_probe', ...generationEvidence },
            ...releaseIdentity,
          });
          return;
        }
      }
      const activeRequest = getActiveRequest();
      if (!activeRequest) {
        await settleReleaseCleanup({ commandId, requestId, status: 'completed', released: true, duplicate: true, ...releaseIdentity });
        return;
      }
      if (requestId && activeRequest.requestId !== requestId) {
        diagnostic('request.release_mismatch', { requestId, activeRequestId: activeRequest.requestId });
        await settleReleaseCleanup({
          commandId, requestId, status: 'failed',
          code: 'RELEASE_ACTIVE_REQUEST_MISMATCH',
          message: `Active request ${activeRequest.requestId} does not match release request`,
          evidence: { activeRequestId: activeRequest.requestId },
          ...releaseIdentity,
        });
        return;
      }
      const released = releaseRequest(activeRequest, String(payload.reason || payload.terminalCode || 'server_terminal'));
      await settleReleaseCleanup({ commandId, requestId, status: 'completed', released, ...releaseIdentity });
    }

    return Object.freeze({ handleRequestRelease });
  }

  globalThis.ChatGptRequestReleaseCommand = Object.freeze({ createRequestReleaseCommand });
})();
