import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  defaultGlobalWorkflowConfig,
  defaultGlobalWorkflowConfigPath,
  findWorkflowProfile,
  loadGlobalWorkflowConfig,
  mergeGlobalWorkflowConfig,
  resolveWorkflowDefaults,
  saveGlobalWorkflowConfig,
  updateGlobalWorkflowProfile,
  validateGlobalWorkflowConfig,
} from '../src/workflow/ux/globalConfig.js';
import { detectProjectChecks } from '../src/workflow/ux/checkDetection.js';
import { WORKFLOW_PRESETS, buildPresetWorkflowConfig, writePresetWorkflowConfig } from '../src/workflow/ux/presets.js';
import { attentionActions, attentionForWorkflowEvent } from '../src/workflow/attention/attentionState.js';
import { acknowledgeWorkflowAttention } from '../src/workflow/attention/attentionAcknowledge.js';
import { desktopNotificationCommand, WorkflowNotificationService } from '../src/workflow/attention/notificationService.js';

async function temporaryRoot(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function invalidAt(mutator, expectedPath) {
  const config = defaultGlobalWorkflowConfig();
  mutator(config);
  assert.throws(
    () => validateGlobalWorkflowConfig(config),
    (error) => error.code === 'WORKFLOW_GLOBAL_CONFIG_INVALID' && error.path === expectedPath,
  );
}

test('global workflow config validation covers every public setting family', () => {
  const cases = [
    [(config) => { config.version = 2; }, '$.version'],
    [(config) => { config.defaults = []; }, '$.defaults'],
    [(config) => { config.defaults.sessionExhaustion = 'later'; }, '$.defaults.sessionExhaustion'],
    [(config) => { config.defaults.session = null; }, '$.defaults.session'],
    [(config) => { config.defaults.session.maxTurns = 0; }, '$.defaults.session.maxTurns'],
    [(config) => { config.defaults.invalidResponseAction = 'retry-forever'; }, '$.defaults.invalidResponseAction'],
    [(config) => { config.defaults.invalidResponseAttempts = -1; }, '$.defaults.invalidResponseAttempts'],
    [(config) => { config.defaults.notifications = []; }, '$.defaults.notifications'],
    [(config) => { config.defaults.notifications.enabled = 'yes'; }, '$.defaults.notifications.enabled'],
    [(config) => { config.defaults.notifications.terminalBell = 1; }, '$.defaults.notifications.terminalBell'],
    [(config) => { config.defaults.notifications.desktop = null; }, '$.defaults.notifications.desktop'],
    [(config) => { config.defaults.notifications.reminderIntervalMs = -1; }, '$.defaults.notifications.reminderIntervalMs'],
    [(config) => { config.defaults.commits = null; }, '$.defaults.commits'],
    [(config) => { config.defaults.commits.mode = 'manual'; }, '$.defaults.commits.mode'],
    [(config) => { config.defaults.commits.iterationStrategy = 'every-file'; }, '$.defaults.commits.iterationStrategy'],
    [(config) => { config.defaults.commits.completionStrategy = 'rebase'; }, '$.defaults.commits.completionStrategy'],
    [(config) => { config.defaults.commits.includeOnlyWorkflowChanges = 'true'; }, '$.defaults.commits.includeOnlyWorkflowChanges'],
    [(config) => { config.defaults.checks = []; }, '$.defaults.checks'],
    [(config) => { config.defaults.checks.maxAttempts = 0; }, '$.defaults.checks.maxAttempts'],
    [(config) => { config.defaults.checks.noProgressLimit = 0; }, '$.defaults.checks.noProgressLimit'],
    [(config) => { config.profiles = []; }, '$.profiles'],
    [(config) => { config.profiles.bad = []; }, '$.profiles.bad'],
    [(config) => { config.profiles.bad = { preset: 'custom' }; }, '$.profiles.bad.preset'],
    [(config) => { config.profiles.bad = { project: 3 }; }, '$.profiles.bad.project'],
    [(config) => { config.profiles.bad = { checks: ['npm test', 2] }; }, '$.profiles.bad.checks'],
    [(config) => { config.profiles.bad = { defaults: [] }; }, '$.profiles.bad.defaults'],
    [(config) => { config.profiles.bad = { defaults: { checks: { maxAttempts: 0 } } }; }, '$.defaults.checks.maxAttempts'],
  ];
  for (const [mutator, expectedPath] of cases) invalidAt(mutator, expectedPath);
  assert.throws(() => validateGlobalWorkflowConfig(null), (error) => error.path === '$');
});

test('global workflow config loading handles first run, creation, parse errors, and atomic updates', async () => {
  const dataDir = await temporaryRoot('bridge-global-config-coverage-');
  assert.equal(defaultGlobalWorkflowConfigPath(dataDir), path.join(dataDir, 'workflows', 'config.json'));

  const missing = await loadGlobalWorkflowConfig({ dataDir });
  assert.equal(missing.exists, false);
  assert.equal(missing.firstRun, true);
  await assert.rejects(fs.stat(missing.path), /ENOENT/);

  const created = await loadGlobalWorkflowConfig({ dataDir, create: true });
  assert.equal(created.exists, false);
  assert.equal(JSON.parse(await fs.readFile(created.path, 'utf8')).version, 1);

  await fs.writeFile(created.path, '{broken json\n', 'utf8');
  await assert.rejects(
    () => loadGlobalWorkflowConfig({ dataDir }),
    (error) => error.code === 'WORKFLOW_GLOBAL_CONFIG_PARSE_ERROR' && error.message.includes(created.path),
  );

  const config = defaultGlobalWorkflowConfig();
  config.unknownTopLevel = { preserved: true };
  const saved = await saveGlobalWorkflowConfig(config, { dataDir });
  assert.equal((await fs.readFile(saved.path, 'utf8')).endsWith('\n'), true);
  assert.deepEqual((await loadGlobalWorkflowConfig({ dataDir })).config.unknownTopLevel, { preserved: true });
  assert.deepEqual((await fs.readdir(path.dirname(saved.path))).filter((item) => item.includes('.tmp-')), []);
});

test('workflow profiles can be found, updated, merged, and overridden deterministically', async () => {
  const dataDir = await temporaryRoot('bridge-global-profile-coverage-');
  const projectRoot = path.join(dataDir, 'project');
  const global = defaultGlobalWorkflowConfig();
  global.defaults.notifications.desktop = true;
  await saveGlobalWorkflowConfig(global, { dataDir });
  await updateGlobalWorkflowProfile('repair-profile', {
    preset: 'fix-until-pass',
    project: projectRoot,
    checks: ['npm test'],
    defaults: { notifications: { desktop: false }, checks: { maxAttempts: 4 } },
  }, { dataDir });

  const loaded = (await loadGlobalWorkflowConfig({ dataDir })).config;
  assert.equal(findWorkflowProfile(loaded, { id: 'repair-profile' }).name, 'repair-profile');
  assert.equal(findWorkflowProfile(loaded, { preset: 'fix-until-pass', project: `${projectRoot}/.` }).name, 'repair-profile');
  assert.equal(findWorkflowProfile(loaded, { preset: 'guided-task', project: projectRoot }), null);

  const resolved = resolveWorkflowDefaults(loaded, loaded.profiles['repair-profile'], {
    checks: { noProgressLimit: 2 },
    notifications: { terminalBell: false },
  });
  assert.equal(resolved.checks.maxAttempts, 4);
  assert.equal(resolved.checks.noProgressLimit, 2);
  assert.equal(resolved.notifications.desktop, false);
  assert.equal(resolved.notifications.terminalBell, false);
  assert.equal(mergeGlobalWorkflowConfig({ defaults: { session: { maxTurns: 7 } } }).defaults.session.maxTurns, 7);
});

test('project check detection covers Node, Python, Rust, Go, PHP, Make, workspaces, and saved checks', async () => {
  const root = await temporaryRoot('bridge-check-detection-coverage-');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: {
    test: 'node --test', lint: 'eslint .', build: 'node build.js', 'type-check': 'tsc --noEmit',
  } }));
  await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nname="sample"\n');
  await fs.writeFile(path.join(root, 'pytest.ini'), '[pytest]\n');
  await fs.writeFile(path.join(root, 'Cargo.toml'), '[package]\nname="sample"\n');
  await fs.writeFile(path.join(root, 'go.mod'), 'module example.test/sample\n');
  await fs.writeFile(path.join(root, 'composer.json'), JSON.stringify({ scripts: { test: 'phpunit' } }));
  await fs.writeFile(path.join(root, 'Makefile'), 'test:\n\t@true\ncheck:\n\t@true\nbuild:\n\t@true\n');
  await fs.writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  await fs.writeFile(path.join(root, 'bridge.workflow.json'), JSON.stringify({ automation: { steps: [
    'custom-check', { name: 'Saved validation', command: 'saved-check' }, { name: 'Duplicate', command: 'npm test' },
  ] } }));

  const checks = await detectProjectChecks(root);
  const commands = checks.map((item) => item.command);
  assert.deepEqual(new Set(commands).size, commands.length, 'commands are deduplicated');
  for (const command of [
    'npm test', 'npm run lint', 'npm run build', 'npm run type-check', 'python -m pytest',
    'cargo test', 'cargo check', 'go test ./...', 'composer test', 'make test', 'make check', 'make build',
    'custom-check', 'saved-check',
  ]) assert.equal(commands.includes(command), true, command);
  assert.equal(commands.filter((item) => item === 'npm test').length, 1, 'workspace discovery does not duplicate npm test');
  assert.equal(checks.find((item) => item.command === 'custom-check').selected, true);

  const empty = await temporaryRoot('bridge-check-detection-empty-');
  await fs.writeFile(path.join(empty, 'package.json'), '{not json');
  assert.deepEqual(await detectProjectChecks(empty), []);
});

