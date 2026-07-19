import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  isSafeLocalEffect,
  localEffectRecoveryDecision,
  reconcileLocalEffect,
} from '../src/workflow/state/localEffects.js';
import {
  WorkflowEffectStatus,
  WorkflowLocalEffectKind,
} from '../src/workflow/state/workflowState.js';

const execFileAsync = promisify(execFile);

function effect(kind, status = WorkflowEffectStatus.DISPATCHED, references = {}, overrides = {}) {
  return {
    id: `matrix-${kind}`,
    kind,
    status,
    attempt: 1,
    safe: isSafeLocalEffect(kind),
    policy: 'if_unconfirmed',
    references,
    ...overrides,
  };
}

for (const kind of Object.values(WorkflowLocalEffectKind)) {
  test(`planned ${kind} is always proved not started without touching external state`, async () => {
    const result = await reconcileLocalEffect({ effect: effect(kind, WorkflowEffectStatus.PLANNED), runtime: {} });
    assert.deepEqual(result, { outcome: 'not_started', reason: 'intent_not_dispatched' });
  });
}

for (const kind of [
  WorkflowLocalEffectKind.PROJECT_SNAPSHOT,
  WorkflowLocalEffectKind.CHECKS,
  WorkflowLocalEffectKind.VERIFY,
  WorkflowLocalEffectKind.PLAN,
]) {
  test(`dispatched read-only ${kind} is explicitly safe to retry`, async () => {
    const result = await reconcileLocalEffect({ effect: effect(kind), runtime: {} });
    assert.deepEqual(result, { outcome: 'safe_retry', reason: 'read_only_effect' });
  });
}

test('apply recovery distinguishes absent intent evidence, partial write evidence, and a completion receipt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-apply-matrix-'));
  try {
    const manifestPath = path.join(root, 'rollback', 'manifest.json');
    const receiptPath = path.join(root, 'rollback', 'apply-completed.json');
    const runtime = { config: { projectRoot: root } };
    const candidate = effect(WorkflowLocalEffectKind.APPLY, WorkflowEffectStatus.DISPATCHED, { manifestPath, receiptPath });

    assert.deepEqual(await reconcileLocalEffect({ effect: candidate, runtime }), {
      outcome: 'not_started', reason: 'rollback_manifest_absent',
    });

    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify([{ path: 'a.txt', exists: false }]));
    const partial = await reconcileLocalEffect({ effect: candidate, runtime });
    assert.equal(partial.outcome, 'uncertain');
    assert.equal(partial.reason, 'apply_started_without_completion_receipt');

    await fs.writeFile(receiptPath, JSON.stringify({ pipelineId: 'pipeline-1', written: ['a.txt'] }));
    const completed = await reconcileLocalEffect({ effect: candidate, runtime });
    assert.equal(completed.outcome, 'succeeded');
    assert.equal(completed.result.pipelineId, 'pipeline-1');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rollback recovery refuses a manifest whose restored bytes no longer match', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-rollback-matrix-'));
  try {
    const projectRoot = path.join(root, 'project');
    const rollbackRoot = path.join(root, 'rollback');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(rollbackRoot, { recursive: true });
    const target = path.join(projectRoot, 'a.txt');
    const backup = path.join(rollbackRoot, 'a.txt');
    const manifestPath = path.join(rollbackRoot, 'manifest.json');
    await fs.writeFile(target, 'after');
    await fs.writeFile(backup, 'before');
    await fs.writeFile(manifestPath, JSON.stringify([{ path: 'a.txt', exists: true, type: 'file', backupPath: backup }]));

    const result = await reconcileLocalEffect({
      effect: effect(WorkflowLocalEffectKind.ROLLBACK, WorkflowEffectStatus.DISPATCHED, {
        manifestPath,
        receiptPath: path.join(rollbackRoot, 'missing-receipt.json'),
      }),
      runtime: { config: { projectRoot } },
    });
    assert.equal(result.outcome, 'uncertain');
    assert.equal(result.reason, 'rollback_state_not_proved');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('commit recovery never accepts unrelated HEAD movement or a matching message with the wrong parent evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-commit-matrix-'));
  try {
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Bridge Test'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'bridge@example.invalid'], { cwd: root });
    await fs.writeFile(path.join(root, 'a.txt'), 'base');
    await execFileAsync('git', ['add', 'a.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: root });
    const base = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    await fs.writeFile(path.join(root, 'a.txt'), 'other');
    await execFileAsync('git', ['add', 'a.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'unrelated commit'], { cwd: root });

    const result = await reconcileLocalEffect({
      effect: effect(WorkflowLocalEffectKind.COMMIT, WorkflowEffectStatus.DISPATCHED, {
        preCommitHead: base,
        expectedMessage: 'expected workflow commit',
      }),
      runtime: { config: { projectRoot: root } },
    });
    assert.equal(result.outcome, 'uncertain');
    assert.equal(result.reason, 'git_head_changed_without_expected_commit');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('local recovery policy blocks ambiguous writes and automatically retries only planned or safe effects', () => {
  const safeState = {
    retryPolicy: { safeLimit: 3, local: {} },
    localEffects: {
      plannedApply: effect(WorkflowLocalEffectKind.APPLY, WorkflowEffectStatus.PLANNED, {}, { id: 'plannedApply' }),
      checks: effect(WorkflowLocalEffectKind.CHECKS, WorkflowEffectStatus.DISPATCHED, {}, { id: 'checks' }),
    },
  };
  assert.deepEqual(localEffectRecoveryDecision(safeState), {
    automatic: true,
    effectIds: ['plannedApply', 'checks'],
  });

  const blockedState = {
    retryPolicy: { safeLimit: 3, local: { apply: 'if_unconfirmed' } },
    localEffects: {
      apply: effect(WorkflowLocalEffectKind.APPLY, WorkflowEffectStatus.DISPATCHED, {}, { id: 'apply' }),
    },
  };
  const blocked = localEffectRecoveryDecision(blockedState);
  assert.equal(blocked.automatic, false);
  assert.equal(blocked.effect.kind, WorkflowLocalEffectKind.APPLY);
});
