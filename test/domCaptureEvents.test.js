import test from 'node:test';
import assert from 'node:assert/strict';
import { publishDomCaptureSnapshot } from '../src/bridge/observation/domCaptureEvents.js';

test('DOM capture retains a complete final snapshot after intermediate capture fills', () => {
  const state = {
    requestId: 'turn-1',
    promptPayload: { options: { captureDomTimeline: true } },
  };
  const events = [];
  const emit = (_state, event) => events.push(event);
  for (let index = 0; index < 80; index += 1) {
    publishDomCaptureSnapshot(state, {
      revision: index + 1,
      turn: { key: 'assistant-1', phase: 'ASSISTANT_REASONING' },
      output: { thinking: `Step ${index}`, parserAudit: { sourceHtml: `<p>Step ${index}</p>` } },
    }, emit);
  }
  assert.equal(events.length, 63);

  const finalObservation = {
    revision: 81,
    turn: { key: 'assistant-1', phase: 'ASSISTANT_FINAL' },
    output: { answer: 'Complete answer', parserAudit: { sourceHtml: '<p>Complete answer</p>' } },
  };
  assert.equal(publishDomCaptureSnapshot(state, finalObservation, emit), true);
  assert.equal(publishDomCaptureSnapshot(state, finalObservation, emit), false);
  assert.equal(events.length, 64);
  assert.equal(events.at(-1).answer, 'Complete answer');
});
