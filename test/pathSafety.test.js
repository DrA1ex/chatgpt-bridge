import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveSafeDescendant } from '../src/pathSafety.js';
import { collectAutomationDiagnostics } from '../src/workflow/automation/diagnostics.js';

test('safe descendants allow double-dot names while rejecting parent traversal and symlinks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-safe-path-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '..cache'));
  assert.equal(await resolveSafeDescendant(root, '..cache/output.txt'), path.join(root, '..cache/output.txt'));
  await assert.rejects(resolveSafeDescendant(root, '../outside.txt'), { code: 'UNSAFE_TARGET_PATH' });
  await fs.symlink(os.tmpdir(), path.join(root, 'linked'), 'junction');
  await assert.rejects(resolveSafeDescendant(root, 'linked/output.txt'), { code: 'UNSAFE_SYMLINK_PATH' });
});

test('diagnostics include double-dot names but never traverse a symlinked parent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-diagnostics-path-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  const reportDir = path.join(root, 'report');
  const outside = path.join(root, 'outside');
  await Promise.all([projectRoot, reportDir, outside].map((dir) => fs.mkdir(dir)));
  await fs.writeFile(path.join(projectRoot, '..results.txt'), 'safe');
  await fs.writeFile(path.join(outside, 'private.txt'), 'outside');
  await fs.symlink(outside, path.join(projectRoot, 'linked'), 'junction');
  const result = await collectAutomationDiagnostics({
    projectRoot, reportDir, include: ['..results.txt', 'linked/private.txt'], maxIncludedBytes: 1000,
  });
  assert.equal(result.files, 1);
  assert.equal(await fs.readFile(path.join(reportDir, 'collected', '..results.txt'), 'utf8'), 'safe');
  assert.deepEqual(result.skipped, [{ path: 'linked/private.txt', reason: 'symlink' }]);
});
