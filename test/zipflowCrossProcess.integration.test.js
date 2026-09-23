import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FileStore } from '../src/fileStore.js';
import { writeZip } from '../src/zipWriter.js';
import { ServerRepairSeriesCoordinator } from '../src/workflow/server/serverRepairSeries.js';
import { ZipflowBridgeRuntime } from '../src/workflow/server/zipflowBridgeRuntime.js';

const execute = promisify(execFile);

async function waitForSurface(runtime, predicate, {
  timeoutMs = 30_000,
  intervalMs = 75,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = runtime.snapshot();
  while (Date.now() < deadline) {
    snapshot = await runtime.refresh();
    if (predicate(snapshot.surface, snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out at workflow surface ${snapshot.surface?.kind || '(none)'}`);
}

function actionInput(surface, actionId) {
  if (actionId === 'select-archive-root') {
    const choice = surface.sections.flatMap((section) => section.choices || [])[0];
    return { rootId: choice?.id };
  }
  if (actionId === 'resolve-conflict') {
    const conflict = surface.sections.flatMap((section) => section.conflicts || [])[0];
    return { path: conflict?.path, decision: 'archive' };
  }
  if (actionId === 'use-archive' || actionId === 'keep-local') {
    const file = surface.sections.flatMap((section) => section.files || [])[0];
    return { path: file?.path };
  }
  if (actionId === 'commit') return { message: 'Apply deterministic workflow update' };
  return {};
}

async function perform(runtime, surface, actionId) {
  const action = surface.actions.find((candidate) => candidate.id === actionId && candidate.enabled);
  assert.ok(action, `${actionId} must be advertised on ${surface.kind}`);
  return await runtime.performAction({
    actionId,
    actionKind: action.kind,
    input: actionInput(surface, actionId),
    surfaceId: surface.id,
    surfaceRevision: surface.revision,
    links: surface.links,
  });
}

async function advanceToCompleted(runtime, {
  commit = false,
  deploy = false,
} = {}) {
  const visited = [];
  for (let step = 0; step < 30; step += 1) {
    const snapshot = await waitForSurface(
      runtime,
      (surface) => surface && surface.kind !== 'operation_progress' && surface.kind !== 'archive_inspecting',
    );
    const surface = snapshot.surface;
    visited.push(`${surface.kind}@${surface.revision}`);
    if (surface.kind === 'completed') return snapshot;
    if (surface.kind === 'archive_root_choice') await perform(runtime, surface, 'select-archive-root');
    else if (surface.kind === 'archive_safety') await perform(runtime, surface, 'acknowledge-archive-safety');
    else if (surface.kind === 'conflict_summary' || surface.kind === 'conflict_file') {
      await perform(runtime, surface, 'resolve-conflict');
    } else if (surface.kind === 'plan_review' || surface.kind === 'plan_files') {
      await perform(runtime, surface, 'approve-plan');
    } else if (surface.kind === 'checks_failed') await perform(runtime, surface, 'finish');
    else if (surface.kind === 'commit_choice') {
      await perform(runtime, surface, commit ? 'prepare-commit' : 'continue-without-commit');
    }
    else if (surface.kind === 'commit_message') await perform(runtime, surface, 'commit');
    else if (surface.kind === 'deploy_choice') await perform(runtime, surface, deploy ? 'deploy' : 'skip-deploy');
    else throw new Error(`Unexpected workflow surface: ${surface.kind}`);
  }
  throw new Error(`Workflow did not complete within the deterministic action budget: ${visited.join(' -> ')}`);
}

async function stopIsolatedDaemon(zipflowHome) {
  const discoveryPath = path.join(zipflowHome, 'runtime', 'server-v1.json');
  const discovery = JSON.parse(await fs.readFile(discoveryPath, 'utf8').catch(() => '{}'));
  if (Number.isInteger(discovery.pid) && discovery.pid > 0) {
    try {
      process.kill(discovery.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

test('two-process Bridge workflow survives restart and rolls back without duplicate mutation', {
  timeout: 60_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-zipflow-e2e-'));
  const project = path.join(root, 'project');
  const dataDir = path.join(root, 'bridge-data');
  const zipflowHome = path.join(root, 'zipflow-home');
  const archivePath = path.join(root, 'result.zip');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'app.txt'), 'before\n');
  await execute('git', ['init'], { cwd: project });
  await execute('git', ['add', 'app.txt'], { cwd: project });
  await execute('git', [
    '-c', 'user.name=Bridge Test',
    '-c', 'user.email=bridge@example.invalid',
    'commit', '-m', 'baseline',
  ], { cwd: project });
  await writeZip(archivePath, [{ name: 'app.txt', data: Buffer.from('after\n') }]);
  const fileStore = new FileStore(dataDir);
  const artifact = await fileStore.importLocalPath({
    filePath: archivePath,
    name: 'result.zip',
  });
  const options = {
    dataDir,
    fileStore,
    daemonOptions: {
      zipflowHome,
      expectedSocketPath: path.join(root, 'zipflow.sock'),
      idleTimeoutMs: 5_000,
      startupTimeoutMs: 15_000,
      retryMs: 50,
    },
  };
  let runtime = new ZipflowBridgeRuntime(options);
  try {
    const opened = await runtime.openProject(project);
    const draft = structuredClone(opened.suggestedWorkflow);
    draft.archive.mode = 'overlay';
    draft.checks = [];
    draft.git.resultCommit = 'ask';
    draft.deploy.policy = 'disabled';
    await runtime.saveWorkflow(draft);
    await runtime.uploadAndStartArchiveRun({
      fileId: artifact.id,
      expected: { size: artifact.size, sha256: artifact.sha256 },
      filename: artifact.name,
      correlation: { requestId: 'request-1', projectId: 'bridge-project-1' },
    });

    const plan = await waitForSurface(
      runtime,
      (surface) => ['plan_review', 'plan_files', 'conflict_summary'].includes(surface?.kind),
    );
    const runId = plan.state.localWorkflow.runId;
    await runtime.close();

    runtime = new ZipflowBridgeRuntime(options);
    const resumed = await runtime.openProject(project);
    assert.equal(resumed.state.localWorkflow.runId, runId);
    assert.ok(['plan_review', 'plan_files', 'conflict_summary'].includes(resumed.surface.kind));

    const completed = await advanceToCompleted(runtime);
    assert.equal(await fs.readFile(path.join(project, 'app.txt'), 'utf8'), 'after\n');
    assert.equal(completed.state.localWorkflow.runId, runId);

    await perform(runtime, completed.surface, 'rollback');
    const confirmation = await waitForSurface(runtime, (surface) => surface?.kind === 'rollback_confirm');
    await perform(runtime, confirmation.surface, 'rollback');
    await waitForSurface(runtime, (_surface, snapshot) => snapshot.resources.run?.status === 'rolled_back');
    assert.equal(await fs.readFile(path.join(project, 'app.txt'), 'utf8'), 'before\n');
  } finally {
    await runtime.close().catch(() => {});
    await stopIsolatedDaemon(zipflowHome).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('two-process workflow owns checks, commit, and configured deployment', {
  timeout: 60_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-zipflow-actions-'));
  const project = path.join(root, 'project');
  const dataDir = path.join(root, 'bridge-data');
  const zipflowHome = path.join(root, 'zipflow-home');
  const archivePath = path.join(root, 'result.zip');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'app.txt'), 'before\n');
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({
    name: 'workflow-actions',
    scripts: {
      test: 'node -e "process.exit(0)"',
    },
  }));
  await execute('git', ['init'], { cwd: project });
  await execute('git', ['add', 'app.txt', 'package.json'], { cwd: project });
  await execute('git', [
    '-c', 'user.name=Bridge Test',
    '-c', 'user.email=bridge@example.invalid',
    'commit', '-m', 'baseline',
  ], { cwd: project });
  await execute('git', ['config', 'user.name', 'Bridge Test'], { cwd: project });
  await execute('git', ['config', 'user.email', 'bridge@example.invalid'], { cwd: project });
  await writeZip(archivePath, [{ name: 'app.txt', data: Buffer.from('committed\n') }]);
  const fileStore = new FileStore(dataDir);
  const artifact = await fileStore.importLocalPath({ filePath: archivePath, name: 'result.zip' });
  const runtime = new ZipflowBridgeRuntime({
    dataDir,
    fileStore,
    daemonOptions: {
      zipflowHome,
      expectedSocketPath: path.join(root, 'zipflow.sock'),
      idleTimeoutMs: 5_000,
      startupTimeoutMs: 15_000,
      retryMs: 50,
    },
  });
  try {
    const opened = await runtime.openProject(project);
    const draft = structuredClone(opened.suggestedWorkflow);
    draft.archive.mode = 'overlay';
    assert.ok(draft.checks.length, 'the fixture test command must be detected');
    draft.git.resultCommit = 'ask';
    draft.deploy = {
      policy: 'ask',
      commandText: 'node -e "require(\'fs\').writeFileSync(\'deployed.txt\', \'yes\\n\')"',
      cwd: '.',
      timeoutMs: 30_000,
    };
    await runtime.saveWorkflow(draft);
    await runtime.uploadAndStartArchiveRun({
      fileId: artifact.id,
      expected: { size: artifact.size, sha256: artifact.sha256 },
      filename: artifact.name,
      correlation: { producer: 'chatgpt-bridge', requestId: 'request-actions' },
    });
    const completed = await advanceToCompleted(runtime, { commit: true, deploy: true });
    assert.equal(completed.surface.kind, 'completed');
    assert.equal(await fs.readFile(path.join(project, 'app.txt'), 'utf8'), 'committed\n');
    assert.equal(await fs.readFile(path.join(project, 'deployed.txt'), 'utf8'), 'yes\n');
    const log = await execute('git', ['log', '-1', '--pretty=%s'], { cwd: project });
    assert.equal(log.stdout.trim(), 'Apply deterministic workflow update');
    const reportResponse = await runtime.report();
    const report = reportResponse.body || reportResponse;
    assert.equal(report.checks.ok, true);
    assert.ok(report.checks.results.length);
    assert.ok(report.checks.results.every((check) => check.ok));
  } finally {
    await runtime.close().catch(() => {});
    await stopIsolatedDaemon(zipflowHome).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('fix-until-pass sends failed checks to Bridge and applies the repaired archive', {
  timeout: 60_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-zipflow-repair-'));
  const project = path.join(root, 'project');
  const dataDir = path.join(root, 'bridge-data');
  const zipflowHome = path.join(root, 'zipflow-home');
  const archivePath = path.join(root, 'repair.zip');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'app.txt'), 'broken\n');
  await fs.writeFile(path.join(project, 'package.json'), `${JSON.stringify({
    name: 'workflow-repair',
    version: '1.0.0',
    scripts: {
      test: "node -e \"process.exit(require('fs').readFileSync('app.txt', 'utf8').includes('fixed') ? 0 : 1)\"",
    },
  }, null, 2)}\n`);
  await execute('git', ['init'], { cwd: project });
  await execute('git', ['add', 'app.txt', 'package.json'], { cwd: project });
  await execute('git', [
    '-c', 'user.name=Bridge Test',
    '-c', 'user.email=bridge@example.invalid',
    'commit', '-m', 'baseline',
  ], { cwd: project });
  await execute('git', ['config', 'user.name', 'Bridge Test'], { cwd: project });
  await execute('git', ['config', 'user.email', 'bridge@example.invalid'], { cwd: project });
  await writeZip(archivePath, [{ name: 'app.txt', data: Buffer.from('fixed\n') }]);
  const fileStore = new FileStore(dataDir);
  const artifact = await fileStore.importLocalPath({
    filePath: archivePath,
    name: 'repair.zip',
  });
  const runtime = new ZipflowBridgeRuntime({
    dataDir,
    fileStore,
    daemonOptions: {
      zipflowHome,
      expectedSocketPath: path.join(root, 'zipflow.sock'),
      idleTimeoutMs: 5_000,
      startupTimeoutMs: 15_000,
      retryMs: 50,
    },
  });
  try {
    const opened = await runtime.openProject(project);
    await runtime.configurePreset('fix-until-pass', {
      attempts: { checkCycles: 3, noProgressLimit: 2 },
    });
    const configured = structuredClone(runtime.snapshot(opened.workflowId).workflow);
    configured.archive.mode = 'overlay';
    configured.deploy.policy = 'disabled';
    await runtime.saveWorkflow(configured);
    let repairs = 0;
    const coordinator = new ServerRepairSeriesCoordinator({
      runtime,
      pollMs: 25,
    });
    const result = await coordinator.run({
      workflowId: opened.workflowId,
      requestRepair: async ({ seriesId, attempt, output }) => {
        repairs += 1;
        assert.equal(attempt, 1);
        assert.ok(seriesId);
        assert.match(output, /failed|code|Test/i);
        return {
          fileId: artifact.id,
          filename: artifact.name,
          expected: { size: artifact.size, sha256: artifact.sha256 },
          correlation: { producer: 'chatgpt-bridge' },
        };
      },
      resolveAction: async ({ surface }) => {
        if (surface.kind === 'archive_root_choice') {
          return { actionId: 'select-archive-root', input: actionInput(surface, 'select-archive-root') };
        }
        if (surface.kind === 'archive_safety') return { actionId: 'acknowledge-archive-safety' };
        if (surface.kind === 'conflict_summary' || surface.kind === 'conflict_file') {
          return { actionId: 'resolve-conflict', input: actionInput(surface, 'resolve-conflict') };
        }
        if (surface.kind === 'plan_review' || surface.kind === 'plan_files') {
          return { actionId: 'approve-plan' };
        }
        if (surface.kind === 'commit_choice') return { actionId: 'prepare-commit' };
        if (surface.kind === 'commit_message') {
          return { actionId: 'commit', input: { message: 'Repair project checks' } };
        }
        if (surface.kind === 'deploy_choice') return { actionId: 'skip-deploy' };
        return null;
      },
    });
    assert.equal(result.status, 'completed');
    assert.equal(repairs, 1);
    assert.equal(await fs.readFile(path.join(project, 'app.txt'), 'utf8'), 'fixed\n');
    const report = await runtime.report();
    assert.equal(report.checks.ok, true);
    const stored = runtime.snapshot(opened.workflowId).orchestration.series;
    assert.equal(stored.status, 'completed');
    assert.equal(stored.attempt, 1);
  } finally {
    await runtime.close().catch(() => {});
    await stopIsolatedDaemon(zipflowHome).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.rm(root, { recursive: true, force: true });
  }
});
