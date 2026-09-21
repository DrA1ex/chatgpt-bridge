import test from 'node:test';
import assert from 'node:assert/strict';
import { tabObservationToCanonicalEvent } from '../src/bridge/adapters/tabObservationAdapter.js';
import { RequestEventType, createRequestEvent } from '../src/bridge/state/requestEvents.js';
import { reduceRequestState } from '../src/bridge/state/requestMachine.js';

function observation(overrides = {}) {
  return {
    observerId: 'observer-a',
    revision: 4,
    observedAt: 100,
    url: 'https://chatgpt.com/c/session-1',
    conversationId: 'session-1',
    generation: { state: 'active' },
    blocker: { state: 'none' },
    output: { state: 'reasoning', answer: 'Current response' },
    artifact: { state: 'none', count: 0 },
    error: { explicit: false, message: '' },
    turn: { key: 'assistant-1', userKey: 'user-1', index: 1 },
    activeRequest: { requestId: 'req-1', submittedUserTurnKey: 'user-1', responseEpoch: 0 },
    ...overrides,
  };
}

test('tab observations become normalized canonical request events', () => {
  const event = tabObservationToCanonicalEvent('req-1', 'client-1', {
    type: 'tab.observation',
    observation: observation(),
  }, {
    source: { conversationId: 'session-1' },
    submission: 'submitted',
  }, 110);
  assert.equal(event.type, RequestEventType.OBSERVATION_UPDATED);
  assert.equal(event.sourceSequence, 4);
  assert.equal(event.data.observationEpoch, 'observer-a');
  assert.equal(event.data.lifecycle, 'generating');
  assert.equal(event.data.generation, 'active');
  assert.equal(event.data.output, 'reasoning');
  assert.equal(event.data.requestReplaced, false);
});


test('visible output from the previous turn is ignored until the submitted prompt boundary is proven', () => {
  const event = tabObservationToCanonicalEvent('req-1', 'client-1', {
    observation: observation({
      turn: { key: 'assistant-old', userKey: 'user-old', index: 1 },
      activeRequest: { requestId: 'req-1', submittedUserTurnKey: 'user-new', responseEpoch: 0 },
      output: { state: 'final', answer: 'Previous response' },
    }),
  }, {
    source: { conversationId: 'session-1' },
    submission: 'submitted',
    response: { epoch: 0 },
  }, 110);

  assert.equal(event.data.leaseScopedToRequest, true);
  assert.equal(event.data.responseBoundaryEstablished, false);
  assert.equal(event.data.scopedToRequest, false);
  assert.equal(event.data.lifecycle, undefined);
  assert.equal(event.data.output, undefined);
  assert.equal(event.data.answer, '');
  assert.equal(event.data.turnKey, '');
  assert.equal(event.data.completionCandidate, false);
});


test('request and conversation mismatches are ignored until prompt binding is established', () => {
  const event = tabObservationToCanonicalEvent('req-1', 'client-1', {
    observation: observation({
      conversationId: 'session-2',
      activeRequest: { requestId: 'req-other' },
      blocker: { state: 'explicit_error' },
      error: { explicit: true, message: 'Historical error' },
    }),
  }, {
    source: { conversationId: 'session-1' },
    submission: 'pending',
  }, 110);
  assert.equal(event.data.conversationChanged, false);
  assert.equal(event.data.requestReplaced, false);
  assert.equal(event.data.scopedToRequest, false);
  assert.equal(event.data.lifecycle, undefined);
  assert.equal(event.data.generation, undefined);
  assert.equal(event.data.output, undefined);
  assert.equal(event.data.explicitError, false);
});

test('tab observation detects incompatible request and conversation immediately', () => {
  const event = tabObservationToCanonicalEvent('req-1', 'client-1', {
    observation: observation({
      conversationId: 'session-2',
      activeRequest: { requestId: 'req-other' },
    }),
  }, {
    source: { conversationId: 'session-1' },
    submission: 'submitted',
  }, 110);
  assert.equal(event.data.conversationChanged, true);
  assert.equal(event.data.requestReplaced, true);
});

