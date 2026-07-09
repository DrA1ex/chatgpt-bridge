import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeZip } from '../src/zipWriter.js';
import { applyZipToProject, checkProjectApplySafety, planZipApply } from '../src/projectApply.js';


function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

async function initGit(root) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await run('git', ['-C', root, 'init']);
  await run('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  await run('git', ['-C', root, 'config', 'user.name', 'Test']);
  await run('git', ['-C', root, 'add', '.']);
  await run('git', ['-C', root, 'commit', '-m', 'initial']);
}

test('checkProjectApplySafety warns outside git repositories', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-apply-no-git-'));
  await fs.writeFile(path.join(projectRoot, 'app.js'), 'old');
  const safety = await checkProjectApplySafety(projectRoot);
  assert.equal(safety.safe, false);
  assert.equal(safety.warnings.some((warning) => warning.code === 'NO_GIT_OR_GIT_STATUS_FAILED'), true);
});

test('applyZipToProject overwrites files after validation and strips common root folder', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-apply-project-'));
  await fs.mkdir(path.join(projectRoot, 'src'));
  await fs.writeFile(path.join(projectRoot, 'src', 'app.js'), 'old');
  await initGit(projectRoot);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-apply-zip-'));
  const zipPath = path.join(dir, 'updated.zip');
  await writeZip(zipPath, [
    { name: 'project/src/app.js', data: Buffer.from('new') },
    { name: 'project/.bridge/PROJECT_CONTEXT.md', data: Buffer.from('skip') },
  ]);

  const plan = await planZipApply({ zipPath, projectRoot });
  assert.equal(plan.safety.safe, true);
  assert.equal(plan.plan.filesToWrite, 1);
  assert.equal(plan.plan.filesSkipped, 1);
  assert.equal(plan.plan.stripPrefix, 'project/');

  const result = await applyZipToProject({ zipPath, projectRoot });
  assert.equal(result.written.length, 1);
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'app.js'), 'utf8'), 'new');
});


test('applyZipToProject treats project folder as root even when root bridge metadata is present', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-apply-project-root-fallback-'));
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'src', 'app.js'), 'old');
  await initGit(projectRoot);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-apply-project-root-fallback-zip-'));
  const zipPath = path.join(dir, 'updated.zip');
  await writeZip(zipPath, [
    { name: 'project/src/app.js', data: Buffer.from('new') },
    { name: 'project/src/new.js', data: Buffer.from('created') },
    { name: '.bridge/MANIFEST.json', data: Buffer.from('{}') },
  ]);

  const plan = await planZipApply({ zipPath, projectRoot });
  assert.equal(plan.plan.stripPrefix, 'project/');
  assert.equal(plan.plan.filesToWrite, 2);
  assert.equal(plan.plan.filesSkipped, 1);
  assert.equal(plan.plan.update[0].path, 'src/app.js');
  assert.equal(plan.plan.create[0].path, 'src/new.js');

  const result = await applyZipToProject({ zipPath, projectRoot });
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'app.js'), 'utf8'), 'new');
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'new.js'), 'utf8'), 'created');
  await assert.rejects(fs.stat(path.join(projectRoot, 'project', 'src', 'app.js')), /ENOENT/);
});

