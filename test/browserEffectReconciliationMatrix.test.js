import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createPromptExecutionPlan, resumePromptExecutionPlan } from '../src/bridge/requestExecutionPlan.js';

const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestCommands.js'), 'utf8');

function makeHarness({
  request = {
    requestId: 'request-1',
    phase: 'waiting_for_response',
    options: {},
    sentAt: 100,
    submittedUserTurnKey: '',
    responseEpoch: 1,
  },
  sessionId = 'session-1',
  page = {},
  intelligence = {},
  composerText = '',
  composerRootText = '',
  attachmentNodes = [],
  generating = false,
} = {}) {
  const sent = [];
  const context = { console };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const composer = {
    value: composerText,
    innerText: composerText,
    textContent: composerText,
    closest: () => composerRoot,
  };
  const composerRoot = {
    innerText: composerRootText,
    textContent: composerRootText,
    querySelectorAll: () => attachmentNodes,
  };

  const commands = context.ChatGptRequestCommands.createRequestCommands({
    DOM_PARSER: {
      intelligenceOptionMatches(option, desired) {
        const value = String(option?.value || option?.label || option || '');
        return value.toLowerCase() === String(desired || '').toLowerCase();
      },
    },
    REQUEST_STATE: {
      createRequestState: () => ({}),
      publicRequestStatus: () => ({}),
    },
    getActiveRequest: () => request,
    getCurrentSession: () => ({ id: sessionId }),
    pagePresence: () => page,
    readIntelligenceState: async () => intelligence,
    findComposer: () => composer,
    findComposerRootStrict: () => composerRoot,
    findStopButton: () => (generating ? {} : null),
    isGenerating: () => generating,
    send: (message) => sent.push(structuredClone(message)),
    settleEffectReconciliation: async (message) => sent.push({ type: 'bridge.effect.reconcile_result', ...structuredClone(message) }),
    diagnostic: () => {},
  });

  return {
    async reconcile(payload = {}) {
      await commands.handleEffectReconcile({
        commandId: 'command-1',
        requestId: request?.requestId || 'request-1',
        effectId: 'effect-1',
        ...payload,
      });
      return sent.at(-1);
    },
  };
}

