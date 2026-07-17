const RETRYABLE_CODES = new Set([
  'ARTIFACT_MATERIALIZATION_FAILED',
  'ARTIFACT_PREVIEW_NOT_READY',
  'ARTIFACT_ACTION_NOT_READY',
  'CHAT_PAGE_NOT_READY',
]);

const RETRYABLE_PATTERNS = [
  /artifact materialization failed/i,
  /artifact preview was not ready/i,
  /exact artifact action did not become ready/i,
  /exact filename-bound artifact action is not currently usable/i,
  /timed out waiting for page generation/i,
];

export function isRetryableArtifactMaterializationError(error) {
  const code = String(error?.code || '').trim();
  if (RETRYABLE_CODES.has(code)) return true;
  const message = String(error?.message || error || '');
  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(message));
}

export function isDeferredMaterializationTerminal(pipeline = {}) {
  return String(pipeline?.terminal?.code || '') === 'artifact_materialization_deferred';
}
