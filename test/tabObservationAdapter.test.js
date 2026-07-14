import test from 'node:test';
import assert from 'node:assert/strict';
import { tabObservationToCanonicalEvent } from '../src/bridge/adapters/tabObservationAdapter.js';
import { RequestEventType } from '../src/bridge/state/requestEvents.js';
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
    output: { state: 'reasoning' },
    artifact: { state: 'none', count: 0 },
    error: { explicit: false, message: '' },
    activeRequest: { requestId: 'req-1' },
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
