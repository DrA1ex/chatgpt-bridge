import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeZip } from '../src/zipWriter.js';
import { MetadataStore } from '../src/metadataStore.js';
import { TurnManager } from '../src/turnManager.js';
import { runProjectTask } from '../src/interactiveLegacy.js';


const runGit = promisify(execFile);

async function initGit(root) {
  await runGit('git', ['-C', root, 'init']);
  await runGit('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  await runGit('git', ['-C', root, 'config', 'user.name', 'Test']);
  await runGit('git', ['-C', root, 'add', '.']);
  await runGit('git', ['-C', root, 'commit', '-m', 'initial']);
}

test('project turn preserves final answer and completes without artifact when required ZIP is absent', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-goal-no-artifact-'));
  const metadataStore = new MetadataStore(dir);
  await metadataStore.ready;

  const bridge = {
    async sendRequest(request, callbacks = {}) {
      callbacks.onEvent?.({ type: 'request.done', requestId: request.requestId, data: { answerLength: 20, artifactCount: 1 } });
      return {
        requestId: request.requestId,
        answer: 'Final summary from ChatGPT',
        thinking: 'Reasoning summary',
        artifacts: [],
        turnKey: 'assistant-turn-current',
        session: { id: 'session-goal' },
      };
    },
    cancelActive() { return 1; },
  };
  const resultResolver = {
    async resolve() {
      const err = new Error('Expected a .zip artifact or fenced ```file:path``` blocks, but ChatGPT did not expose either.');
      err.code = 'EXPECTED_ZIP_ARTIFACT_NOT_FOUND';
      err.extra = { artifacts: [], answerPreview: 'Final summary from ChatGPT' };
      throw err;
    },
  };
  const manager = new TurnManager({ bridge, metadataStore, resultResolver });
  const thread = await manager.createThread({ title: 'Project', cwd: dir });
  const { turn } = await manager.startTurn({ threadId: thread.id, input: 'change project', output: { expected: 'zip', required: true } });

  await new Promise((resolve) => setTimeout(resolve, 120));
  const completed = await manager.getTurn(turn.id);
  assert.equal(completed.status, 'completed_without_artifact');
  assert.equal(completed.output.type, 'text');
  assert.equal(completed.output.status, 'missing_required_artifact');
  assert.equal(completed.output.answer, 'Final summary from ChatGPT');

  const items = await manager.getItems({ turnId: turn.id });
  assert.ok(items.some((item) => item.type === 'agent_message' && item.content?.text === 'Final summary from ChatGPT'));

  let events = await manager.getTurnEvents(turn.id, { limit: 100 });
  for (let i = 0; i < 10 && !events.some((event) => event.type === 'turn/completed_without_artifact'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    events = await manager.getTurnEvents(turn.id, { limit: 100 });
  }
  assert.ok(events.some((event) => event.type === 'turn/completed_without_artifact'));
  assert.ok(events.some((event) => event.type === 'result/missing_required_artifact'));
});

test('runProjectTask prints final answer when project turn completed without required artifact', async () => {
  const state = { projectRoot: '/tmp/project', projectThreadId: 'thread-1', sessionId: 'session-1', responseHistory: [] };
  const statuses = [];
  let finished = '';
  const turnManager = {
    async startTurn() { return { turn: { id: 'turn-no-artifact' } }; },
    async getTurnEvents() { return []; },
    async getTurn() {
      return {
        id: 'turn-no-artifact',
        status: 'completed_without_artifact',
        completedAt: '2026-07-08T00:00:00.000Z',
        input: { output: { expected: 'zip', required: true } },
        output: { type: 'text', status: 'missing_required_artifact', answer: 'Final answer text', artifacts: [] },
      };
    },
    async getItems() { return []; },
    on() {},
    off() {},
  };
  const projectService = {
    async ensureThread() { return { id: 'thread-1' }; },
  };
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await runProjectTask('make changes', {
      state,
      projectService,
      turnManager,
      createConsoleStream() {
        return {
          status(line) { statuses.push(line); },
          onThinkingUpdate() {},
          onAnswerUpdate() {},
          onArtifactUpdate() {},
          finish(text) { finished = text; },
          fail() {},
        };
      },
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(finished, 'Final answer text');
  assert.equal(state.lastTurn.status, 'completed_without_artifact');
  assert.equal(state.responseHistory[0].text, 'Final answer text');
  assert.ok(logs.some((line) => line.includes('expected a ZIP artifact')));
});

test('normal project request.done with answer and zip enters result resolver under the project turn id', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-goal-normal-pipeline-'));
  const metadataStore = new MetadataStore(dir);
  await metadataStore.ready;

  const bridge = {
    async sendRequest(request, callbacks = {}) {
      callbacks.onEvent?.({ type: 'request.done', requestId: request.requestId, data: { answerLength: 20, artifactCount: 1 } });
      return {
        id: request.requestId,
        requestId: request.requestId,
        answer: 'Final normal summary',
        thinking: 'Visible thinking',
        artifacts: [{ id: 'artifact-zip', name: 'result.zip', mime: 'application/zip', requestId: request.requestId, sourceClientId: 'client-a' }],
        sourceClientId: 'client-a',
        turnKey: 'assistant-turn-normal',
        session: { id: 'session-normal' },
      };
    },
    cancelActive() { return 1; },
  };
  const resolverCalls = [];
  const resultResolver = {
    async resolve(job, response) {
      resolverCalls.push({ job, response });
      return {
        type: 'zip',
        status: 'ready',
        answer: response.answer,
        text: response.answer,
        artifacts: response.artifacts,
        artifactId: 'artifact-zip',
        fileId: 'file-zip',
        name: 'result.zip',
        sourceClientId: response.sourceClientId,
        sourceRequestId: response.requestId,
        sourceTurnKey: response.turnKey,
      };
    },
  };
  const manager = new TurnManager({ bridge, metadataStore, resultResolver });
  const thread = await manager.createThread({ title: 'Project', cwd: dir });
  const { turn } = await manager.startTurn({ threadId: thread.id, input: 'change project', output: { expected: 'zip', required: true } });

  let completed = null;
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    completed = await manager.getTurn(turn.id);
    if (completed.status === 'completed') break;
  }

  assert.equal(completed.status, 'completed');
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].job.id, turn.id);
  assert.equal(resolverCalls[0].response.requestId, turn.id);
  assert.equal(completed.output.type, 'zip');
  assert.equal(completed.output.fileId, 'file-zip');
  assert.equal(completed.output.sourceRequestId, turn.id);

  const events = await manager.getTurnEvents(turn.id, { limit: 100 });
  assert.ok(events.some((event) => event.type === 'request.done'));
  assert.ok(events.some((event) => event.type === 'normal.done.received'));
  assert.ok(events.some((event) => event.type === 'normal.pipeline.started'));
  assert.ok(events.some((event) => event.type === 'result/resolving'));
  assert.ok(events.some((event) => event.type === 'turn/completed'));
});

