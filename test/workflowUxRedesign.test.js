import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeZip } from '../src/zipWriter.js';
import {
  defaultGlobalWorkflowConfig,
  loadGlobalWorkflowConfig,
  resolveWorkflowDefaults,
  saveGlobalWorkflowConfig,
  validateGlobalWorkflowConfig,
} from '../src/workflow/ux/globalConfig.js';
import { detectProjectChecks } from '../src/workflow/ux/checkDetection.js';
import { WORKFLOW_PRESETS, buildPresetWorkflowConfig } from '../src/workflow/ux/presets.js';
import { WorkflowWizardController } from '../src/workflow/ux/workflowWizard.js';
import { desktopNotificationCommand, WorkflowNotificationService } from '../src/workflow/attention/notificationService.js';
import { attentionActions, attentionForWorkflowEvent } from '../src/workflow/attention/attentionState.js';
import { validateWorkflowResultProtocol } from '../src/workflow/result/resultProtocol.js';
import { buildWorkflowHandoff, isSessionExhaustionError, workflowInstructionText } from '../src/workflow/session/bootstrap.js';
import { TransactionalApplier } from '../src/workflow/transaction.js';
import { createGitCommit, restoreGitWorkflowState } from '../src/workflow/gitCommit.js';
import { runGuidedWorkflow } from '../src/interactive/guidedWorkflowRuntime.js';

const execFileAsync = promisify(execFile);