test('preset configs encode each public mode and every global policy', async () => {
  const root = await temporaryRoot('bridge-preset-coverage-');
  const defaults = defaultGlobalWorkflowConfig().defaults;
  defaults.sessionExhaustion = 'ask';
  defaults.session.maxTurns = 9;
  defaults.invalidResponseAction = 'ask';
  defaults.invalidResponseAttempts = 0;
  defaults.commits.mode = 'ask';
  defaults.commits.iterationStrategy = 'final-only';
  defaults.commits.completionStrategy = 'keep-checkpoints';
  defaults.checks.maxAttempts = 5;
  defaults.checks.noProgressLimit = 2;

  const apply = await buildPresetWorkflowConfig({
    preset: 'apply-changes', projectRoot: root, checks: ['npm test'], defaults,
    chat: { mode: 'current', sessionId: 'c/current', clientId: 'client-1' },
    intelligence: { model: 'GPT-5.6 Thinking', effort: 'xhigh' }, id: 'Apply custom id',
  });
  assert.equal(apply.watch.mode, 'auto');
  assert.deepEqual(apply.apply.commands, ['npm test']);
  assert.equal(apply.apply.rollbackOnFailure, false);
  assert.deepEqual(apply.automation.session, { policy: 'pinned', id: 'c/current' });
  assert.equal(apply.resultProtocol.repairAttempts, 0);
  assert.equal(apply.commit.policy.mode, 'ask');
  assert.equal(apply.commit.policy.iterationStrategy, 'final-only');
  assert.equal(apply.automation.maxCycles, 5);
  assert.equal(apply.automation.noProgressLimit, 2);
  assert.deepEqual(apply.ux.intelligence, { model: 'GPT-5.6 Thinking', effort: 'xhigh' });
  assert.equal(apply.automation.turn.model, 'GPT-5.6 Thinking');
  assert.equal(apply.automation.turn.effort, 'xhigh');

  const fix = await buildPresetWorkflowConfig({
    preset: 'fix-until-pass', projectRoot: root, checks: ['npm test', 'npm run check'], defaults,
    chat: { mode: 'new' },
  });
  assert.equal(fix.automation.enabled, true);
  assert.deepEqual(fix.automation.steps.map((item) => item.command), ['npm test', 'npm run check']);
  assert.equal(fix.automation.session.policy, 'new');
  assert.equal(fix.remediation.enabled, false, 'ask policy does not silently repair');

  const guided = await buildPresetWorkflowConfig({ preset: 'guided-task', projectRoot: root, defaults, chat: {} });
  assert.equal(guided.watch.mode, 'ask');
  assert.equal(guided.resultProtocol.required, false);
  assert.equal(guided.resultProtocol.allowTextOnly, true);
  assert.equal(guided.ux.guidedFocused, true);

  const disabledDefaults = structuredClone(defaults);
  disabledDefaults.commits.mode = 'disabled';
  const disabled = await buildPresetWorkflowConfig({ preset: 'guided-task', projectRoot: root, defaults: disabledDefaults });
  assert.equal(disabled.commit.mode, 'none');
  assert.equal(disabled.resultProtocol.requireCommitMessage, false);

  assert.deepEqual(WORKFLOW_PRESETS.map((item) => item.id), ['apply-changes', 'fix-until-pass', 'guided-task']);
  await assert.rejects(() => buildPresetWorkflowConfig({ preset: 'unknown', projectRoot: root, defaults }), /Unknown workflow preset/);

  const written = await writePresetWorkflowConfig({ ...guided, id: 'unsafe workflow/id' }, { dataDir: root });
  assert.equal(path.basename(written), 'unsafe-workflow-id.json');
  assert.equal(JSON.parse(await fs.readFile(written, 'utf8')).preset, 'guided-task');
});

