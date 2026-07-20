import { isCriticalMessageType, makeEnvelope, messageDefinition } from './protocolV5.js';

export function createProtocolOutbox({ backgroundEpoch, backgroundState, post, summarize }) {
  const activeFlushes = new Map();
  async function materialize(state, messageType, body, options = {}) {
    const sequenceOutcome = await backgroundState.transition(state.tabId, {
      type: 'transport.outbound.next', contentEpoch: state.contentEpoch || '',
    });
    if (!sequenceOutcome.accepted) throw new Error(`Unable to advance protocol sequence: ${sequenceOutcome.reason}`);
    const runtime = sequenceOutcome.state;
    const envelopeLease = Object.hasOwn(options, 'lease') ? options.lease : runtime.lease;
    return makeEnvelope(messageType, body, {
      clientId: state.clientId,
      tabId: state.tabId,
      backgroundEpoch,
      contentEpoch: runtime.contentEpoch,
      lease: envelopeLease,
    }, runtime.transport.outboundSequence, options);
  }

  function createEnvelopeDraft(state, messageType, body, options = {}) {
    const definition = messageDefinition(messageType);
    if (!definition) throw new Error(`Unsupported protocol messageType: ${messageType}`);
    const envelopeLease = Object.hasOwn(options, 'lease') ? options.lease : options.runtimeLease;
    return makeEnvelope(messageType, body, {
      clientId: state.clientId,
      tabId: state.tabId,
      backgroundEpoch,
      contentEpoch: state.contentEpoch || '',
      lease: envelopeLease || null,
    }, 0, options);
  }

  async function sendProtocolMessage(state, messageType, body, options = {}) {
    const envelope = await materialize(state, messageType, body, options);
    const critical = options.critical === true || isCriticalMessageType(messageType);
    if (critical && options.persisted !== true) {
      const stored = await backgroundState.transition(state.tabId, {
        type: 'outbox.enqueued', envelope, contentEpoch: state.contentEpoch || '',
      });
      if (!stored.accepted) throw new Error(`Unable to persist critical extension message: ${stored.reason}`);
    }
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(envelope));
    else post(state.port, { type: 'extension.status', status: 'extension queueing', detail: JSON.stringify(summarize(body)) });
    return envelope;
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
          clientId: state.clientId,
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

  async function flushCriticalOutbox(state) {
    const tabId = state.tabId;
    let active = activeFlushes.get(tabId);
    if (active) {
      active.state = state;
      active.dirty = true;
      return active.promise;
    }
    active = { state, dirty: true, promise: null };
    active.promise = (async () => {
      do {
        active.dirty = false;
        await replayCriticalOutbox(active.state);
      } while (active.dirty);
    })().finally(() => {
      if (activeFlushes.get(tabId) === active) activeFlushes.delete(tabId);
    });
    activeFlushes.set(tabId, active);
    return active.promise;
  }

  return Object.freeze({ createEnvelopeDraft, replayCriticalOutbox, flushCriticalOutbox, sendProtocolMessage });
}
