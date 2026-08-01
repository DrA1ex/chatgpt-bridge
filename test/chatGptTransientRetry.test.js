import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  GenerationState,
  OutputState,
  RequestBlocker,
  RequestDeadlineKind,
  RequestEffectType,
  RequestEventType,
  RequestTerminalCode,
  createRequestEvent,
} from '../src/bridge/state/requestEvents.js';
import { reduceRequestState } from '../src/bridge/state/requestMachine.js';
import { deadlineIntentsForRequest } from '../src/bridge/deadlines/requestDeadlinePolicy.js';
import { createPromptResponseRetryPlan } from '../src/bridge/requestExecutionPlan.js';

function event(type, data = {}, at = 1) {
  return createRequestEvent(type, 'retry-request', data, { occurredAt: at, receivedAt: at });
}

function created(policy = { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 8_000 }) {
  return reduceRequestState(null, event(RequestEventType.CREATED, {
    submittedUserTurnKey: 'user-1',
    responseEpoch: 0,
    responseRetryPolicy: policy,
  }, 1)).state;
}

function transientObservation(userTurnKey = 'user-1', at = 10) {
  return event(RequestEventType.OBSERVATION_UPDATED, {
    responseEpoch: 0,
    blocker: RequestBlocker.EXPLICIT_ERROR,
    generation: GenerationState.STOPPED,
    output: OutputState.NONE,
    explicitError: true,
    errorRetryable: true,
    errorCode: 'CHATGPT_TRANSIENT_REQUEST_ERROR',
    errorKind: 'transient_request_error',
    errorMessage: 'Something went wrong. Please try again.',
    failedUserTurnKey: userTurnKey,
  }, at);
}

test('explicit ChatGPT submission error schedules bounded exponential retry instead of terminal failure', () => {
  const first = reduceRequestState(created(), transientObservation());
  assert.equal(first.state.terminal, null);
  assert.equal(first.state.responseRetry.status, 'scheduled');
  assert.equal(first.state.responseRetry.scheduledAttempt, 1);
  assert.equal(first.state.responseRetry.dueAt, 1_010);
  assert.equal(first.state.blocker, RequestBlocker.RECOVERY);
  assert.equal(first.deadlines[0].kind, RequestDeadlineKind.RESPONSE_RETRY);

  const duplicate = reduceRequestState(first.state, transientObservation('user-1', 20));
  assert.equal(duplicate.state.responseRetry.scheduledAttempt, 1);
  assert.equal(duplicate.deadlines.length, 0);

  const intents = deadlineIntentsForRequest(first.state, {
    meaningfulProgressTimeoutMs: 120_000,
    hardLivenessTimeoutMs: 60_000,
  });
  const retryIntent = intents.find((item) => item.kind === RequestDeadlineKind.RESPONSE_RETRY);
  assert.equal(retryIntent.dueAt, 1_010);
  assert.equal(retryIntent.attempt, 1);
});

test('retry deadline dispatches one response retry and accepted submit advances the response epoch', () => {
  const scheduled = reduceRequestState(created(), transientObservation()).state;
  const deadline = reduceRequestState(scheduled, event(RequestEventType.DEADLINE_REACHED, {
    kind: RequestDeadlineKind.RESPONSE_RETRY,
    dueAt: 1_010,
    attempt: 1,
    failedUserTurnKey: 'user-1',
  }, 1_010));
  assert.equal(deadline.state.responseRetry.status, 'dispatching');
  assert.equal(deadline.effects.length, 1);
  assert.equal(deadline.effects[0].type, RequestEffectType.PROMPT_RESPONSE_RETRY);
  assert.equal(deadline.effects[0].data.previousResponseEpoch, 0);
  assert.equal(deadline.effects[0].data.targetResponseEpoch, 1);

  const accepted = reduceRequestState(deadline.state, event(RequestEventType.PROMPT_RETRY_ACCEPTED, {
    responseEpoch: 1,
    previousResponseEpoch: 0,
    targetResponseEpoch: 1,
    retryAttempt: 1,
    userTurnKey: 'user-2',
  }, 1_020));
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.state.response.epoch, 1);
  assert.equal(accepted.state.response.userTurnKey, 'user-2');
  assert.equal(accepted.state.response.history[0].userTurnKey, 'user-1');
  assert.equal(accepted.state.responseRetry.attempts, 1);
  assert.equal(accepted.state.responseRetry.status, 'idle');
  assert.equal(accepted.state.blocker, RequestBlocker.NONE);
});

