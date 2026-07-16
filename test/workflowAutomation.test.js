import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/fileStore.js';
import { loadWorkflowConfig } from '../src/workflow/config.js';
import { WorkflowAutomationController } from '../src/workflow/automation/controller.js';
import { runAutomationSteps } from '../src/workflow/automation/commandRunner.js';
import { collectAutomationDiagnostics } from '../src/workflow/automation/diagnostics.js';
import { validateZipFile } from '../src/zipUtils.js';
import {
  WorkflowStateEventType,
  createWorkflowState,
  reduceWorkflowState,
} from '../src/workflow/state/workflowState.js';

async function tempDir(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

test('workflow config normalizes language-independent automation steps and nested policies', async () => {
  const root = await tempDir('workflow-automation-config-');
  const configPath = path.join(root, 'bridge.workflow.json');
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"automation-fixture"}\n');
  await fs.writeFile(configPath, JSON.stringify({
    id: 'automation-fixture',
    projectRoot: '.',
    watch: { mode: 'auto' },
    automation: {
      enabled: true,
      trigger: 'manual',
      maxCycles: 4,
      steps: [
        'python -m pytest',
        { name: 'Rust checks', run: 'cargo test', cwd: 'backend', timeoutMs: 5000, env: { RUST_BACKTRACE: 1 }, continueOnFailure: false },
      ],
      diagnostics: { include: ['reports'], keepReports: 3 },
      onFailure: { action: 'chatgpt-repair', prompt: 'Preserve generated bindings.' },
    },
  }, null, 2));
  const config = await loadWorkflowConfig(configPath);
  assert.equal(config.automation.enabled, true);
  assert.equal(config.automation.maxCycles, 4);
  assert.equal(config.automation.steps[0].command, 'python -m pytest');
  assert.equal(config.automation.steps[1].name, 'Rust checks');
  assert.equal(config.automation.steps[1].cwd, path.join(root, 'backend'));
  assert.equal(config.automation.steps[1].env.RUST_BACKTRACE, '1');
  assert.equal(config.automation.steps[1].continueOnFailure, false);
  assert.deepEqual(config.automation.diagnostics.include, ['reports']);
  assert.equal(config.automation.onFailure.prompt, 'Preserve generated bindings.');
});

test('automation command runner keeps complete output in files while verbose controls only terminal rendering', async () => {
  const root = await tempDir('workflow-automation-steps-');
  const reportDir = path.join(root, 'report');
  const result = await runAutomationSteps([
    {
      id: 'output',
      name: 'Output',
      command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('full stdout\\n'); process.stderr.write('full stderr\\n')"`,
      cwd: root,
      timeoutMs: 5000,
      env: {},
      continueOnFailure: true,
    },
  ], {
    cwd: root,
    reportDir,
    timeoutMs: 5000,
    verbose: false,
    env: process.env,
  });
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(result.results[0].stdoutPath, 'utf8'), 'full stdout\n');
  assert.equal(await fs.readFile(result.results[0].stderrPath, 'utf8'), 'full stderr\n');
  assert.match(await fs.readFile(result.results[0].combinedPath, 'utf8'), /\[stdout\] full stdout/);
  assert.match(await fs.readFile(result.results[0].combinedPath, 'utf8'), /\[stderr\] full stderr/);
});



test('automation diagnostics can include a parent tree without recursing into the current report', async () => {
  const root = await tempDir('workflow-automation-diagnostics-parent-');
  const reportDir = path.join(root, '.bridge-data', 'workflow-runs', 'current');
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(root, 'project.txt'), 'project evidence\n');
  await fs.writeFile(path.join(reportDir, 'existing.log'), 'must not be copied recursively\n');
  const manifest = await collectAutomationDiagnostics({
    projectRoot: root,
    reportDir,
    include: ['.'],
    maxIncludedBytes: 1024 * 1024,
  });
  assert.equal(await fs.readFile(path.join(reportDir, 'collected', 'project.txt'), 'utf8'), 'project evidence\n');
  assert.ok(manifest.skipped.some((entry) => entry.reason === 'current-report-directory'));
  await assert.rejects(fs.access(path.join(reportDir, 'collected', '.bridge-data', 'workflow-runs', 'current', 'existing.log')));
});

