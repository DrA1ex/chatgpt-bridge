import {
  committed,
  enqueueEnvelopePatch,
  now,
  rejected
} from './stateV6Core.js';

export function reduceTransportEvent(state, event) {
  switch (event.type) {
    case 'outbox.enqueued': {
      const queued = enqueueEnvelopePatch(state, event.envelope);
      if (!queued.accepted) return rejected(state, event, queued.reason, {
        metrics: { ...state.metrics, outboxRejected: (Number(state.metrics?.outboxRejected) || 0) + 1 },
      });
      return committed(state, event, queued.patch);
    }
    case 'outbox.acknowledged': {
      const messageId = String(event.messageId || '');
      const found = state.outbox.some((item) => item.messageId === messageId);
      if (!found) return rejected(state, event, 'outbox_message_missing');
      return committed(state, event, {
        transport: {
          ...state.transport,
          ackCursor: Math.max(Number(state.transport?.ackCursor) || 0, Number(event.sequence) || 0),
          updatedAt: now(event),
        },
        outbox: state.outbox.filter((item) => item.messageId !== messageId),
      });
    }
    case 'transport.ack_rejected': {
      const messageId = String(event.messageId || '');
      if (!messageId) return rejected(state, event, 'outbox_message_missing');
      const found = state.outbox.some((item) => item.messageId === messageId);
      if (!found) return rejected(state, event, 'outbox_message_missing');
      return committed(state, event, {
        transport: {
          ...state.transport,
          rejectedAckCount: (Number(state.transport?.rejectedAckCount) || 0) + 1,
          lastRejectedAck: {
            messageId,
            reason: String(event.reason || 'server_rejected'),
            at: now(event),
          },
          updatedAt: now(event),
        },
      });
    }
    case 'outbox.resequenced': {
      const envelope = event.envelope;
      if (!envelope?.messageId) return rejected(state, event, 'outbox_message_missing');
      const index = state.outbox.findIndex((item) => item.messageId === envelope.messageId);
      if (index < 0) return rejected(state, event, 'outbox_message_missing');
      const outbox = state.outbox.slice();
      outbox[index] = envelope;
      return committed(state, event, { outbox });
    }
    case 'transport.connected': {
      const connectionEpoch = String(event.connectionEpoch || '');
      const serverEpoch = String(event.serverEpoch || '');
      const serverInstanceId = String(event.serverInstanceId || '');
      if (!connectionEpoch) return rejected(state, event, 'connection_epoch_missing');
      const epochChanged = Boolean(serverEpoch && serverEpoch !== state.transport?.serverEpoch);
      return committed(state, event, { transport: {
        ...(state.transport || {}),
        connectionEpoch,
        serverEpoch: serverEpoch || state.transport?.serverEpoch || '',
        serverInstanceId: serverInstanceId || state.transport?.serverInstanceId || '',
        connected: true,
        inboundSequence: epochChanged ? 0 : Number(state.transport?.inboundSequence) || 0,
        updatedAt: now(event),
      } });
    }
    case 'transport.disconnected':
      return committed(state, event, { transport: {
        ...(state.transport || {}), connected: false, updatedAt: now(event),
      } });
    case 'transport.inbound': {
      const serverEpoch = String(event.serverEpoch || '');
      const sequence = Number(event.sequence);
      if (!serverEpoch) return rejected(state, event, 'server_epoch_missing');
      if (state.transport?.serverEpoch && state.transport.serverEpoch !== serverEpoch) return rejected(state, event, 'server_epoch_mismatch');
      if (!Number.isInteger(sequence) || sequence <= (Number(state.transport?.inboundSequence) || 0)) return rejected(state, event, 'stale_server_sequence');
      return committed(state, event, { transport: {
        ...(state.transport || {}), serverEpoch, inboundSequence: sequence, connected: true, updatedAt: now(event),
      } });
    }
    case 'transport.outbound.next':
      return committed(state, event, { transport: {
        ...(state.transport || {}), outboundSequence: (Number(state.transport?.outboundSequence) || 0) + 1, updatedAt: now(event),
      } });
    default:
      return null;
  }
}
