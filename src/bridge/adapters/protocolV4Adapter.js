import {
  ExtensionMessageKind,
  createExtensionEnvelope,
  unwrapExtensionEnvelope,
} from '../protocol/v4.js';

const MAX_SEEN_MESSAGES = 2_000;

export class ProtocolV4Adapter {
  #sources = new Map();
  #owners = new Map();
  #seen = new Set();
  #seenOrder = [];

  ingest(raw, client = {}) {
    const unwrapped = unwrapExtensionEnvelope(raw);
    if (!unwrapped.valid) return { accepted: false, reason: 'invalid_envelope', diagnostics: unwrapped.errors };
    const { envelope, payload } = unwrapped;
    if (this.#seen.has(envelope.messageId)) return { accepted: false, reason: 'duplicate_message', envelope, payload };

    const ownerKey = `${envelope.source.clientId || client.id || ''}:${envelope.source.tabId ?? client.browserTabId ?? ''}`;
    const owner = this.#owners.get(ownerKey);
    if (envelope.kind !== ExtensionMessageKind.TRANSPORT_HELLO) {
      if (!owner) return { accepted: false, reason: 'handshake_required', envelope, payload };
      if (owner.backgroundEpoch !== envelope.source.backgroundEpoch) return { accepted: false, reason: 'stale_background_epoch', envelope, payload };
      if (owner.contentEpoch !== envelope.source.contentEpoch) return { accepted: false, reason: 'stale_content_epoch', envelope, payload };
    }

    const sourceKey = [
      envelope.source.clientId || client.id || '',
      envelope.source.tabId ?? client.browserTabId ?? '',
      envelope.source.backgroundEpoch || '',
      envelope.source.contentEpoch || '',
    ].join(':');
    const previous = this.#sources.get(sourceKey);
    if (previous != null && envelope.source.sequence <= previous) {
      return { accepted: false, reason: 'stale_sequence', envelope, payload, previousSequence: previous };
    }

    this.#sources.set(sourceKey, envelope.source.sequence);
    if (envelope.kind === ExtensionMessageKind.TRANSPORT_HELLO) {
      this.#owners.set(ownerKey, {
        backgroundEpoch: envelope.source.backgroundEpoch,
        contentEpoch: envelope.source.contentEpoch,
      });
    }
    this.#remember(envelope.messageId);
    return { accepted: true, envelope, payload };
  }

  command(payload, options = {}) {
    return createExtensionEnvelope(ExtensionMessageKind.COMMAND_EXECUTE, payload, options);
  }

  ack(envelope, options = {}) {
    return createExtensionEnvelope(ExtensionMessageKind.TRANSPORT_ACK, {
      ackMessageId: envelope.messageId,
      acceptedSequence: envelope.source.sequence,
    }, { ...options, causationId: envelope.messageId });
  }

  #remember(messageId) {
    this.#seen.add(messageId);
    this.#seenOrder.push(messageId);
    while (this.#seenOrder.length > MAX_SEEN_MESSAGES) this.#seen.delete(this.#seenOrder.shift());
  }
}