const cases = [
  {
    name: 'page readiness succeeds only from observed page evidence',
    options: { page: { pageReady: true } },
    payload: { effectType: 'page.ready.initial' },
    outcome: 'succeeded', reason: 'page_readiness_observed',
  },
  {
    name: 'session apply succeeds when the exact desired session is observed',
    options: { sessionId: 'session-2' },
    payload: { effectType: 'session.apply', evidence: { desiredSessionId: 'session-2' } },
    outcome: 'succeeded', reason: 'expected_session_observed',
  },
  {
    name: 'session apply is not started when its stage was never reached',
    options: { request: { requestId: 'request-1', phase: 'page_ready', options: {}, responseEpoch: 1 }, sessionId: 'old' },
    payload: { effectType: 'session.apply', evidence: { desiredSessionId: 'new', previousSessionId: 'old' } },
    outcome: 'not_started', reason: 'session_stage_not_reached',
  },
  {
    name: 'model apply succeeds only when both selected values match',
    options: { intelligence: { selectedModel: { value: 'gpt-5' }, selectedEffort: { value: 'high' } } },
    payload: { effectType: 'model.apply', evidence: { model: 'gpt-5', effort: 'high' } },
    outcome: 'succeeded', reason: 'selected_intelligence_matches_expected',
  },
  {
    name: 'model apply stays uncertain after its stage when selection differs',
    options: { intelligence: { selectedModel: { value: 'gpt-4' }, selectedEffort: { value: 'low' } } },
    payload: { effectType: 'model.apply', evidence: { model: 'gpt-5', effort: 'high' } },
    outcome: 'uncertain', reason: 'selected_intelligence_does_not_match_expected',
  },
  {
    name: 'attachment upload succeeds from exact visible names',
    options: { composerRootText: 'alpha.txt beta.zip' },
    payload: { effectType: 'attachments.upload', evidence: { attachments: [{ name: 'alpha.txt' }, { name: 'beta.zip' }] } },
    outcome: 'succeeded', reason: 'expected_attachment_names_visible_in_composer',
  },
  {
    name: 'attachment upload is not started before its stage with an empty composer',
    options: { request: { requestId: 'request-1', phase: 'model_applied', options: {}, responseEpoch: 1 } },
    payload: { effectType: 'attachments.upload', evidence: { attachmentCount: 1 } },
    outcome: 'not_started', reason: 'attachment_stage_not_reached',
  },
  {
    name: 'prompt submit succeeds only after a submitted user turn is observed',
    options: { request: { requestId: 'request-1', phase: 'waiting_for_response', options: {}, submittedUserTurnKey: 'user-1', responseEpoch: 1 } },
    payload: { effectType: 'prompt.submit', evidence: { message: 'hello' } },
    outcome: 'succeeded', reason: 'submitted_user_turn_observed',
  },
  {
    name: 'prompt submit is proved not started when exact text remains in composer',
    options: { composerText: 'hello' },
    payload: { effectType: 'prompt.submit', evidence: { message: 'hello' } },
    outcome: 'not_started', reason: 'expected_prompt_still_in_composer',
  },
  {
    name: 'prompt submit remains uncertain without a turn or composer proof',
    options: { composerText: '' },
    payload: { effectType: 'prompt.submit', evidence: { message: 'hello' } },
    outcome: 'uncertain', reason: 'prompt_submission_not_provable',
  },
  {
    name: 'prompt cancel succeeds only when generation is quiescent',
    options: { generating: false },
    payload: { effectType: 'prompt.cancel' },
    outcome: 'succeeded', reason: 'generation_is_quiescent',
  },
  {
    name: 'prompt cancel remains uncertain while generation is active',
    options: { generating: true },
    payload: { effectType: 'prompt.cancel' },
    outcome: 'uncertain', reason: 'generation_still_active',
  },
  {
    name: 'artifact reconciliation succeeds from a completed background capture',
    payload: { effectType: 'artifact.download', backgroundEvidence: { downloads: [{ status: 'completed' }] } },
    outcome: 'succeeded', reason: 'download_capture_completed',
  },
  {
    name: 'artifact reconciliation is not started for a planned undispatched effect',
    payload: { effectType: 'artifact.download', backgroundEvidence: { effect: { status: 'planned' }, downloads: [] } },
    outcome: 'not_started', reason: 'background_effect_not_dispatched',
  },
  {
    name: 'artifact reconciliation proves failure from a failed capture',
    payload: { effectType: 'artifact.download', backgroundEvidence: { downloads: [{ status: 'failed' }] } },
    outcome: 'failed', reason: 'download_capture_failed',
  },
  {
    name: 'unknown read-only effect can succeed only under explicit always policy and active projection',
    payload: { effectType: 'diagnostic.read', retryPolicy: 'always' },
    outcome: 'succeeded', reason: 'read_only_stage_has_active_projection',
  },
];

for (const scenario of cases) {
  test(scenario.name, async () => {
    const result = await makeHarness(scenario.options).reconcile(scenario.payload);
    assert.equal(result.type, 'bridge.effect.reconcile_result');
    assert.equal(result.reconciliationOutcome, scenario.outcome);
    assert.equal(result.reconciliationReason, scenario.reason);
  });
}

test('effect reconciliation fails closed when the request projection is missing', async () => {
  const result = await makeHarness({ request: null }).reconcile({ effectType: 'prompt.submit' });
  assert.equal(result.reconciliationOutcome, 'uncertain');
  assert.equal(result.reconciliationReason, 'request_projection_missing_or_mismatched');
});

