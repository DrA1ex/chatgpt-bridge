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



test('ResultResolver accepts unscoped ZIP artifacts when they are already part of the current response', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-resolver-unscoped-current-'));
  const fileStore = new FileStore(root);
  const metadataStore = new MetadataMock();
  const zipPath = path.join(root, 'current.zip');
  await (await import('../src/zipWriter.js')).writeZip(zipPath, [{ name: 'project/current.txt', data: Buffer.from('current') }]);

  const bridge = {
    async fetchArtifact(id) {
      assert.equal(id, 'current-unscoped-artifact');
      return await fileStore.importArtifactPath({ artifactId: id, filePath: zipPath, name: 'current.zip', mime: 'application/zip' });
    },
  };
  const resolver = new ResultResolver({ bridge, fileStore, metadataStore, eventBus: null });

  const result = await resolver.resolve({
    id: 'job-unscoped-current',
    request: { output: { expected: 'zip', downloadUrl: '/turns/job-unscoped-current/result/download' } },
  }, {
    id: 'legacy-response-id',
    answer: 'Done.',
    artifacts: [{ id: 'current-unscoped-artifact', name: 'current.zip', mime: 'application/zip', kind: 'file' }],
  });

  assert.equal(result.type, 'zip');
  assert.equal(result.artifactId, 'current-unscoped-artifact');
  assert.equal(result.manifest.some((item) => /current\.txt$/.test(item.path)), true);
});

test('ResultResolver prefers ZIP artifact from the completed assistant turn', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-resolver-turn-aware-'));
  const fileStore = new FileStore(root);
  const metadataStore = new MetadataMock();
  const zipsDir = path.join(root, 'zips');
  await fs.mkdir(zipsDir, { recursive: true });
  const oldZip = path.join(zipsDir, 'old.zip');
  const newZip = path.join(zipsDir, 'new.zip');
  await (await import('../src/zipWriter.js')).writeZip(oldZip, [{ name: 'project/old.txt', data: Buffer.from('old') }]);
  await (await import('../src/zipWriter.js')).writeZip(newZip, [{ name: 'project/new.txt', data: Buffer.from('new') }]);

  const bridge = {
    async fetchArtifact(id, options = {}) {
      assert.equal(options.sourceClientId, 'client-current');
      const filePath = id === 'old-artifact' ? oldZip : newZip;
      return await fileStore.importArtifactPath({ artifactId: id, filePath, name: `${id}.zip`, mime: 'application/zip' });
    },
  };
  const resolver = new ResultResolver({ bridge, fileStore, metadataStore, eventBus: null });

  const result = await resolver.resolve({
    id: 'job-current-artifact',
    request: { output: { expected: 'zip', downloadUrl: '/turns/job-current-artifact/result/download' } },
  }, {
    requestId: 'job-current-artifact',
    turnKey: 'current-turn',
    answer: 'Done.',
    sourceClientId: 'client-current',
    artifacts: [
      { id: 'old-artifact', name: 'old.zip', mime: 'application/zip', sourceTurnKey: 'old-turn', sourceTurnIndex: 5, sourceClientId: 'client-old' },
      { id: 'new-artifact', name: 'new.zip', mime: 'application/zip', sourceTurnKey: 'current-turn', sourceTurnIndex: 6 },
    ],
  });

  assert.equal(result.artifactId, 'new-artifact');
  assert.equal(result.name, 'new-artifact.zip');
  assert.equal(result.sourceClientId, 'client-current');
  assert.equal(result.sourceRequestId, 'job-current-artifact');
  assert.equal(result.sourceTurnKey, 'current-turn');
  assert.ok(metadataStore.events.some((event) => event.type === 'artifact.downloaded' && event.data.sourceClientId === 'client-current'));
  const validationStarted = metadataStore.events.find((event) => event.type === 'result.validation.started');
  const validationPassed = metadataStore.events.find((event) => event.type === 'result.validated');
  assert.equal(validationStarted.data.name, 'new-artifact.zip');
  assert.equal(validationPassed.data.entries > 0, true);
  assert.equal(validationPassed.data.sourceClientId, 'client-current');
  assert.equal(metadataStore.downloads[0].metadata.sourceClientId, 'client-current');
  assert.equal(metadataStore.downloads[0].metadata.sourceTurnKey, 'current-turn');
  assert.equal(result.manifest.some((item) => /new\.txt$/.test(item.path)), true);
});

test('ResultResolver passes forceArtifactDownload to bridge.fetchArtifact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-resolver-force-'));
  const fileStore = new FileStore(root);
  const metadataStore = new MetadataMock();
  const zipPath = path.join(root, 'forced.zip');
  await (await import('../src/zipWriter.js')).writeZip(zipPath, [{ name: 'project/forced.txt', data: Buffer.from('forced') }]);
  let seenForce = null;
  const bridge = {
    async fetchArtifact(id, options = {}) {
      seenForce = options.force;
      return await fileStore.importArtifactPath({ artifactId: id, filePath: zipPath, name: 'forced.zip', mime: 'application/zip' });
    },
  };
  const resolver = new ResultResolver({ bridge, fileStore, metadataStore, eventBus: null });
  await resolver.resolve({
    id: 'job-force-artifact',
    request: { output: { expected: 'zip', forceArtifactDownload: true } },
  }, {
    answer: 'Done.',
    artifacts: [{ id: 'force-artifact', name: 'forced.zip', mime: 'application/zip' }],
  });
  assert.equal(seenForce, true);
});

test('ResultResolver retries the same assistant turn when ZIP artifact appears after final answer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-resolver-retry-'));
  const fileStore = new FileStore(root);
  const metadataStore = new MetadataMock();
  const zipPath = path.join(root, 'delayed.zip');
  await (await import('../src/zipWriter.js')).writeZip(zipPath, [{ name: 'project/delayed.txt', data: Buffer.from('delayed') }]);

  const calls = [];
  const bridge = {
    async recoverResponseByTurnKey(options = {}) {
      calls.push(options);
      assert.equal(options.turnKey, 'turn-current');
      assert.equal(options.sourceClientId, 'client-source');
      if (calls.length === 1) {
        return { requestId: options.requestId, turnKey: 'turn-current', answer: 'Final answer', artifacts: [] };
      }
      return {
        requestId: options.requestId,
        turnKey: 'turn-current',
        answer: 'Final answer',
        artifacts: [{ id: 'delayed-artifact', name: 'delayed.zip', mime: 'application/zip', sourceTurnKey: 'turn-current' }],
      };
    },
    async fetchArtifact(id, options = {}) {
      assert.equal(id, 'delayed-artifact');
      assert.equal(options.sourceClientId, 'client-source');
      return await fileStore.importArtifactPath({ artifactId: id, filePath: zipPath, name: 'delayed.zip', mime: 'application/zip' });
    },
  };
  const resolver = new ResultResolver({ bridge, fileStore, metadataStore, eventBus: null });

  const result = await resolver.resolve({
    id: 'job-delayed-artifact',
    request: { output: { expected: 'zip', artifactResolveRetries: 3, artifactResolveRetryDelayMs: 0 } },
  }, {
    requestId: 'job-delayed-artifact',
    turnKey: 'turn-current',
    sourceClientId: 'client-source',
    answer: 'Final answer',
    artifacts: [],
  });

  assert.equal(result.type, 'zip');
  assert.equal(result.artifactId, 'delayed-artifact');
  assert.equal(calls.length, 2);
  assert.ok(metadataStore.events.some((event) => event.type === 'result.artifact.retry'));
  assert.ok(metadataStore.events.some((event) => event.type === 'result.artifact.retry_found'));
});
