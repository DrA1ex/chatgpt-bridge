import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createPromptExecutionPlan, resumePromptExecutionPlan } from '../src/bridge/requestExecutionPlan.js';

const COMMAND_FILES = [
  'tools/chrome-bridge-extension/content/requestCommandSupport.js',
  'tools/chrome-bridge-extension/content/requestResumeCommands.js',
  'tools/chrome-bridge-extension/content/requestResponseRetry.js',
  'tools/chrome-bridge-extension/content/requestReleaseCommand.js',
  'tools/chrome-bridge-extension/content/requestPromptAdmission.js',
  'tools/chrome-bridge-extension/content/requestPromptCommands.js',
];
const sources = await Promise.all(COMMAND_FILES.map((file) => fs.readFile(path.resolve(file), 'utf8')));

function makeHarness({ anchor = null, requestKeyAfterAnchor = '', initialRequestKey = '' } = {}) {
  const context = { console };
  context.globalThis = context;
  vm.createContext(context);
  for (const source of sources) vm.runInContext(source, context);

  const request = {
    requestId: 'request-admission',
    leaseId: 'lease-admission',
    ownerServerInstanceId: 'server-admission',
    responseEpoch: 0,
    phase: 'model_applied',
    options: {},
    sentAt: 0,
    submittedUserTurnKey: initialRequestKey,
    update(_type, data = {}) { Object.assign(this, data); },
  };
  let activeRequest = request;
  const errors = [];
  const effectResults = [];
  const turns = [{ key: 'user-existing' }];
  const commands = context.ChatGptRequestPromptCommands.createRequestPromptCommands({
    REQUEST_STATE: { createRequestState() { throw new Error('prompt continuation must retain its request state'); } },
    applyModelOptions: async () => {},
    applySessionOptions: async () => {},
    attachFiles: async () => {},
    baselinePassiveTurns: () => {},
    clickStopButton: () => false,
    collectAndEmit: () => {},
    diagnostic: () => {},
    emitChatEvent: () => {},
    enterPrompt: async () => {},
    findStopButton: () => null,
    getActiveRequest: () => activeRequest,
    getAssistantNodes: () => [],
    getConnectedServerInstanceId: () => 'server-admission',
    getCurrentSession: () => ({ id: 'session-admission' }),
    getTurnNodes: () => turns,
    isGenerating: () => false,
    markRequestProgress: () => {},
    refreshRequestTurnAnchors: () => {},
    registerPassivePromptBoundary: () => {},
    releaseRequest: () => true,
    settleReleaseCleanup: async () => {},
    runObservedRequestEffect: async (_request, _kind, execute, options = {}) => {
      const result = await execute();
      effectResults.push(options.result ? options.result(result) : result);
    },
    schedulePageStatus: () => {},
    schedulePassiveTurnScan: () => {},
    scheduleTabObservation: () => {},
    send: () => {},
    setActiveRequest: (value) => { activeRequest = value; },
    setRequestPhase: (value, phase) => { value.phase = phase; },
    simpleHash: (value) => `hash:${value}`,
    startDomMonitor: () => {},
    turnKey: (turn) => turn.key,
    waitForChatPageReady: async () => {},
    waitForDocumentReady: async () => {},
    waitForSubmittedUserTurnAnchor: async (value) => {
      if (requestKeyAfterAnchor) value.submittedUserTurnKey = requestKeyAfterAnchor;
      return anchor;
    },
    readSubmittedUserTurnError: () => ({ hasError: false }),
    requestCommandSupport: {
      settleEffectCommandWithoutExecution: async (...args) => { errors.push(args[3]); },
    },
  });

  const initialPlan = createPromptExecutionPlan({
    request: {
      requestId: request.requestId,
      leaseId: request.leaseId,
      ownerServerInstanceId: request.ownerServerInstanceId,
      responseEpoch: request.responseEpoch,
    },
    message: 'admission check prompt',
    options: { sessionId: 'session-admission' },
    attachments: [],
  });
  const previousEffectId = initialPlan.steps.find((step) => step.kind === 'model.apply').effectId;
  const executionPlan = resumePromptExecutionPlan(initialPlan, { effectType: 'model.apply', mode: 'continue_after' });

  return {
    request,
    errors,
    effectResults,
    async submit() {
      await commands.handlePromptSend({
        type: 'prompt.send',
        commandId: 'prompt-admission-command',
        requestId: request.requestId,
        leaseId: request.leaseId,
        ownerServerInstanceId: request.ownerServerInstanceId,
        responseEpoch: request.responseEpoch,
        message: 'admission check prompt',
        options: { sessionId: 'session-admission' },
        attachments: [],
        executionPlan,
        executionStepOnly: true,
        continuationOfEffectId: previousEffectId,
      });
    },
  };
}

test('prompt submission fails closed when ChatGPT does not expose a new matching user turn', async () => {
  for (const scenario of [
    { name: 'missing anchor', anchor: null, requestKeyAfterAnchor: '' },
    { name: 'old anchor', anchor: { key: 'user-existing' }, requestKeyAfterAnchor: 'user-existing' },
    { name: 'mismatched request anchor', anchor: { key: 'user-new' }, requestKeyAfterAnchor: 'user-other' },
  ]) {
    const harness = makeHarness(scenario);
    await harness.submit();

    assert.equal(harness.errors.length, 1, scenario.name);
    assert.equal(harness.errors[0]?.code, 'PROMPT_USER_TURN_ADMISSION_UNCONFIRMED', scenario.name);
    assert.equal(harness.request.phase, 'waiting_for_user_turn', scenario.name);
    assert.equal(harness.effectResults.length, 0, scenario.name);
  }
});

test('prompt submission admits the exact new user-turn key returned by ChatGPT', async () => {
  const harness = makeHarness({
    anchor: { key: 'user-new' },
    requestKeyAfterAnchor: 'user-new',
  });
  await harness.submit();

  assert.equal(harness.errors.length, 0);
  assert.equal(harness.effectResults.length, 1);
  assert.equal(harness.effectResults[0]?.submittedUserTurnKey, 'user-new');
});
