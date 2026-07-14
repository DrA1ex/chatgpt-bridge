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
import { applyLastTurnResult, runProjectTask, summarizeAppliedChanges } from '../src/interactive/runtime.js';


const runGit = promisify(execFile);

async function waitForTurnStatus(manager, turnId, expectedStatus, { timeoutMs = 1500, intervalMs = 25 } = {}) {
  const startedAt = Date.now();
  let turn = null;
  while (Date.now() - startedAt <= timeoutMs) {
    turn = await manager.getTurn(turnId);
    if (turn?.status === expectedStatus) return turn;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`Timed out waiting for turn ${turnId} to become ${expectedStatus}; last status: ${turn?.status || 'unknown'}`);
}

async function waitForTurnEvent(manager, turnId, eventType, { timeoutMs = 1500, intervalMs = 25 } = {}) {
  const startedAt = Date.now();
  let events = [];
  while (Date.now() - startedAt <= timeoutMs) {
    events = await manager.getTurnEvents(turnId, { limit: 100 });
    if (events.some((event) => event.type === eventType)) return events;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`Timed out waiting for turn event ${eventType}; seen: ${events.map((event) => event.type).join(', ') || 'none'}`);
}

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

  const completed = await waitForTurnStatus(manager, turn.id, 'completed_without_artifact');
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
  assert.ok(statuses.some((line) => line.includes('expected a ZIP artifact')));
});

test('runProjectTask preserves the final answer when ZIP result processing fails', async () => {
  const state = { projectRoot: '/tmp/project', projectThreadId: 'thread-1', sessionId: 'session-1', responseHistory: [] };
  const statuses = [];
  let finished = '';
  let failed = false;
  const turnManager = {
    async startTurn() { return { turn: { id: 'turn-result-failed' } }; },
    async getTurnEvents() { return []; },
    async getTurn() {
      return {
        id: 'turn-result-failed',
        status: 'failed',
        completedAt: '2026-07-08T00:00:00.000Z',
        input: { output: { expected: 'zip', required: true } },
        error: { code: 'ZIP_VALIDATION_FAILED', message: 'ZIP validation failed' },
      };
    },
    async getItems() { return [{ type: 'agent_message', content: { text: 'Final answer survived resolver failure' } }]; },
    on() {},
    off() {},
  };
  const projectService = { async ensureThread() { return { id: 'thread-1' }; } };

  await assert.rejects(
    runProjectTask('make changes', {
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
          fail() { failed = true; },
        };
      },
    }),
    /ZIP validation failed/
  );

  assert.equal(finished, 'Final answer survived resolver failure');
  assert.equal(failed, false);
  assert.equal(state.responseHistory[0].text, 'Final answer survived resolver failure');
  assert.ok(statuses.some((line) => line.includes('final answer was preserved')));
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
    async resolve(operation, response) {
      resolverCalls.push({ operation, response });
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

  const completed = await waitForTurnStatus(manager, turn.id, 'completed');
  assert.equal(completed.status, 'completed');
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].operation.id, turn.id);
  assert.equal(resolverCalls[0].response.requestId, turn.id);
  assert.equal(completed.output.type, 'zip');
  assert.equal(completed.output.fileId, 'file-zip');
  assert.equal(completed.output.sourceRequestId, turn.id);

  const events = await waitForTurnEvent(manager, turn.id, 'turn/completed');
  assert.ok(events.some((event) => event.type === 'request.done'));
  assert.ok(events.some((event) => event.type === 'normal.done.received'));
  assert.ok(events.some((event) => event.type === 'normal.pipeline.started'));
  assert.ok(events.some((event) => event.type === 'result/resolving'));
  assert.ok(events.some((event) => event.type === 'turn/completed'));
});

