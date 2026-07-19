import { isCriticalKind, makeEnvelope } from './protocolV4.js';

export function createProtocolOutbox({ backgroundEpoch, backgroundState, post, summarize }) {
  async function sendOne(state, payload, options = {}) {
    const tabId = state.tabId;
    const sequenceOutcome = await backgroundState.transition(tabId, {
      type: 'transport.outbound.next',
      contentEpoch: state.contentEpoch || '',
    });
    if (!sequenceOutcome.accepted) throw new Error(`Unable to advance protocol sequence: ${sequenceOutcome.reason}`);
    const runtime = sequenceOutcome.state;
    const nextSequence = runtime.transport.outboundSequence;
    const envelopeLease = Object.hasOwn(options, 'lease') ? options.lease : runtime.lease;
    const envelope = makeEnvelope(payload, {
      clientId: state.clientId,
      tabId,
      backgroundEpoch,
      contentEpoch: runtime.contentEpoch,
      lease: envelopeLease,
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

  // Callers execute this inside the single tab-scoped operation queue. The
  // outbox deliberately has no competing serializer.
  function sendProtocolPayload(state, payload, options = {}) {
    return sendOne(state, payload, options);
  }

  async function replayCriticalOutbox(state) {
    const runtime = await backgroundState.read(state.tabId);
    for (const persisted of runtime.outbox) {
      if (state.ws?.readyState !== WebSocket.OPEN) return;
      const sequenceOutcome = await backgroundState.transition(state.tabId, {
        type: 'transport.outbound.next', contentEpoch: state.contentEpoch || runtime.contentEpoch || '',
      });
      if (!sequenceOutcome.accepted) throw new Error(`Unable to resequence critical extension message: ${sequenceOutcome.reason}`);
      const current = sequenceOutcome.state;
      const envelope = {
        ...persisted,
        sentAt: Date.now(),
        source: {
          ...persisted.source,
          backgroundEpoch,
          contentEpoch: current.contentEpoch,
          sequence: current.transport.outboundSequence,
        },
      };
      const resequenced = await backgroundState.transition(state.tabId, {
        type: 'outbox.resequenced', envelope, contentEpoch: current.contentEpoch,
      });
      if (!resequenced.accepted) {
        if (resequenced.reason === 'outbox_message_missing') continue;
        throw new Error(`Unable to persist replay sequence: ${resequenced.reason}`);
      }
      state.ws.send(JSON.stringify(envelope));
    }
  }

  return Object.freeze({ replayCriticalOutbox, sendProtocolPayload });
}
