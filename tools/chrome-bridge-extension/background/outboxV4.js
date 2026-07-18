import { isCriticalKind, makeEnvelope } from './protocolV4.js';

export function createProtocolOutbox({ backgroundEpoch, backgroundState, post, summarize }) {
  async function sendProtocolPayload(state, payload, options = {}) {
    const tabId = state.tabId;
    const current = await backgroundState.read(tabId);
    const nextSequence = current.sequence + 1;
    const sequenceOutcome = await backgroundState.transition(tabId, {
      type: 'sequence.advanced',
      sequence: nextSequence,
      contentEpoch: state.contentEpoch || current.contentEpoch || '',
    });
    if (!sequenceOutcome.accepted) throw new Error(`Unable to advance protocol sequence: ${sequenceOutcome.reason}`);
    const runtime = sequenceOutcome.state;
    const envelope = makeEnvelope(payload, {
      clientId: state.clientId,
      tabId,
      backgroundEpoch,
      contentEpoch: runtime.contentEpoch,
      lease: runtime.lease,
    }, nextSequence, options);
    if (isCriticalKind(envelope.kind)) {
      const stored = await backgroundState.transition(tabId, {
        type: 'outbox.enqueued', envelope, contentEpoch: runtime.contentEpoch,
      });
      if (!stored.accepted) throw new Error(`Unable to persist critical extension message: ${stored.reason}`);
    }
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(envelope));
    else post(state.port, { type: 'extension.status', status: 'extension queueing', detail: JSON.stringify(summarize(payload)) });
    return envelope;
  }

  async function replayCriticalOutbox(state) {
    const runtime = await backgroundState.read(state.tabId);
    for (const envelope of runtime.outbox) {
      if (state.ws?.readyState !== WebSocket.OPEN) return;
      state.ws.send(JSON.stringify(envelope));
    }
  }

  return Object.freeze({ replayCriticalOutbox, sendProtocolPayload });
}
