import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadWorkflowConfig } from '../src/workflow/config.js';
import { validateResultManifestAgainstPlan } from '../src/workflow/result/resultProtocol.js';
import { WorkflowCommitService } from '../src/workflow/services/commitService.js';
import { WorkflowSettingsService } from '../src/workflow/services/settingsService.js';
import { WorkflowSessionService } from '../src/workflow/services/sessionService.js';
import { WorkflowCheckFailureService } from '../src/workflow/services/checkFailureService.js';
import { WorkflowApplyVerifiedService } from '../src/workflow/services/applyVerifiedService.js';
import { WorkflowNotificationService } from '../src/workflow/attention/notificationService.js';
import { attentionActions, attentionForWorkflowEvent } from '../src/workflow/attention/attentionState.js';
import { defaultGlobalWorkflowConfig, saveGlobalWorkflowConfig } from '../src/workflow/ux/globalConfig.js';
import { inspectGitRepository } from '../src/workflow/gitCommit.js';
import { publicWorkflowSnapshot } from '../src/workflow/state/workflowProjection.js';

const execFileAsync = promisify(execFile);
async function temp(prefix) { return await fs.mkdtemp(path.join(os.tmpdir(), prefix)); }

function plan(...paths) {
  return {
    plan: {
      create: paths.map((item) => ({ path: item })),
      update: [],
      localChanged: [],
      delete: [],
      localChangedDelete: [],
    },
  };
}

test('result manifest file list is an exact allow-list for applied changes', () => {
  const manifest = { status: 'changed', files: ['src/a.js'] };
  assert.deepEqual(validateResultManifestAgainstPlan({ manifest, plan: plan('src/a.js') }), []);
  assert.deepEqual(validateResultManifestAgainstPlan({ manifest, plan: plan('src/a.js', 'src/unlisted.js') }), [
    'result package changes a file that is missing from the manifest: src/unlisted.js',
  ]);
  assert.deepEqual(validateResultManifestAgainstPlan({ manifest: { status: 'unchanged', files: [] }, plan: plan('src/a.js') }), [
    'result manifest status=unchanged but the package changes 1 project file(s)',
  ]);
});