test('attention event mapping and action menus cover every required decision state', () => {
  const mappings = [
    ['workflow.approval.required', {}, 'confirmation'],
    ['workflow.automation.approval.required', {}, 'confirmation'],
    ['workflow.commit.approval.required', {}, 'commit-confirmation'],
    ['workflow.checks.failed.after-apply', {}, 'checks-failed'],
    ['workflow.result.repair.exhausted', {}, 'invalid-response'],
    ['workflow.no-progress', {}, 'no-progress'],
    ['workflow.session.exhausted.ask', {}, 'session-exhausted'],
    ['workflow.local-change.conflict', {}, 'local-conflict'],
    ['workflow.failed', {}, 'error'],
    ['workflow.automation.failed', { code: 'WORKFLOW_SESSION_AWAITING_DECISION' }, 'session-exhausted'],
    ['workflow.automation.failed', { code: 'WORKFLOW_NO_PROGRESS' }, 'no-progress'],
    ['workflow.automation.failed', { code: 'WORKFLOW_LOCAL_CHANGE_CONFLICT' }, 'local-conflict'],
    ['workflow.completed_with_warnings', {}, 'warning'],
  ];
  for (const [type, data, kind] of mappings) {
    const attention = attentionForWorkflowEvent('workflow-1', type, { ...data, message: 'Details', pipelineId: 'pipeline-1' });
    assert.equal(attention.kind, kind, type);
    assert.equal(attention.required, true);
    assert.match(attention.key, /^workflow-1:/);
  }
  for (const type of ['workflow.completed', 'workflow.automation.completed', 'workflow.guided.completed']) {
    const attention = attentionForWorkflowEvent('workflow-1', type, { commit: 'abc123' });
    assert.equal(attention.kind, 'completed');
    assert.equal(attention.required, false);
  }
  assert.equal(attentionForWorkflowEvent('workflow-1', 'workflow.progress', {}), null);

  const expectedCounts = {
    confirmation: 4, 'commit-confirmation': 4, 'checks-failed': 4, 'invalid-response': 4,
    'session-exhausted': 3, 'local-conflict': 4, 'no-progress': 4, paused: 2, error: 4, completed: 3,
  };
  for (const [kind, count] of Object.entries(expectedCounts)) {
    assert.equal(attentionActions({ attention: { kind } }).length, count, kind);
  }
  assert.deepEqual(attentionActions({ attention: { kind: 'warning' } }), []);
});