test('runProjectTask invalidates the previous selected result before waiting for a new task result', async () => {
  const oldTurn = { id: 'turn-old', status: 'completed', output: { type: 'zip', fileId: 'file-old' } };
  const state = { projectRoot: '/tmp/project', projectThreadId: 'thread-1', sessionId: 'session-1', responseHistory: [], lastTurnId: 'turn-old', lastTurn: oldTurn, currentTurnId: 'turn-old' };
  const turnManager = {
    async startTurn() {
      assert.equal(state.lastTurn, oldTurn);
      return { turn: { id: 'turn-new' } };
    },
    async getTurnEvents() { return []; },
    async getTurn() {
      assert.equal(state.lastTurn, null);
      return {
        id: 'turn-new',
        status: 'completed_without_artifact',
        completedAt: '2026-07-08T00:00:00.000Z',
        input: { output: { expected: 'zip', required: true } },
        output: { type: 'text', status: 'missing_required_artifact', answer: 'New final answer', artifacts: [] },
      };
    },
    async getItems() { return []; },
    on() {},
    off() {},
  };
  const projectService = { async ensureThread() { return { id: 'thread-1' }; } };

  await runProjectTask('make changes', {
    state,
    projectService,
    turnManager,
    createConsoleStream() {
      return { status() {}, onThinkingUpdate() {}, onAnswerUpdate() {}, onArtifactUpdate() {}, finish() {}, fail() {} };
    },
  });

  assert.equal(state.lastTurnId, 'turn-new');
  assert.equal(state.currentTurnId, 'turn-new');
  assert.equal(state.lastTurn.id, 'turn-new');
});


test('runProjectTask auto-applies a safe ZIP result after result.ready', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-goal-auto-apply-'));
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'src', 'app.js'), 'old');
  await initGit(projectRoot);

  const zipDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-goal-auto-zip-'));
  const zipPath = path.join(zipDir, 'updated.zip');
  await writeZip(zipPath, [{ name: 'project/src/app.js', data: Buffer.from('new') }]);
  const stat = await fs.stat(zipPath);

  const state = {
    projectRoot,
    projectThreadId: 'thread-1',
    sessionId: 'session-1',
    responseHistory: [],
    lastProjectScan: { manifest: { files: [{ path: 'src/app.js' }] } },
  };
  const applyEvents = [];
  const turnManager = {
    async startTurn() { return { turn: { id: 'turn-auto-apply' } }; },
    async getTurnEvents() { return []; },
    async getTurn() {
      return {
        id: 'turn-auto-apply',
        status: 'completed',
        completedAt: '2026-07-08T00:00:00.000Z',
        input: { output: { expected: 'zip', required: true } },
        output: { type: 'zip', status: 'ready', answer: 'Done', text: 'Done', fileId: 'file-auto-zip', name: 'updated.zip', artifacts: [{ id: 'artifact-auto' }] },
      };
    },
    async getItems() { return []; },
    async recordTurnEvent(turnId, type, data) { applyEvents.push({ turnId, type, data }); },
    on() {},
    off() {},
  };
  const fileStore = {
    async getReadable(fileId) { return { id: fileId, name: 'updated.zip', absolutePath: zipPath, size: stat.size }; },
    async remove() { return false; },
    async pruneArtifacts() { return []; },
  };
  const projectService = {
    async ensureThread() { return { id: 'thread-1' }; },
    async getLatestSnapshotManifest() { return state.lastProjectScan.manifest; },
  };
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await runProjectTask('make changes', {
      state,
      projectService,
      turnManager,
      fileStore,
      confirm: async () => false,
      createConsoleStream() {
        return { status() {}, onThinkingUpdate() {}, onAnswerUpdate() {}, onArtifactUpdate() {}, finish() {}, fail() {} };
      },
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(await fs.readFile(path.join(projectRoot, 'src', 'app.js'), 'utf8'), 'new');
  assert.equal(state.lastAppliedTurnId, 'turn-auto-apply');
  assert.equal(state.lastAppliedFileId, 'file-auto-zip');
  assert.ok(logs.some((line) => line.includes('safe plan detected')));
  assert.deepEqual(
    applyEvents.map((event) => event.type).filter((type) => type.startsWith('apply/')),
    ['apply/planning', 'apply/plan.ready', 'apply/auto.started', 'apply/done']
  );
});
