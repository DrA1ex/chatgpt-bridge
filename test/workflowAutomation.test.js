import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkflowAutomationController } from '../src/workflow/automation/controller.js';
import { runAutomationSteps } from '../src/workflow/automation/commandRunner.js';
import { loadWorkflowConfig } from '../src/workflow/config.js';
import { WorkflowLifecycle, createWorkflowState, reduceWorkflowState } from '../src/workflow/state/workflowState.js';

async function tempDir(prefix) { return await fs.mkdtemp(path.join(os.tmpdir(), prefix)); }

test('workflow config keeps language-independent automation steps and nested policies', async (t) => {
  const root = await tempDir('workflow-automation-config-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"automation-fixture"}\n');
  const configPath = path.join(root, 'bridge.workflow.json');
  await fs.writeFile(configPath, JSON.stringify({
    id: 'automation-fixture', projectRoot: '.', watch: { mode: 'auto' },
    automation: {
      enabled: true, trigger: 'manual', maxCycles: 4,
      steps: ['python -m pytest', { name: 'Rust checks', run: 'cargo test', cwd: 'backend', env: { RUST_BACKTRACE: 1 } }],
      diagnostics: { include: ['reports'], keepReports: 3 },
      onFailure: { action: 'chatgpt-repair', prompt: 'Preserve generated bindings.' },
    },
  }));
  const config = await loadWorkflowConfig(configPath);
  assert.deepEqual(config.automation.steps.map((step) => step.command), ['python -m pytest', 'cargo test']);
  assert.equal(config.automation.steps[1].cwd, path.join(root, 'backend'));
  assert.equal(config.automation.steps[1].env.RUST_BACKTRACE, '1');
  assert.equal(config.automation.onFailure.prompt, 'Preserve generated bindings.');
});

test('automation command runner preserves full stdout and stderr in its report', async (t) => {
  const root = await tempDir('workflow-automation-runner-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await runAutomationSteps([{
    id: 'output', name: 'Output',
    command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('full stdout\\n'); process.stderr.write('full stderr\\n')"`,
    cwd: root, timeoutMs: 5_000, env: {}, continueOnFailure: false,
  }], { cwd: root, reportDir: path.join(root, 'report'), timeoutMs: 5_000, env: process.env });
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(result.results[0].stdoutPath, 'utf8'), 'full stdout\n');
  assert.equal(await fs.readFile(result.results[0].stderrPath, 'utf8'), 'full stderr\n');
});

test('fix-until-pass automation uses the canonical run and reaches one terminal outcome', async (t) => {
  const root = await tempDir('workflow-automation-v3-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"automation-v3"}\n');
  const configPath = path.join(root, 'bridge.workflow.json');
  await fs.writeFile(configPath, JSON.stringify({
    id: 'automation-v3', preset: 'fix-until-pass', projectRoot: '.', watch: { mode: 'off' },
    automation: { enabled: true, maxCycles: 2, steps: [`${JSON.stringify(process.execPath)} -e "process.exit(0)"`] },
  }));
  const config = await loadWorkflowConfig(configPath);
  const runtime = {
    id: config.id, config,
    workflowState: createWorkflowState({ lifecycle: WorkflowLifecycle.READY, project: { root, id: 'project-v3' } }),
  };
  let sequence = 0;
  const events = [];
  const transition = async (target, type, data = {}, publishedType = '') => {
    const reduced = reduceWorkflowState(target.workflowState, { eventId: `automation-event-${++sequence}`, type, data, at: new Date().toISOString() });
    assert.equal(reduced.accepted, true, JSON.stringify(reduced.diagnostics));
    target.workflowState = reduced.state;
    if (publishedType) events.push(publishedType);
  };
  const controller = new WorkflowAutomationController({
    turnManager: {}, fileStore: {}, transition,
    publish: async (_workflowId, type) => events.push(type),
    processFile: async () => null,
  });
  await controller.start(runtime, { trigger: 'test' });
  assert.equal(await controller.waitForIdle(runtime.id, 10_000), true);
  assert.equal(runtime.workflowState.lifecycle, WorkflowLifecycle.READY);
  assert.equal(runtime.workflowState.lastOutcome.status, 'completed');
  assert.equal(runtime.workflowState.lastOutcome.evidence.cycle, 1);
  assert.ok(events.includes('workflow.automation.completed'));
});
