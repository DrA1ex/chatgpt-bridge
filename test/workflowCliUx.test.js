import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseWorkflowCli, workflowSignalState } from '../src/cli/workflowRuntime.js';
import { loadWorkflowConfig } from '../src/workflow/config.js';
import { starterWorkflowConfig } from '../src/cli/workflowConfigCommands.js';
import { WorkflowAutomationController } from '../src/workflow/automation/controller.js';
import { WorkflowAutomationService } from '../src/workflow/automation/service.js';
import { createWorkflowState, reduceWorkflowState } from '../src/workflow/state/workflowState.js';

async function tempDir(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('workflow CLI parses fresh run, serve alias, and explicit session policies', () => {
  assert.deepEqual(parseWorkflowCli(['workflow', 'serve']), {
    action: 'serve', configPath: '', force: false, verbose: false, maxCycles: undefined, approve: 'ask', sessionPolicy: 'current', sessionId: '',
  });
  assert.equal(parseWorkflowCli(['workflow', 'watch']).action, 'serve');
  const run = parseWorkflowCli(['workflow', 'run', './custom.json', '--session', 'new', '--max-cycles', '3', '--verbose']);
  assert.equal(run.configPath, './custom.json');
  assert.equal(run.sessionPolicy, 'new');
  assert.equal(run.maxCycles, 3);
  assert.equal(run.verbose, true);
  const pinned = parseWorkflowCli(['workflow', 'run', '--session', 'c/123']);
  assert.equal(pinned.sessionPolicy, 'pinned');
  assert.equal(pinned.sessionId, 'c/123');
});

test('workflow config defaults to predictable current session and ask restart policies', async () => {
  const root = await tempDir('workflow-ux-config-');
  const file = path.join(root, 'bridge.workflow.json');
  await fs.writeFile(file, JSON.stringify({
    id: 'ux',
    projectRoot: '.',
    automation: { enabled: true, steps: ['true'] },
  }));
  const config = await loadWorkflowConfig(file);
  assert.deepEqual(config.automation.session, { policy: 'current', id: '' });
  assert.equal(config.automation.restartPolicy, 'ask');
});

test('legacy sessionId and resumeOnRestart migrate without silently changing semantics', async () => {
  const root = await tempDir('workflow-ux-legacy-');
  const file = path.join(root, 'bridge.workflow.json');
  await fs.writeFile(file, JSON.stringify({
    id: 'legacy',
    projectRoot: '.',
    automation: {
      enabled: true,
      steps: ['true'],
      resumeOnRestart: true,
      turn: { sessionId: 'c/legacy' },
    },
  }));
  const config = await loadWorkflowConfig(file);
  assert.deepEqual(config.automation.session, { policy: 'pinned', id: 'c/legacy' });
  assert.equal(config.automation.restartPolicy, 'auto');
});

test('npm bin entrypoint is executable and has a node shebang', async () => {
  const root = path.resolve(new URL('..', import.meta.url).pathname);
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin.bridge, 'bin/bridge.js');
  assert.equal(packageJson.bin['chatgpt-bridge'], 'bin/bridge.js');
  const target = path.join(root, 'bin/bridge.js');
  const stat = await fs.stat(target);
  assert.ok((stat.mode & 0o111) !== 0, 'bin entrypoint is executable');
  assert.match(await fs.readFile(target, 'utf8'), /^#!\/usr\/bin\/env node/);
});


test('a fresh workflow run never inherits the previous run thread or session', async () => {
  const root = await tempDir('workflow-fresh-run-');
  const runtime = {
    id: 'fresh-run',
    config: {
      configPath: path.join(root, 'bridge.workflow.json'),
      projectRoot: root,
      watch: { sessionId: '', clientId: '' },
      automation: {
        enabled: true,
        restartPolicy: 'ask',
        session: { policy: 'current', id: '' },
        maxCycles: 1,
        stepTimeoutMs: 5_000,
        steps: [{ id: 'ok', name: 'OK', command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`, cwd: root, timeoutMs: 5_000, env: {}, continueOnFailure: false }],
        turn: { timeoutMs: 5_000, pollIntervalMs: 25, approvalTimeoutMs: 5_000, sourceClientId: '', model: '', effort: 'high' },
        diagnostics: { reportDir: path.join(root, '.reports'), keepReports: 2, include: [], maxIncludedBytes: 1024 },
        project: { mode: 'package', useGitignore: true, snapshotPolicy: 'always', force: true },
        onFailure: { prompt: '', attachProject: true, attachDiagnostics: true, applyResult: true, output: { expected: 'zip', required: true } },
      },
    },
    workflowState: createWorkflowState({
      automationStatus: 'completed',
      automationId: 'automation_old',
      automationThreadId: 'thread_old',
      automationEvidence: { sessionId: 'c/old' },
    }),
  };
  const transitions = [];
  const controller = new WorkflowAutomationController({
    turnManager: {},
    fileStore: {},
    transition: async (_runtime, type, data) => {
      transitions.push({ type, data });
      const reduced = reduceWorkflowState(runtime.workflowState, { type, data, at: new Date().toISOString() });
      assert.equal(reduced.accepted, true, JSON.stringify(reduced.diagnostics));
      runtime.workflowState = reduced.state;
    },
    publish: async () => {},
    processFile: async () => ({ status: 'applied' }),
  });
  await controller.start(runtime, { sessionId: 'c/new', sessionPolicy: 'current', trigger: 'test' });
  assert.equal(transitions[0].data.threadId, '');
  assert.equal(transitions[0].data.evidence.sessionId, 'c/new');
  assert.equal(transitions[0].data.evidence.sessionPolicy, 'current');
  assert.equal(await controller.waitForIdle(runtime.id, 5_000), true);
  assert.equal(runtime.workflowState.automation.status, 'completed');
  await controller.close();
});


test('restart policy ask exposes an interrupted run instead of resuming it silently', async () => {
  const saved = [];
  const events = [];
  let restored = 0;
  const runtime = {
    id: 'interrupted',
    configPath: '/tmp/interrupted/bridge.workflow.json',
    config: {
      projectRoot: '/tmp/interrupted',
      watch: { mode: 'ask', clientId: '', sessionId: '' },
      automation: { restartPolicy: 'ask', session: { policy: 'current', id: '' } },
    },
    workflowState: createWorkflowState({ automationStatus: 'waiting_turn', automationId: 'run-old', automationCycle: 2 }),
    automationInterrupted: false,
  };
  const service = new WorkflowAutomationService({
    bridge: {},
    store: { async setWorkflow(_id, value) { saved.push(value); } },
    controller: {
      async restore() { restored += 1; },
      async stop() { throw new Error('ask policy must not discard the run'); },
    },
    publish: async (_id, type, data) => events.push({ type, data }),
  });
  await service.restore(runtime);
  assert.equal(runtime.automationInterrupted, true);
  assert.equal(restored, 0);
  assert.equal(saved.at(-1).automationInterrupted, true);
  assert.equal(events.at(-1).type, 'workflow.automation.interrupted');
});

test('current session policy never falls back to a stale passive watcher session', async () => {
  let startOptions = null;
  const runtime = {
    id: 'current-session',
    config: {
      watch: { sessionId: 'c/stale-passive-session' },
      automation: { session: { policy: 'current', id: '' } },
    },
    workflowState: createWorkflowState(),
    automationInterrupted: false,
  };
  const service = new WorkflowAutomationService({
    bridge: { health: () => ({ activeClient: null }) },
    store: {},
    controller: { async start(_runtime, options) { startOptions = options; return { id: 'run-new' }; } },
    publish: async () => {},
  });
  await service.run(runtime, { sessionPolicy: 'current' });
  assert.equal(startOptions.sessionId, '');
  assert.equal(startOptions.sessionPolicy, 'current');
});


test('workflow init detects common project commands without hard-coding this repository', async () => {
  const root = await tempDir('workflow-starter-node-');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sample-node', scripts: { test: 'node --test', check: 'node check.js' } }));
  const config = await starterWorkflowConfig(root);
  assert.equal(config.verification.packageName, 'sample-node');
  assert.deepEqual(config.verification.requiredFiles, ['package.json']);
  assert.deepEqual(config.automation.steps.map((step) => step.command), ['npm test', 'npm run check']);
  assert.equal(config.automation.enabled, true);
  assert.equal(config.extensionUpdate.enabled, false);
  assert.equal(config.commit.mode, 'none');
});

test('workflow signal state confirms only local blocking work and preserves remote waiting', () => {
  const waiting = { id: 'repair', automation: { status: 'waiting_turn' }, pipeline: { status: 'idle' } };
  const validating = { id: 'repair', automation: { status: 'validating' }, pipeline: { status: 'idle' } };
  assert.deepEqual(workflowSignalState({ list: () => [waiting], get: () => waiting }), {
    workflow: waiting,
    blocking: false,
    exitCode: 130,
  });
  assert.deepEqual(workflowSignalState({ list: () => [validating], get: () => validating }), {
    workflow: validating,
    blocking: true,
    exitCode: 130,
  });
  assert.deepEqual(workflowSignalState({ list: () => [], get: () => null }), {
    workflow: null,
    blocking: false,
    exitCode: 0,
  });
});

test('preserving a waiting workflow during shutdown does not cancel or abort it', async () => {
  let cancelled = 0;
  let aborted = 0;
  const controller = new WorkflowAutomationController({
    turnManager: { async cancelTurn() { cancelled += 1; } },
    fileStore: {},
    transition: async () => {},
    publish: async () => {},
    processFile: async () => ({}),
  });
  controller.tasks.set('repair', new Promise(() => {}));
  controller.activeTurns.set('repair', 'turn-active');
  controller.runControllers.set('repair', { abort() { aborted += 1; } });

  const result = await controller.close({ cancelActiveTurns: false });

  assert.deepEqual(result, { drained: false, pending: 1, preserved: true });
  assert.equal(cancelled, 0);
  assert.equal(aborted, 0);
  assert.equal(controller.stopRequests.size, 0);
});