test('integrated automation validates, sends one repair turn, applies its ZIP, and validates again', async () => {
  const root = await tempDir('workflow-automation-loop-');
  const dataDir = path.join(root, 'data');
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"automation-loop"}\n');
  const configPath = path.join(root, 'bridge.workflow.json');
  await fs.writeFile(configPath, JSON.stringify({
    id: 'automation-loop',
    projectRoot: '.',
    watch: { mode: 'auto' },
    commit: { mode: 'none' },
    extensionUpdate: { enabled: false },
    daemonRestart: { enabled: false },
    automation: {
      enabled: true,
      maxCycles: 3,
      steps: [{
        name: 'Marker validation',
        command: `${JSON.stringify(process.execPath)} -e "process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)"`,
        cwd: '.',
        timeoutMs: 5000,
      }],
      turn: { timeoutMs: 5000, pollIntervalMs: 25, effort: 'high' },
      diagnostics: { reportDir: '.bridge-data/workflow-runs', keepReports: 2 },
      onFailure: { action: 'chatgpt-repair', attachProject: true, attachDiagnostics: true, applyResult: true },
    },
  }, null, 2));
  const workflow = await loadWorkflowConfig(configPath);
  const fileStore = new FileStore(dataDir);
  const turns = new Map();
  const threads = new Map();
  let startedInput = null;
  const turnManager = {
    async createThread(input) {
      const thread = { id: 'thread-1', sessionId: input.sessionId || 'session-1', ...input };
      threads.set(thread.id, thread);
      return thread;
    },
    async getThread(id) { return threads.get(id) || null; },
    async startTurn(input) {
      startedInput = input;
      const turn = {
        id: 'turn-1',
        threadId: input.threadId,
        status: 'completed',
        input,
        output: { fileId: 'returned-project-zip', response: { turnKey: 'assistant-turn-1', sourceClientId: 'client-1' } },
      };
      turns.set(turn.id, turn);
      return { turn, reused: false };
    },
    async getTurn(id) { return turns.get(id) || null; },
    async getItems({ turnId }) {
      return turnId === 'turn-1' ? [{ type: 'agent_message', content: { text: 'Fixed project attached.' } }] : [];
    },
    async cancelTurn() { return null; },
  };
  const events = [];
  const runtime = {
    id: workflow.id,
    config: workflow,
    workflowState: createWorkflowState(),
    boundSourceClientId: '',
  };
  const transition = async (_runtime, type, data, publishedType, publishedData) => {
    const result = reduceWorkflowState(runtime.workflowState, { type, data, at: new Date().toISOString() });
    assert.equal(result.accepted, true, JSON.stringify(result.diagnostics));
    runtime.workflowState = result.state;
    if (publishedType) events.push({ type: publishedType, data: publishedData });
    return runtime.workflowState;
  };
  const controller = new WorkflowAutomationController({
    turnManager,
    fileStore,
    transition,
    publish: async (_workflowId, type, data) => { events.push({ type, data }); },
    processFile: async (_runtime, payload) => {
      assert.equal(payload.fileId, 'returned-project-zip');
      await fs.writeFile(path.join(root, 'fixed.txt'), 'fixed\n');
      return { status: 'applied' };
    },
  });

  const started = await controller.start(runtime, { trigger: 'test' });
  assert.equal(started.status, 'validating');
  await waitFor(() => runtime.workflowState.automation.status === 'completed');
  assert.equal(runtime.workflowState.automation.cycle, 2);
  assert.equal(startedInput.project.mode, 'package');
  assert.equal(startedInput.project.cwd, root);
  assert.equal(startedInput.output.expected, 'zip');
  assert.equal(startedInput.attachments.length, 1);
  assert.match(startedInput.message, /Marker validation/);
  const diagnostic = await fileStore.getReadable(startedInput.attachments[0]);
  assert.ok(diagnostic?.absolutePath);
  assert.equal((await validateZipFile(diagnostic.absolutePath)).ok, true);
  assert.ok(events.some((event) => event.type === 'workflow.automation.turn.started'));
  assert.ok(events.some((event) => event.type === 'workflow.automation.apply.completed'));
  assert.ok(events.some((event) => event.type === 'workflow.automation.completed'));
  await controller.close();
});

test('automation stop is canonical and cancels an active repair turn', async () => {
  const runtime = {
    id: 'stop-workflow',
    config: { automation: { enabled: true, steps: [{ command: 'noop' }] } },
    workflowState: createWorkflowState(),
  };
  let cancelled = '';
  const turnManager = {
    async cancelTurn(id) { cancelled = id; },
  };
  const controller = new WorkflowAutomationController({
    turnManager,
    fileStore: {},
    transition: async (_runtime, type, data) => {
      const result = reduceWorkflowState(runtime.workflowState, { type, data, at: new Date().toISOString() });
      assert.equal(result.accepted, true, JSON.stringify(result.diagnostics));
      runtime.workflowState = result.state;
    },
    publish: async () => {},
    processFile: async () => ({}),
  });
  let result = reduceWorkflowState(runtime.workflowState, {
    type: WorkflowStateEventType.AUTOMATION_STARTED,
    data: { automationId: 'automation-stop', status: 'waiting_turn', cycle: 1, maxCycles: 2 },
  });
  runtime.workflowState = result.state;
  result = reduceWorkflowState(runtime.workflowState, {
    type: WorkflowStateEventType.AUTOMATION_STAGE_CHANGED,
    data: { automationId: 'automation-stop', status: 'waiting_turn', turnId: 'turn-stop' },
  });
  runtime.workflowState = result.state;
  const stopped = await controller.stop(runtime, 'test stop');
  assert.equal(cancelled, 'turn-stop');
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.error, 'test stop');
});

