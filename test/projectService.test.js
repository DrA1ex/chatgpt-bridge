import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/fileStore.js';
import { ProjectService } from '../src/projectService.js';
import { validateZipFile } from '../src/zipUtils.js';

test('ProjectService scans gitignored project and packs a safe zip', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-project-'));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-data-'));
  await fs.writeFile(path.join(projectRoot, '.gitignore'), 'node_modules\n.env\n');
  await fs.writeFile(path.join(projectRoot, 'AGENT.md'), 'Use concise changelogs.');
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"scripts":{"test":"node --test"}}');
  await fs.mkdir(path.join(projectRoot, 'src'));
  await fs.writeFile(path.join(projectRoot, 'src', 'index.js'), 'export function add(a, b) { return a + b; }\n');
  await fs.mkdir(path.join(projectRoot, 'node_modules'));
  await fs.writeFile(path.join(projectRoot, 'node_modules', 'ignored.js'), 'ignored');
  await fs.writeFile(path.join(projectRoot, '.env'), 'SECRET=1');

  const fileStore = new FileStore(dataRoot);
  const service = new ProjectService({ fileStore, rootDir: dataRoot });
  const scan = await service.scan(projectRoot);
  assert.equal(scan.files.some((file) => file.path === 'src/index.js'), true);
  assert.equal(scan.files.some((file) => file.path === 'node_modules/ignored.js'), false);
  assert.equal(scan.files.some((file) => file.path === '.env'), false);
  assert.equal(scan.agent.path, 'AGENT.md');
  assert.match(scan.context, /function add/);

  const pack = await service.pack(projectRoot, { threadId: 'thread_test' });
  assert.equal(pack.shouldAttach, true);
  const readable = await fileStore.getReadable(pack.file.id);
  const zip = await validateZipFile(readable.absolutePath);
  assert.equal(zip.ok, true);
  assert.equal(zip.files.some((file) => file.path === 'project/src/index.js'), true);
  assert.equal(zip.files.some((file) => file.path === '.bridge/PROJECT_CONTEXT.md'), true);
});

test('ProjectService does not reattach an unchanged snapshot already uploaded for a thread', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-project-reuse-'));
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-data-reuse-'));
  await fs.writeFile(path.join(projectRoot, 'index.js'), 'console.log("same");\n');

  const fileStore = new FileStore(dataRoot);
  const service = new ProjectService({ fileStore, rootDir: dataRoot });
  const first = await service.pack(projectRoot, { threadId: 'thread_same' });
  assert.equal(first.shouldAttach, true);
  assert.ok(first.sha256);

  await service.markSnapshotUploaded({
    cwd: projectRoot,
    threadId: 'thread_same',
    snapshotId: first.snapshotId,
    fileId: first.file.id,
    sha256: first.sha256,
    source: 'test',
  });

  const second = await service.pack(projectRoot, { threadId: 'thread_same', snapshotPolicy: 'reuse-if-unchanged' });
  assert.equal(second.snapshotId, first.snapshotId);
  assert.equal(second.shouldAttach, false);
  assert.equal(second.alreadyUploaded, true);
  assert.deepEqual(second.attachmentIds, []);
});