test('applyZipToProject sync deletes only files from the original snapshot and leaves ignored files alone', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-sync-project-'));
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'src', 'keep.js'), 'old keep');
  await fs.writeFile(path.join(projectRoot, 'src', 'remove.js'), 'remove me');
  await fs.writeFile(path.join(projectRoot, '.env'), 'secret');
  await initGit(projectRoot);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-sync-zip-'));
  const zipPath = path.join(dir, 'updated.zip');
  await writeZip(zipPath, [
    { name: 'project/src/keep.js', data: Buffer.from('new keep') },
    { name: 'project/src/new.js', data: Buffer.from('new file') },
  ]);

  const referenceManifest = { files: [{ path: 'src/keep.js' }, { path: 'src/remove.js' }] };
  const plan = await planZipApply({ zipPath, projectRoot, options: { sync: true, referenceManifest } });
  assert.equal(plan.plan.filesToDelete, 1);
  assert.equal(plan.plan.delete[0].path, 'src/remove.js');

  const result = await applyZipToProject({ zipPath, projectRoot, options: { sync: true, referenceManifest } });
  assert.equal(result.deleted.length, 1);
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'keep.js'), 'utf8'), 'new keep');
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'new.js'), 'utf8'), 'new file');
  await assert.rejects(fs.stat(path.join(projectRoot, 'src', 'remove.js')), /ENOENT/);
  assert.equal(await fs.readFile(path.join(projectRoot, '.env'), 'utf8'), 'secret');
});

test('applyZipToProject can skip selected conflicting files while still creating new files and deleting missing snapshot files', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-conflict-project-'));
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'src', 'keep-local.js'), 'local');
  await fs.writeFile(path.join(projectRoot, 'src', 'apply.js'), 'old');
  await fs.writeFile(path.join(projectRoot, 'src', 'delete.js'), 'delete me');
  await initGit(projectRoot);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-conflict-zip-'));
  const zipPath = path.join(dir, 'updated.zip');
  await writeZip(zipPath, [
    { name: 'project/src/keep-local.js', data: Buffer.from('remote') },
    { name: 'project/src/apply.js', data: Buffer.from('applied') },
    { name: 'project/src/new.js', data: Buffer.from('new') },
  ]);

  const referenceManifest = { files: [{ path: 'src/keep-local.js' }, { path: 'src/apply.js' }, { path: 'src/delete.js' }] };
  const plan = await planZipApply({ zipPath, projectRoot, options: { sync: true, referenceManifest } });
  assert.equal(plan.plan.filesToOverwrite, 2);
  assert.equal(plan.plan.filesToDelete, 1);

  const result = await applyZipToProject({
    zipPath,
    projectRoot,
    options: { sync: true, referenceManifest, selectedConflictPaths: ['src/apply.js'] },
  });

  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'keep-local.js'), 'utf8'), 'local');
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'apply.js'), 'utf8'), 'applied');
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'new.js'), 'utf8'), 'new');
  await assert.rejects(fs.stat(path.join(projectRoot, 'src', 'delete.js')), /ENOENT/);
  assert.equal(result.skipped.some((item) => item.targetPath === 'src/keep-local.js' && item.reason === 'conflict-skipped'), true);
});


test('planZipApply detects files changed locally after the original snapshot', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-local-change-project-'));
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'src', 'conflict.js'), 'snapshot');
  await fs.writeFile(path.join(projectRoot, 'src', 'delete.js'), 'snapshot-delete');
  await initGit(projectRoot);

  const referenceManifest = { files: [
    { path: 'src/conflict.js', sha256: sha256Text('snapshot') },
    { path: 'src/delete.js', sha256: sha256Text('snapshot-delete') },
  ] };

  await fs.writeFile(path.join(projectRoot, 'src', 'conflict.js'), 'local edit');
  await fs.writeFile(path.join(projectRoot, 'src', 'delete.js'), 'local delete edit');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-local-change-zip-'));
  const zipPath = path.join(dir, 'updated.zip');
  await writeZip(zipPath, [
    { name: 'project/src/conflict.js', data: Buffer.from('remote edit') },
    { name: 'project/src/new.js', data: Buffer.from('new') },
  ]);

  const plan = await planZipApply({ zipPath, projectRoot, options: { sync: true, referenceManifest } });
  assert.equal(plan.hasLocalChangesAfterSnapshot, true);
  assert.equal(plan.requiresConfirmation, true);
  assert.equal(plan.plan.filesLocallyChanged, 1);
  assert.equal(plan.plan.localChanged[0].path, 'src/conflict.js');
  assert.equal(plan.plan.filesLocallyChangedDelete, 1);
  assert.equal(plan.plan.localChangedDelete[0].path, 'src/delete.js');
  assert.equal(plan.safety.warnings.some((warning) => warning.code === 'LOCAL_CHANGES_AFTER_SNAPSHOT'), true);
});

