import { isCriticalKind, makeEnvelope } from './protocolV4.js';

export function createProtocolOutbox({ backgroundEpoch, backgroundState, post, summarize }) {
  const operationQueues = new Map();

  function serialize(tabId, operation) {
    const previous = operationQueues.get(tabId) || Promise.resolve();
    const next = previous.then(operation);
    operationQueues.set(tabId, next.catch(() => {}));
    return next;
  }

  async function sendOne(state, payload, options = {}) {
    const tabId = state.tabId;
    const sequenceOutcome = await backgroundState.transition(tabId, {
      type: 'sequence.next',
      contentEpoch: state.contentEpoch || '',
    });
    if (!sequenceOutcome.accepted) throw new Error(`Unable to advance protocol sequence: ${sequenceOutcome.reason}`);
    const runtime = sequenceOutcome.state;
    const nextSequence = runtime.sequence;
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

  function sendProtocolPayload(state, payload, options = {}) {
    return serialize(state.tabId, () => sendOne(state, payload, options));
  }

  function replayCriticalOutbox(state) {
    return serialize(state.tabId, async () => {
    const runtime = await backgroundState.read(state.tabId);
    for (const persisted of runtime.outbox) {
      if (state.ws?.readyState !== WebSocket.OPEN) return;
      const sequenceOutcome = await backgroundState.transition(state.tabId, {
        type: 'sequence.next', contentEpoch: state.contentEpoch || runtime.contentEpoch || '',
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
          sequence: current.sequence,
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
    });
  }

  return Object.freeze({ replayCriticalOutbox, sendProtocolPayload });
}
