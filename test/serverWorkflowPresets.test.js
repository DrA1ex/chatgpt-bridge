import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVER_WORKFLOW_PRESETS,
  buildServerWorkflowPreset,
} from '../src/workflow/server/serverWorkflowPresets.js';

function base() {
  return {
    version: 9,
    name: 'Project',
    archive: { mode: 'overlay' },
    checks: [{ id: 'test', commandText: 'npm test', cwd: '.' }],
    policy: {},
    git: { checkpoint: 'ask', resultCommit: 'ask' },
    deploy: { policy: 'disabled', commandText: '', cwd: '.' },
  };
}

test('all three Bridge presets retain orchestration ownership and server execution ownership', () => {
  assert.deepEqual(
    SERVER_WORKFLOW_PRESETS.map(({ id }) => id),
    ['apply-changes', 'fix-until-pass', 'guided-task'],
  );
  for (const preset of SERVER_WORKFLOW_PRESETS.map(({ id }) => id)) {
    const result = buildServerWorkflowPreset(preset, base(), {
      intelligence: { model: 'gpt', effort: 'high' },
      binding: { sessionId: 'session-1' },
    });
    assert.equal(result.orchestration.preset, preset);
    assert.equal(result.orchestration.intelligence.model, 'gpt');
    assert.equal(result.orchestration.binding.sessionId, 'session-1');
    assert.equal(result.workflow.policy.confirmPlan, true);
    assert.equal(result.workflow.policy.conflictPolicy, 'ask');
    assert.equal(result.workflow.git.resultCommit, 'ask');
    assert.equal(
      result.workflow.git.checkpoint,
      preset === 'fix-until-pass' ? 'auto' : 'ask',
    );
    assert.equal(
      result.workflow.archive.mode,
      preset === 'apply-changes' ? 'snapshot' : 'overlay',
    );
  }
});
