import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowE2eRuntime } from '../scripts/e2e/workflow-runtime.js';

function runtimeFor(apiImpl, logs = []) {
  return createWorkflowE2eRuntime({
    api: apiImpl,
    assert,
    buildPassivePromptBody() { return {}; },
    findWorkflowWaitOutcome(events, { predicate }) {
      return { matched: events.find(predicate) || null, fatal: null };
    },
    nowIso: () => new Date().toISOString(),
    scenarioDiagnosticDir: () => '.',
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    testLog: (...args) => logs.push(args),
    workflowEventKey: (event) => event.id || `${event.type}:${event.time || ''}`,
    workflowProgressFromEvents: () => ({}),
  });
}

test('workflow wait fails at its explicit absolute timeout while still idle', async () => {
  const logs = [];
  const runtime = runtimeFor(async (_options, pathname) => {
    if (pathname.includes('/events')) return { events: [{ id: 'loaded', type: 'workflow.loaded' }] };
    return { workflow: { workflowStateRevision: 0, pipeline: { status: 'idle' } } };
  }, logs);
  await assert.rejects(
    runtime.waitForWorkflowEvent({ pipelineIdleTimeoutMs: 10_000 }, 'wf', () => false, {
      timeoutMs: 35,
      intervalMs: 5,
      scope: 'workflow-timeout-test',
      target: 'workflow.approval.required',
    }),
    (error) => error?.name === 'WorkflowWaitTimeoutError' && error.timeoutMs === 35,
  );
  assert(logs.some((entry) => entry[0] === 'fail' && /absolute timeout/i.test(entry[2])));
});

test('workflow wait uses the pipeline idle timeout after processing starts', async () => {
  let revision = 1;
  const runtime = runtimeFor(async (_options, pathname) => {
    if (pathname.includes('/events')) {
      return { events: [
        { id: 'loaded', type: 'workflow.loaded' },
        { id: 'observed', type: 'workflow.pipeline.observed' },
      ] };
    }
    return { workflow: { workflowStateRevision: revision, pipeline: { status: 'downloading' } } };
  });
  await assert.rejects(
    runtime.waitForWorkflowEvent({ pipelineIdleTimeoutMs: 20 }, 'wf', () => false, {
      timeoutMs: 200,
      intervalMs: 5,
      scope: 'workflow-idle-test',
      target: 'workflow.completed',
    }),
    (error) => error?.name === 'WorkflowWaitIdleTimeoutError' && error.pipelineStatus === 'downloading',
  );
});