test('normal result pipeline records a recoverable failure and preserves the final answer when ZIP resolution fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-goal-pipeline-failed-'));
  const metadataStore = new MetadataStore(dir);
  await metadataStore.ready;

  const bridge = {
    async sendRequest(request, callbacks = {}) {
      callbacks.onEvent?.({ type: 'request.done', requestId: request.requestId, data: { answerLength: 28, artifactCount: 1 } });
      return {
        requestId: request.requestId,
        answer: 'Final answer before ZIP failure',
        thinking: '',
        artifacts: [{ id: 'artifact-bad-zip', name: 'result.zip', mime: 'application/zip', sourceClientId: 'client-a' }],
        sourceClientId: 'client-a',
        turnKey: 'assistant-turn-bad-zip',
        session: { id: 'session-failed' },
      };
    },
    cancelActive() { return 1; },
  };
  const resultResolver = {
    async resolve() {
      const err = new Error('ZIP validation failed after final response');
      err.code = 'ZIP_VALIDATION_FAILED';
      throw err;
    },
  };
  const manager = new TurnManager({ bridge, metadataStore, resultResolver });
  const thread = await manager.createThread({ title: 'Project', cwd: dir });
  const { turn } = await manager.startTurn({ threadId: thread.id, input: 'change project', output: { expected: 'zip', required: true } });

  const failed = await waitForTurnStatus(manager, turn.id, 'failed');
  assert.equal(failed.error.code, 'ZIP_VALIDATION_FAILED');
  assert.equal(failed.error.recoverable, true);

  const items = await manager.getItems({ turnId: turn.id });
  assert.ok(items.some((item) => item.type === 'agent_message' && item.content?.text === 'Final answer before ZIP failure'));

  const events = await waitForTurnEvent(manager, turn.id, 'turn/failed');
  assert.ok(events.some((event) => event.type === 'normal.done.received'));
  assert.ok(events.some((event) => event.type === 'normal.pipeline.started'));
  assert.ok(events.some((event) => event.type === 'normal.pipeline.failed'));
  assert.equal(events.some((event) => event.type === 'normal.pipeline.missing_after_done'), false);
});

