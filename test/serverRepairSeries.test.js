import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerRepairSeriesCoordinator } from '../src/workflow/server/serverRepairSeries.js';

function repairOrchestration(series) {
  return {
    preset: 'fix-until-pass',
    remediation: { enabled: true },
    attempts: { checkCycles: 3 },
    noProgressLimit: 2,
    series,
  };
}

test('repair series resumes a persisted artifact with the same mutation keys', async () => {
  const series = {
    id: 'series-one',
    status: 'active',
    stage: 'artifact_ready',
    attempt: 1,
    noProgress: 0,
    lastSha256: 'abc',
    artifact: {
      fileId: 'file-one',
      filename: 'repair.zip',
      expected: { size: 10, sha256: 'abc' },
      correlation: { producer: 'chatgpt-bridge' },
      uploadIdempotencyKey: 'upload-one',
      runIdempotencyKey: 'run-one',
    },
  };
  let activeRunId = 'check-one';
  let surface = {
    id: 'surface-check',
    revision: 3,
    kind: 'checks_failed',
    links: {},
    actions: [{ id: 'finish', kind: 'finish', enabled: true }],
  };
  let run = { runId: 'check-one', kind: 'checks', seriesId: 'series-one' };
  let orchestration = repairOrchestration(series);
  const uploads = [];
  const runtime = {
    snapshot() {
      return {
        workflowId: 'workflow-one',
        orchestration: structuredClone(orchestration),
        state: { localWorkflow: { runId: run.runId, seriesId: 'series-one' } },
        resources: { run: structuredClone(run), project: { activeRunId } },
        surface: structuredClone(surface),
      };
    },
    async updateOrchestration(patch) {
      orchestration = { ...orchestration, ...structuredClone(patch) };
      return orchestration;
    },
    async performAction(request) {
      assert.equal(request.actionId, 'finish');
      activeRunId = null;
      surface = { id: 'finished', revision: 4, kind: 'completed', actions: [] };
    },
    async refresh() {
      return this.snapshot();
    },
    async uploadAndStartArchiveRun(request) {
      uploads.push(structuredClone(request));
      activeRunId = null;
      run = { runId: 'archive-one', kind: 'archive', seriesId: 'series-one' };
      surface = { id: 'archive-complete', revision: 8, kind: 'completed', actions: [] };
      return { run };
    },
    async report() {
      return { checks: { ok: true, failed: 0, results: [{ ok: true }] } };
    },
  };
  let repairs = 0;
  const coordinator = new ServerRepairSeriesCoordinator({ runtime, pollMs: 0 });
  const result = await coordinator.run({
    workflowId: 'workflow-one',
    requestRepair: async () => {
      repairs += 1;
      throw new Error('must not request ChatGPT twice');
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(repairs, 0);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].uploadIdempotencyKey, 'upload-one');
  assert.equal(uploads[0].runIdempotencyKey, 'run-one');
});

test('repair series stops for recovery when a prior ChatGPT response is uncertain', async () => {
  const series = {
    id: 'series-two',
    status: 'active',
    stage: 'requesting_repair',
    attempt: 1,
    artifact: null,
  };
  const runtime = {
    snapshot: () => ({
      workflowId: 'workflow-two',
      orchestration: repairOrchestration(series),
      state: { localWorkflow: { runId: 'check-two', seriesId: 'series-two' } },
      resources: { run: { runId: 'check-two', kind: 'checks', seriesId: 'series-two' } },
      surface: { kind: 'checks_failed' },
    }),
    async updateOrchestration() {},
  };
  let repairs = 0;
  const result = await new ServerRepairSeriesCoordinator({ runtime }).run({
    workflowId: 'workflow-two',
    requestRepair: async () => { repairs += 1; },
  });
  assert.equal(result.status, 'waiting_action');
  assert.equal(result.reason, 'repair_response_uncertain');
  assert.equal(repairs, 0);
});
