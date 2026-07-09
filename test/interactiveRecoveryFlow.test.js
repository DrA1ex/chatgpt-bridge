import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCommand } from '../src/interactiveLegacy.js';

test('/recover <n> treats n as visible candidate index and allows adopted recovery turns', async () => {
  let seen = null;
  const state = {
    projectRoot: '/tmp/current-project',
    projectThreadId: 'thread_current',
    sessionId: 'session_current',
    responseHistory: [],
    lastArtifacts: [],
  };
  const turnManager = {
    async recoverTurnFromLatestResponse(id, options) {
      seen = { id, options };
      return {
        id: 'turn_adopted',
        threadId: 'thread_recovered',
        status: 'completed',
        completedAt: '2026-07-08T00:00:00.000Z',
        output: { type: 'text', answer: 'Recovered answer', artifacts: [] },
      };
    },
    async getItems() { return []; },
  };

  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const handled = await handleCommand('/recover 1', {
      bridge: {},
      fileStore: {},
      state,
      projectService: null,
      turnManager,
      confirm: async () => false,
    });
    assert.equal(handled, true);
  } finally {
    console.log = originalLog;
  }

  assert.equal(seen.id, '');
  assert.equal(seen.options.index, 1);
  assert.equal(seen.options.allowAdoptedTurn, true);
  assert.equal(seen.options.threadId, 'thread_current');
  assert.equal(seen.options.cwd, '/tmp/current-project');
  assert.equal(seen.options.sessionId, 'session_current');
  assert.deepEqual(seen.options.expectedOutput, { expected: 'zip', required: true });
  assert.equal(state.lastTurnId, 'turn_adopted');
  assert.equal(state.lastTurn.id, 'turn_adopted');
  assert.equal(state.projectThreadId, 'thread_recovered');
  assert.equal(state.responseHistory[0].text, 'Recovered answer');
  assert.ok(logs.some((line) => line.includes('assistant response #1')));
});


test('/recover <n> selects recovered ZIP result for current project scope', async () => {
  const state = {
    projectRoot: '/tmp/current-project',
    projectId: 'project-current',
    projectThreadId: 'thread_current',
    sessionId: 'session_current',
    responseHistory: [],
    lastArtifacts: [],
  };
  const turnManager = {
    async recoverTurnFromLatestResponse() {
      return {
        id: 'turn_recovered_zip',
        threadId: 'thread_current',
        status: 'completed',
        completedAt: '2026-07-08T00:00:00.000Z',
        output: {
          type: 'zip',
          status: 'ready',
          answer: 'Recovered ZIP answer',
          fileId: 'file_recovered_zip',
          artifactId: 'artifact_recovered_zip',
          name: 'recovered.zip',
          sourceClientId: 'client-recovered',
          sourceTurnKey: 'assistant-recovered',
          sourceRequestId: 'turn_recovered_zip',
          artifacts: [{ id: 'artifact_recovered_zip' }],
        },
      };
    },
    async getItems() { return []; },
  };

  const originalLog = console.log;
  console.log = () => {};
  try {
    const handled = await handleCommand('/recover 1', {
      bridge: {},
      fileStore: {},
      state,
      projectService: null,
      turnManager,
      confirm: async () => false,
    });
    assert.equal(handled, true);
  } finally {
    console.log = originalLog;
  }

  assert.equal(state.selectedResult.turnId, 'turn_recovered_zip');
  assert.equal(state.selectedResult.projectId, 'project-current');
  assert.equal(state.selectedResult.projectRoot, '/tmp/current-project');
  assert.equal(state.selectedResult.fileId, 'file_recovered_zip');
  assert.equal(state.selectedResult.artifactId, 'artifact_recovered_zip');
  assert.equal(state.selectedResult.sourceClientId, 'client-recovered');
  assert.equal(state.selectedResult.sourceTurnKey, 'assistant-recovered');
});
