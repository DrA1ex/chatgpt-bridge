export function artifactIdentityText(artifact = {}) {
  return [
    artifact.name,
    artifact.fileName,
    artifact.extension,
    artifact.mime,
    artifact.text,
    artifact.actionLabel,
    artifact.blockText,
    artifact.title,
    artifact.downloadUrl,
    artifact.url,
  ].filter(Boolean).join(' ').toLowerCase();
}

export function isZipArtifactCandidate(artifact = {}) {
  const identity = artifactIdentityText(artifact);
  return /\.zip(?:\b|$)|application\/(?:x-)?zip|\bzip\b|zip archive|архив zip/i.test(identity);
}