test('temporary WEB conversation id is promoted to the canonical id inside the same request boundary', () => {
  const event = tabObservationToCanonicalEvent('req-1', 'client-1', {
    observation: observation({
      url: 'https://chatgpt.com/c/6a61d754-e0a4-83ed-a9d9-814a7bcdc8b6',
      conversationId: '6a61d754-e0a4-83ed-a9d9-814a7bcdc8b6',
      activeRequest: { requestId: 'req-1', submittedUserTurnKey: 'user-1', responseEpoch: 0 },
      turn: { key: 'assistant-1', userKey: 'user-1', index: 1 },
    }),
  }, {
    source: { conversationId: 'WEB:5e28091a-3aca-4d27-bd8c-c1ff91440544' },
    submission: 'submitted',
    response: { epoch: 0, userTurnKey: 'user-1' },
  }, 110);

  assert.equal(event.data.conversationCanonicalized, true);
  assert.equal(event.data.previousConversationId, 'WEB:5e28091a-3aca-4d27-bd8c-c1ff91440544');
  assert.equal(event.data.conversationChanged, false);
  assert.equal(event.data.scopedToRequest, true);
});

test('temporary WEB conversation id still rejects a different conversation without the same turn boundary', () => {
  const event = tabObservationToCanonicalEvent('req-1', 'client-1', {
    observation: observation({
      conversationId: 'different-conversation',
      activeRequest: { requestId: 'req-1', submittedUserTurnKey: 'user-other', responseEpoch: 0 },
      turn: { key: 'assistant-other', userKey: 'user-other', index: 1 },
    }),
  }, {
    source: { conversationId: 'WEB:5e28091a-3aca-4d27-bd8c-c1ff91440544' },
    submission: 'submitted',
    response: { epoch: 0, userTurnKey: 'user-1' },
  }, 110);

  assert.equal(event.data.conversationCanonicalized, false);
  assert.equal(event.data.conversationChanged, true);
});

test('temporary WEB conversation id rejects a conflicting visible turn even when content retains the old request key', () => {
  const event = tabObservationToCanonicalEvent('req-1', 'client-1', {
    observation: observation({
      conversationId: 'different-conversation',
      activeRequest: { requestId: 'req-1', submittedUserTurnKey: 'user-1', responseEpoch: 0 },
      turn: { key: 'assistant-other', userKey: 'user-other', index: 1 },
    }),
  }, {
    source: { conversationId: 'WEB:5e28091a-3aca-4d27-bd8c-c1ff91440544' },
    submission: 'submitted',
    response: { epoch: 0, userTurnKey: 'user-1' },
  }, 110);

  assert.equal(event.data.conversationCanonicalized, false);
  assert.equal(event.data.conversationChanged, true);
});

test('observation sequence resets are accepted after a new observer epoch', () => {
  const create = {
    schemaVersion: 1,
    eventId: 'create',
    type: 'request.created',
    entityType: 'request',
    entityId: 'req-1',
    source: 'test',
    sourceSequence: null,
    causationId: '',
    correlationId: 'req-1',
    occurredAt: 1,
    receivedAt: 1,
    data: { sessionId: 'session-1' },
  };
  let state = reduceRequestState(null, create).state;
  const first = tabObservationToCanonicalEvent('req-1', 'client-1', { observation: observation({ revision: 10 }) }, state, 100);
  state = reduceRequestState(state, first).state;
  const reset = tabObservationToCanonicalEvent('req-1', 'client-1', {
    observation: observation({ observerId: 'observer-b', revision: 1 }),
  }, state, 120);
  const outcome = reduceRequestState(state, reset);
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.state.source.observationEpoch, 'observer-b');
  assert.equal(outcome.state.source.observationSequence, 1);
});

