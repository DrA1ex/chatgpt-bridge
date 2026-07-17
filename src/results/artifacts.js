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

function artifactDownloadSignal(artifact = {}) {
  return [
    artifact.name,
    artifact.fileName,
    artifact.title,
    artifact.mime,
    artifact.type,
    artifact.text,
    artifact.actionLabel,
    artifact.downloadUrl,
    artifact.url,
    artifact.src,
  ].filter(Boolean).join(' ').toLowerCase();
}


function artifactExplicitIdentitySignal(artifact = {}) {
  return [
    artifact.name,
    artifact.fileName,
    artifact.title,
    artifact.mime,
    artifact.type,
    artifact.text,
    artifact.actionLabel,
    artifact.downloadUrl,
    artifact.url,
    artifact.src,
  ].filter(Boolean).join(' ').toLowerCase();
}

function isMaterializableArtifact(artifact = {}, response = {}) {
  if (!artifact?.id || !artifactMatchesResponseScope(artifact, response)) return false;
  const kind = String(artifact.kind || '').toLowerCase();
  if (kind === 'image') return false;
  const phase = String(artifact.phase || 'READY').toUpperCase();
  if (phase === 'FAILED' || phase === 'GENERATING' || phase === 'UPLOADING') return false;
  return Boolean(
    artifact.downloadable
    || artifact.downloadActionPresent
    || artifact.downloadUrl
    || artifact.url
    || artifact.src
    || kind === 'action'
    || kind === 'file'
    || kind === 'canvas'
  );
}

const EXPLICIT_NON_ZIP_EXTENSION_RE = /\.(?:txt|csv|json|js|mjs|cjs|ts|tsx|jsx|md|pdf|png|jpe?g|webp|gif|svg|html?|css|xml|ya?ml|toml|ini|log|py|sh|bash|zsh|sql|tar|gz|tgz|7z|rar|docx|xlsx|pptx|odt|ods|odp|rtf|mp3|wav|flac|aac|mp4|m4v|mov|webm|avi|mkv|wasm|bin|dmg|pkg|exe)(?:\b|$)/i;

export function artifactHasExplicitNonZipIdentity(artifact = {}) {
  const signal = artifactExplicitIdentitySignal(artifact);
  return EXPLICIT_NON_ZIP_EXTENSION_RE.test(signal) && !/\.zip(?:\b|$)/i.test(signal);
}

function fallbackZipCandidateScore(artifact = {}, response = {}) {
  if (!isMaterializableArtifact(artifact, response)) return Number.NEGATIVE_INFINITY;
  const signal = artifactDownloadSignal(artifact);
  let score = 0;
  if (/\.zip(?:\b|$)|application\/zip|zip archive|архив zip|скачать[^\n]{0,80}архив|download[^\n]{0,80}archive/i.test(signal)) score += 1000;
  if (/archive|архив|bundle|пакет/i.test(signal)) score += 180;
  if (artifact.downloadActionPresent) score += 80;
  if (artifact.downloadable) score += 60;
  if (String(artifact.phase || 'READY').toUpperCase() === 'READY') score += 40;
  if (['file', 'action', 'canvas'].includes(String(artifact.kind || '').toLowerCase())) score += 30;

  const responseTurnKey = String(response.turnKey || response.sourceTurnKey || response.assistantTurnKey || '');
  const artifactTurnKey = String(artifact.sourceTurnKey || artifact.turnKey || artifact.assistantTurnKey || '');
  if (responseTurnKey && artifactTurnKey === responseTurnKey) score += 300;
  const responseCandidateIndex = positiveNumber(response.candidateIndex || response.sourceCandidateIndex);
  const artifactCandidateIndex = positiveNumber(artifact.sourceCandidateIndex || artifact.candidateIndex);
  if (responseCandidateIndex && artifactCandidateIndex === responseCandidateIndex) score += 150;

  // A clearly named non-ZIP file should not win a multi-candidate fallback.
  if (artifactHasExplicitNonZipIdentity(artifact)) score -= 500;
  return score;
}

/**
 * Recovery DOM can expose a real file button without a filename/href. In that
 * case metadata cannot prove it is a ZIP until the scoped action is clicked and
 * the downloaded bytes are validated. Return a candidate only when the choice
 * is safe: one scoped materializable artifact, or one uniquely ZIP-like action.
 */
export function selectMaterializableZipFallback(artifacts = [], response = {}) {
  const candidates = artifacts
    .filter((artifact) => isMaterializableArtifact(artifact, response))
    .map((artifact, index) => ({ artifact, index, score: fallbackZipCandidateScore(artifact, response) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score || b.index - a.index);

  if (candidates.length === 1) {
    if (artifactHasExplicitNonZipIdentity(candidates[0].artifact)) {
      return { artifact: null, reason: 'single_explicit_non_zip_artifact', candidates: candidates.map(({ artifact, score }) => ({ artifact, score })) };
    }
    return { artifact: candidates[0].artifact, reason: 'single_scoped_materializable_artifact', candidates: candidates.map(({ artifact, score }) => ({ artifact, score })) };
  }

  const zipHinted = candidates.filter((item) => item.score >= 900);
  if (zipHinted.length === 1) {
    return { artifact: zipHinted[0].artifact, reason: 'unique_zip_hint_in_scoped_artifacts', candidates: candidates.map(({ artifact, score }) => ({ artifact, score })) };
  }

  if (zipHinted.length > 1 && zipHinted[0].score > zipHinted[1].score) {
    return { artifact: zipHinted[0].artifact, reason: 'strongest_unique_zip_hint', candidates: candidates.map(({ artifact, score }) => ({ artifact, score })) };
  }

  return { artifact: null, reason: candidates.length ? 'ambiguous_materializable_artifacts' : 'no_materializable_artifacts', candidates: candidates.map(({ artifact, score }) => ({ artifact, score })) };
}


/**
 * Completion guards should use the same safe fallback policy as the result
 * resolver. A single scoped generic action can be downloaded and byte-checked
 * as ZIP immediately, but a clearly named non-ZIP file or ambiguous set must
 * keep waiting.
 */
export function selectRequiredZipCompletionCandidate(artifacts = [], response = {}) {
  const exact = selectZipArtifact(artifacts, response);
  if (exact) return { artifact: exact, reason: 'zip_metadata' };
  const fallback = selectMaterializableZipFallback(artifacts, response);
  if (!fallback.artifact || artifactHasExplicitNonZipIdentity(fallback.artifact)) {
    return { artifact: null, reason: fallback.reason || 'no_materializable_artifacts', candidates: fallback.candidates || [] };
  }
  return fallback;
}

export function summarizeArtifact(artifact = {}) {
  return {
    id: artifact.id || '',
    name: artifact.name || artifact.fileName || '',
    mime: artifact.mime || artifact.type || '',
    kind: artifact.kind || '',
    phase: artifact.phase || '',
    downloadable: Boolean(artifact.downloadable),
    downloadActionPresent: Boolean(artifact.downloadActionPresent),
    sourceTurnKey: artifact.sourceTurnKey || artifact.turnKey || '',
    actionLabel: String(artifact.actionLabel || '').slice(0, 160),
    blockText: String(artifact.blockText || '').slice(0, 240),
  };
}
