import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeJsonFile } from '../src/storage/jsonFile.js';
import { FileStore } from '../src/fileStore.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-json-file-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('JSON writes preserve call order and snapshot values before asynchronous work', async (t) => {
  const root = await fixture(t);
  const target = path.join(root, 'state.json');
  const value = { sequence: 0, content: 'x'.repeat(100_000) };
  const writes = [];
  for (let sequence = 0; sequence < 30; sequence += 1) {
    value.sequence = sequence;
    value.content = 'x'.repeat(100_000 - sequence * 3_000);
    writes.push(writeJsonFile(target, value));
  }
  value.sequence = -1;
  await Promise.all(writes);
  assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).sequence, 29);
  assert.deepEqual(await fs.readdir(root), ['state.json']);
});

test('failed JSON replacement preserves the prior state and permits the next save', async (t) => {
  const root = await fixture(t);
  const target = path.join(root, 'state.json');
  await writeJsonFile(target, { sequence: 1 });
  const rename = fs.rename;
  const mock = t.mock.method(fs, 'rename', async (source, destination) => {
    if (destination === target) throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' });
    return rename(source, destination);
  });
  await assert.rejects(writeJsonFile(target, { sequence: 2 }), /disk failure/);
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { sequence: 1 });
  assert.deepEqual(await fs.readdir(root), ['state.json']);
  mock.mock.restore();
  await writeJsonFile(target, { sequence: 3 });
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { sequence: 3 });
});

test('concurrent file imports survive reopening the file index', async (t) => {
  const root = await fixture(t);
  const store = new FileStore(root);
  const uploads = await Promise.all(Array.from({ length: 40 }, (_, index) => store.putUpload({
    name: `upload-${index}.txt`, content: 'x'.repeat(index * 100),
  })));
  const reopened = new FileStore(root);
  assert.deepEqual((await reopened.listFiles()).map((item) => item.id).sort(), uploads.map((item) => item.id).sort());
});

test('a malformed existing file index is reported without overwriting it', async (t) => {
  const root = await fixture(t);
  const target = path.join(root, 'index.json');
  await fs.writeFile(target, '{truncated');
  const store = new FileStore(root);
  await assert.rejects(store.ready, SyntaxError);
  assert.equal(await fs.readFile(target, 'utf8'), '{truncated');
});

test('artifact IDs with colliding sanitized names retain independent bytes', async (t) => {
  const root = await fixture(t);
  const store = new FileStore(root);
  await store.putArtifact({ artifactId: 'a/b', name: 'file.txt', content: 'first' });
  await store.putArtifact({ artifactId: 'a_b', name: 'file.txt', content: 'second' });
  assert.equal(Buffer.from((await store.readForTransport('a/b')).contentBase64, 'base64').toString(), 'first');
  assert.equal(Buffer.from((await store.readForTransport('a_b')).contentBase64, 'base64').toString(), 'second');
});

test('artifact IDs never resolve inherited properties and prototype-like IDs persist', async (t) => {
  const root = await fixture(t);
  const store = new FileStore(root);
  assert.equal(await store.get('constructor'), null);
  await store.putArtifact({ artifactId: '__proto__', name: 'file.txt', content: 'safe' });
  const reopened = new FileStore(root);
  assert.equal((await reopened.get('__proto__')).id, '__proto__');
  assert.equal((await reopened.listArtifacts()).length, 1);
});

for (const method of ['importLocalPath', 'importArtifactPath']) {
  test(`${method} records the copied bytes when the source changes after its initial stat`, async (t) => {
    const root = await fixture(t);
    const source = path.join(root, 'source.txt');
    await fs.writeFile(source, 'old');
    const copyFile = fs.copyFile;
    t.mock.method(fs, 'copyFile', async (...args) => {
      if (args[0] === source) await fs.writeFile(source, 'new, longer contents');
      return copyFile(...args);
    });
    const store = new FileStore(root);
    const record = await store[method]({ filePath: source, name: 'source.txt' });
    assert.equal(record.size, Buffer.byteLength('new, longer contents'));
    const opened = await store.openVerifiedReadable(record.id);
    await opened.close();
  });
}
