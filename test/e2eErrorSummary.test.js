import test from 'node:test';
import assert from 'node:assert/strict';
import { collectE2eIssues, formatE2eIssueSummary } from '../scripts/e2e/error-summary.js';

test('E2E failure summary separates failed scenarios from underlying runtime errors', () => {
  const issues = collectE2eIssues({
    scenarioFailures: [
      { id: 'conversation', error: new Error('POST /chat failed (500): setRequestPhase is not defined') },
      { id: 'model-effort', error: new Error('Model/effort model switch case 1 ended as failed') },
    ],
    report: {
      scenarios: [
        { id: 'conversation', status: 'failed', error: { message: 'POST /chat failed (500): setRequestPhase is not defined' } },
      ],
      debugEvents: [
        { type: 'browser.diagnostic', data: { name: 'tab_observer.collect_failed', message: 'collectArtifactsFromNode is not defined', clientId: 'tab-1' } },
        { type: 'request.state.runtime_error', data: { message: 'setRequestPhase is not defined' } },
      ],
    },
  });

  assert.deepEqual(issues, [
    { severity: 'FAILED', scope: 'conversation', message: 'POST /chat failed (500): setRequestPhase is not defined' },
    { severity: 'FAILED', scope: 'model-effort', message: 'Model/effort model switch case 1 ended as failed' },
    { severity: 'ERROR', scope: 'tab_observer.collect_failed:tab-1', message: 'collectArtifactsFromNode is not defined' },
    { severity: 'ERROR', scope: 'request.state.runtime_error', message: 'setRequestPhase is not defined' },
  ]);

  const output = formatE2eIssueSummary(issues);
  assert.match(output, /FAILED \[conversation\]/);
  assert.match(output, /ERROR \[request\.state\.runtime_error\]/);
  assert.match(output, /END E2E FAILURE SUMMARY/);
});

test('E2E failure summary reports browser diagnostic names nested in event data', () => {
  const issues = collectE2eIssues({
    report: {
      debugEvents: [
        { type: 'diagnostic', data: { name: 'tab_observer.collect_failed', message: 'collectArtifactsFromNode is not defined', clientId: 'tab-1' } },
      ],
    },
  });

  assert.deepEqual(issues, [
    { severity: 'ERROR', scope: 'tab_observer.collect_failed:tab-1', message: 'collectArtifactsFromNode is not defined' },
  ]);
});


test('E2E failure summary includes cleanup and diagnostics finalization failures', () => {
  const issues = collectE2eIssues({
    report: {
      downloadCleanupVerificationError: 'download source still exists',
      diagnosticsWriteError: 'disk full',
    },
  });
  assert.deepEqual(issues, [
    { severity: 'ERROR', scope: 'diagnostics.write', message: 'disk full' },
    { severity: 'FAILED', scope: 'download-cleanup-verification', message: 'download source still exists' },
  ]);
});


test('E2E failure summary reports an interrupted active scenario', () => {
  const issues = collectE2eIssues({
    report: {
      interruption: { signal: 'SIGINT' },
      scenarios: [
        { id: 'workflow-approval', status: 'interrupted', note: 'Interrupted by SIGINT' },
      ],
    },
  });

  assert.deepEqual(issues, [
    { severity: 'FAILED', scope: 'workflow-approval', message: 'Interrupted by SIGINT' },
  ]);
});
