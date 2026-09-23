function transferError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function normalizedHash(value) {
  return String(value || '').trim().toLowerCase();
}

function requireIdempotencyKey(value, operation) {
  const key = String(value || '').trim();
  if (!key) throw transferError('IDEMPOTENCY_REQUIRED', `${operation} requires an idempotency key.`);
  return key;
}

function protocolCorrelation(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(
    ['producer', 'workflowId', 'requestId']
      .filter((key) => String(source[key] || '').trim())
      .map((key) => [key, String(source[key])]),
  );
}

export class ZipflowArtifactTransfer {
  constructor({ fileStore, client, persistCorrelation }) {
    if (!fileStore?.openVerifiedReadable) throw new Error('ZipflowArtifactTransfer requires a verified FileStore reader.');
    if (!client?.uploadBlob) throw new Error('ZipflowArtifactTransfer requires a Zipflow client.');
    if (typeof persistCorrelation !== 'function') throw new Error('ZipflowArtifactTransfer requires durable correlation persistence.');
    this.fileStore = fileStore;
    this.client = client;
    this.persistCorrelation = persistCorrelation;
  }

  async upload({ fileId, expected = {}, filename = '', idempotencyKey }) {
    const key = requireIdempotencyKey(idempotencyKey, 'Blob upload');
    const opened = await this.fileStore.openVerifiedReadable(fileId, expected);
    if (!opened) throw transferError('FILE_NOT_FOUND', `Selected workflow artifact was not found: ${fileId}`);
    try {
      const response = await this.client.uploadBlob({
        body: opened.createReadStream(),
        size: opened.size,
        filename: filename || opened.name || 'result.zip',
        idempotencyKey: key,
      });
      const blob = response?.blob || response;
      const actualHash = normalizedHash(blob?.sha256);
      const expectedHash = normalizedHash(opened.sha256);
      if (!blob?.blobId || !actualHash || actualHash !== expectedHash || Number(blob.size) !== opened.size) {
        throw transferError('BLOB_VERIFICATION_FAILED', 'Zipflow returned blob metadata that does not match the selected artifact.', {
          expected: { sha256: expectedHash, size: opened.size },
          actual: { blobId: blob?.blobId || '', sha256: actualHash, size: Number(blob?.size) },
        });
      }
      return {
        blobId: String(blob.blobId),
        sha256: expectedHash,
        size: opened.size,
        filename: String(blob.filename || filename || opened.name || 'result.zip'),
        fileId: String(fileId),
      };
    } finally {
      await opened.close();
    }
  }

  async uploadAndStartArchiveRun({
    fileId,
    expected = {},
    filename = '',
    projectId,
    seriesId = null,
    correlation = {},
    uploadIdempotencyKey,
    runIdempotencyKey,
  }) {
    if (!this.client?.startArchiveRun) throw new Error('Zipflow client cannot start archive runs.');
    const runKey = requireIdempotencyKey(runIdempotencyKey, 'Archive run');
    const uploaded = await this.upload({
      fileId,
      expected,
      filename,
      idempotencyKey: uploadIdempotencyKey,
    });
    await this.persistCorrelation({
      projectId: String(projectId || ''),
      seriesId: seriesId == null ? null : String(seriesId),
      ...uploaded,
      correlation: { ...correlation },
    });
    const run = await this.client.startArchiveRun(projectId, {
      kind: 'archive',
      blobId: uploaded.blobId,
      seriesId,
      correlation: protocolCorrelation(correlation),
    }, { idempotencyKey: runKey });
    return { uploaded, run: run?.run || run };
  }
}
