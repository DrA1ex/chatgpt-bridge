import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

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
    assert.equal(result.type, 'request.effect.reconciled');
    assert.equal(result.reconciliationOutcome, scenario.outcome);
    assert.equal(result.reconciliationReason, scenario.reason);
  });
}

test('effect reconciliation fails closed when the request projection is missing', async () => {
  const result = await makeHarness({ request: null }).reconcile({ effectType: 'prompt.submit' });
  assert.equal(result.reconciliationOutcome, 'uncertain');
  assert.equal(result.reconciliationReason, 'request_projection_missing_or_mismatched');
});