async function temporaryRoot(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function protocolWorkflow(overrides = {}) {
  return {
    id: 'workflow-1',
    projectId: 'project-1',
    projectRoot: '/tmp/project',
    artifact: { maxEntries: 100, maxExtractedBytes: 10_000_000 },
    resultProtocol: { required: true, manifest: 'bridge-result.json', requireCommitMessage: true },
    apply: {
      sync: false,
      protectedPaths: [],
      allowedWarningCodes: [],
      maxChangedFiles: 100,
      maxDeletedFiles: 100,
      requireCleanGit: false,
      commands: [],
      timeoutMs: 1_000,
      rollbackOnFailure: true,
    },
    ...overrides,
  };
}

test('global workflow configuration is stable, editable JSON and preserves unknown fields', async () => {
  const dataDir = await temporaryRoot('bridge-workflow-config-');
  const config = defaultGlobalWorkflowConfig();
  config.customExtension = { enabled: true };
  config.defaults.notifications.desktop = false;
  const saved = await saveGlobalWorkflowConfig(config, { dataDir });
  const text = await fs.readFile(saved.path, 'utf8');
  assert.match(text, /^\{\n  "version": 1,/);
  assert.equal(text.endsWith('\n'), true);
  const loaded = await loadGlobalWorkflowConfig({ dataDir });
  assert.deepEqual(loaded.config.customExtension, { enabled: true });
  assert.equal(loaded.config.defaults.notifications.desktop, false);
});

test('invalid workflow configuration reports the exact JSON path', () => {
  const config = defaultGlobalWorkflowConfig();
  config.defaults.commits.mode = 'sometimes';
  assert.throws(
    () => validateGlobalWorkflowConfig(config),
    (error) => error.code === 'WORKFLOW_GLOBAL_CONFIG_INVALID' && error.path === '$.defaults.commits.mode',
  );
});

test('per-workflow defaults override profile and global values without discarding nested defaults', () => {
  const global = defaultGlobalWorkflowConfig();
  const resolved = resolveWorkflowDefaults(global, {
    defaults: { commits: { mode: 'ask' }, checks: { maxAttempts: 4 } },
  }, {
    notifications: { desktop: false },
  });
  assert.equal(resolved.commits.mode, 'ask');
  assert.equal(resolved.commits.completionStrategy, 'squash');
  assert.equal(resolved.checks.maxAttempts, 4);
  assert.equal(resolved.checks.noProgressLimit, 3);
  assert.equal(resolved.notifications.desktop, false);
  assert.equal(resolved.notifications.terminalBell, true);
});

test('project check detection finds friendly Node and Make commands', async () => {
  const root = await temporaryRoot('bridge-check-detection-');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', check: 'eslint .', build: 'node build.js' } }));
  await fs.writeFile(path.join(root, 'Makefile'), 'check:\n\t@true\n');
  const checks = await detectProjectChecks(root);
  assert.equal(checks.some((item) => item.label === 'Run all tests' && item.command === 'npm test' && item.selected), true);
  assert.equal(checks.some((item) => item.label === 'Check code quality' && item.command === 'npm run check'), true);
  assert.equal(checks.some((item) => item.label === 'Build the project' && item.command === 'npm run build'), true);
  assert.equal(checks.some((item) => item.label === 'Run Make checks' && item.command === 'make check'), true);
});

test('first workflow run asks for global recovery, commit, iteration, and notification defaults', () => {
  const wizard = new WorkflowWizardController({ invalidate() {} });
  wizard.global = { firstRun: true, config: defaultGlobalWorkflowConfig() };
  wizard.draft = { checks: [] };
  wizard.showSummary = WorkflowWizardController.prototype.showSummary.bind(wizard);
  wizard.draft = { preset: 'fix-until-pass', chat: { mode: 'current' }, projectRoot: '/tmp/project', checks: [] };
  wizard.afterChecks();
  assert.equal(wizard.screen.id, 'summary');
  assert.equal(wizard.screen.options[0].label, 'Start with these recommended global defaults');
  assert.equal(wizard.screen.options[1].label, 'Customize global defaults');

  wizard.showFirstRunCommits = WorkflowWizardController.prototype.showFirstRunCommits.bind(wizard);
  wizard.showFirstRunCommits();
  wizard.screen.options[0].action();
  assert.equal(wizard.screen.id, 'default-iteration-commits');
  wizard.screen.options[2].action();
  assert.equal(wizard.global.config.defaults.commits.mode, 'automatic');
  assert.equal(wizard.global.config.defaults.commits.iterationStrategy, 'final-only');
  assert.equal(wizard.screen.id, 'default-notifications');
});

test('workflow wizard exposes exactly the three public presets and maps them to the shared runner', async () => {
  assert.deepEqual(WORKFLOW_PRESETS.map((item) => item.id), ['apply-changes', 'fix-until-pass', 'guided-task']);
  const projectRoot = await temporaryRoot('bridge-preset-project-');
  const defaults = defaultGlobalWorkflowConfig().defaults;
  const fix = await buildPresetWorkflowConfig({
    preset: 'fix-until-pass', projectRoot, checks: ['npm test'], defaults, chat: { mode: 'new' },
  });
  assert.equal(fix.preset, 'fix-until-pass');
  assert.equal(fix.automation.enabled, true);
  assert.equal(fix.automation.steps[0].command, 'npm test');
  assert.equal(fix.automation.session.policy, 'new');
  assert.equal(fix.resultProtocol.required, true);
  const guided = await buildPresetWorkflowConfig({ preset: 'guided-task', projectRoot, defaults, chat: { mode: 'current' } });
  assert.equal(guided.automation.enabled, false);
  assert.equal(guided.ux.guidedFocused, true);
  assert.equal(guided.resultProtocol.allowTextOnly, true);
});

test('result protocol rejects patch payloads and private package-lock registries', async () => {
  const root = await temporaryRoot('bridge-result-protocol-');
  const zipPath = path.join(root, 'result.zip');
  const manifest = {
    version: 1,
    status: 'changed',
    summary: 'Changed a file',
    commitMessage: 'Change a file',
    files: ['src/app.js'],
  };
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'package-lock.json'), '{"resolved":"https://packages.hub.ace-research.openai.org/pkg.tgz"}');
  await writeZip(zipPath, [
    { name: 'bridge-result.json', data: Buffer.from(JSON.stringify(manifest)) },
    { name: 'src/app.js', data: Buffer.from('export const value = 2;\n') },
    { name: 'notes.patch', data: Buffer.from('diff --git a/a b/a') },
    { name: 'package-lock.json', data: await fs.readFile(path.join(root, 'package-lock.json')) },
  ]);
  const result = await validateWorkflowResultProtocol({
    workflow: protocolWorkflow(),
    zipPath,
    stagingRoot: root,
    outputFiles: ['bridge-result.json', 'src/app.js', 'notes.patch', 'package-lock.json'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasons.some((reason) => reason.includes('unsupported patch file')), true);
  assert.equal(result.reasons.some((reason) => reason.includes('private or internal registry')), true);
});

test('transactional workflow planning excludes result manifest and Bridge metadata from project writes', async () => {
  const projectRoot = await temporaryRoot('bridge-control-file-project-');
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'src', 'app.js'), 'old\n');
  const root = await temporaryRoot('bridge-control-file-result-');
  const zipPath = path.join(root, 'result.zip');
  await writeZip(zipPath, [
    { name: 'project/src/app.js', data: Buffer.from('new\n') },
    { name: 'project/bridge-result.json', data: Buffer.from('{}') },
    { name: 'project/.bridge/internal.json', data: Buffer.from('{}') },
    { name: 'project/bridge-workflow-instructions.md', data: Buffer.from('control file') },
  ]);
  const workflow = protocolWorkflow({ projectRoot });
  const applier = new TransactionalApplier({ dataDir: await temporaryRoot('bridge-control-file-data-') });
  const plan = await applier.plan({ workflow, verification: { zipPath } });
  assert.deepEqual(plan.plan.written.map((item) => item.path), ['src/app.js']);
  assert.equal(plan.plan.skippedPreview.some((item) => item.path === 'bridge-result.json' && item.reason === 'excluded-control-file'), true);
  assert.equal(plan.plan.skippedPreview.some((item) => item.path === 'bridge-workflow-instructions.md' && item.reason === 'excluded-control-file'), true);
  assert.equal(plan.plan.skippedPreview.some((item) => item.targetPath === '.bridge/internal.json' && item.reason === 'bridge-metadata'), true);
  await applier.apply({ workflow, verification: { zipPath }, plan, pipelineId: 'pipeline-1' });
  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'app.js'), 'utf8'), 'new\n');
  await assert.rejects(fs.stat(path.join(projectRoot, 'bridge-result.json')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(projectRoot, '.bridge', 'internal.json')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(projectRoot, 'bridge-workflow-instructions.md')), /ENOENT/);
});

