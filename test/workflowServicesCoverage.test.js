import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  attachWorkflowInstructions,
  bootstrapWorkflowChat,
  buildWorkflowHandoff,
  isSessionExhaustionError,
  workflowInstructionText,
} from '../src/workflow/session/bootstrap.js';
import { WorkflowSessionService } from '../src/workflow/services/sessionService.js';
import { WorkflowResultRepairService } from '../src/workflow/services/resultRepairService.js';
import { WorkflowCommitService } from '../src/workflow/services/commitService.js';
import { WorkflowApplyCompletionService } from '../src/workflow/services/applyCompletionService.js';
import { WorkflowContextService } from '../src/workflow/services/contextService.js';
import { WorkflowDaemonRestartService } from '../src/workflow/services/daemonRestartService.js';
import { WorkflowCheckFailureService } from '../src/workflow/services/checkFailureService.js';
import { inspectGitRepository } from '../src/workflow/gitCommit.js';

const execFileAsync = promisify(execFile);

async function temporaryRoot(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function workflow(projectRoot, overrides = {}) {
  return {
    id: 'workflow-1',
    preset: 'fix-until-pass',
    projectRoot,
    watch: { sessionId: 'c/current', clientId: 'client-1' },
    ux: {
      label: 'Fix project checks',
      sessionExhaustion: 'start-new-chat',
      session: { maxTurns: 40 },
      invalidResponseAction: 'repair',
    },
    resultProtocol: { manifest: 'bridge-result.json', repairAction: 'repair', repairAttempts: 2 },
    automation: { maxCycles: 8, session: { policy: 'pinned', id: 'c/current' } },
    remediation: { enabled: true, maxAttempts: 2, sameChat: true, outputTailLines: 20 },
    commit: {
      mode: 'block', required: false, beginMarker: 'BEGIN', endMarker: 'END', style: 'short', prompt: '', maxContextBytes: 1024 * 1024,
      authorName: '', authorEmail: '',
      policy: { mode: 'automatic', iterationStrategy: 'checkpoint', completionStrategy: 'squash', includeOnlyWorkflowChanges: true },
    },
    daemonRestart: { enabled: false },
    ...overrides,
  };
}

function bootstrapMocks(root, { sessionId = 'c/new', answer = 'Ready', sourceClientId = 'client-new' } = {}) {
  const calls = { imported: [], sent: [], marked: [], packed: [], newSessions: [] };
  const fileStore = {
    async importLocalPath(options) {
      calls.imported.push(options);
      return { id: `file-${calls.imported.length}`, name: options.name, path: options.filePath };
    },
  };
  const projectService = {
    async pack(projectRoot, options) {
      calls.packed.push({ projectRoot, options });
      return { file: { id: 'project-file' }, project: { id: 'project-1' }, snapshotId: 'snapshot-1', sha256: 'sha-1' };
    },
    async markSnapshotUploaded(options) { calls.marked.push(options); },
  };
  const bridge = {
    async newSession(options) { calls.newSessions.push(options); return { session: { id: sessionId } }; },
    async sendRequest(options) { calls.sent.push(options); return { answer, sourceClientId, session: { id: options.sessionId || sessionId } }; },
  };
  return { calls, fileStore, projectService, bridge, dataDir: root };
}

test('workflow instruction attachment is separate, complete, and acknowledged in an existing chat', async () => {
  const root = await temporaryRoot('bridge-workflow-instructions-');
  const mocks = bootstrapMocks(root);
  const config = workflow(root, { preset: 'guided-task', resultProtocol: { manifest: 'custom-result.json' } });
  const content = workflowInstructionText(config);
  assert.match(content, /custom-result\.json/);
  assert.match(content, /complete project ZIP/);
  assert.match(content, /public registry URLs only/);
  assert.doesNotMatch(content, /Russian|Рус/);

  const result = await attachWorkflowInstructions({
    workflow: config,
    bridge: mocks.bridge,
    fileStore: mocks.fileStore,
    dataDir: root,
    sessionId: 'c/existing',
    sourceClientId: 'client-existing',
  });
  assert.equal(result.instructionsFileId, 'file-1');
  assert.equal(mocks.calls.sent[0].sessionId, 'c/existing');
  assert.deepEqual(mocks.calls.sent[0].attachments, ['file-1']);
  assert.equal(path.basename(mocks.calls.imported[0].filePath), 'bridge-workflow-instructions.md');
  assert.equal((await fs.readFile(mocks.calls.imported[0].filePath, 'utf8')).includes('custom-result.json'), true);

  await assert.rejects(() => attachWorkflowInstructions({ workflow: config }), /requires bridge and fileStore/);
  const noAck = bootstrapMocks(await temporaryRoot('bridge-workflow-instructions-no-ack-'), { answer: '' });
  await assert.rejects(() => attachWorkflowInstructions({ workflow: config, ...noAck, sessionId: 'c/existing' }), /did not acknowledge/);
});

test('new-chat bootstrap uploads project and instructions separately and records the remote snapshot', async () => {
  const root = await temporaryRoot('bridge-workflow-bootstrap-');
  const mocks = bootstrapMocks(root);
  const config = workflow(root);
  const result = await bootstrapWorkflowChat({ workflow: config, ...mocks, sourceClientId: 'client-source' });
  assert.equal(result.sessionId, 'c/new');
  assert.equal(result.projectFileId, 'project-file');
  assert.equal(result.instructionsFileId, 'file-1');
  assert.deepEqual(mocks.calls.sent[0].attachments, ['project-file', 'file-1']);
  assert.equal(mocks.calls.sent[0].effort, 'instant');
  assert.equal(mocks.calls.marked[0].threadId, 'c/new');
  assert.equal(mocks.calls.marked[0].snapshotId, 'snapshot-1');
  assert.equal(mocks.calls.marked[0].source, 'workflow-bootstrap');
  assert.equal(mocks.calls.packed[0].options.snapshotPolicy, 'always');

  await assert.rejects(() => bootstrapWorkflowChat({ workflow: config }), /requires bridge, fileStore, and projectService/);
  const noSession = bootstrapMocks(await temporaryRoot('bridge-workflow-bootstrap-no-session-'), { sessionId: '' });
  await assert.rejects(() => bootstrapWorkflowChat({ workflow: config, ...noSession }), /did not return a session id/);
  const noAck = bootstrapMocks(await temporaryRoot('bridge-workflow-bootstrap-no-ack-'), { answer: '' });
  await assert.rejects(() => bootstrapWorkflowChat({ workflow: config, ...noAck }), /did not acknowledge workflow initialization/);
});

test('session exhaustion detection and handoff include actionable workflow state', () => {
  for (const value of [
    { message: 'Context window exceeded' },
    { answer: 'The conversation is too long' },
    { code: 'CONVERSATION_NOT_FOUND' },
    { message: 'Chat is unavailable' },
    { code: 'WORKFLOW_SESSION_TURN_LIMIT' },
    { message: 'Repeated stale context failure' },
  ]) assert.equal(isSessionExhaustionError(value), true, JSON.stringify(value));
  assert.equal(isSessionExhaustionError({ message: 'Temporary network error' }), false);

  const handoff = buildWorkflowHandoff({
    workflow: { id: 'repair', ux: { label: 'Fix project checks' } },
    automation: { status: 'waiting_turn', cycle: 3, maxCycles: 8 },
    failingChecks: ['npm test: exit 1'],
    conclusions: ['The parser is not the cause'],
  });
  assert.match(handoff, /Original goal: Fix project checks/);
  assert.match(handoff, /Attempt: 3 of 8/);
  assert.match(handoff, /npm test: exit 1/);
  assert.match(handoff, /The parser is not the cause/);
  assert.match(handoff, /only current source of truth/);
});

test('session service counts turns per chat and resets the counter when the chat changes', async () => {
  const persisted = [];
  const runtime = {
    id: 'workflow-1',
    config: workflow('/tmp/project'),
    workflowTurnSessionId: '', workflowTurnCount: 9,
  };
  const service = new WorkflowSessionService({ persistRuntime: async (item) => persisted.push(item.workflowTurnCount) });
  const first = await service.prepareRequest(runtime, { sessionId: 'c/one', sourceClientId: 'client-one' });
  assert.deepEqual(first, { sessionId: 'c/one', sourceClientId: 'client-one', turn: 1, maxTurns: 40 });
  const second = await service.prepareRequest(runtime, { sessionId: 'c/one' });
  assert.equal(second.turn, 2);
  const switched = await service.prepareRequest(runtime, { sessionId: 'c/two' });
  assert.equal(switched.turn, 1);
  assert.equal(runtime.workflowTurnSessionId, 'c/two');
  assert.deepEqual(persisted, [1, 2, 1]);
});

test('session service implements stop, ask, unavailable, and automatic recovery policies', async () => {
  const root = await temporaryRoot('bridge-session-recovery-');
  const events = [];
  const persisted = [];

  const stopRuntime = { id: 'stop', config: workflow(root, { ux: { sessionExhaustion: 'stop', session: { maxTurns: 2 } } }) };
  const stopService = new WorkflowSessionService({ publish: async () => {}, persistRuntime: async () => {} });
  await assert.rejects(
    () => stopService.recover(stopRuntime, { error: new Error('context window exceeded') }),
    (error) => error.code === 'WORKFLOW_SESSION_EXHAUSTED',
  );

  const askRuntime = { id: 'ask', config: workflow(root, { ux: { sessionExhaustion: 'ask', session: { maxTurns: 2 } } }) };
  const askService = new WorkflowSessionService({
    publish: async (_id, type, data) => events.push({ type, data }),
    persistRuntime: async (runtime) => persisted.push(runtime.pendingSessionRecovery),
  });
  const ask = await askService.recover(askRuntime, { error: new Error('conversation is too long'), cycle: 2, automationId: 'automation-1' });
  assert.deepEqual(ask, { recovered: false, attention: true });
  assert.equal(askRuntime.pendingSessionRecovery.cycle, 2);
  assert.equal(events.at(-1).type, 'workflow.session.exhausted.ask');
  assert.equal(persisted.length, 1);

  const unavailableRuntime = { id: 'auto', config: workflow(root) };
  const unavailable = new WorkflowSessionService({ publish: async () => {}, persistRuntime: async () => {} });
  await assert.rejects(
    () => unavailable.recover(unavailableRuntime, { error: new Error('session is exhausted') }),
    (error) => error.code === 'WORKFLOW_SESSION_RECOVERY_UNAVAILABLE',
  );
  assert.equal(await unavailable.recover(unavailableRuntime, { error: new Error('network timeout') }), null);

  const mocks = bootstrapMocks(root, { sessionId: 'c/recovered', sourceClientId: 'client-recovered' });
  const autoRuntime = {
    id: 'auto',
    config: workflow(root),
    boundSessionId: 'c/old', boundSourceClientId: 'client-old', workflowTurnCount: 20,
  };
  const autoEvents = [];
  const autoService = new WorkflowSessionService({
    ...mocks,
    publish: async (_id, type, data) => autoEvents.push({ type, data }),
    persistRuntime: async () => {},
  });
  const recovered = await autoService.recover(autoRuntime, {
    error: new Error('context window exceeded'), automationId: 'automation-1', cycle: 4, maxCycles: 8,
    validation: { failed: [{ command: 'npm test', code: 1 }] },
  });
  assert.equal(recovered.sessionId, 'c/recovered');
  assert.equal(autoRuntime.config.watch.sessionId, 'c/recovered');
  assert.deepEqual(autoRuntime.config.automation.session, { policy: 'pinned', id: 'c/recovered' });
  assert.equal(autoRuntime.contextSyncFingerprint, 'snapshot-1');
  assert.equal(autoRuntime.pendingSessionRecovery, null);
  assert.equal(autoRuntime.workflowTurnCount, 0);
  assert.deepEqual(autoEvents.map((item) => item.type), ['workflow.session.recovery.started', 'workflow.session.recovery.completed']);
  assert.match(mocks.calls.sent[1].message, /npm test: exit 1/);
});

test('prepareRequest stops and exposes attention when turn-limit recovery needs a decision', async () => {
  const runtime = {
    id: 'workflow-1',
    config: workflow('/tmp/project', { ux: { sessionExhaustion: 'ask', session: { maxTurns: 1 } } }),
    workflowTurnSessionId: 'c/current', workflowTurnCount: 1,
  };
  const service = new WorkflowSessionService({
    publish: async () => {},
    persistRuntime: async () => {},
  });
  await assert.rejects(
    () => service.prepareRequest(runtime, {}),
    (error) => error.code === 'WORKFLOW_SESSION_AWAITING_DECISION',
  );
  assert.equal(Boolean(runtime.pendingSessionRecovery), true);
});

test('result repair service covers manual repair, automatic repair, exhaustion, and non-repair policies', async () => {
  const sent = [];
  const published = [];
  const transitioned = [];
  const processed = [];
  const bridge = {
    async sendRequest(options) {
      sent.push(options);
      return { answer: 'Corrected', artifacts: [{ id: 'zip-1' }], session: { id: options.sessionId || 'c/new' }, turnKey: 'turn-1' };
    },
  };
  const service = new WorkflowResultRepairService({
    bridge,
    publish: async (_id, type, data) => published.push({ type, data }),
    transition: async (_runtime, type, data, eventType, eventData) => transitioned.push({ type, data, eventType, eventData }),
    prepareRequest: async (_runtime, context) => ({ sessionId: `${context.sessionId}-prepared`, sourceClientId: 'prepared-client' }),
    processResponse: async (...args) => { processed.push(args); return { processed: true }; },
  });
  const runtime = {
    id: 'workflow-1',
    lastError: 'Missing bridge-result.json',
    lastSessionId: 'c/current', lastSourceClientId: 'client-1',
    config: workflow('/tmp/project'),
  };

  const manual = await service.requestManual(runtime);
  assert.deepEqual(manual, { processed: true });
  assert.match(sent[0].message, /Missing bridge-result\.json/);
  assert.equal(sent[0].sessionId, 'c/current-prepared');
  assert.equal(processed[0][2].source, 'manual-result-repair');

  const noSession = structuredClone(runtime);
  noSession.lastSessionId = '';
  noSession.config.watch.sessionId = '';
  await assert.rejects(() => service.requestManual(noSession), /not attached to a ChatGPT chat/);

  runtime.config.resultProtocol.repairAction = 'ask';
  assert.equal(await service.maybeRepair(runtime, {}, { pipelineId: 'pipeline-1', reasons: ['bad'] }), null);

  runtime.config.resultProtocol.repairAction = 'repair';
  runtime.config.resultProtocol.repairAttempts = 1;
  assert.equal(await service.maybeRepair(runtime, {}, { pipelineId: 'pipeline-1', reasons: ['bad'], context: { invalidResponseAttempt: 1 } }), null);
  assert.equal(published.some((item) => item.type === 'workflow.result.repair.exhausted'), true);

  const repaired = await service.maybeRepair(runtime, { sessionId: 'c/current', sourceClientId: 'client-1' }, {
    pipelineId: 'pipeline-2', reasons: ['unsafe path'], context: { invalidResponseAttempt: 0, custom: true },
  });
  assert.deepEqual(repaired, { processed: true });
  assert.equal(transitioned.at(-1).eventType, 'workflow.result.repair.started');
  assert.equal(sent.at(-1).output.expected, 'zip');
  assert.equal(processed.at(-1)[2].invalidResponseAttempt, 1);
});

test('validation remediation supports same-chat and fresh-chat repair requests', async () => {
  const sent = [];
  const processed = [];
  const service = new WorkflowResultRepairService({
    bridge: { async sendRequest(options) { sent.push(options); return { answer: 'fixed', artifacts: [], session: { id: 'c/result' } }; } },
    publish: async () => {},
    transition: async () => {},
    prepareRequest: async (_runtime, context) => ({ ...context, sessionId: `${context.sessionId}-prepared` }),
    processResponse: async (...args) => { processed.push(args); return { status: 'processed' }; },
  });
  const runtime = { id: 'workflow-1', config: workflow('/tmp/project') };
  const error = Object.assign(new Error('checks failed'), {
    commandResults: [{ command: 'npm test', stdout: 'a\nb\nc', stderr: 'failed' }],
  });
  const state = { pipelineId: 'pipeline-1', response: { session: { id: 'c/current' }, sourceClientId: 'client-1' } };
  assert.deepEqual(await service.remediate(runtime, state, error, 1), { status: 'processed' });
  assert.equal(sent[0].sessionId, 'c/current-prepared');
  assert.equal(sent[0].newSession, false);
  assert.match(sent[0].message, /VALIDATION_OUTPUT_BEGIN/);
  assert.equal(processed[0][2].remediationAttempt, 1);

  runtime.config.remediation.sameChat = false;
  await service.remediate(runtime, state, error, 2);
  assert.equal(sent[1].newSession, true);
  assert.equal(sent[1].sessionId, '');
});

test('context service records remote snapshots only when project service and chat binding are available', async () => {
  const runtime = { id: 'workflow-1', config: workflow('/tmp/project'), boundSessionId: '', contextSyncFingerprint: '' };
  const unavailable = new WorkflowContextService({ persistRuntime: async () => {} });
  assert.deepEqual(await unavailable.recordRemoteSnapshot(runtime, {}), { recorded: false, reason: 'project-service-unavailable' });

  const noSession = new WorkflowContextService({ projectService: { pack: async () => ({ snapshotId: 'snapshot' }) }, persistRuntime: async () => {} });
  runtime.config.watch.sessionId = '';
  assert.deepEqual(await noSession.recordRemoteSnapshot(runtime, {}), { recorded: false, reason: 'session-unbound' });

  let persisted = 0;
  const service = new WorkflowContextService({
    projectService: { async pack(root, options) { assert.equal(root, '/tmp/project'); assert.equal(options.snapshotPolicy, 'reuse'); return { snapshotId: 'snapshot-2' }; } },
    persistRuntime: async () => { persisted += 1; },
  });
  const recorded = await service.recordRemoteSnapshot(runtime, { session: { id: 'c/remote' } });
  assert.deepEqual(recorded, { recorded: true, sessionId: 'c/remote', fingerprintSha256: 'snapshot-2' });
  assert.equal(runtime.contextSyncedSessionId, 'c/remote');
  assert.equal(runtime.projectFingerprintSha256, 'snapshot-2');
  assert.equal(persisted, 1);
});

test('apply completion persists outcomes, tolerates snapshot-record failures, and records restart intent', async () => {
  const root = await temporaryRoot('bridge-apply-completion-');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  const artifacts = new Map([['artifact-1', { original: true }]]);
  const events = [];
  let refreshed = 0;
  const restartCalls = [];
  const daemon = new WorkflowDaemonRestartService({
    dataDir: root,
    restartHandler: async (request) => restartCalls.push(request),
    publish: async (_id, type, data) => events.push({ type, data }),
  });
  const service = new WorkflowApplyCompletionService({
    store: {
      async getArtifact(key) { return artifacts.get(key); },
      async setArtifact(key, value) { artifacts.set(key, value); },
    },
    transition: async (_runtime, _type, _data, eventType, eventData) => events.push({ type: eventType, data: eventData }),
    contextService: { async recordRemoteSnapshot() { throw new Error('snapshot failed'); } },
    daemonRestartService: daemon,
    syncRefresh: () => { refreshed += 1; },
    publish: async (_id, type, data) => events.push({ type, data }),
  });
  const runtime = {
    id: 'workflow-1', pendingCommit: { id: 'pending' }, lastError: '',
    config: workflow(root, { daemonRestart: { enabled: true, required: true, mode: 'exit', command: '', delayMs: 10, exitCode: 75 } }),
  };
  const result = await service.complete(runtime, {
    pipelineId: 'pipeline-1', artifactKey: 'artifact-1', applied: { written: ['app.js'] },
    extensionUpdate: { updated: true }, response: { sessionId: 'c/current' },
  }, { commit: { committed: true, sha: 'abc123' }, warnings: ['warning one'] });
  assert.equal(result.status, 'applied-with-warnings');
  assert.equal(result.daemonRestart.requested, true);
  assert.equal(runtime.pendingCommit, null);
  assert.equal(runtime.lastError, 'warning one');
  assert.equal(artifacts.get('artifact-1').daemonRestart.requested, true);
  assert.equal(restartCalls[0].expectedPackageVersion, '1.2.3');
  assert.equal(refreshed, 1);
  assert.equal(events.some((item) => item.type === 'workflow.context.snapshot.record.failed'), true);
  assert.equal(events.some((item) => item.type === 'workflow.completed_with_warnings'), true);
});

test('daemon restart service handles disabled, optional missing handler, and required missing handler', async () => {
  const root = await temporaryRoot('bridge-daemon-restart-');
  const events = [];
  const runtime = { id: 'workflow-1', config: workflow(root, { daemonRestart: { enabled: false } }) };
  const disabled = new WorkflowDaemonRestartService({ dataDir: root, publish: async () => {} });
  assert.deepEqual(await disabled.request(runtime, { pipelineId: 'pipeline-1' }), { requested: false, reason: 'disabled' });

  runtime.config.daemonRestart = { enabled: true, required: false };
  const optional = new WorkflowDaemonRestartService({ dataDir: root, publish: async (_id, type, data) => events.push({ type, data }) });
  assert.equal((await optional.request(runtime, { pipelineId: 'pipeline-1' })).reason, 'handler-unavailable');
  assert.equal(events[0].type, 'workflow.daemon.restart.failed');

  runtime.config.daemonRestart.required = true;
  await assert.rejects(() => optional.request(runtime, { pipelineId: 'pipeline-1' }), /no restart handler/);
});

async function createGitProject(prefix) {
  const root = await temporaryRoot(prefix);
  const git = async (...args) => (await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8' })).stdout.trim();
  await git('init');
  await git('config', 'user.name', 'Bridge Tests');
  await git('config', 'user.email', 'bridge-tests@example.com');
  await fs.writeFile(path.join(root, 'app.js'), 'initial\n');
  await git('add', 'app.js');
  await git('commit', '-m', 'Initial');
  return { root, git };
}

test('commit service covers disabled, no-change, approval, skip, final-only, and required repository policies', async () => {
  const events = [];
  const completed = [];
  const dataDir = await temporaryRoot('bridge-commit-service-data-');
  const service = new WorkflowCommitService({
    dataDir,
    publish: async (_id, type, data) => events.push({ type, data }),
    persistRuntime: async () => {},
    completeAppliedPipeline: async (...args) => { completed.push(args); return { completed: true }; },
  });

  const noGitRoot = await temporaryRoot('bridge-commit-no-git-');
  const noGitRuntime = { id: 'no-git', config: workflow(noGitRoot), workflowCommitPaths: [], workflowCommitPathStates: {}, workflowCommitShas: [] };
  assert.equal((await service.maybeCommit(noGitRuntime, {}, 'pipeline-1', { workflowPaths: [] })).reason, 'not-a-git-repository');
  noGitRuntime.config.commit.required = true;
  await assert.rejects(() => service.maybeCommit(noGitRuntime, {}, 'pipeline-1', { workflowPaths: [] }), /Git commit is required/);

  const { root, git } = await createGitProject('bridge-commit-service-');
  const runtime = { id: 'workflow-1', config: workflow(root), workflowCommitPaths: [], workflowCommitPathStates: {}, workflowCommitShas: [] };
  const clean = await service.maybeCommit(runtime, {}, 'pipeline-clean', { workflowPaths: ['app.js'] });
  assert.equal(clean.reason, 'no-changes');

  const preApplyGit = await inspectGitRepository(root);
  await fs.writeFile(path.join(root, 'app.js'), 'workflow change\n');
  runtime.config.commit.mode = 'none';
  const disabled = await service.maybeCommit(runtime, {}, 'pipeline-disabled', { preApplyGit, workflowPaths: ['app.js'] });
  assert.equal(disabled.reason, 'disabled');
  assert.deepEqual(runtime.workflowCommitPaths, ['app.js']);

  runtime.config.commit.mode = 'block';
  runtime.config.commit.policy.mode = 'ask';
  const pending = await service.maybeCommit(runtime, {}, 'pipeline-ask', {
    preApplyGit, workflowPaths: ['app.js'], verification: { resultProtocol: { manifest: { commitMessage: 'Update app' } } },
  });
  assert.equal(pending.reason, 'approval-required');
  runtime.pendingCommit = {
    pipelineId: 'pipeline-ask', artifactKey: 'artifact-1', message: pending.message, paths: pending.paths, pathStates: pending.pathStates,
    preApplyHead: preApplyGit.head, applied: {}, extensionUpdate: {}, warnings: [],
  };
  assert.deepEqual(await service.skipPending(runtime, 'Not now'), { completed: true });
  assert.equal(runtime.pendingCommit, null);
  assert.equal(completed.at(-1)[2].commit.reason, 'skipped-by-user');

  runtime.config.preset = 'fix-until-pass';
  runtime.config.commit.policy.mode = 'automatic';
  runtime.config.commit.policy.iterationStrategy = 'final-only';
  const deferred = await service.maybeCommit(runtime, {}, 'pipeline-final', {
    preApplyGit, workflowPaths: ['app.js'], verification: { resultProtocol: { manifest: { summary: 'Fix final workflow' } } },
  });
  assert.equal(deferred.reason, 'deferred-final');
  assert.equal(runtime.lastWorkflowCommitMessage, 'Fix final workflow');
  const final = await service.finalize(runtime, { automationId: 'automation-1' });
  assert.equal(final.committed, true);
  assert.equal(await git('log', '-1', '--pretty=%s'), 'Fix final workflow');
  assert.equal(runtime.workflowCommitShas.length, 1);
});

test('commit finalization honors nonautomatic policy and checkpoint count', async () => {
  const { root } = await createGitProject('bridge-commit-final-policy-');
  const events = [];
  const service = new WorkflowCommitService({ publish: async (_id, type, data) => events.push({ type, data }), persistRuntime: async () => {} });
  const runtime = {
    id: 'workflow-1', config: workflow(root), workflowCommitPaths: [], workflowCommitPathStates: {}, workflowCommitShas: [],
  };
  runtime.config.commit.policy.mode = 'ask';
  assert.deepEqual(await service.finalize(runtime), { committed: false, reason: 'policy' });
  runtime.config.commit.policy.mode = 'automatic';
  runtime.config.commit.policy.iterationStrategy = 'checkpoint';
  runtime.config.commit.policy.completionStrategy = 'squash';
  assert.deepEqual(await service.finalize(runtime), { squashed: false, reason: 'not-enough-checkpoints' });
});

test('failed-check keep-and-stop handles commit approval and immediate completion paths', async () => {
  const basePending = {
    id: 'decision-1', pipelineId: 'pipeline-1', artifactKey: 'artifact-1', workflowPaths: ['app.js'], pathStates: {},
    previousWorkflowPaths: [], previousPathStates: {}, preApplyGit: { head: 'base' }, verification: {}, response: {}, applied: { written: ['app.js'] },
  };
  const runtime = { id: 'workflow-1', config: workflow('/tmp/project'), pendingCheckFailure: structuredClone(basePending) };
  const transitions = [];
  const service = new WorkflowCheckFailureService({
    commitService: { async maybeCommit() { return { reason: 'approval-required', message: 'Keep app', pathStates: { 'app.js': { sha256: 'x' } } }; } },
    persistRuntime: async () => {},
    transition: async (...args) => transitions.push(args),
  });
  const pending = await service.keepAndStop(runtime);
  assert.equal(pending.status, 'pending-approval');
  assert.equal(runtime.pendingCommit.stopAfterCommit, true);
  assert.equal(transitions[0][3], 'workflow.commit.approval.required');

  let stopped = 0;
  runtime.pendingCheckFailure = structuredClone(basePending);
  const immediate = new WorkflowCheckFailureService({
    commitService: { async maybeCommit() { return { committed: false, reason: 'disabled' }; } },
    applyCompletionService: { async complete() { return { status: 'applied-with-warnings' }; } },
    stopWatcher: async () => { stopped += 1; },
  });
  assert.deepEqual(await immediate.keepAndStop(runtime), { status: 'applied-with-warnings' });
  assert.equal(stopped, 1);
  assert.equal(runtime.pendingCheckFailure, null);

  await assert.rejects(() => immediate.keepAndStop(runtime), /has no failed-check decision/);
});