test('acknowledging an error clears sticky passive-workflow state and persists the watcher', async () => {
  const acknowledged = [];
  const persisted = [];
  const runtime = {
    attention: { key: 'workflow:error:preview', kind: 'error' },
    lastError: 'Artifact preview timed out',
    workflowState: { watcher: { status: 'running' } },
  };
  await acknowledgeWorkflowAttention(runtime, {
    notificationService: { acknowledge(key) { acknowledged.push(key); } },
    async persist(value) { persisted.push(value); },
  });
  assert.equal(runtime.attention, null);
  assert.equal(runtime.lastError, '');
  assert.deepEqual(acknowledged, ['workflow:error:preview']);
  assert.deepEqual(persisted, [runtime]);
});

test('desktop notification commands escape user content and unsupported platforms fall back safely', () => {
  const mac = desktopNotificationCommand('darwin', { title: 'A "title"', body: 'C:\\path\nnext' });
  assert.equal(mac.command, 'osascript');
  assert.match(mac.args[1], /A \\\"title\\\"/);
  assert.equal(mac.args[1].includes('\n'), false);

  const linux = desktopNotificationCommand('linux', { title: 'Title\nline', body: 'Body\r\nline' });
  assert.deepEqual(linux, { command: 'notify-send', args: ['Title line', 'Body line'] });

  const windows = desktopNotificationCommand('win32', { title: "It's ready", body: "User's choice" });
  assert.equal(windows.command, 'powershell');
  assert.match(windows.args.at(-1), /It''s ready/);
  assert.match(windows.args.at(-1), /User''s choice/);
  assert.equal(desktopNotificationCommand('freebsd', { title: 'Title', body: 'Body' }), null);
});

test('notification service handles disable, non-TTY, failures, force, reminders, acknowledgement, and config reload', async () => {
  const dataDir = await temporaryRoot('bridge-notification-coverage-');
  const config = defaultGlobalWorkflowConfig();
  config.defaults.notifications.reminderIntervalMs = 100;
  await saveGlobalWorkflowConfig(config, { dataDir });
  let current = 1_000;
  const writes = [];
  const runs = [];
  const service = new WorkflowNotificationService({
    dataDir,
    platform: 'linux',
    output: { isTTY: false, write: (value) => writes.push(value) },
    run: async (...args) => { runs.push(args); throw new Error('desktop unavailable'); },
    clock: () => current,
  });

  const disabled = await service.notify({ key: 'disabled', title: 'A', body: 'B', config: { enabled: false } });
  assert.equal(disabled.reason, 'disabled');

  const first = await service.notify({ key: 'state', title: 'A', body: 'B' });
  assert.equal(first.bell, false);
  assert.equal(first.desktop, false);
  assert.match(first.desktopError, /desktop unavailable/);
  assert.equal(first.notified, false);
  assert.equal(runs.length, 1);

  assert.equal((await service.notify({ key: 'state', title: 'A', body: 'B' })).reason, 'deduplicated');
  await service.notify({ key: 'state', title: 'A', body: 'B', force: true });
  assert.equal(runs.length, 2);
  service.acknowledge('state');
  await service.notify({ key: 'state', title: 'A', body: 'B' });
  assert.equal(runs.length, 3);

  current += 101;
  await service.notify({ key: 'state', title: 'A', body: 'B' });
  assert.equal(runs.length, 4);
  assert.deepEqual(writes, []);

  const changed = defaultGlobalWorkflowConfig();
  changed.defaults.notifications.enabled = false;
  await saveGlobalWorkflowConfig(changed, { dataDir });
  assert.notEqual((await service.notify({ key: 'cached', title: 'A', body: 'B' })).reason, 'disabled');
  service.invalidateConfig();
  assert.equal((await service.notify({ key: 'reloaded', title: 'A', body: 'B' })).reason, 'disabled');

  const tty = new WorkflowNotificationService({
    dataDir,
    platform: 'freebsd',
    output: { isTTY: true, write: (value) => writes.push(value) },
    run: async () => { throw new Error('must not run'); },
  });
  const bell = await tty.notify({ key: 'bell', title: 'A', body: 'B', config: { enabled: true, terminalBell: true, desktop: false } });
  assert.equal(bell.bell, true);
  assert.equal(writes.at(-1), '\u0007');
});