test('notifications use native best-effort commands and deduplicate unresolved attention', async () => {
  assert.equal(desktopNotificationCommand('darwin', { title: 'Title', body: 'Body' }).command, 'osascript');
  assert.equal(desktopNotificationCommand('linux', { title: 'Title', body: 'Body' }).command, 'notify-send');
  assert.equal(desktopNotificationCommand('win32', { title: 'Title', body: 'Body' }).command, 'powershell');
  const dataDir = await temporaryRoot('bridge-notification-');
  const config = defaultGlobalWorkflowConfig();
  config.defaults.notifications.desktop = true;
  config.defaults.notifications.reminderIntervalMs = 10_000;
  await saveGlobalWorkflowConfig(config, { dataDir });
  const writes = [];
  const runs = [];
  let current = 100;
  const service = new WorkflowNotificationService({
    dataDir,
    platform: 'linux',
    output: { isTTY: true, write: (value) => writes.push(value) },
    run: async (...args) => { runs.push(args); },
    clock: () => current,
  });
  const first = await service.notify({ key: 'same-state', title: 'Needs attention', body: 'Choose an action' });
  const second = await service.notify({ key: 'same-state', title: 'Needs attention', body: 'Choose an action' });
  current += 10_001;
  const reminder = await service.notify({ key: 'same-state', title: 'Needs attention', body: 'Choose an action' });
  assert.equal(first.notified, true);
  assert.equal(second.reason, 'deduplicated');
  assert.equal(reminder.notified, true);
  assert.deepEqual(writes, ['\u0007', '\u0007']);
  assert.equal(runs.length, 2);
});

test('attention states expose context-specific actions instead of extra commands', () => {
  const noProgress = attentionForWorkflowEvent('wf', 'workflow.no-progress', { attempt: 3, message: 'Same failures remained' });
  assert.equal(noProgress.required, true);
  assert.equal(noProgress.kind, 'no-progress');
  assert.deepEqual(attentionActions({ attention: noProgress }), [
    'Ask ChatGPT to try a different approach',
    'Review current changes',
    'Continue anyway',
    'Stop and restore the starting state',
  ]);
  const commit = attentionForWorkflowEvent('wf', 'workflow.commit.approval.required', { approvalId: 'a1' });
  assert.equal(attentionActions({ attention: commit })[0], 'Create this commit');
});

test('session recovery helpers detect exhaustion and create a self-contained handoff', () => {
  assert.equal(isSessionExhaustionError(new Error('The conversation is too long to continue')), true);
  assert.equal(isSessionExhaustionError(new Error('Temporary network error')), false);
  const workflow = protocolWorkflow({ preset: 'fix-until-pass', ux: { label: 'Fix project checks' } });
  const instructions = workflowInstructionText(workflow);
  assert.match(instructions, /bridge-result\.json/);
  assert.match(instructions, /complete files, not patch or diff files/);
  const handoff = buildWorkflowHandoff({
    workflow,
    automation: { status: 'run-checks', cycle: 3, maxCycles: 8 },
    failingChecks: ['npm test'],
    conclusions: ['The parser is still failing'],
  });
  assert.match(handoff, /Attempt: 3 of 8/);
  assert.match(handoff, /npm test/);
  assert.match(handoff, /only current source of truth/);
});