test('automation command runner aborts the active process group', async () => {
  const root = await tempDir('workflow-automation-abort-');
  const reportDir = path.join(root, 'report');
  const controller = new AbortController();
  const running = runAutomationSteps([{
    id: 'long-running',
    name: 'Long running',
    command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
    cwd: root,
    timeoutMs: 30_000,
    env: {},
    continueOnFailure: false,
  }], {
    cwd: root,
    reportDir,
    timeoutMs: 30_000,
    signal: controller.signal,
    env: process.env,
  });
  setTimeout(() => controller.abort('test abort'), 100);
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.equal(result.results[0].aborted, true);
  assert.ok(result.results[0].durationMs < 5_000);
});

test('automation restore waits for the existing approval pipeline before revalidating', async () => {
  const root = await tempDir('workflow-automation-restore-approval-');
  await fs.writeFile(path.join(root, 'fixed.txt'), 'already applied\n');
  let workflowState = createWorkflowState();
  for (const event of [
    { type: WorkflowStateEventType.AUTOMATION_STARTED, data: { automationId: 'automation-resume', status: 'validating', cycle: 1, maxCycles: 3, threadId: 'thread-resume' } },
    { type: WorkflowStateEventType.AUTOMATION_STAGE_CHANGED, data: { automationId: 'automation-resume', status: 'awaiting_approval', cycle: 1, turnId: 'turn-completed', approvalId: 'approval-resume' } },
    { type: WorkflowStateEventType.PIPELINE_STARTED, data: { pipelineId: 'pipeline-resume', status: 'observed' } },
    { type: WorkflowStateEventType.PIPELINE_STAGE_CHANGED, data: { pipelineId: 'pipeline-resume', status: 'awaiting_approval', approvalId: 'approval-resume' } },
  ]) {
    const reduced = reduceWorkflowState(workflowState, event);
    assert.equal(reduced.accepted, true, JSON.stringify(reduced.diagnostics));
    workflowState = reduced.state;
  }
  const runtime = {
    id: 'restore-approval',
    config: {
      projectRoot: root,
      configPath: path.join(root, 'bridge.workflow.json'),
      watch: { sessionId: '', clientId: '' },
      automation: {
        enabled: true,
        resumeOnRestart: true,
        maxCycles: 3,
        stepTimeoutMs: 5_000,
        steps: [{ id: 'validate', name: 'Validate', command: `${JSON.stringify(process.execPath)} -e "process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)"`, cwd: root, timeoutMs: 5_000, env: {}, continueOnFailure: false }],
        turn: { timeoutMs: 5_000, pollIntervalMs: 25, approvalTimeoutMs: 5_000, sessionId: '', sourceClientId: '', model: '', effort: 'high' },
        diagnostics: { reportDir: path.join(root, '.reports'), keepReports: 2, include: [], maxIncludedBytes: 1024 },
        project: { mode: 'package', useGitignore: true, snapshotPolicy: 'always', force: true },
        onFailure: { prompt: '', attachProject: true, attachDiagnostics: true, applyResult: true, output: { expected: 'zip', required: true } },
      },
    },
    workflowState,
    boundSourceClientId: '',
  };
  let cancelled = 0;
  let turnsStarted = 0;
  const controller = new WorkflowAutomationController({
    turnManager: {
      async cancelTurn() { cancelled += 1; },
      async startTurn() { turnsStarted += 1; throw new Error('A new turn must not start while resuming approval'); },
    },
    fileStore: {},
    transition: async (_runtime, type, data) => {
      const reduced = reduceWorkflowState(runtime.workflowState, { type, data, at: new Date().toISOString() });
      assert.equal(reduced.accepted, true, JSON.stringify(reduced.diagnostics));
      runtime.workflowState = reduced.state;
    },
    publish: async () => {},
    processFile: async () => ({ status: 'applied' }),
  });
  await controller.restore(runtime);
  setTimeout(() => {
    const reduced = reduceWorkflowState(runtime.workflowState, {
      type: WorkflowStateEventType.PIPELINE_COMPLETED,
      data: { pipelineId: 'pipeline-resume', code: 'applied' },
      at: new Date().toISOString(),
    });
    assert.equal(reduced.accepted, true, JSON.stringify(reduced.diagnostics));
    runtime.workflowState = reduced.state;
  }, 50);
  await waitFor(() => runtime.workflowState.automation.status === 'completed', 5_000);
  assert.equal(runtime.workflowState.automation.cycle, 2);
  assert.equal(cancelled, 0);
  assert.equal(turnsStarted, 0);
  await controller.close();
});

test('workflow config rejects repair loops that cannot apply the returned artifact', async () => {
  const root = await tempDir('workflow-automation-invalid-apply-');
  const configPath = path.join(root, 'bridge.workflow.json');
  await fs.writeFile(configPath, JSON.stringify({
    id: 'invalid-automation',
    projectRoot: '.',
    watch: { mode: 'verify' },
    automation: {
      enabled: true,
      steps: ['true'],
      onFailure: { applyResult: true, output: { expected: 'zip', required: true } },
    },
  }));
  await assert.rejects(loadWorkflowConfig(configPath), /cannot be used with watch\.mode=verify/);
});
