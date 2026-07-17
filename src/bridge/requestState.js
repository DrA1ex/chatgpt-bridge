import { config } from '../config.js';
import { selectRequiredZipCompletionCandidate } from '../results/artifacts.js';

export function noopCallbacks(callbacks = {}) {
  return {
    onThinkingUpdate: typeof callbacks.onThinkingUpdate === 'function' ? callbacks.onThinkingUpdate : null,
    onAnswerUpdate: typeof callbacks.onAnswerUpdate === 'function' ? callbacks.onAnswerUpdate : null,
    onArtifactUpdate: typeof callbacks.onArtifactUpdate === 'function' ? callbacks.onArtifactUpdate : null,
    onProgressUpdate: typeof callbacks.onProgressUpdate === 'function' ? callbacks.onProgressUpdate : null,
    onEvent: typeof callbacks.onEvent === 'function' ? callbacks.onEvent : null,
    onStatus: typeof callbacks.onStatus === 'function' ? callbacks.onStatus : null,
  };
}

function progressRecordId(item = {}, index = 0) {
  return String(item?.id || item?.key || `${item?.kind || 'progress'}:${item?.structuralHint || index}`);
}

export function mergeProgressRecords(...collections) {
  const ordered = [];
  const records = new Map();
  for (const collection of collections) {
    for (const item of Array.isArray(collection) ? collection : []) {
      if (!item || typeof item !== 'object') continue;
      const id = progressRecordId(item, ordered.length);
      const previous = records.get(id);
      if (!previous) {
        ordered.push(id);
        records.set(id, { ...item, id: item.id || id, key: item.key || id });
        continue;
      }
      const previousRevision = Number(previous.revision || 0);
      const nextRevision = Number(item.revision || 0);
      const preferNext = nextRevision >= previousRevision || (!previous.text && item.text);
      const preferred = preferNext ? item : previous;
      const fallback = preferNext ? previous : item;
      records.set(id, {
        ...fallback,
        ...preferred,
        id: preferred.id || fallback.id || id,
        key: preferred.key || fallback.key || id,
        text: preferred.text || fallback.text || '',
        revision: Math.max(previousRevision, nextRevision),
        testIds: Array.isArray(preferred.testIds) ? preferred.testIds : (Array.isArray(fallback.testIds) ? fallback.testIds : []),
      });
    }
  }
  return ordered.map((id) => records.get(id)).filter(Boolean);
}

export function completedReasoningRecords(items = []) {
  return (Array.isArray(items) ? items : []).filter((item) => item?.kind === 'thinking' && (item?.state === 'completed' || item?.active === false));
}

export function abortError(message = 'Request cancelled') {
  const err = new Error(message);
  err.name = 'AbortError';
  err.statusCode = 499;
  return err;
}

export function makeEvent(type, payload = {}) {
  return {
    type,
    time: new Date().toISOString(),
    ...payload,
  };
}

function ageMs(timestamp) {
  const value = Number(timestamp) || 0;
  return value > 0 ? Date.now() - value : null;
}

export function responseHasVisibleOutput(response = {}) {
  return Boolean(
    String(response.answer || response.response || '').trim()
    || String(response.thinking || '').trim()
    || String(response.progress || response.progressText || '').trim()
    || (Array.isArray(response.artifacts) && response.artifacts.length)
  );
}

export function responseHasTerminalOutput(response = {}) {
  return Boolean(
    String(response.answer || response.response || '').trim()
    || (Array.isArray(response.artifacts) && response.artifacts.length)
  );
}

export function artifactSnapshotSignature(artifacts = []) {
  if (!Array.isArray(artifacts) || !artifacts.length) return '';
  return artifacts.map((artifact) => [
    artifact?.id || '',
    artifact?.name || artifact?.filename || '',
    artifact?.url || artifact?.downloadUrl || artifact?.src || '',
    artifact?.size || 0,
    artifact?.mime || '',
    artifact?.kind || '',
    artifact?.phase || '',
    artifact?.state || '',
    artifact?.downloadable ? 'downloadable' : '',
    artifact?.downloadActionPresent ? 'action' : '',
    artifact?.actionLabel || '',
    artifact?.lifecycleObserved ?? '',
  ].join('|')).sort().join('\n');
}

export function requiredArtifactExpectation(state) {
  const output = state?.expectedOutput || {};
  if (!output.required) return '';
  const expected = String(output.expected || '').trim().toLowerCase();
  if (expected === 'zip') return 'zip';
  if (['file', 'artifact', 'download'].includes(expected)) return 'file';
  return '';
}

function artifactIsMaterializable(artifact = {}) {
  const phase = String(artifact?.phase || artifact?.state || '').trim().toUpperCase();
  if (phase === 'FAILED') return false;
  if (phase && phase !== 'READY') return false;
  return Boolean(
    artifact?.downloadable
    || artifact?.downloadActionPresent
    || artifact?.url
    || artifact?.downloadUrl
    || artifact?.src
    || phase === 'READY'
  );
}

