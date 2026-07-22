function normalizeName(value = '') {
  const raw = String(value || '').split(/[\\/]/).pop() || '';
  try { return decodeURIComponent(raw).trim().toLowerCase(); }
  catch { return raw.trim().toLowerCase(); }
}

function normalizeConflictName(value = '') {
  const name = normalizeName(value);
  const dot = name.lastIndexOf('.');
  const stem = dot >= 0 ? name.slice(0, dot) : name;
  const extension = dot >= 0 ? name.slice(dot) : '';
  return `${stem.replace(/ \([0-9]+\)$/i, '')}${extension}`;
}

function candidateNames(item = {}) {
  return [...new Set([item.filename, item.url, item.finalUrl]
    .filter(Boolean)
    .map(normalizeConflictName)
    .filter(Boolean))];
}

export function downloadCapturePortMatches(left, right) {
  return left === right;
}

export function downloadCaptureExpectedNames(state = {}) {
  return [...new Set([
    state.expectedName,
    state.artifact?.name,
    ...(Array.isArray(state.expectedNames) ? state.expectedNames : []),
  ].map(normalizeConflictName).filter(Boolean))];
}

export function downloadCaptureExpectedIdentity(options = {}) {
  const artifact = options.artifact && typeof options.artifact === 'object' ? options.artifact : {};
  return Object.freeze({
    requirementId: String(options.artifactRequirementId || artifact.requirementId || ''),
    candidateId: String(options.artifactCandidateId || artifact.id || ''),
    sourceTurnKey: String(artifact.sourceTurnKey || ''),
    name: String(options.expectedName || artifact.name || ''),
    kind: String(artifact.kind || ''),
  });
}

export function downloadCaptureIdentityScore(state, item = {}, now = Date.now()) {
  if (!state || state.done || state.itemId != null || !state.actionActivatedAt) return -Infinity;
  const identity = state.expectedArtifactIdentity || {};
  if (!identity.candidateId || !identity.sourceTurnKey) return -Infinity;
  const expected = downloadCaptureExpectedNames(state);
  const candidates = candidateNames(item);
  if (!expected.length || !candidates.length) return -Infinity;
  const itemStartedAt = Date.parse(String(item.startTime || ''));
  if (Number.isFinite(itemStartedAt)) {
    const earliest = state.actionActivatedAt - 1_000;
    const latest = state.actionActivatedAt + Math.min(state.timeoutMs, 15_000);
    if (itemStartedAt < earliest || itemStartedAt > latest) return -Infinity;
  } else if (now - state.actionActivatedAt > Math.min(state.timeoutMs, 10_000)) return -Infinity;
  for (const name of expected) {
    if (candidates.some((candidate) => candidate === name)) return 500;
  }
  return -Infinity;
}

export function findPendingDownloadCapture(downloadCaptures, item = {}, now = Date.now()) {
  const ranked = [...downloadCaptures.values()]
    .filter((state) => !state.done && state.itemId == null)
    .map((state) => ({ state, score: downloadCaptureIdentityScore(state, item, now) }))
    .filter((entry) => Number.isFinite(entry.score) && entry.score > 0)
    .sort((left, right) => right.score - left.score || left.state.startedAt - right.state.startedAt);
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
  return ranked[0].state;
}

export function downloadCapturePublicItem(item = {}, state = null) {
  return {
    id: item.id,
    url: item.url || '',
    finalUrl: item.finalUrl || '',
    filename: item.filename || '',
    name: item.filename ? item.filename.split(/[\\/]/).pop() : '',
    mime: item.mime || '',
    fileSize: item.fileSize || 0,
    bytesReceived: item.bytesReceived || 0,
    state: item.state || '',
    danger: item.danger || '',
    exists: item.exists !== false,
    startTime: item.startTime || '',
    endTime: item.endTime || '',
    captureId: state?.captureId || '',
    captureStartedAt: state?.startedAt || 0,
    capturedAt: Date.now(),
    expectedNames: state ? downloadCaptureExpectedNames(state) : [],
    artifactIdentity: state?.expectedArtifactIdentity || null,
  };
}
