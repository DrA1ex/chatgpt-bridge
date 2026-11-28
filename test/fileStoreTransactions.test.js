import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileStore } from '../src/fileStore.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-file-transactions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new FileStore(root);
  await store.ready;
  return { root, store };
}

function failIndexSave(t, store) {
  const rename = fs.rename;
  return t.mock.method(fs, 'rename', async (source, target) => {
    if (target === store.indexPath) throw Object.assign(new Error('index disk failure'), { code: 'EIO' });
    return rename(source, target);
  });
}

test('failed upload commit is invisible in memory and after reopening', async (t) => {
  const { root, store } = await fixture(t);
  const failure = failIndexSave(t, store);
  await assert.rejects(store.putUpload({ name: 'new.txt', content: 'uncommitted' }), /disk failure/);
  failure.mock.restore();
  assert.deepEqual(await store.listFiles(), []);
  assert.deepEqual(await new FileStore(root).listFiles(), []);
  assert.deepEqual(await fs.readdir(store.filesDir), []);
  await store.putUpload({ name: 'later.txt', content: 'committed' });
  assert.equal((await new FileStore(root).listFiles()).length, 1);
});

for (const method of ['putArtifact', 'importArtifactPath']) {
  test(`failed ${method} replacement preserves the previous bytes and identity`, async (t) => {
    const { root, store } = await fixture(t);
    const original = await store.putArtifact({ artifactId: 'same', name: 'data.txt', content: 'old bytes' });
    const source = path.join(root, 'source.txt');
    await fs.writeFile(source, 'replacement');
    const failure = failIndexSave(t, store);
    await assert.rejects(store[method]({ artifactId: 'same', name: 'data.txt', content: 'replacement', filePath: source,
      removeSource: true }), /disk failure/);
    failure.mock.restore();
    assert.deepEqual(await store.get('same'), original);
    assert.equal(Buffer.from((await store.readForTransport('same')).contentBase64, 'base64').toString(), 'old bytes');
    const reopened = new FileStore(root);
    const opened = await reopened.openVerifiedReadable('same');
    await opened.close();
    assert.equal(await fs.readFile(source, 'utf8'), 'replacement');
    assert.equal((await fs.readdir(store.artifactsDir)).length, 1);
  });
}

for (const method of ['remove', 'pruneArtifacts']) {
  test(`failed ${method} persistence leaves the existing artifact readable`, async (t) => {
    const { root, store } = await fixture(t);
    await store.putArtifact({ artifactId: 'kept', name: 'data.txt', content: 'valuable' });
    const failure = failIndexSave(t, store);
    await assert.rejects(method === 'remove' ? store.remove('kept') : store.pruneArtifacts({ maxCount: 0 }), /disk failure/);
    failure.mock.restore();
    for (const current of [store, new FileStore(root)]) {
      const opened = await current.openVerifiedReadable('kept');
      assert.ok(opened);
      await opened.close();
    }
  });
}

test('simultaneous replacements of one artifact commit complete bytes in call order', async (t) => {
  const { root, store } = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.putArtifact({
    artifactId: 'same', name: 'data.txt', content: `${i}:${'x'.repeat(100_000 - i * 1000)}`,
  })));
  const reopened = new FileStore(root);
  const opened = await reopened.openVerifiedReadable('same');
  await opened.close();
  assert.ok(Buffer.from((await reopened.readForTransport('same')).contentBase64, 'base64').toString().startsWith('11:'));
  assert.equal((await fs.readdir(store.artifactsDir)).length, 1);
});

test('uncommitted artifacts are not observable while index replacement is pending', async (t) => {
  const { store } = await fixture(t);
  let release;
  let announce;
  const started = new Promise((resolve) => { announce = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (target === store.indexPath) { announce(); await gate; }
    return rename(source, target);
  });
  const pending = store.putArtifact({ artifactId: 'new', content: 'bytes' });
  await started;
  assert.equal(await store.get('new'), null);
  assert.deepEqual(await store.listArtifacts(), []);
  release();
  await pending;
  assert.equal((await store.get('new')).id, 'new');
});

test('public source and metadata objects cannot mutate the committed index', async (t) => {
  const { root, store } = await fixture(t);
  const metadata = { nested: { phase: 'READY' } };
  const record = await store.putArtifact({ artifactId: 'safe', content: 'bytes', metadata, source: { type: 'test' } });
  metadata.nested.phase = 'FAILED';
  record.metadata.nested.phase = 'MATERIALIZING';
  record.source.type = 'changed';
  const fresh = await store.get('safe');
  assert.equal(fresh.metadata.nested.phase, 'READY');
  assert.equal(fresh.source.type, 'test');
  assert.deepEqual(await new FileStore(root).get('safe'), fresh);
});

test('an opened verified descriptor preserves old bytes across artifact replacement', async (t) => {
  const { store } = await fixture(t);
  await store.putArtifact({ artifactId: 'same', name: 'data.txt', content: 'old bytes' });
  const opened = await store.openVerifiedReadable('same');
  try {
    await store.putArtifact({ artifactId: 'same', name: 'data.txt', content: 'new bytes' });
    const chunks = [];
    for await (const chunk of opened.createReadStream()) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'old bytes');
    assert.equal(Buffer.from((await store.readForTransport('same')).contentBase64, 'base64').toString(), 'new bytes');
  } finally {
    await opened.close();
  }
});
