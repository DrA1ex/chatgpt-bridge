import {
  DOWNLOAD_TRANSITIONS,
  DownloadStatus,
  committed,
  matchingLease,
  matchingPersistedRequestIdentity,
  now,
  rejected
} from './stateV6Core.js';

export function reduceDownloadEvent(state, event) {
  switch (event.type) {
    case 'download.identity_updated': {
      const captureId = String(event.captureId || '');
      const previous = state.downloads[captureId] || null;
      if (!previous) return rejected(state, event, 'download_missing');
      if ([DownloadStatus.COMPLETED, DownloadStatus.FAILED, DownloadStatus.RELEASED].includes(previous.status)) return rejected(state, event, 'download_terminal');
      if (previous.scope === 'standalone') {
        if (!event.commandId || String(event.commandId) !== String(previous.commandId || '')) {
          return rejected(state, event, 'download_identity_mismatch');
        }
      } else if (!matchingPersistedRequestIdentity(previous, event, { requireResponseEpoch: true })) {
        return rejected(state, event, 'download_identity_mismatch');
      }
      return committed(state, event, { downloads: { ...state.downloads, [captureId]: {
        ...previous,
        expectedNames: [...new Set([...(previous.expectedNames || []), ...(event.expectedNames || [])].map(String).filter(Boolean))],
        expectedArtifactIdentity: event.expectedArtifactIdentity || previous.expectedArtifactIdentity || null,
        actionActivationId: String(event.actionActivationId || previous.actionActivationId || ''),
        actionActivatedAt: Number(event.actionActivatedAt) || previous.actionActivatedAt || 0,
        updatedAt: now(event),
      } } });
    }
    case 'download.transition': {
      const captureId = String(event.captureId || '');
      const status = String(event.status || '');
      if (!captureId || !Object.values(DownloadStatus).includes(status)) return rejected(state, event, 'download_transition_invalid');
      const previous = state.downloads[captureId] || null;
      if (previous && [DownloadStatus.COMPLETED, DownloadStatus.FAILED, DownloadStatus.RELEASED].includes(previous.status)) {
        return rejected(state, event, 'download_terminal');
      }
      if (!previous && status !== DownloadStatus.PLANNED) return rejected(state, event, 'download_transition_invalid');
      if (previous && !DOWNLOAD_TRANSITIONS[previous.status]?.has(status)) return rejected(state, event, 'download_transition_invalid');
      const scope = previous?.scope || (event.scope === 'standalone' ? 'standalone' : 'request');
      const commandId = String(event.commandId || previous?.commandId || '');
      const requestId = String(event.requestId || '');
      const leaseId = String(event.leaseId || '');
      const ownerServerInstanceId = String(event.ownerServerInstanceId || '');
      const responseEpoch = Math.max(0, Number(event.responseEpoch) || 0);
      if (scope === 'request') {
        if (!requestId || !leaseId || !ownerServerInstanceId || event.responseEpoch == null) return rejected(state, event, 'download_identity_missing');
        if (previous && !matchingPersistedRequestIdentity(previous, event, { requireResponseEpoch: true })) return rejected(state, event, 'download_identity_mismatch');
        if (!previous && !matchingLease(state, event, { requireResponseEpoch: true })) return rejected(state, event, 'lease_mismatch');
        if (status !== DownloadStatus.PLANNED && !matchingLease(state, previous, { requireResponseEpoch: true })) return rejected(state, event, 'download_lease_inactive');
      } else {
        if (!commandId) return rejected(state, event, 'download_identity_missing');
        if (previous && (previous.scope !== 'standalone' || previous.commandId !== commandId)) return rejected(state, event, 'download_identity_mismatch');
      }
      return committed(state, event, { downloads: { ...state.downloads, [captureId]: {
        ...(previous || {}),
        captureId,
        status,
        scope,
        commandId,
        requestId: scope === 'request' ? requestId : '',
        leaseId: scope === 'request' ? leaseId : '',
        ownerServerInstanceId: scope === 'request' ? ownerServerInstanceId : '',
        responseEpoch: scope === 'request' ? responseEpoch : 0,
        effectId: String(event.effectId || previous?.effectId || ''),
        artifactRequirementId: String(event.artifactRequirementId || previous?.artifactRequirementId || ''),
        artifactCandidateId: String(event.artifactCandidateId || previous?.artifactCandidateId || ''),
        expectedArtifactIdentity: event.expectedArtifactIdentity || previous?.expectedArtifactIdentity || null,
        downloadId: event.downloadId ?? previous?.downloadId ?? null,
        expectedNames: event.expectedNames || previous?.expectedNames || [],
        bindingSource: String(event.bindingSource || previous?.bindingSource || ''),
        actionActivationId: String(event.actionActivationId || previous?.actionActivationId || ''),
        actionActivatedAt: Number(event.actionActivatedAt) || previous?.actionActivatedAt || 0,
        result: event.result && typeof event.result === 'object' ? event.result : previous?.result || null,
        error: event.error && typeof event.error === 'object' ? event.error : previous?.error || null,
        updatedAt: now(event),
      } } });
    }
    default:
      return null;
  }
}