function artifactMatchesRequiredExpectation(artifact = {}, expectation = '') {
  if (!artifactIsMaterializable(artifact)) return false;
  if (expectation !== 'zip') return true;
  const identity = [
    artifact?.name,
    artifact?.filename,
    artifact?.fileName,
    artifact?.mime,
    artifact?.contentType,
    artifact?.kind,
    artifact?.type,
    artifact?.actionLabel,
    artifact?.text,
  ].filter(Boolean).join(' ').trim().toLowerCase();
  return /\.zip(?:$|[?#]|\b)/.test(identity)
    || /(?:application|multipart)\/(?:zip|x-zip-compressed)/.test(identity)
    || /(?:^|\b)(?:zip|zip archive|project archive|archive bundle)(?:\b|$)/.test(identity);
}

export function requiredOutputArtifactMissing(state, artifacts = state?.artifacts || []) {
  const expectation = requiredArtifactExpectation(state);
  if (!expectation) return false;
  const candidates = Array.isArray(artifacts) ? artifacts : [];
  if (expectation !== 'zip') return !candidates.some((artifact) => artifactMatchesRequiredExpectation(artifact, expectation));

  const responseScope = {
    requestId: state?.requestId || '',
    turnKey: state?.progress?.assistantTurnKey || state?.deferredDone?.metadata?.turnKey || '',
    candidateIndex: state?.progress?.sourceCandidateIndex || 0,
  };
  return !selectRequiredZipCompletionCandidate(candidates, responseScope).artifact;
}

export function preferCompleteText(primary = '', fallback = '') {
  const first = String(primary || '');
  const second = String(fallback || '');
  return second.length > first.length ? second : first;
}

export function compactRequestState(state) {
  if (!state) return null;
  return {
    requestId: state.requestId,
    clientId: state.clientId || '',
    accepted: Boolean(state.accepted),
    delivered: Boolean(state.delivered),
    done: Boolean(state.done),
    resumed: Boolean(state.resumed),
    model: state.model || '',
    effort: state.effort || '',
    phase: state.progress?.phase || state.lastActivityReason || 'unknown',
    sourceUrl: state.progress?.url || '',
    sourceTitle: state.progress?.title || '',
    sourceSession: state.progress?.session || state.session || null,
    createdAt: state.createdAt || '',
    startedAt: state.startedAt || 0,
    lastHeartbeatAt: state.lastHeartbeatAt || 0,
    lastActivityAt: state.lastActivityAt || 0,
    lastActivityReason: state.lastActivityReason || '',
    lastMeaningfulProgressAt: state.lastMeaningfulProgressAt || 0,
    lastProgressAt: state.lastProgressAt || 0,
    lastProgressEvent: state.progress || null,
    phaseEnteredAt: state.phaseEnteredAt || state.startedAt || 0,
    phaseAgeMs: ageMs(state.phaseEnteredAt || state.startedAt || 0),
    meaningfulProgressAgoMs: ageMs(state.lastMeaningfulProgressAt),
    hardHeartbeatAgoMs: ageMs(state.lastHeartbeatAt),
    generationActivityAt: state.generationActivityAt || 0,
    currentGenerationActive: Boolean(state.currentGenerationActive),
    generationActivityAgoMs: ageMs(state.generationActivityAt),
    forcedSnapshotCount: state.forcedSnapshotCount || 0,
    lastForcedSnapshotAt: state.lastForcedSnapshotAt || 0,
    lastForcedSnapshotAgoMs: ageMs(state.lastForcedSnapshotAt),
    answerLength: String(state.answer || '').length,
    thinkingLength: String(state.thinking || '').length,
    artifactCount: Array.isArray(state.artifacts) ? state.artifacts.length : 0,
    progressText: state.progressText || '',
    progressTextLength: String(state.progressText || '').length,
    submittedUserTurnKey: state.progress?.submittedUserTurnKey || '',
    submittedUserTurnIndex: state.progress?.submittedUserTurnIndex ?? -1,
    assistantTurnKey: state.progress?.assistantTurnKey || '',
    assistantTurnIndex: state.progress?.assistantTurnIndex ?? -1,
    anchorConfidence: state.progress?.anchorConfidence || '',
    anchorReason: state.progress?.anchorReason || '',
    visibilityState: state.progress?.visibilityState || '',
    focused: state.progress?.focused ?? null,
    sawGenerating: state.progress?.sawGenerating ?? false,
    sawAnswer: state.progress?.sawAnswer ?? false,
    networkDone: state.progress?.networkDone ?? false,
    stopButtonVisible: state.progress?.stopButtonVisible ?? false,
  };
}

export function normalizeOptions(options = {}) {
  return {
    sessionId: typeof options.sessionId === 'string' ? options.sessionId : '',
    newSession: Boolean(options.newSession),
    model: typeof options.model === 'string' ? options.model : '',
    effort: typeof options.effort === 'string' ? options.effort : '',
    attachments: Array.isArray(options.attachments) ? options.attachments : [],
    sourceClientId: typeof options.sourceClientId === 'string' ? options.sourceClientId : typeof options.clientId === 'string' ? options.clientId : '',
    autoOpenTab: typeof options.autoOpenTab === 'boolean' ? options.autoOpenTab : undefined,
    captureDomTimeline: Boolean(options.captureDomTimeline),
    answerSettleMs: config.answerSettleMs,
    answerDoneSettleMs: config.answerDoneSettleMs,
    postStopTerminalSettleMs: config.postStopTerminalSettleMs,
    requiredArtifactSettleMs: config.requiredArtifactSettleMs,
    expectedOutput: options.output && typeof options.output === 'object'
      ? { expected: String(options.output.expected || options.output.format || ''), required: Boolean(options.output.required) }
      : options.expectedOutput && typeof options.expectedOutput === 'object'
        ? { expected: String(options.expectedOutput.expected || options.expectedOutput.format || ''), required: Boolean(options.expectedOutput.required) }
        : { expected: '', required: false },
    ...(options.chatOptions && typeof options.chatOptions === 'object' ? options.chatOptions : {}),
  };
}