test('canonical response boundary survives content reload with a lease-only request projection', () => {
  const currentState = {
    source: { conversationId: 'session-1' },
    submission: 'submitted',
    response: { epoch: 0, userTurnKey: 'user-1' },
  };
  const event = tabObservationToCanonicalEvent('req-1', 'client-1', {
    observation: observation({
      generation: { state: 'stopped' },
      output: { state: 'final', answer: 'Finished after reload' },
      activeRequest: { requestId: 'req-1', submittedUserTurnKey: '', responseEpoch: 0 },
      turn: {
        key: 'assistant-1', userKey: 'user-1', index: 1,
        finalMessage: true, actionBarVisible: true, stableForMs: 2_500,
      },
      stableForMs: 2_500,
    }),
  }, currentState, 110);

  assert.equal(event.data.responseBoundaryEstablished, true);
  assert.equal(event.data.submittedUserTurnKey, 'user-1');
  assert.equal(event.data.scopedToRequest, true);
  assert.equal(event.data.answer, 'Finished after reload');
  assert.equal(event.data.generation, 'stopped');
  assert.equal(event.data.completionCandidate, true);
});

test('final request-owned output wins over a transient reload banner after ChatGPT exposes its action bar', () => {
  const event = tabObservationToCanonicalEvent('req-1', 'client-1', {
    observation: observation({
      generation: { state: 'stopped', stopVisible: false, streamingVisible: false },
      blocker: { state: 'explicit_error' },
      output: {
        state: 'final',
        answer: 'Completed after reload\n\nRELOAD_RECOVERED',
        finalMessage: true,
        actionBarVisible: true,
      },
      error: {
        explicit: true,
        retryable: true,
        code: 'CHATGPT_TRANSIENT_REQUEST_ERROR',
        kind: 'transient_request_error',
        message: 'Something went wrong. Please try again.',
        userTurnKey: 'user-1',
      },
      activeRequest: { requestId: 'req-1', submittedUserTurnKey: 'user-1', responseEpoch: 0 },
      turn: { key: 'assistant-1', userKey: 'user-1', index: 1 },
      stableForMs: 760,
    }),
  }, {
    source: { conversationId: 'session-1' },
    submission: 'submitted',
    response: { epoch: 0, userTurnKey: 'user-1' },
  }, 110);

  assert.equal(event.data.completionCandidate, true);
  assert.equal(event.data.completionEvidence.transientErrorAfterFinalOutput, true);
  let state = reduceRequestState(null, createRequestEvent(RequestEventType.CREATED, 'req-1', {
    submittedUserTurnKey: 'user-1',
  }, { occurredAt: 1, receivedAt: 1 })).state;
  state = reduceRequestState(state, createRequestEvent(RequestEventType.PROMPT_ACCEPTED, 'req-1', {}, {
    occurredAt: 2, receivedAt: 2,
  })).state;
  state = reduceRequestState(state, createRequestEvent(RequestEventType.PROMPT_SUBMITTED, 'req-1', {}, {
    occurredAt: 3, receivedAt: 3,
  })).state;
  const outcome = reduceRequestState(state, event);
  assert.equal(outcome.state.lifecycle, 'completed');
  assert.equal(outcome.state.terminal.code, 'completed');
  assert.ok(outcome.state.diagnostics.some((item) => item.code === 'chatgpt_transient_error_ignored_after_final_output'));
});

test('an empty final shell with a transient banner remains retryable after reload', () => {
  const event = tabObservationToCanonicalEvent('req-1', 'client-1', {
    observation: observation({
      generation: { state: 'stopped', stopVisible: false, streamingVisible: false },
      blocker: { state: 'explicit_error' },
      output: { state: 'final', answer: '', finalMessage: true, actionBarVisible: true },
      error: {
        explicit: true,
        retryable: true,
        code: 'CHATGPT_TRANSIENT_REQUEST_ERROR',
        message: 'Something went wrong. Please try again.',
        userTurnKey: 'user-1',
      },
      stableForMs: 2_000,
    }),
  }, {
    source: { conversationId: 'session-1' },
    submission: 'submitted',
    response: { epoch: 0, userTurnKey: 'user-1' },
  }, 110);

  assert.equal(event.data.completionCandidate, false);
  assert.equal(event.data.completionEvidence.transientErrorAfterFinalOutput, false);
  assert.equal(event.data.errorRetryable, true);
});

