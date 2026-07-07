import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/fileStore.js';
import { ResultResolver } from '../src/resultResolver.js';
import { extractZipFile } from '../src/zipUtils.js';

class MetadataMock {
  constructor() { this.events = []; this.downloads = []; }
  async addJobEvent(jobId, event) { this.events.push({ jobId, ...event }); return event; }
  async createDownload(download) { this.downloads.push(download); return download; }
}

test('ResultResolver reconstructs ZIP output from fenced file:path blocks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-resolver-'));
  const fileStore = new FileStore(root);
  const metadataStore = new MetadataMock();
  const resolver = new ResultResolver({ bridge: {}, fileStore, metadataStore, eventBus: null });

  const result = await resolver.resolve({
    id: 'job-blocks',
    request: { output: { expected: 'zip', downloadUrl: '/turns/job-blocks/result/download' } },
  }, {
    answer: 'Files:\n```file:src/app.js\nconsole.log("ok");\n```\n```file:README.md\n# Readme\n```',
    artifacts: [],
  });

  assert.equal(result.type, 'zip');
  assert.equal(result.reconstructedFrom, 'file-blocks');
  assert.match(result.answer, /Files:/);
  assert.equal(result.manifest.some((item) => item.path === 'src/app.js'), true);
  const readable = await fileStore.getReadable(result.fileId);
  const out = path.join(root, 'extract');
  await extractZipFile(readable.absolutePath, out);
  assert.equal(await fs.readFile(path.join(out, 'src/app.js'), 'utf8'), 'console.log("ok");');
});

test('ResultResolver reports explicit error when a required ZIP artifact is absent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-resolver-missing-'));
  const fileStore = new FileStore(root);
  const metadataStore = new MetadataMock();
  const resolver = new ResultResolver({ bridge: {}, fileStore, metadataStore, eventBus: null });

  await assert.rejects(
    resolver.resolve({
      id: 'job-no-zip',
      request: { output: { expected: 'zip', downloadUrl: '/turns/job-no-zip/result/download' } },
    }, {
      answer: 'I changed the files, but forgot the artifact.',
      artifacts: [],
    }),
    (err) => {
      assert.equal(err.code, 'EXPECTED_ZIP_ARTIFACT_NOT_FOUND');
      assert.match(err.message, /Expected a \.zip artifact/);
      return true;
    }
  );
});