test('commit approval refuses user edits made after workflow application', async () => {
  const root = await temp('bridge-commit-race-');
  const git = async (...args) => (await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim();
  await git('init');
  await git('config', 'user.name', 'Bridge Tests');
  await git('config', 'user.email', 'bridge-tests@example.com');
  await fs.writeFile(path.join(root, 'app.js'), 'before\n');
  await git('add', 'app.js');
  await git('commit', '-m', 'Initial');
  const preApplyGit = await inspectGitRepository(root);
  await fs.writeFile(path.join(root, 'app.js'), 'workflow version\n');

  const events = [];
  const service = new WorkflowCommitService({
    dataDir: await temp('bridge-commit-data-'),
    publish: async (_id, type, data) => events.push({ type, data }),
    persistRuntime: async () => {},
    completeAppliedPipeline: async () => ({ completed: true }),
  });
  const runtime = {
    id: 'workflow-1',
    config: {
      id: 'workflow-1', projectRoot: root, preset: 'apply-changes', ux: { label: 'Apply changes' },
      commit: {
        mode: 'block', required: false, beginMarker: 'BEGIN', endMarker: 'END', style: 'short',
        authorName: '', authorEmail: '', policy: { mode: 'ask', iterationStrategy: 'checkpoint', completionStrategy: 'squash', includeOnlyWorkflowChanges: true },
      },
    },
    workflowCommitPaths: [], workflowCommitShas: [], workflowCommitPathStates: {},
  };
  const pending = await service.maybeCommit(runtime, { answer: '' }, 'pipeline-1', {
    preApplyGit,
    verification: { resultProtocol: { manifest: { summary: 'Update app', commitMessage: 'Update app' } } },
    workflowPaths: ['app.js'],
  });
  assert.equal(pending.reason, 'approval-required');
  runtime.pendingCommit = { ...pending, pipelineId: 'pipeline-1', artifactKey: 'artifact-1', preApplyHead: preApplyGit.head, applied: {}, extensionUpdate: {}, warnings: [] };
  await fs.writeFile(path.join(root, 'app.js'), 'user changed it again\n');
  await assert.rejects(() => service.approvePending(runtime), (error) => error.code === 'WORKFLOW_LOCAL_CHANGE_CONFLICT');
  assert.equal(events.some((item) => item.type === 'workflow.local-change.conflict'), true);
  assert.equal(await git('rev-parse', 'HEAD'), preApplyGit.head);
});

test('automatic commit refuses edits made while a commit message is being generated', async () => {
  const root = await temp('bridge-commit-message-race-');
  const git = async (...args) => (await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim();
  await git('init');
  await git('config', 'user.name', 'Bridge Tests');
  await git('config', 'user.email', 'bridge-tests@example.com');
  await fs.writeFile(path.join(root, 'app.js'), 'before\n');
  await git('add', 'app.js');
  await git('commit', '-m', 'Initial');
  const preApplyGit = await inspectGitRepository(root);
  await fs.writeFile(path.join(root, 'app.js'), 'workflow version\n');

  const service = new WorkflowCommitService({
    bridge: {
      sendRequest: async () => {
        await fs.writeFile(path.join(root, 'app.js'), 'user edit during commit message\n');
        return { answer: 'BEGIN\nUpdate app\nEND', session: { id: 'session-1' } };
      },
    },
    dataDir: await temp('bridge-commit-message-data-'),
    publish: async () => {},
    persistRuntime: async () => {},
  });
  const runtime = {
    id: 'workflow-1',
    config: {
      id: 'workflow-1', projectRoot: root, preset: 'apply-changes', watch: { sessionId: 'session-1', clientId: 'client-1' }, ux: { label: 'Apply changes' },
      commit: {
        mode: 'same-chat', required: false, beginMarker: 'BEGIN', endMarker: 'END', style: 'short', prompt: '',
        authorName: '', authorEmail: '', policy: { mode: 'automatic', iterationStrategy: 'checkpoint', completionStrategy: 'squash', includeOnlyWorkflowChanges: true },
      },
    },
    workflowCommitPaths: [], workflowCommitShas: [], workflowCommitPathStates: {},
  };

  await assert.rejects(
    () => service.maybeCommit(runtime, { answer: '', session: { id: 'session-1' }, sourceClientId: 'client-1' }, 'pipeline-1', {
      preApplyGit,
      verification: { resultProtocol: { manifest: { summary: 'Update app', commitMessage: '' } } },
      workflowPaths: ['app.js'],
    }),
    (error) => error.code === 'WORKFLOW_LOCAL_CHANGE_CONFLICT',
  );
  assert.equal(await git('rev-parse', 'HEAD'), preApplyGit.head);
  assert.equal(await fs.readFile(path.join(root, 'app.js'), 'utf8'), 'user edit during commit message\n');
});

test('disabled commit mode still tracks workflow-owned file states for later iterations', async () => {
  const root = await temp('bridge-disabled-commit-');
  await fs.writeFile(path.join(root, 'app.js'), 'workflow version\n');
  const runtime = {
    id: 'workflow-1',
    config: { projectRoot: root, ux: { label: 'Fix project' }, commit: { mode: 'none', policy: {} } },
    workflowCommitPaths: [], workflowCommitPathStates: {},
  };
  const service = new WorkflowCommitService({ persistRuntime: async () => {}, publish: async () => {} });
  const result = await service.maybeCommit(runtime, {}, 'pipeline-1', {
    preApplyGit: { head: 'base-sha' }, workflowPaths: ['app.js'],
  });
  assert.equal(result.reason, 'disabled');
  assert.deepEqual(runtime.workflowCommitPaths, ['app.js']);
  assert.equal(runtime.workflowCommitPathStates['app.js'].sha256.length, 64);
});

test('live per-workflow settings update runtime and the saved profile config', async () => {
  const root = await temp('bridge-settings-');
  const configPath = path.join(root, 'workflow.json');
  const runtime = {
    id: 'workflow-1',
    configPath,
    config: {
      version: 1, id: 'workflow-1', preset: 'fix-until-pass', projectRoot: root,
      ux: { sessionExhaustion: 'start-new-chat', session: { maxTurns: 40 }, notifications: {}, checks: {} },
      resultProtocol: {}, remediation: {}, automation: { maxCycles: 8, noProgressLimit: 3 },
      commit: { mode: 'block', policy: {} },
    },
  };
  let invalidated = 0;
  const service = new WorkflowSettingsService({ persistRuntime: async () => {}, invalidateNotifications: () => { invalidated += 1; } });
  await service.apply(runtime, {
    sessionExhaustion: 'ask', session: { maxTurns: 12 }, invalidResponseAction: 'ask', invalidResponseAttempts: 1,
    notifications: { enabled: false }, commits: { mode: 'disabled', iterationStrategy: 'final-only', completionStrategy: 'squash', includeOnlyWorkflowChanges: true },
    checks: { maxAttempts: 5, noProgressLimit: 2 },
  });
  assert.equal(runtime.config.ux.sessionExhaustion, 'ask');
  assert.equal(runtime.config.ux.session.maxTurns, 12);
  assert.equal(runtime.config.commit.mode, 'none');
  assert.equal(runtime.config.automation.maxCycles, 5);
  assert.equal(invalidated, 1);
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(saved.configPath, undefined);
  assert.equal(saved.ux.notifications.enabled, false);
});

test('workflow session turn limit uses the configured recovery policy', async () => {
  const runtime = {
    id: 'workflow-1',
    config: { watch: { sessionId: 'session-1', clientId: 'client-1' }, ux: { session: { maxTurns: 2 } }, automation: {} },
    boundSessionId: '', boundSourceClientId: '', workflowTurnSessionId: 'session-1', workflowTurnCount: 2,
  };
  const service = new WorkflowSessionService({ persistRuntime: async () => {} });
  service.recover = async (_runtime, context) => {
    assert.equal(context.error.code, 'WORKFLOW_SESSION_TURN_LIMIT');
    return { recovered: true, sessionId: 'session-2', sourceClientId: 'client-2' };
  };
  const prepared = await service.prepareRequest(runtime, {});
  assert.equal(prepared.sessionId, 'session-2');
  assert.equal(prepared.turn, 1);
  assert.equal(runtime.workflowTurnSessionId, 'session-2');
});

test('Apply Changes routes failed post-apply checks into a user decision instead of automatic remediation', async () => {
  const root = await temp('bridge-apply-check-route-');
  const validationError = Object.assign(new Error('Post-apply command failed'), {
    code: 'WORKFLOW_VALIDATION_FAILED',
    workflowApply: { applied: { written: [], deleted: [] }, commands: { results: [] }, rollback: { skipped: true }, manifest: [] },
  });
  let captured = null;
  let remediationCalls = 0;
  const service = new WorkflowApplyVerifiedService({
    applier: { apply: async () => { throw validationError; } },
    extensionDeployer: {},
    commitService: {},
    checkFailureService: { capture: async (...args) => { captured = args; return { status: 'checks-failed' }; } },
    applyCompletionService: {},
    resultRepairService: { remediate: async () => { remediationCalls += 1; } },
    store: {}, transition: async () => {}, publish: async () => {}, refresh: () => {},
  });
  const runtime = {
    id: 'workflow-1', workflowCommitPathStates: {},
    config: {
      preset: 'apply-changes', projectRoot: root,
      commit: { mode: 'none' }, extensionUpdate: { enabled: false },
      remediation: { enabled: false, maxAttempts: 2 }, watch: { clientId: '' },
    },
  };
  const result = await service.apply(runtime, {
    pipelineId: 'pipeline-1', artifactKey: 'artifact-1', response: {}, verification: {}, remediationAttempt: 0,
    plan: { plan: { written: [{ path: 'app.js' }], delete: [], localChangedDelete: [] } },
  });
  assert.equal(result.status, 'checks-failed');
  assert.equal(captured[0], runtime);
  assert.deepEqual(captured[3].workflowPaths, ['app.js']);
  assert.equal(remediationCalls, 0);
});

test('failed checks after Apply Changes create an attention decision with required actions', async () => {
  const root = await temp('bridge-check-failure-');
  await fs.writeFile(path.join(root, 'app.js'), 'changed\n');
  const transitions = [];
  const artifacts = new Map([['artifact-1', {}]]);
  const service = new WorkflowCheckFailureService({
    store: {
      getArtifact: async (key) => artifacts.get(key),
      setArtifact: async (key, value) => artifacts.set(key, value),
    },
    persistRuntime: async () => {},
    transition: async (...args) => transitions.push(args),
  });
  const runtime = {
    id: 'workflow-1',
    config: { projectRoot: root, commit: { policy: { includeOnlyWorkflowChanges: true } } },
    workflowCommitPaths: [], workflowCommitPathStates: {},
  };
  const error = Object.assign(new Error('Post-apply command failed'), {
    code: 'WORKFLOW_VALIDATION_FAILED',
    commandResults: [{ command: 'npm test', ok: false, code: 1, stdout: '', stderr: 'failed' }],
    workflowApply: { manifest: [{ path: 'app.js', exists: true }], commands: { results: [] }, rollback: { skipped: true } },
  });
  const result = await service.capture(runtime, {
    pipelineId: 'pipeline-1', artifactKey: 'artifact-1', verification: {}, response: {},
  }, error, { workflowPaths: ['app.js'], preApplyGit: { head: 'abc' }, appliedSummary: { written: ['app.js'] } });
  assert.equal(result.status, 'checks-failed');
  assert.equal(runtime.pendingCheckFailure.commands[0].command, 'npm test');
  assert.equal(transitions[0][3], 'workflow.checks.failed.after-apply');
  const attention = attentionForWorkflowEvent('workflow-1', 'workflow.checks.failed.after-apply', { approvalId: 'approval-1', message: error.message });
  assert.deepEqual(attentionActions({ attention }), [
    'Ask ChatGPT to fix the failures',
    'Keep the changes and stop',
    'Revert this workflow update',
    'Review the test output',
  ]);
});

test('reverting a failed Apply Changes update restores earlier workflow ownership state', async () => {
  const runtime = {
    id: 'workflow-1',
    config: { projectRoot: '/tmp/project' },
    workflowCommitPaths: ['app.js', 'new.js'],
    workflowCommitPathStates: { 'app.js': { sha256: 'new' }, 'new.js': { sha256: 'new-file' } },
    pendingCheckFailure: {
      id: 'decision-1', pipelineId: 'pipeline-1', artifactKey: 'artifact-1', workflowPaths: ['app.js', 'new.js'],
      previousWorkflowPaths: ['app.js'], previousPathStates: { 'app.js': { sha256: 'previous' } }, rollbackManifest: [],
    },
  };
  const service = new WorkflowCheckFailureService({
    applier: { rollback: async () => ({ ok: true, errors: [] }) },
    store: { getArtifact: async () => ({}), setArtifact: async () => {} },
    persistRuntime: async () => {}, transition: async () => {},
  });
  await service.revert(runtime);
  assert.deepEqual(runtime.workflowCommitPaths, ['app.js']);
  assert.deepEqual(runtime.workflowCommitPathStates, { 'app.js': { sha256: 'previous' } });
});

test('failed Apply Changes decision can enable and start the shared fix loop', async () => {
  let runEnabled = false;
  const runtime = {
    id: 'workflow-1',
    config: { automation: { enabled: false } },
    pendingCheckFailure: { pipelineId: 'pipeline-1', artifactKey: 'artifact-1' },
  };
  let configPersisted = false;
  const service = new WorkflowCheckFailureService({
    persistRuntime: async () => {},
    persistConfig: async (value) => { configPersisted = value.config.automation.enabled; },
    applyCompletionService: { complete: async () => ({ completed: true }) },
    runAutomation: async (value) => { runEnabled = value.config.automation.enabled; return { started: true }; },
  });
  const result = await service.startFixLoop(runtime);
  assert.equal(runtime.config.automation.enabled, true);
  assert.equal(runEnabled, true);
  assert.equal(configPersisted, true);
  assert.deepEqual(result, { started: true });
});

test('per-workflow notification override can disable global notifications', async () => {
  const dataDir = await temp('bridge-notification-override-');
  const global = defaultGlobalWorkflowConfig();
  global.defaults.notifications.enabled = true;
  global.defaults.notifications.desktop = true;
  await saveGlobalWorkflowConfig(global, { dataDir });
  const writes = [];
  const runs = [];
  const service = new WorkflowNotificationService({
    dataDir, platform: 'linux', output: { isTTY: true, write: (value) => writes.push(value) },
    run: async (...args) => runs.push(args),
  });
  const result = await service.notify({
    key: 'workflow-1:attention', title: 'Attention', body: 'Choose',
    config: { enabled: false },
  });
  assert.equal(result.reason, 'disabled');
  assert.deepEqual(writes, []);
  assert.deepEqual(runs, []);
});

test('saved workflow profiles can retain the active check commands', () => {
  const snapshot = publicWorkflowSnapshot({
    id: 'workflow-1', configPath: '/tmp/workflow.json', loadedAt: '', updatedAt: '',
    config: {
      preset: 'fix-until-pass', projectRoot: '/tmp/project', watch: { mode: 'auto', clientId: '', sessionId: '' },
      ux: {}, resultProtocol: {}, commit: { policy: {} },
      automation: { session: {}, restartPolicy: 'ask', maxCycles: 8, noProgressLimit: 3, steps: [{ command: 'npm test' }, { command: 'npm run check' }] },
    },
    workflowState: { schemaVersion: 1, revision: 0, watcher: {}, pipeline: {}, automation: {} },
  });
  assert.deepEqual(snapshot.checks, ['npm test', 'npm run check']);
});

test('legacy workflow definitions are mapped to presets when the intent is deterministic', async () => {
  const root = await temp('bridge-legacy-preset-');
  const applyPath = path.join(root, 'apply.json');
  await fs.writeFile(applyPath, JSON.stringify({ version: 1, id: 'apply', projectRoot: root, watch: { mode: 'auto' } }));
  assert.equal((await loadWorkflowConfig(applyPath)).preset, 'apply-changes');

  const fixPath = path.join(root, 'fix.json');
  await fs.writeFile(fixPath, JSON.stringify({
    version: 1, id: 'fix', projectRoot: root, watch: { mode: 'ask' },
    automation: { enabled: true, steps: ['npm test'] },
  }));
  assert.equal((await loadWorkflowConfig(fixPath)).preset, 'fix-until-pass');
});
