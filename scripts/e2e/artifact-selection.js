export function artifactIdentityText(artifact = {}) {
  return [
    artifact.name,
    artifact.fileName,
    artifact.extension,
    artifact.mime,
    artifact.text,
    artifact.actionLabel,
    artifact.title,
    artifact.downloadUrl,
    artifact.url,
  ].filter(Boolean).join(' ').toLowerCase();
}

export function isZipArtifactCandidate(artifact = {}) {
  const identity = artifactIdentityText(artifact);
  return /\.zip(?:\b|$)|application\/(?:x-)?zip|\bzip\b|zip archive|архив zip/i.test(identity);
}

export function artifactsFromTurnSnapshot(snapshot = {}) {
  const artifacts = (snapshot.items || [])
    .filter((item) => item?.type === 'artifact' && item.status !== 'superseded')
    .map((item) => item.content?.artifact)
    .filter(Boolean);
  const output = snapshot?.turn?.output || {};
  const selectedArtifactId = String(output.artifactId || output.result?.artifactId || '');
  if (!selectedArtifactId) return artifacts;
  const selected = artifacts.find((artifact) => String(artifact.id || '') === selectedArtifactId);
  return selected ? [selected] : [{
    id: selectedArtifactId,
    name: output.name || output.result?.name || selectedArtifactId,
    fileName: output.name || output.result?.name || selectedArtifactId,
    mime: output.mime || output.result?.mime || '',
  }];
}
