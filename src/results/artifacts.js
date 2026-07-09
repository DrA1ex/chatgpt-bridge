export function looksLikeZipArtifact(artifact = {}) {
  const name = String(artifact.name || artifact.title || artifact.filename || '').toLowerCase();
  const mime = String(artifact.mime || artifact.type || '').toLowerCase();
  const kind = String(artifact.kind || '').toLowerCase();
  return name.endsWith('.zip') || mime.includes('zip') || (kind === 'file' && /zip/.test(name + mime));
}

export function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function artifactMatchesResponseScope(artifact = {}, response = {}) {
  const responseRequestId = String(response.requestId || '');
  const artifactRequestId = String(artifact.requestId || '');
  if (responseRequestId && artifactRequestId && artifactRequestId !== responseRequestId) return false;

  const responseTurnKey = String(response.turnKey || response.sourceTurnKey || response.assistantTurnKey || '');
  const artifactTurnKey = String(artifact.sourceTurnKey || artifact.turnKey || artifact.assistantTurnKey || '');
  if (responseTurnKey && artifactTurnKey && artifactTurnKey !== responseTurnKey) return false;

  const responseCandidateIndex = positiveNumber(response.candidateIndex || response.sourceCandidateIndex);
  const artifactCandidateIndex = positiveNumber(artifact.sourceCandidateIndex || artifact.candidateIndex);
  if (responseCandidateIndex && artifactCandidateIndex && artifactCandidateIndex !== responseCandidateIndex) return false;

  const responseHasScope = Boolean(responseRequestId || responseTurnKey || responseCandidateIndex);
  const artifactHasScope = Boolean(artifactRequestId || artifactTurnKey || artifactCandidateIndex);
  if (responseHasScope && !artifactHasScope) return false;

  return true;
}

export function artifactSelectionScore(artifact = {}, response = {}) {
  if (!looksLikeZipArtifact(artifact) || !artifactMatchesResponseScope(artifact, response)) return Number.NEGATIVE_INFINITY;
  let score = 0;
  const responseTurnKey = String(response.turnKey || response.sourceTurnKey || response.assistantTurnKey || '');
  const artifactTurnKey = String(artifact.sourceTurnKey || artifact.turnKey || artifact.assistantTurnKey || '');
  if (responseTurnKey && artifactTurnKey === responseTurnKey) score += 1000;
  const responseRequestId = String(response.requestId || '');
  if (artifact.requestId && responseRequestId && artifact.requestId === responseRequestId) score += 500;
  const responseCandidateIndex = positiveNumber(response.candidateIndex || response.sourceCandidateIndex);
  const artifactCandidateIndex = positiveNumber(artifact.sourceCandidateIndex || artifact.candidateIndex);
  if (responseCandidateIndex && artifactCandidateIndex === responseCandidateIndex) score += 250;
  if (artifact.kind === 'file' || artifact.kind === 'action') score += 10;
  if (String(artifact.name || '').toLowerCase().endsWith('.zip')) score += 5;
  const turnIndex = Number(artifact.sourceTurnIndex);
  if (Number.isFinite(turnIndex)) score += Math.max(0, Math.min(50, turnIndex));
  return score;
}

export function selectZipArtifact(artifacts = [], response = {}) {
  return artifacts
    .filter((artifact) => looksLikeZipArtifact(artifact) && artifactMatchesResponseScope(artifact, response))
    .map((artifact, index) => ({ artifact, index, score: artifactSelectionScore(artifact, response) }))
    .sort((a, b) => b.score - a.score || b.index - a.index)[0]?.artifact || null;
}
