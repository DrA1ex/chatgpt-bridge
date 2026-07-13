import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  removeCapturedBrowserDownload,
  resolveBrowserDownloadedPath,
} from '../src/tampermonkeyBridge.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bridge-download-safety-'));
}

function identityFor(fileName, size, overrides = {}) {
  const now = Date.now();
  return {
    size,
    captureSource: 'chrome-downloads',
    downloadId: 42,
    browserActualName: fileName,
    browserCaptureStartedAt: now - 1_000,
    browserCapturedAt: now,
    ...overrides,
  };
}

test('captured browser download resolves by exact absolute path and is removed only with complete fresh identity', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'project.zip');
  const bytes = Buffer.from('fresh-archive');
  await fs.writeFile(filePath, bytes);

  const resolved = await resolveBrowserDownloadedPath(filePath, 'project.zip', identityFor('project.zip', bytes.length));
  assert.equal(resolved.path, filePath);
  assert.equal(resolved.resolution, 'exact');

  const cleanup = await removeCapturedBrowserDownload(resolved);
  assert.equal(cleanup.removed, true);
  await assert.rejects(fs.stat(filePath), { code: 'ENOENT' });
});

test('cleanup fails closed when browser download identity is incomplete', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'project.zip');
  const bytes = Buffer.from('archive');
  await fs.writeFile(filePath, bytes);

  const resolved = await resolveBrowserDownloadedPath(filePath, 'project.zip', identityFor('project.zip', bytes.length, {
    captureSource: '',
    downloadId: null,
  }));
  const cleanup = await removeCapturedBrowserDownload(resolved);
  assert.equal(cleanup.removed, false);
  assert.equal(cleanup.reason, 'untrusted_capture_source');
  assert.equal((await fs.readFile(filePath)).toString(), 'archive');
});

test('cleanup refuses to unlink a file whose inode or metadata changed after import', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'project.zip');
  const bytes = Buffer.from('archive-v1');
  await fs.writeFile(filePath, bytes);

  const resolved = await resolveBrowserDownloadedPath(filePath, 'project.zip', identityFor('project.zip', bytes.length));
  await fs.writeFile(filePath, Buffer.from('user-file-that-replaced-the-download'));

  const cleanup = await removeCapturedBrowserDownload(resolved);
  assert.equal(cleanup.removed, false);
  assert.equal(cleanup.reason, 'identity_changed_after_import');
  assert.match((await fs.readFile(filePath)).toString(), /user-file/);
});

test('resolver rejects a stale file even when its name and size match', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'project.zip');
  const bytes = Buffer.from('old-archive');
  await fs.writeFile(filePath, bytes);

  await assert.rejects(
    resolveBrowserDownloadedPath(filePath, 'project.zip', identityFor('project.zip', bytes.length, {
      browserCaptureStartedAt: Date.now() + 60_000,
      browserCapturedAt: Date.now() + 61_000,
    })),
    /creation timestamp .* outside capture window/,
  );
  assert.equal((await fs.readFile(filePath)).toString(), 'old-archive');
});

test('resolver rejects a mismatched captured filename and ambiguous conflict copies', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('archive');
  const exactPath = path.join(dir, 'different.zip');
  await fs.writeFile(exactPath, bytes);
  await assert.rejects(
    resolveBrowserDownloadedPath(exactPath, 'different.zip', identityFor('expected.zip', bytes.length)),
    /name mismatch/,
  );

  const missingPath = path.join(dir, 'project.zip');
  await fs.writeFile(path.join(dir, 'project (1).zip'), bytes);
  await fs.writeFile(path.join(dir, 'project (2).zip'), bytes);
  await assert.rejects(
    resolveBrowserDownloadedPath(missingPath, 'project.zip', identityFor('project.zip', bytes.length)),
    /2 fresh matching files/,
  );
});


test('resolver rejects symbolic links even when their target looks like a fresh captured download', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-download-symlink-'));
  const target = path.join(root, 'personal-file.zip');
  const link = path.join(root, 'captured.zip');
  await fs.writeFile(target, Buffer.from('not a test download'));
  try {
    await fs.symlink(target, link);
  } catch (err) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) return t.skip(`symlinks unavailable: ${err.code}`);
    throw err;
  }
  const now = Date.now();
  await assert.rejects(
    resolveBrowserDownloadedPath(link, 'captured.zip', {
      size: (await fs.stat(target)).size,
      browserCaptureStartedAt: now - 1_000,
      browserCapturedAt: now,
      browserActualName: 'captured.zip',
      captureSource: 'chrome-downloads',
      downloadId: 77,
    }),
    /not readable at the exact path|Could not safely resolve captured browser download/,
  );
  assert.equal(await fs.readFile(target, 'utf8'), 'not a test download');
});