test('proved pre-submit session effect resumes the remaining prompt pipeline after content reload', async () => {
  const context = {
    console,
    location: { href: 'https://chatgpt.com/c/session-1' },
    document: { title: 'Session' },
    Set,
    Date,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const sent = [];
  const effects = [];
  const request = {
    requestId: 'request-recovered',
    leaseId: 'lease-recovered',
    ownerServerInstanceId: 'server-recovered',
    recovering: true,
    responseEpoch: 0,
    sentAt: 0,
    submittedUserTurnKey: '',
    update(type, data = {}) {
      if (type === 'request.executor_updated' || type === 'request.anchor_updated') Object.assign(this, data);
    },
  };
  const turnNodes = [{ id: 'old-user' }, { id: 'old-assistant' }];
  const commands = context.ChatGptRequestCommands.createRequestCommands({
    REQUEST_STATE: {
      createRequestState() { throw new Error('recovery must reuse the restored executor projection'); },
      publicRequestStatus: () => ({}),
    },
    DOM_PARSER: {},
    getActiveRequest: () => request,
    setActiveRequest() { throw new Error('recovery must not claim a second executor projection'); },
    getConnectedServerInstanceId: () => 'server-recovered',
    getCurrentSession: () => ({ id: 'session-1' }),
    applySessionOptions: async () => { throw new Error('proved session.apply must not run twice'); },
    applyModelOptions: async () => ({ model: 'gpt-test' }),
    attachFiles: async () => {},
    waitForDocumentReady: async () => { throw new Error('proved page readiness must not run twice'); },
    waitForChatPageReady: async () => {},
    getAssistantNodes: () => [],
    getTurnNodes: () => turnNodes,
    turnKey: (node, index) => `${node.id}-${index}`,
    startDomMonitor: () => {},
    enterPrompt: async (message) => assert.equal(message, 'continue after reload'),
    waitForSubmittedUserTurnAnchor: async () => { request.submittedUserTurnKey = 'user-new'; },
    refreshRequestTurnAnchors: () => {},
    collectAndEmit: () => {},
    runObservedRequestEffect: async (_request, type, execute) => {
      effects.push(type);
      return await execute();
    },
    send: (message) => sent.push(structuredClone(message)),
    setRequestPhase: (_request, phase) => { request.phase = phase; },
    emitChatEvent: () => {},
    diagnostic: () => {},
    schedulePageStatus: () => {},
    scheduleTabObservation: () => {},
    simpleHash: (value) => `hash:${value}`,
    reportExecutionFailure: (_request, error) => { throw error; },
  });

  const initialPlan = createPromptExecutionPlan({
    request: {
      requestId: request.requestId,
      leaseId: request.leaseId,
      ownerServerInstanceId: request.ownerServerInstanceId,
      responseEpoch: request.responseEpoch,
    },
    message: 'continue after reload',
    options: { sessionId: 'session-1' },
    attachments: [],
  });
  const executionPlan = resumePromptExecutionPlan(initialPlan, {
    effectType: 'session.apply',
    mode: 'continue_after',
  });
  const sessionEffectId = initialPlan.steps.find((step) => step.kind === 'session.apply').effectId;
  await commands.handlePromptSend({
    type: 'prompt.send',
    commandId: 'resume-model-command',
    requestId: request.requestId,
    message: 'continue after reload',
    options: { sessionId: 'session-1' },
    attachments: [],
    executionPlan,
    executionStepOnly: true,
    continuationOfEffectId: sessionEffectId,
    recoveryOfEffectId: sessionEffectId,
  });

  assert.deepEqual(effects, ['model.apply']);
  assert.equal(request.sentAt, 0);
  assert.deepEqual(sent.filter((message) => message.type === 'command.result'), []);
  assert.equal(sent.some((message) => message.type === 'prompt.execution.step.completed'), false);

  const modelEffectId = executionPlan.steps.find((step) => step.kind === 'model.apply').effectId;
  const promptPlan = resumePromptExecutionPlan(executionPlan, {
    effectId: modelEffectId,
    mode: 'continue_after',
  });
  await commands.handlePromptSend({
    type: 'prompt.send',
    commandId: 'resume-prompt-command',
    requestId: request.requestId,
    message: 'continue after reload',
    options: { sessionId: 'session-1' },
    attachments: [],
    executionPlan: promptPlan,
    executionStepOnly: true,
    continuationOfEffectId: modelEffectId,
  });

  assert.deepEqual(effects, ['model.apply', 'prompt.submit']);
  assert.equal(request.recovering, false);
  assert.ok(request.sentAt > 0);
  assert.equal(request.submittedUserTurnKey, 'user-new');
  assert.equal(sent.some((message) => message.type === 'command.error'), false);
  assert.equal(sent.some((message) => message.type === 'prompt.accepted'), false);
  assert.equal(sent.filter((message) => message.type === 'command.result').length, 0);
  assert.equal(sent.some((message) => message.type === 'prompt.execution.step.completed'), false);
});

test('request.resume rehydrates canonical response anchors only after proving the submitted turn boundary', async () => {
  const context = {
    console,
    location: { href: 'https://chatgpt.com/c/session-1' },
    document: { title: 'Session' },
    Date,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const sent = [];
  const updates = [];
  let collected = 0;
  const request = {
    requestId: 'request-reload',
    submittedUserTurnKey: '',
    assistantTurnKey: '',
    responseEpoch: 0,
    update(type, patch) {
      updates.push({ type, patch: structuredClone(patch) });
      Object.assign(this, patch);
    },
  };
  const turns = [
    { key: 'user-current', textContent: 'finish after reload', getAttribute: (name) => name === 'data-turn' ? 'user' : null, querySelector: () => null },
    { key: 'assistant-current', textContent: 'partial', getAttribute: (name) => name === 'data-turn' ? 'assistant' : null, querySelector: () => null },
  ];
  const commands = context.ChatGptRequestCommands.createRequestCommands({
    REQUEST_STATE: {
      createRequestState: () => ({}),
      publicRequestStatus: (value) => ({
        requestId: value.requestId,
        responseEpoch: value.responseEpoch,
        submittedUserTurnKey: value.submittedUserTurnKey,
        assistantTurnKey: value.assistantTurnKey,
      }),
    },
    DOM_PARSER: {},
    getActiveRequest: () => request,
    getCurrentSession: () => ({ id: 'session-1' }),
    getTurnNodes: () => turns,
    turnKey: (turn) => turn.key,
    normalizeText: (value) => String(value || '').trim().replace(/\s+/g, ' '),
    waitForChatPageReady: async () => {},
    resumeBoundaryTimeoutMs: 0,
    findStopButton: () => null,
    isGenerating: () => false,
    send: (message) => sent.push(structuredClone(message)),
    settleEffectReconciliation: async (message) => sent.push({ type: 'bridge.effect.reconcile_result', ...structuredClone(message) }),
    diagnostic: () => {},
    startDomMonitor: () => {},
    collectAndEmit: () => { collected += 1; },
  });

  await commands.handleRequestResume({
    commandId: 'resume-command',
    requestId: request.requestId,
    projection: {
      responseEpoch: 2,
      submittedUserTurnKey: 'user-current',
      submittedUserTurnIndex: 0,
      assistantTurnKey: 'assistant-current',
      assistantTurnIndex: 1,
      submittedPromptText: 'finish after reload',
      sentAt: 1234,
    },
  });

  assert.deepEqual(updates, [{
    type: 'request.anchor_updated',
    patch: {
      responseEpoch: 2,
      submittedUserTurnKey: 'user-current',
      submittedUserTurnIndex: 0,
      assistantTurnKey: 'assistant-current',
      assistantTurnIndex: 1,
      sentAt: 1234,
    },
  }]);
  assert.equal(sent.at(-1).type, 'request.resumed');
  assert.equal(sent.at(-1).boundaryStatus, 'matched');
  assert.equal(sent.at(-1).activeRequest.submittedUserTurnKey, 'user-current');
  assert.equal(collected, 1);
});

test('request.resume rebinds a changed DOM turn key only from exact submitted prompt text', async () => {
  const context = { console, location: { href: 'https://chatgpt.com/c/session-1' }, document: { title: 'Session' }, Date };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  const sent = [];
  const request = {
    requestId: 'request-rebound', submittedUserTurnKey: '', assistantTurnKey: '', responseEpoch: 0,
    update(_type, patch) { Object.assign(this, patch); },
  };
  const turns = [
    { key: 'user-new-key', textContent: 'same exact prompt', getAttribute: (name) => name === 'data-turn' ? 'user' : null, querySelector: () => null },
    { key: 'assistant-new-key', textContent: 'response', getAttribute: (name) => name === 'data-turn' ? 'assistant' : null, querySelector: () => null },
  ];
  const commands = context.ChatGptRequestCommands.createRequestCommands({
    REQUEST_STATE: { createRequestState: () => ({}), publicRequestStatus: () => ({ requestId: request.requestId }) },
    DOM_PARSER: {}, getActiveRequest: () => request, getCurrentSession: () => ({ id: 'session-1' }),
    getTurnNodes: () => turns, turnKey: (turn) => turn.key,
    normalizeText: (value) => String(value || '').trim().replace(/\s+/g, ' '),
    waitForChatPageReady: async () => {}, resumeBoundaryTimeoutMs: 0, findStopButton: () => null, isGenerating: () => false,
    send: (message) => sent.push(structuredClone(message)), diagnostic: () => {}, startDomMonitor: () => {}, collectAndEmit: () => {},
  });
  await commands.handleRequestResume({
    commandId: 'resume-rebound', requestId: request.requestId,
    projection: { responseEpoch: 1, submittedUserTurnKey: 'user-old-key', submittedPromptText: 'same exact prompt' },
  });
  assert.equal(sent.at(-1).boundaryStatus, 'rebound');
  assert.equal(sent.at(-1).submittedUserTurnKey, 'user-new-key');
  assert.equal(request.assistantTurnKey, 'assistant-new-key');
});

test('request.resume reports a missing boundary instead of attaching an older assistant turn', async () => {
  const context = { console, location: { href: 'https://chatgpt.com/c/session-1' }, document: { title: 'Session' }, Date };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  const sent = [];
  const request = {
    requestId: 'request-missing', submittedUserTurnKey: '', assistantTurnKey: '', responseEpoch: 0,
    update(_type, patch) { Object.assign(this, patch); },
  };
  const turns = [
    { key: 'old-user', textContent: 'previous prompt', getAttribute: (name) => name === 'data-turn' ? 'user' : null, querySelector: () => null },
    { key: 'old-assistant', textContent: 'previous answer', getAttribute: (name) => name === 'data-turn' ? 'assistant' : null, querySelector: () => null },
  ];
  const commands = context.ChatGptRequestCommands.createRequestCommands({
    REQUEST_STATE: { createRequestState: () => ({}), publicRequestStatus: () => ({ requestId: request.requestId }) },
    DOM_PARSER: {}, getActiveRequest: () => request, getCurrentSession: () => ({ id: 'session-1' }),
    getTurnNodes: () => turns, turnKey: (turn) => turn.key,
    normalizeText: (value) => String(value || '').trim().replace(/\s+/g, ' '),
    waitForChatPageReady: async () => {}, resumeBoundaryTimeoutMs: 0, findStopButton: () => null, isGenerating: () => false,
    send: (message) => sent.push(structuredClone(message)), diagnostic: () => {}, startDomMonitor: () => {}, collectAndEmit: () => {},
  });
  await commands.handleRequestResume({
    commandId: 'resume-missing', requestId: request.requestId,
    projection: { responseEpoch: 1, submittedUserTurnKey: 'missing-user', submittedPromptText: 'new prompt' },
  });
  assert.equal(sent.at(-1).boundaryStatus, 'missing');
  assert.equal(request.assistantTurnKey, '');
  assert.equal(request.submittedUserTurnKey, 'missing-user');
});