test('applyZipToProject default sync applies ordinary updates without per-file selection', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-default-apply-project-'));
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'src', 'app.js'), 'snapshot');
  await fs.writeFile(path.join(projectRoot, 'src', 'remove.js'), 'snapshot-remove');
  await initGit(projectRoot);

  const referenceManifest = { files: [
    { path: 'src/app.js', sha256: sha256Text('snapshot') },
    { path: 'src/remove.js', sha256: sha256Text('snapshot-remove') },
  ] };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-default-apply-zip-'));
  const zipPath = path.join(dir, 'updated.zip');
  await writeZip(zipPath, [
    { name: 'project/src/app.js', data: Buffer.from('remote') },
    { name: 'project/src/new.js', data: Buffer.from('new') },
  ]);

  const plan = await planZipApply({ zipPath, projectRoot, options: { sync: true, referenceManifest } });
  assert.equal(plan.plan.filesToUpdate, 1);
  assert.equal(plan.plan.filesToDelete, 1);
  assert.equal(plan.plan.filesLocallyChanged, 0);

  const result = await applyZipToProject({ zipPath, projectRoot, options: { sync: true, referenceManifest } });
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'app.js'), 'utf8'), 'remote');
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'new.js'), 'utf8'), 'new');
  await assert.rejects(fs.stat(path.join(projectRoot, 'src', 'remove.js')), /ENOENT/);
  assert.equal(result.written.some((item) => item.path === 'src/app.js'), true);
});

test('applyZipToProject interactive selection only applies selected updates and deletes', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-interactive-apply-project-'));
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'src', 'apply.js'), 'snapshot-apply');
  await fs.writeFile(path.join(projectRoot, 'src', 'skip.js'), 'snapshot-skip');
  await fs.writeFile(path.join(projectRoot, 'src', 'delete.js'), 'snapshot-delete');
  await fs.writeFile(path.join(projectRoot, 'src', 'keep-delete.js'), 'snapshot-keep-delete');
  await initGit(projectRoot);

  const referenceManifest = { files: [
    { path: 'src/apply.js', sha256: sha256Text('snapshot-apply') },
    { path: 'src/skip.js', sha256: sha256Text('snapshot-skip') },
    { path: 'src/delete.js', sha256: sha256Text('snapshot-delete') },
    { path: 'src/keep-delete.js', sha256: sha256Text('snapshot-keep-delete') },
  ] };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-interactive-apply-zip-'));
  const zipPath = path.join(dir, 'updated.zip');
  await writeZip(zipPath, [
    { name: 'project/src/apply.js', data: Buffer.from('remote-apply') },
    { name: 'project/src/skip.js', data: Buffer.from('remote-skip') },
    { name: 'project/src/new.js', data: Buffer.from('new') },
  ]);

  const result = await applyZipToProject({
    zipPath,
    projectRoot,
    options: { sync: true, referenceManifest, selectedWritePaths: ['src/apply.js'], selectedDeletePaths: ['src/delete.js'] },
  });
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'apply.js'), 'utf8'), 'remote-apply');
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'skip.js'), 'utf8'), 'snapshot-skip');
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'new.js'), 'utf8'), 'new');
  await assert.rejects(fs.stat(path.join(projectRoot, 'src', 'delete.js')), /ENOENT/);
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'keep-delete.js'), 'utf8'), 'snapshot-keep-delete');
  assert.equal(result.skipped.some((item) => item.targetPath === 'src/skip.js'), true);
  assert.equal(result.skipped.some((item) => item.path === 'src/keep-delete.js' && item.reason === 'delete-skipped'), true);
});
