import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkflowApplyVerifiedService } from '../src/workflow/services/applyVerifiedService.js';

const execFileAsync = promisify(execFile);

async function temp(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function appliedResult(paths = ['src/app.js']) {
  return {
    ok: true,
    appliedAt: '2026-07-17T00:00:00.000Z',
    backupRoot: '/tmp/backup',
    manifest: paths.map((filePath) => ({ path: filePath })),
    applied: { written: paths.map((filePath) => ({ path: filePath })), deleted: [] },
    commands: { ok: true, results: [] },
  };
}

function state(overrides = {}) {
  return {
    pipelineId: 'pipeline-1',
    artifactKey: 'artifact-1',
    remediationAttempt: 0,
    response: { sourceClientId: 'client-1', session: { id: 'session-1' } },
    verification: { resultProtocol: { manifest: { commitMessage: 'Update project' } } },
    plan: { plan: { written: [{ path: 'src/app.js' }], delete: [], localChangedDelete: [] } },
    ...overrides,
  };
}

function runtime(projectRoot, overrides = {}) {
  return {
    id: 'workflow-1',
    workflowCommitPathStates: {},
    config: {
      projectRoot,
      preset: 'fix-until-pass',
      watch: { clientId: 'client-1' },
      commit: { mode: 'none' },
      extensionUpdate: { enabled: false },
      remediation: { enabled: false, maxAttempts: 2 },
    },
    ...overrides,
  };
}

function service(overrides = {}) {
  const events = [];
  const transitions = [];
  const artifacts = new Map([['artifact-1', { status: 'verified' }]]);
  const completionCalls = [];
  const instance = new WorkflowApplyVerifiedService({
    applier: { apply: async () => appliedResult() },
    extensionDeployer: {
      prepareBackup: async () => ({ available: false, reason: 'disabled' }),
      deploy: async () => ({ updated: false }),
    },
    commitService: { maybeCommit: async () => ({ committed: false, reason: 'disabled' }) },
    checkFailureService: { capture: async () => ({ status: 'checks-failed' }) },
    applyCompletionService: {
      complete: async (...args) => {
        completionCalls.push(args);
        return { status: 'applied', commit: args[2]?.commit, warnings: args[2]?.warnings || [] };
      },
    },
    resultRepairService: { remediate: async () => ({ status: 'repairing' }) },
    store: {
      getArtifact: async (key) => artifacts.get(key),
      setArtifact: async (key, value) => artifacts.set(key, value),
    },
    transition: async (...args) => transitions.push(args),
    publish: async (workflowId, type, data) => events.push({ workflowId, type, data }),
    refresh: () => {},
    ...overrides,
  });
  return { instance, events, transitions, artifacts, completionCalls };
}

test('verified application publishes progress and completes through shared services', async () => {
  const root = await temp('bridge-apply-success-');
  const harness = service();
  const result = await harness.instance.apply(runtime(root), state());

  assert.equal(result.status, 'applied');
  assert.equal(harness.transitions[0][3], 'workflow.apply.started');
  assert.equal(harness.events.some((item) => item.type === 'workflow.apply.completed'), true);
  assert.equal(harness.completionCalls.length, 1);
  assert.deepEqual(harness.completionCalls[0][2].warnings, []);
  assert.equal(harness.completionCalls[0][1].applied.files.writtenCount, 1);
});

test('extension deployment failures and commit failures become completion warnings', async () => {
  const root = await temp('bridge-apply-warnings-');
  let backupPrepared = false;
  const harness = service({
    extensionDeployer: {
      prepareBackup: async () => { backupPrepared = true; return { available: true, path: '/tmp/ext-backup' }; },
      deploy: async () => { throw Object.assign(new Error('extension deploy failed'), { extensionRollback: { ok: true } }); },
    },
    commitService: { maybeCommit: async () => { throw Object.assign(new Error('commit failed'), { code: 'COMMIT_FAILED' }); } },
  });
  const run = runtime(root);
  run.config.extensionUpdate.enabled = true;

  const result = await harness.instance.apply(run, state());

  assert.equal(backupPrepared, true);
  assert.deepEqual(result.warnings, ['commit failed', 'extension deploy failed']);
  assert.equal(harness.events.some((item) => item.type === 'workflow.extension.update.failed'), true);
  assert.equal(harness.events.some((item) => item.type === 'workflow.commit.failed'), true);
});

test('commit approval stores a recoverable pending decision and artifact state', async () => {
  const root = await temp('bridge-apply-approval-');
  const harness = service({
    commitService: {
      maybeCommit: async () => ({
        committed: false,
        reason: 'approval-required',
        message: 'Update project',
        pathStates: { 'src/app.js': { type: 'file', sha256: 'abc' } },
      }),
    },
  });
  const run = runtime(root);

  const result = await harness.instance.apply(run, state());

  assert.equal(result.status, 'pending-approval');
  assert.equal(result.approvalType, 'commit');
  assert.equal(run.pendingCommit.message, 'Update project');
  assert.deepEqual(run.pendingCommit.paths, ['src/app.js']);
  assert.equal((await harness.artifacts.get('artifact-1')).status, 'awaiting-commit');
  assert.equal(harness.transitions.at(-1)[3], 'workflow.commit.approval.required');
});

test('apply failure starts automatic remediation while attempts remain', async () => {
  const root = await temp('bridge-apply-remediation-');
  const error = new Error('package could not be applied');
  let remediation = null;
  const harness = service({
    applier: { apply: async () => { throw error; } },
    resultRepairService: {
      remediate: async (_runtime, _state, received, attempt) => {
        remediation = { received, attempt };
        return { status: 'repairing', attempt };
      },
    },
  });
  const run = runtime(root);
  run.config.remediation.enabled = true;

  const result = await harness.instance.apply(run, state());

  assert.deepEqual(result, { status: 'repairing', attempt: 1 });
  assert.equal(remediation.received, error);
  assert.equal(remediation.attempt, 1);
  assert.equal(harness.transitions.at(-1)[3], 'workflow.apply.failed');
});

test('exhausted remediation records a terminal pipeline failure and rethrows', async () => {
  const root = await temp('bridge-apply-terminal-');
  const error = Object.assign(new Error('still invalid'), { commandResults: [{ command: 'npm test', ok: false, code: 1 }] });
  let refreshed = false;
  const harness = service({
    applier: { apply: async () => { throw error; } },
    refresh: () => { refreshed = true; },
  });
  const run = runtime(root);
  run.config.remediation = { enabled: true, maxAttempts: 1 };

  await assert.rejects(() => harness.instance.apply(run, state({ remediationAttempt: 1 })), /still invalid/);
  assert.equal(run.lastError, 'still invalid');
  assert.equal(refreshed, true);
  assert.equal(harness.transitions.at(-1)[3], 'workflow.apply.failed');
});

test('dirty user files that overlap the result are rejected before application', async () => {
  const root = await temp('bridge-apply-overlap-');
  const git = async (...args) => await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8' });
  await git('init');
  await git('config', 'user.name', 'Bridge Tests');
  await git('config', 'user.email', 'bridge-tests@example.com');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/app.js'), 'initial\n');
  await git('add', 'src/app.js');
  await git('commit', '-m', 'Initial');
  await fs.writeFile(path.join(root, 'src/app.js'), 'manual edit\n');

  let applied = false;
  const harness = service({ applier: { apply: async () => { applied = true; return appliedResult(); } } });
  const run = runtime(root);
  run.config.commit.mode = 'block';

  await assert.rejects(
    () => harness.instance.apply(run, state()),
    (error) => error.code === 'WORKFLOW_LOCAL_CHANGE_CONFLICT' && /src\/app\.js/.test(error.message),
  );
  assert.equal(applied, false);
  assert.equal(harness.events.some((item) => item.type === 'workflow.local-change.conflict'), true);
});
