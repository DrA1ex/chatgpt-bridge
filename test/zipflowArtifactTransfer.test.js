import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileStore } from '../src/fileStore.js';
import { ZipflowArtifactTransfer } from '../src/workflow/server/artifactTransfer.js';

async function bytesFrom(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('artifact transfer uploads one verified descriptor and persists correlation before run creation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-zipflow-transfer-'));
  try {
    const fileStore = new FileStore(root);
    const file = await fileStore.putArtifact({
      artifactId: 'artifact_result',
      name: 'result.zip',
      content: 'archive bytes',
    });
    const order = [];
    let uploadRequest = null;
    const client = {
      async uploadBlob(request) {
        uploadRequest = request;
        const content = await bytesFrom(request.body);
        assert.equal(content.toString(), 'archive bytes');
        order.push('upload');
        return {
          blobId: `sha256:${file.sha256}`,
          sha256: file.sha256,
          size: content.length,
          filename: request.filename,
        };
      },
      async startArchiveRun(projectId, body, options) {
        order.push('run');
        assert.equal(projectId, 'project-1');
        assert.equal(body.blobId, `sha256:${file.sha256}`);
        assert.deepEqual(body.correlation, {
          producer: 'chatgpt-bridge',
          requestId: 'request-1',
        });
        assert.equal(options.idempotencyKey, 'run-key');
        return { runId: 'run-1', operationId: 'operation-1', status: 'running' };
      },
    };
    let persisted = null;
    const transfer = new ZipflowArtifactTransfer({
      fileStore,
      client,
      persistCorrelation: async (value) => {
        order.push('persist');
        persisted = value;
      },
    });

    const result = await transfer.uploadAndStartArchiveRun({
      fileId: file.id,
      projectId: 'project-1',
      correlation: {
        producer: 'chatgpt-bridge',
        requestId: 'request-1',
        projectId: 'bridge-project-1',
      },
      uploadIdempotencyKey: 'upload-key',
      runIdempotencyKey: 'run-key',
    });

    assert.deepEqual(order, ['upload', 'persist', 'run']);
    assert.equal(persisted.blobId, `sha256:${file.sha256}`);
    assert.equal(persisted.correlation.projectId, 'bridge-project-1');
    assert.equal(result.run.runId, 'run-1');
    assert.equal(uploadRequest.idempotencyKey, 'upload-key');
    assert.equal(Object.hasOwn(uploadRequest, 'path'), false);
    assert.equal(Object.hasOwn(uploadRequest, 'absolutePath'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact transfer refuses mismatched blob receipts and never persists or starts a run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-zipflow-mismatch-'));
  try {
    const fileStore = new FileStore(root);
    const file = await fileStore.putArtifact({ artifactId: 'artifact_bad', name: 'result.zip', content: 'archive' });
    let mutations = 0;
    const transfer = new ZipflowArtifactTransfer({
      fileStore,
      client: {
        async uploadBlob(request) {
          await bytesFrom(request.body);
          return { blobId: 'sha256:bad', sha256: '0'.repeat(64), size: file.size };
        },
        async startArchiveRun() {
          mutations += 1;
        },
      },
      persistCorrelation: async () => {
        mutations += 1;
      },
    });

    await assert.rejects(
      transfer.uploadAndStartArchiveRun({
        fileId: file.id,
        projectId: 'project-1',
        uploadIdempotencyKey: 'upload-key',
        runIdempotencyKey: 'run-key',
      }),
      (error) => error.code === 'BLOB_VERIFICATION_FAILED',
    );
    assert.equal(mutations, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact transfer requires explicit idempotency keys', async () => {
  const transfer = new ZipflowArtifactTransfer({
    fileStore: { openVerifiedReadable() {} },
    client: { uploadBlob() {}, startArchiveRun() {} },
    persistCorrelation() {},
  });
  await assert.rejects(
    transfer.upload({ fileId: 'file-1' }),
    (error) => error.code === 'IDEMPOTENCY_REQUIRED',
  );
});