test('server-owned response boundary wins over a stale content projection', () => {
  const event = tabObservationToCanonicalEvent('req-1', 'client-1', {
    observation: observation({
      activeRequest: { requestId: 'req-1', submittedUserTurnKey: 'user-old', responseEpoch: 0 },
      turn: { key: 'assistant-new', userKey: 'user-new', index: 3 },
      output: { state: 'streaming', answer: 'Current response' },
    }),
  }, {
    source: { conversationId: 'session-1' },
    submission: 'submitted',
    response: { epoch: 0, userTurnKey: 'user-new' },
  }, 110);

  assert.equal(event.data.responseBoundaryEstablished, true);
  assert.equal(event.data.submittedUserTurnKey, 'user-new');
  assert.equal(event.data.scopedToRequest, true);
});


test('final answer after steer may remain attached to the original prompt turn', () => {
  const event = tabObservationToCanonicalEvent('req-1', 'client-1', {
    observation: observation({
      generation: { state: 'stopped', stopVisible: false },
      output: { state: 'final', answer: 'STEER_RESULT BLUE', finalMessage: true, actionBarVisible: true },
      stableForMs: 2_500,
      activeRequest: { requestId: 'req-1', submittedUserTurnKey: 'user-steer', responseEpoch: 1 },
      turn: {
        key: 'assistant-final', userKey: 'user-root', index: 2,
        messageId: 'assistant-final', finalMessage: true, actionBarVisible: true, stableForMs: 2_500,
      },
    }),
  }, {
    source: { conversationId: 'session-1' },
    submission: 'submitted',
    response: {
      epoch: 1,
      userTurnKey: 'user-steer',
      history: [{ epoch: 0, userTurnKey: 'user-root', endedAt: 90 }],
    },
  }, 110);

  assert.equal(event.data.responseBoundaryEstablished, true);
  assert.equal(event.data.steerContinuationBoundary, true);
  assert.equal(event.data.originalSubmittedUserTurnKey, 'user-root');
  assert.equal(event.data.submittedUserTurnKey, 'user-steer');
  assert.equal(event.data.scopedToRequest, true);
  assert.equal(event.data.answer, 'STEER_RESULT BLUE');
  assert.equal(event.data.completionCandidate, true);
});

test('original prompt boundary is not accepted after steer without exact epoch history evidence', () => {
  const event = tabObservationToCanonicalEvent('req-1', 'client-1', {
    observation: observation({
      generation: { state: 'stopped' },
      output: { state: 'final', answer: 'Stale answer' },
      activeRequest: { requestId: 'req-1', submittedUserTurnKey: 'user-steer', responseEpoch: 1 },
      turn: { key: 'assistant-old', userKey: 'user-root', index: 2 },
    }),
  }, {
    source: { conversationId: 'session-1' },
    submission: 'submitted',
    response: { epoch: 1, userTurnKey: 'user-steer', history: [] },
  }, 110);

  assert.equal(event.data.responseBoundaryEstablished, false);
  assert.equal(event.data.steerContinuationBoundary, false);
  assert.equal(event.data.scopedToRequest, false);
  assert.equal(event.data.answer, '');
  assert.equal(event.data.completionCandidate, false);
});

test('accepted observation persists the proved response boundary in canonical state', () => {
  const create = {
    schemaVersion: 1,
    eventId: 'create-boundary',
    type: 'request.created',
    entityType: 'request',
    entityId: 'req-1',
    source: 'test',
    sourceSequence: null,
    causationId: '',
    correlationId: 'req-1',
    occurredAt: 1,
    receivedAt: 1,
    data: { sessionId: 'session-1', submittedUserTurnKey: 'user-1' },
  };
  let state = reduceRequestState(null, create).state;
  state = { ...state, submission: 'submitted' };
  const event = tabObservationToCanonicalEvent('req-1', 'client-1', {
    observation: observation(),
  }, state, 100);
  const outcome = reduceRequestState(state, event);
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.state.response.userTurnKey, 'user-1');
});