test('guided task sends returned artifacts through the shared workflow result pipeline', async () => {
  const calls = [];
  const response = {
    requestId: 'request-1',
    turnKey: 'turn-1',
    answer: 'I returned the requested changes.',
    artifacts: [{ id: 'artifact-1', name: 'result.zip' }],
    session: { id: 'session-1' },
    sourceClientId: 'client-1',
  };
  const workflow = {
    id: 'workflow-1',
    preset: 'guided-task',
    label: 'Work through a task',
    sessionId: 'session-1',
    clientId: 'client-1',
  };
  const runtime = {
    options: {
      bridge: {
        health: () => ({ ok: true, activeClient: { id: 'client-1' } }),
        canAutoOpenPromptTab: () => false,
        sendRequest: async () => response,
      },
      workflowManager: {
        prepareWorkflowRequest: async () => ({ sessionId: 'session-1', sourceClientId: 'client-1' }),
        refreshProjectContext: async () => ({ synced: false, reason: 'already-synced' }),
        processResponse: async (workflowId, value, context) => {
          calls.push({ workflowId, value, context });
          return { status: 'pending-approval' };
        },
        get: () => ({ ...workflow, attention: { required: true } }),
      },
    },
    state: {
      pendingAttachments: [],
      model: '',
      effort: '',
      sessionId: 'session-1',
      projectRoot: '/tmp/project',
      projectId: 'project-1',
      projectThreadId: '',
      enabledSkills: [],
      responseHistory: [],
      inputHistories: {},
      scopes: {},
      focusedWorkflowId: workflow.id,
    },
    workflowWizard: {
      openForWorkflow: async (workflowId) => calls.push({ opened: workflowId }),
      showGuidedResponse: () => calls.push({ shown: true }),
    },
    clearLive() {},
    resetActivity() {},
    pushEntry() {},
    onChatEvent() {},
    updateAssistantStream() {},
    onArtifactUpdate() {},
    flushActivitySummary() {},
    completeAssistantStream() {},
    failAssistantStream() {},
    invalidate() {},
  };

  await runGuidedWorkflow(runtime, 'Please update the project', workflow);

  assert.equal(calls[0].workflowId, workflow.id);
  assert.equal(calls[0].value, response);
  assert.deepEqual(calls[0].context, { source: 'guided-task', remediationAttempt: 0 });
  assert.deepEqual(calls.at(-1), { opened: workflow.id });
  assert.equal(calls.some((item) => item.shown), false);
});


test('workflow restore rewinds only workflow-owned commits and preserves unrelated local work', async () => {
  const root = await temporaryRoot('bridge-workflow-restore-');
  const git = async (...args) => (await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim();
  await git('init');
  await git('config', 'user.name', 'Bridge Tests');
  await git('config', 'user.email', 'bridge-tests@example.com');
  await fs.writeFile(path.join(root, 'app.js'), 'original\n');
  await fs.writeFile(path.join(root, 'notes.txt'), 'user baseline\n');
  await git('add', 'app.js', 'notes.txt');
  await git('commit', '-m', 'Initial state');
  const baseSha = await git('rev-parse', 'HEAD');

  await fs.writeFile(path.join(root, 'app.js'), 'workflow update\n');
  await fs.writeFile(path.join(root, 'created.js'), 'created by workflow\n');
  const checkpoint = await createGitCommit({
    root,
    message: 'Workflow checkpoint',
    paths: ['app.js', 'created.js'],
  });
  assert.equal(checkpoint.committed, true);
  await fs.writeFile(path.join(root, 'notes.txt'), 'unrelated user edit\n');

  const restored = await restoreGitWorkflowState({
    root,
    baseSha,
    commitShas: [checkpoint.sha],
    paths: ['app.js', 'created.js'],
    refName: 'workflow-1',
  });

  assert.equal(restored.restored, true);
  assert.equal(restored.rewound, true);
  assert.equal(await git('rev-parse', 'HEAD'), baseSha);
  assert.equal(await fs.readFile(path.join(root, 'app.js'), 'utf8'), 'original\n');
  await assert.rejects(fs.stat(path.join(root, 'created.js')), /ENOENT/);
  assert.equal(await fs.readFile(path.join(root, 'notes.txt'), 'utf8'), 'unrelated user edit\n');
});