test('runProjectTask invalidates the previous selected result before waiting for a new task result', async () => {
  const oldTurn = { id: 'turn-old', status: 'completed', output: { type: 'zip', fileId: 'file-old' } };
  const state = { projectRoot: '/tmp/project', projectId: 'project-a', projectThreadId: 'thread-1', sessionId: 'session-1', responseHistory: [], lastTurnId: 'turn-old', lastTurn: oldTurn, currentTurnId: 'turn-old', selectedResult: { turnId: 'turn-old', projectId: 'project-a', projectRoot: '/tmp/project', fileId: 'file-old', artifactId: 'artifact-old', outputType: 'zip' } };
  const turnManager = {
    async startTurn() {
      assert.equal(state.lastTurn, oldTurn);
      return { turn: { id: 'turn-new' } };
    },
    async getTurnEvents() { return []; },
    async getTurn() {
      assert.equal(state.lastTurn, null);
      assert.equal(state.selectedResult?.stale, true);
      assert.equal(state.selectedResult?.staleReason, 'superseded_by_new_task');
      assert.equal(state.selectedResult?.replacedByTurnId, 'turn-new');
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
  assert.equal(state.selectedResult, null);
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
    projectId: 'project-auto',
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
        output: { type: 'zip', status: 'ready', answer: 'Done', text: 'Done', fileId: 'file-auto-zip', artifactId: 'artifact-auto', name: 'updated.zip', artifacts: [{ id: 'artifact-auto' }], sourceClientId: 'client-auto', sourceTurnKey: 'assistant-auto', sourceRequestId: 'turn-auto-apply' },
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
  assert.equal(state.selectedResult.turnId, 'turn-auto-apply');
  assert.equal(state.selectedResult.projectId, 'project-auto');
  assert.equal(state.selectedResult.sourceClientId, 'client-auto');
  assert.equal(state.selectedResult.artifactId, 'artifact-auto');
  assert.equal(state.selectedResult.fileId, 'file-auto-zip');
  assert.ok(logs.some((line) => line.includes('safe plan detected')));
  assert.ok(logs.some((line) => line.includes('Applied changes')));
  assert.ok(logs.some((line) => line.includes('~ src/app.js')));
  assert.deepEqual(
    applyEvents.map((event) => event.type).filter((type) => type.startsWith('apply/')),
    ['apply/planning', 'apply/plan.ready', 'apply/auto.started', 'apply/done']
  );
  const doneEvent = applyEvents.find((event) => event.type === 'apply/done');
  assert.deepEqual(doneEvent.data.updatedFiles, ['src/app.js']);
});


test('/apply refuses stale selected results before reading artifact files', async () => {
  const state = {
    projectRoot: '/tmp/project-a',
    projectId: 'project-a',
    currentTurnId: 'turn-new',
    lastTurnId: 'turn-new',
    selectedResult: { turnId: 'turn-old', projectId: 'project-a', projectRoot: '/tmp/project-a', fileId: 'file-old', stale: true, staleReason: 'superseded_by_new_task' },
  };
  const fileStore = { async getReadable() { assert.fail('stale apply must not read artifact file'); } };
  await assert.rejects(
    applyLastTurnResult(fileStore, state, { confirm: async () => false }),
    /older turn \(turn-old\).*current turn is turn-new/
  );
});

test('/apply refuses selected results from another project', async () => {
  const state = {
    projectRoot: '/tmp/project-b',
    projectId: 'project-b',
    currentTurnId: 'turn-1',
    lastTurnId: 'turn-1',
    selectedResult: { turnId: 'turn-1', projectId: 'project-a', projectRoot: '/tmp/project-a', fileId: 'file-a', outputType: 'zip' },
  };
  const fileStore = { async getReadable() { assert.fail('project mismatch must not read artifact file'); } };
  await assert.rejects(
    applyLastTurnResult(fileStore, state, { confirm: async () => false }),
    /another project \(project-a\).*current project is project-b/
  );
});

test('/apply refuses selected results from another ChatGPT session', async () => {
  const state = {
    projectRoot: '/tmp/project-a',
    projectId: 'project-a',
    sessionId: 'session-current',
    currentTurnId: 'turn-1',
    lastTurnId: 'turn-1',
    selectedResult: { turnId: 'turn-1', projectId: 'project-a', projectRoot: '/tmp/project-a', sessionId: 'session-old', fileId: 'file-a', outputType: 'zip' },
  };
  const fileStore = { async getReadable() { assert.fail('session mismatch must not read artifact file'); } };
  await assert.rejects(
    applyLastTurnResult(fileStore, state, { confirm: async () => false }),
    /another ChatGPT session \(session-old\).*current session is session-current/
  );
});

test('/apply refuses a selected result when its file is missing', async () => {
  const state = {
    projectRoot: '/tmp/project-a',
    projectId: 'project-a',
    currentTurnId: 'turn-1',
    lastTurnId: 'turn-1',
    selectedResult: { turnId: 'turn-1', projectId: 'project-a', projectRoot: '/tmp/project-a', fileId: 'file-missing', outputType: 'zip' },
  };
  const fileStore = { async getReadable() { return null; } };
  await assert.rejects(
    applyLastTurnResult(fileStore, state, { confirm: async () => false }),
    /file is missing or not readable: file-missing/
  );
});


test('auto /apply skips selected results without source client identity', async () => {
  const zipDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-goal-no-source-zip-'));
  const zipPath = path.join(zipDir, 'updated.zip');
  await writeZip(zipPath, [{ name: 'project/src/app.js', data: Buffer.from('new') }]);
  const stat = await fs.stat(zipPath);
  const state = {
    projectRoot: '/tmp/project-a',
    projectId: 'project-a',
    currentTurnId: 'turn-no-source',
    lastTurnId: 'turn-no-source',
    selectedResult: { turnId: 'turn-no-source', projectId: 'project-a', projectRoot: '/tmp/project-a', fileId: 'file-no-source', outputType: 'zip', confidence: 'manual' },
  };
  const applyEvents = [];
  const fileStore = { async getReadable(fileId) { return { id: fileId, name: 'updated.zip', absolutePath: zipPath, size: stat.size }; } };
  const turnManager = { async recordTurnEvent(turnId, type, data) { applyEvents.push({ turnId, type, data }); } };
  const result = await applyLastTurnResult(fileStore, state, { auto: true, confirm: async () => false, turnManager });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'missing_source_identity');
  assert.equal(state.lastAppliedTurnId || '', '');
  assert.ok(applyEvents.some((event) => event.type === 'apply/skipped' && event.data.reason === 'missing_source_identity'));
});


test('auto /apply refuses a low-confidence result even when source identity exists', async () => {
  const zipDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-goal-low-confidence-zip-'));
  const zipPath = path.join(zipDir, 'updated.zip');
  await writeZip(zipPath, [{ name: 'src/app.js', data: Buffer.from('new') }]);
  const stat = await fs.stat(zipPath);
  const state = {
    projectRoot: '/tmp/project-a',
    projectId: 'project-a',
    sessionId: 'session-a',
    currentTurnId: 'turn-low-confidence',
    lastTurnId: 'turn-low-confidence',
    selectedResult: {
      turnId: 'turn-low-confidence',
      projectId: 'project-a',
      projectRoot: '/tmp/project-a',
      sessionId: 'session-a',
      sourceClientId: 'client-a',
      fileId: 'file-low-confidence',
      outputType: 'zip',
      confidence: 'low',
    },
  };
  const applyEvents = [];
  const fileStore = { async getReadable(fileId) { return { id: fileId, name: 'updated.zip', absolutePath: zipPath, size: stat.size }; } };
  const turnManager = { async recordTurnEvent(turnId, type, data) { applyEvents.push({ turnId, type, data }); } };

  const result = await applyLastTurnResult(fileStore, state, { auto: true, confirm: async () => true, turnManager });
  assert.deepEqual(result, { skipped: true, reason: 'low_confidence_selected_result' });
  assert.equal(state.lastAppliedTurnId || '', '');
  assert.ok(applyEvents.some((event) => event.type === 'apply/skipped' && event.data.reason === 'low_confidence_selected_result'));
});

test('summarizeAppliedChanges separates created, updated, deleted, and skipped files', () => {
  const summary = summarizeAppliedChanges({
    plan: {
      create: [{ path: 'src/new.js' }],
      update: [{ path: 'src/app.js' }],
      localChanged: [{ path: 'README.md' }],
      delete: [{ path: 'old.txt' }],
      localChangedDelete: [],
    },
    written: [
      { path: 'src/new.js', conflict: false },
      { path: 'src/app.js', conflict: true },
      { path: 'README.md', conflict: true },
    ],
    deleted: [{ path: 'old.txt' }],
    skipped: [{ targetPath: 'node_modules/pkg/index.js', reason: 'node_modules' }],
  });
  assert.deepEqual(summary.created, ['src/new.js']);
  assert.deepEqual(summary.updated, ['README.md', 'src/app.js']);
  assert.deepEqual(summary.deleted, ['old.txt']);
  assert.deepEqual(summary.skipped, [{ path: 'node_modules/pkg/index.js', reason: 'node_modules' }]);
});

test('auto apply skip prints explicit decision and leaves dirty result selected', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-goal-auto-skip-'));
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'src', 'app.js'), 'old');
  await initGit(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'README.md'), 'dirty local change');

  const zipDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-goal-auto-skip-zip-'));
  const zipPath = path.join(zipDir, 'updated.zip');
  await writeZip(zipPath, [{ name: 'project/src/app.js', data: Buffer.from('new') }]);
  const stat = await fs.stat(zipPath);

  const state = {
    projectRoot,
    projectThreadId: 'thread-1',
    sessionId: 'session-1',
    responseHistory: [],
    currentTurnId: 'turn-dirty',
    lastTurnId: 'turn-dirty',
    lastTurn: { id: 'turn-dirty', status: 'completed', output: { type: 'zip', status: 'ready', fileId: 'file-dirty-zip', name: 'updated.zip', sourceClientId: 'client-dirty' } },
    lastProjectScan: { manifest: { files: [{ path: 'src/app.js' }, { path: 'README.md' }] } },
  };
  const applyEvents = [];
  const turnManager = { async recordTurnEvent(turnId, type, data) { applyEvents.push({ turnId, type, data }); } };
  const fileStore = {
    async getReadable(fileId) { return { id: fileId, name: 'updated.zip', absolutePath: zipPath, size: stat.size }; },
  };
  const projectService = { async getLatestSnapshotManifest() { return state.lastProjectScan.manifest; } };
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  let result;
  try {
    result = await applyLastTurnResult(fileStore, state, { auto: true, confirm: async () => false, projectService, turnManager });
  } finally {
    console.log = originalLog;
  }

  assert.equal(result.skipped, true);
  assert.equal(state.lastAppliedTurnId || '', '');
  assert.equal(state.lastTurn.id, 'turn-dirty');
  assert.ok(logs.some((line) => line.includes('auto-apply skipped')));
  assert.ok(logs.some((line) => line.includes('result remains selected')));
  assert.ok(applyEvents.some((event) => event.type === 'apply/skipped' && event.data.reason === 'DIRTY_WORKTREE'));
});
