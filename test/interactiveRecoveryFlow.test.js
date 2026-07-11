import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleCommand, waitForTurn } from '../src/interactiveLegacy.js';

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


test('waitForTurn cannot miss a terminal event between status read and subscription', async () => {
  class RacingTurnManager extends EventEmitter {
    constructor() {
      super();
      this.reads = 0;
    }
    async getTurnEvents() { return []; }
    getTurn(turnId) {
      this.reads += 1;
      if (this.reads > 1) return Promise.resolve({ id: turnId, status: 'completed' });
      return {
        then: (resolve) => {
          resolve({ id: turnId, status: 'running' });
          this.emit(`turn:${turnId}`, { type: 'turn/completed', time: new Date().toISOString() });
        },
      };
    }
  }

  const manager = new RacingTurnManager();
  const consoleStream = {
    onProgressUpdate() {},
    onThinkingUpdate() {},
    onAnswerUpdate() {},
    status() {},
  };
  const result = await Promise.race([
    waitForTurn(manager, 'turn-race', {}, consoleStream),
    new Promise((_, reject) => setTimeout(() => reject(new Error('waitForTurn hung after terminal event')), 250)),
  ]);
  assert.equal(result.status, 'completed');
});

test('/resume follows an already tracked project turn instead of reporting an error', async () => {
  class TrackedTurnManager extends EventEmitter {
    isTurnTracked(id) { return id === 'turn-tracked'; }
    async getTurnEvents() { return []; }
    async getTurn() { return { id: 'turn-tracked', threadId: 'thread-1', status: 'completed', output: { type: 'text', answer: 'done' } }; }
    async getItems() { return [{ type: 'agent_message', content: { text: 'done' } }]; }
    async resumeActiveTurn() { throw new Error('resumeActiveTurn should not be called for an already tracked turn'); }
  }
  const state = { lastTurnId: 'turn-tracked', responseHistory: [], lastArtifacts: [], pendingAttachments: [] };
  const logs = [];
  const stream = {
    status: (line) => logs.push(line),
    onProgressUpdate() {},
    onThinkingUpdate() {},
    onAnswerUpdate() {},
    finish: (text) => logs.push(text),
    fail() {},
  };
  const handled = await handleCommand('/resume', {
    bridge: {
      findActiveRequest: () => ({ clientId: 'client-1', activeRequest: { requestId: 'turn-tracked', promptPreview: 'work' } }),
      health: () => ({ activeClient: { activeRequest: { requestId: 'turn-tracked' } } }),
    },
    state,
    turnManager: new TrackedTurnManager(),
    fileStore: {},
    projectService: null,
    confirm: async () => false,
    createConsoleStream: () => stream,
  });
  assert.equal(handled, true);
  assert.ok(logs.some((line) => line.includes('already tracked locally')));
  assert.equal(state.lastTurnId, 'turn-tracked');
  assert.equal(state.responseHistory[0].text, 'done');
});
