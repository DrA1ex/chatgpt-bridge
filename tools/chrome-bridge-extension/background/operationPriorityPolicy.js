import { MessageKind } from './protocolV4.js';
import { TabOperationPriority } from './tabOperationQueue.js';

export function serverEnvelopeQueueOptions(envelope = {}) {
  const type = String(envelope.payload?.type || '');
  let priority = TabOperationPriority.REQUEST;
  let critical = false;
  if (envelope.kind === MessageKind.TRANSPORT_ACK || envelope.kind === MessageKind.TRANSPORT_HELLO) {
    priority = TabOperationPriority.OWNER_INVALIDATION;
    critical = true;
  } else if (['request.release', 'prompt.cancel', 'command.cancel'].includes(type)) {
    priority = TabOperationPriority.RELEASE;
    critical = true;
  } else if (['request.resume', 'request.effect.reconcile'].includes(type)) {
    priority = TabOperationPriority.RECONCILE;
    critical = true;
  } else if (type === 'extension.reload') {
    priority = TabOperationPriority.MAINTENANCE;
  }
  return {
    label: `server:${envelope.kind}:${type || 'unknown'}`,
    priority,
    critical,
    serialGroup: 'server',
    order: Number(envelope.source?.sequence) || 0,
    meta: {
      type,
      requestId: String(envelope.request?.requestId || ''),
      commandId: String(envelope.commandId || envelope.payload?.commandId || ''),
    },
  };
}

export function contentMessageQueueOptions(message = {}) {
  const type = String(message.type || '');
  let priority = TabOperationPriority.REQUEST;
  let critical = false;
  if (type === 'bridge.connect') {
    priority = TabOperationPriority.OWNER_INVALIDATION;
    critical = true;
  } else if (type === 'bridge.effect.settle' || type === 'bridge.payload') {
    priority = TabOperationPriority.RECONCILE;
    critical = true;
  } else if (type === 'bridge.extension.reload' || type === 'bridge.tab.reload') {
    priority = TabOperationPriority.MAINTENANCE;
  } else if (type.includes('.cancel') || type.includes('.release')) {
    priority = TabOperationPriority.RELEASE;
    critical = true;
  }
  return {
    label: `content:${type || 'unknown'}`,
    priority,
    critical,
    serialGroup: 'content',
    meta: { type, requestId: String(message.browserRequestId || message.requestId || '') },
  };
}