test('transient retries exhaust with a typed terminal cause and unrelated explicit errors still fail immediately', () => {
  const oneRetry = created({ maxRetries: 1, baseDelayMs: 100, maxDelayMs: 100 });
  const scheduled = reduceRequestState(oneRetry, transientObservation('user-1', 10)).state;
  const dispatch = reduceRequestState(scheduled, event(RequestEventType.DEADLINE_REACHED, {
    kind: RequestDeadlineKind.RESPONSE_RETRY, attempt: 1,
  }, 110)).state;
  const accepted = reduceRequestState(dispatch, event(RequestEventType.PROMPT_RETRY_ACCEPTED, {
    responseEpoch: 1, previousResponseEpoch: 0, targetResponseEpoch: 1,
    retryAttempt: 1, userTurnKey: 'user-2',
  }, 120)).state;
  const exhausted = reduceRequestState(accepted, event(RequestEventType.OBSERVATION_UPDATED, {
    responseEpoch: 1,
    blocker: RequestBlocker.EXPLICIT_ERROR,
    explicitError: true,
    errorRetryable: true,
    errorCode: 'CHATGPT_TRANSIENT_REQUEST_ERROR',
    errorMessage: 'Something went wrong. Please try again.',
    failedUserTurnKey: 'user-2',
  }, 130));
  assert.equal(exhausted.state.terminal.code, RequestTerminalCode.CHATGPT_TRANSIENT_ERROR_RETRY_EXHAUSTED);

  const fatal = reduceRequestState(created(), event(RequestEventType.OBSERVATION_UPDATED, {
    blocker: RequestBlocker.EXPLICIT_ERROR,
    explicitError: true,
    errorRetryable: false,
    errorCode: 'CHATGPT_ACCOUNT_ERROR',
    errorMessage: 'Account access failed',
  }, 10));
  assert.equal(fatal.state.terminal.code, RequestTerminalCode.EXPLICIT_UI_ERROR);
});


test('response retry plan remains in the proven conversation and reuses only stable preparation steps', () => {
  const plan = createPromptResponseRetryPlan({
    request: {
      requestId: 'retry-request',
      leaseId: 'lease-1',
      ownerServerInstanceId: 'server-1',
      responseEpoch: 1,
    },
    message: 'retry me',
    options: { newSession: true, sessionId: '', model: 'GPT Mock', effort: 'high' },
    attachments: [{ id: 'file-1', name: 'input.txt', size: 4, mime: 'text/plain' }],
  });
  assert.deepEqual(plan.steps.map((step) => step.kind), [
    'page.ready.initial',
    'model.apply',
    'attachments.upload',
    'prompt.submit',
  ]);
  assert.equal(plan.steps.some((step) => step.kind === 'session.apply'), false);
  assert.equal(plan.steps.every((step) => step.preconditions.responseEpoch === 1), true);
});

test('content prompt executor recognizes the response retry plan as intentionally session-free', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestPromptCommands.js'), 'utf8');
  assert.match(source, /responseRetryPlan[\s\S]*chatgpt_transient_error_retry/);
  assert.match(source, /\.\.\.\(responseRetryPlan \? \[\] : \['session\.apply'\]\)/);
});

test('retry delays grow exponentially and remain bounded by policy', () => {
  let state = created({ maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 4_000 });
  const expectedDelays = [1_000, 2_000, 4_000];
  for (let index = 0; index < expectedDelays.length; index += 1) {
    const userTurnKey = `user-${index + 1}`;
    const observedAt = 10_000 * (index + 1);
    const scheduled = reduceRequestState(state, event(RequestEventType.OBSERVATION_UPDATED, {
      responseEpoch: index,
      blocker: RequestBlocker.EXPLICIT_ERROR,
      generation: GenerationState.STOPPED,
      output: OutputState.NONE,
      explicitError: true,
      errorRetryable: true,
      errorCode: 'CHATGPT_TRANSIENT_REQUEST_ERROR',
      errorMessage: 'Something went wrong. Please try again.',
      failedUserTurnKey: userTurnKey,
    }, observedAt));
    assert.equal(scheduled.state.responseRetry.dueAt - observedAt, expectedDelays[index]);
    const dispatched = reduceRequestState(scheduled.state, event(RequestEventType.DEADLINE_REACHED, {
      kind: RequestDeadlineKind.RESPONSE_RETRY,
      attempt: index + 1,
    }, observedAt + expectedDelays[index]));
    state = reduceRequestState(dispatched.state, event(RequestEventType.PROMPT_RETRY_ACCEPTED, {
      responseEpoch: index + 1,
      previousResponseEpoch: index,
      targetResponseEpoch: index + 1,
      retryAttempt: index + 1,
      userTurnKey: `user-${index + 2}`,
    }, observedAt + expectedDelays[index] + 1)).state;
  }
  assert.equal(state.responseRetry.attempts, 3);
});
