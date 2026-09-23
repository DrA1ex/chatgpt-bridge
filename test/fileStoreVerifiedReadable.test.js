import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileStore } from '../src/fileStore.js';

async function streamBytes(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('openVerifiedReadable binds upload bytes to one verified regular-file descriptor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-verified-file-'));
  try {
    const store = new FileStore(root);
    const content = Buffer.from('verified archive bytes');
    const stored = await store.putArtifact({
      artifactId: 'artifact_verified',
      name: 'result.zip',
      contentBase64: content.toString('base64'),
    });
    const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
    assert.equal(stored.sha256, expectedHash);

    const opened = await store.openVerifiedReadable(stored.id, {
      size: content.length,
      sha256: expectedHash,
    });
    try {
      assert.equal(opened.sha256, expectedHash);
      assert.equal(opened.size, content.length);
      assert.deepEqual(await streamBytes(opened.createReadStream()), content);
    } finally {
      await opened.close();
      await opened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('openVerifiedReadable rejects a stored file replaced after import', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-replaced-file-'));
  try {
    const store = new FileStore(root);
    const stored = await store.putArtifact({
      artifactId: 'artifact_replaced',
      name: 'result.zip',
      content: 'original',
    });
    const readable = await store.getReadable(stored.id);
    await writeFile(readable.absolutePath, 'tampered');

    await assert.rejects(
      store.openVerifiedReadable(stored.id),
      (error) => error.code === 'FILE_IDENTITY_CHANGED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('openVerifiedReadable rejects a symlink substituted for a stored artifact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-linked-file-'));
  try {
    const store = new FileStore(root);
    const stored = await store.putArtifact({
      artifactId: 'artifact_linked',
      name: 'result.zip',
      content: 'original',
    });
    const readable = await store.getReadable(stored.id);
    const original = `${readable.absolutePath}.original`;
    const target = path.join(root, 'attacker.zip');
    await rename(readable.absolutePath, original);
    await writeFile(target, 'attacker');
    await symlink(target, readable.absolutePath);

    await assert.rejects(
      store.openVerifiedReadable(stored.id),
      (error) => error.code === 'UNSAFE_FILE_PATH',
    );
    assert.equal(await readFile(original, 'utf8'), 'original');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('openVerifiedReadable rejects caller correlation with the wrong hash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-wrong-hash-'));
  try {
    const store = new FileStore(root);
    const stored = await store.putUpload({ name: 'result.zip', content: 'archive' });
    await assert.rejects(
      store.openVerifiedReadable(stored.id, { sha256: '0'.repeat(64) }),
      (error) => error.code === 'FILE_HASH_MISMATCH',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
