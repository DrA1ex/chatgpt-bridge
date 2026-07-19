import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { reconcileLocalEffect } from '../src/workflow/state/localEffects.js';
import { restoreGitWorkflowState, squashGitCommits } from '../src/workflow/gitCommit.js';
import { WorkflowEffectStatus, WorkflowLocalEffectKind } from '../src/workflow/state/workflowState.js';

const execFileAsync = promisify(execFile);

async function tempRoot() { return await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-local-reconcile-')); }

function effect(kind, references = {}, status = WorkflowEffectStatus.DISPATCHED) {
  return { id: `effect-${kind}`, kind, status, attempt: 1, references };
}

test('apply reconciliation proves success only from a durable completion receipt', async () => {
  const root = await tempRoot();
  try {
    const manifestPath = path.join(root, 'rollback', 'manifest.json');
    const receiptPath = path.join(root, 'rollback', 'apply-completed.json');
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, '[]');
    const uncertain = await reconcileLocalEffect({
      effect: effect(WorkflowLocalEffectKind.APPLY, { manifestPath, receiptPath }),
      runtime: { config: { projectRoot: root } },
    });
    assert.equal(uncertain.outcome, 'uncertain');
    await fs.writeFile(receiptPath, JSON.stringify({ pipelineId: 'p1', written: ['a.js'] }));
    const succeeded = await reconcileLocalEffect({
      effect: effect(WorkflowLocalEffectKind.APPLY, { manifestPath, receiptPath }),
      runtime: { config: { projectRoot: root } },
    });
    assert.equal(succeeded.outcome, 'succeeded');
    assert.equal(succeeded.result.pipelineId, 'p1');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('rollback reconciliation verifies restored project bytes without guessing', async () => {
  const root = await tempRoot();
  try {
    const backup = path.join(root, 'rollback', 'file.txt');
    const target = path.join(root, 'project', 'file.txt');
    const manifestPath = path.join(root, 'rollback', 'manifest.json');
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(backup, 'before');
    await fs.writeFile(target, 'before');
    await fs.writeFile(manifestPath, JSON.stringify([{ path: 'file.txt', exists: true, type: 'file', backupPath: backup }]));
    const result = await reconcileLocalEffect({
      effect: effect(WorkflowLocalEffectKind.ROLLBACK, { manifestPath, receiptPath: path.join(root, 'rollback', 'rollback-completed.json') }),
      runtime: { config: { projectRoot: path.dirname(target) } },
    });
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.reason, 'rollback_state_verified');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('commit reconciliation distinguishes not-started, proved success, and unrelated head movement', async () => {
  const root = await tempRoot();
  try {
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Bridge Test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'bridge@example.invalid'], { cwd: root });
    await fs.writeFile(path.join(root, 'a.txt'), 'one');
    await execFileAsync('git', ['add', 'a.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: root });
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
    const base = stdout.trim();
    const refs = { preCommitHead: base, expectedMessage: 'expected commit' };
    const before = await reconcileLocalEffect({ effect: effect(WorkflowLocalEffectKind.COMMIT, refs), runtime: { config: { projectRoot: root } } });
    assert.equal(before.outcome, 'not_started');
    await fs.writeFile(path.join(root, 'a.txt'), 'two');
    await execFileAsync('git', ['add', 'a.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', refs.expectedMessage], { cwd: root });
    const after = await reconcileLocalEffect({ effect: effect(WorkflowLocalEffectKind.COMMIT, refs), runtime: { config: { projectRoot: root } } });
    assert.equal(after.outcome, 'succeeded');
    assert.ok(after.result.sha);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test('squash reconciliation proves the exact checkpoint graph and final parent', async () => {
  const root = await tempRoot();
  try {
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Bridge Test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'bridge@example.invalid'], { cwd: root });
    await fs.writeFile(path.join(root, 'a.txt'), 'base');
    await execFileAsync('git', ['add', 'a.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: root });
    const base = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    const checkpoints = [];
    for (const [value, message] of [['one', 'checkpoint one'], ['two', 'checkpoint two']]) {
      await fs.writeFile(path.join(root, 'a.txt'), value);
      await execFileAsync('git', ['add', 'a.txt'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', message], { cwd: root });
      checkpoints.push((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim());
    }
    const result = await squashGitCommits({
      root,
      baseSha: base,
      commitShas: checkpoints,
      message: 'final squash',
      paths: ['a.txt'],
      refName: 'fixture/squash',
    });
    assert.equal(result.squashed, true);
    const reconciled = await reconcileLocalEffect({
      effect: effect(WorkflowLocalEffectKind.SQUASH, {
        preCommitHead: checkpoints.at(-1),
        expectedMessage: 'final squash',
        baseSha: base,
        checkpointShas: checkpoints,
        backupRef: result.backupRef,
      }),
      runtime: { config: { projectRoot: root } },
    });
    assert.equal(reconciled.outcome, 'succeeded');
    assert.equal(reconciled.reason, 'git_squash_verified');
    assert.deepEqual(reconciled.result.checkpointShas, checkpoints);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test('git restore reconciliation proves the backup ref, rewound HEAD, and exact path state', async () => {
  const root = await tempRoot();
  try {
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Bridge Test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'bridge@example.invalid'], { cwd: root });
    await fs.writeFile(path.join(root, 'a.txt'), 'base');
    await execFileAsync('git', ['add', 'a.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: root });
    const base = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    const checkpoints = [];
    for (const [value, message] of [['one', 'checkpoint one'], ['two', 'checkpoint two']]) {
      await fs.writeFile(path.join(root, 'a.txt'), value);
      await execFileAsync('git', ['add', 'a.txt'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', message], { cwd: root });
      checkpoints.push((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim());
    }
    const preCommitHead = checkpoints.at(-1);
    const restored = await restoreGitWorkflowState({
      root,
      baseSha: base,
      commitShas: checkpoints,
      paths: ['a.txt'],
      refName: 'fixture-restore',
    });
    assert.equal(restored.restored, true);
    const references = {
      mode: 'git_restore',
      baseSha: base,
      checkpointShas: checkpoints,
      paths: ['a.txt'],
      preCommitHead,
      refName: 'fixture-restore',
      receiptPath: path.join(root, 'missing-receipt.json'),
    };
    const reconciled = await reconcileLocalEffect({
      effect: effect(WorkflowLocalEffectKind.ROLLBACK, references),
      runtime: { config: { projectRoot: root } },
    });
    assert.equal(reconciled.outcome, 'succeeded');
    assert.equal(reconciled.reason, 'git_restore_verified');

    await fs.writeFile(path.join(root, 'a.txt'), 'changed after restore');
    const noLongerProved = await reconcileLocalEffect({
      effect: effect(WorkflowLocalEffectKind.ROLLBACK, references),
      runtime: { config: { projectRoot: root } },
    });
    assert.equal(noLongerProved.outcome, 'uncertain');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
