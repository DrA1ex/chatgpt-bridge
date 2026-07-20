import {
  ExtensionMessageType,
  createExtensionEnvelope,
  unwrapExtensionEnvelope,
} from '../protocol/v5.js';

const MAX_SEEN_MESSAGES = 2_000;
const MAX_DIAGNOSTICS = 500;

function tabOwnerKey(envelope, client = {}) {
  const tabId = envelope?.source?.tabId ?? client.browserTabId;
  if (Number.isInteger(tabId)) return `tab:${tabId}`;
  // A transport hello should normally carry a tab id. Keep an isolated
  // connection-scoped owner only for startup diagnostics; it can never alias a
  // real tab owner.
  return `connection:${String(client.connectionId || client.id || envelope?.source?.clientId || '')}`;
}

function sourceIdentity(envelope, client = {}) {
  return {
    clientId: String(envelope?.source?.clientId || client.id || ''),
    tabId: Number.isInteger(envelope?.source?.tabId) ? envelope.source.tabId : (Number.isInteger(client.browserTabId) ? client.browserTabId : null),
    backgroundEpoch: String(envelope?.source?.backgroundEpoch || ''),
    contentEpoch: String(envelope?.source?.contentEpoch || ''),
  };
}

function sameOwner(owner, source) {
  return Boolean(owner
    && owner.clientId === source.clientId
    && owner.backgroundEpoch === source.backgroundEpoch
    && owner.contentEpoch === source.contentEpoch);
}


function internalPayloadForEnvelope(envelope, body = {}) {
  const type = envelope.messageType;
  if (type === ExtensionMessageType.TRANSPORT_HELLO) return { ...body, type: 'hello' };
  if (type === ExtensionMessageType.TRANSPORT_PONG) return { ...body, type: 'pong' };
  if (type === ExtensionMessageType.TRANSPORT_DIAGNOSTIC) return { ...body, type: String(body.diagnosticType || body.type || 'diagnostic') };
  if (type === ExtensionMessageType.TAB_OBSERVATION) return { ...body, type: 'tab.observation' };
  if (type === ExtensionMessageType.COMMAND_ACCEPTED) return { ...body, type: 'command.accepted', commandId: envelope.commandId };
  if (type === ExtensionMessageType.COMMAND_PROGRESS) return { ...body, type: 'command.progress', commandId: envelope.commandId };
  if (type === ExtensionMessageType.COMMAND_REJECTED) return { ...body, type: 'command.error', commandId: envelope.commandId };
  if (type === ExtensionMessageType.COMMAND_RESULT) return { ...body, type: 'command.result', commandId: envelope.commandId };
  if (type === ExtensionMessageType.EFFECT_STARTED) return { ...body, type: 'request.effect.started', effectId: envelope.effectId };
  if (type === ExtensionMessageType.EFFECT_SUCCEEDED) return { ...body, type: 'request.effect.succeeded', effectId: envelope.effectId };
  if (type === ExtensionMessageType.EFFECT_FAILED) return { ...body, type: 'request.effect.failed', effectId: envelope.effectId };
  if (type === ExtensionMessageType.EFFECT_UNCERTAIN) return { ...body, type: 'request.effect.uncertain', effectId: envelope.effectId };
  if (type === ExtensionMessageType.EFFECT_CANCELLED) return { ...body, type: 'request.effect.cancelled', effectId: envelope.effectId };
  if (type === ExtensionMessageType.LEASE_RELEASED) return { ...body, type: 'lease.released', commandId: envelope.commandId, activeRequest: null };
  if (type === ExtensionMessageType.LEASE_QUARANTINED) return { ...body, type: 'lease.quarantined', commandId: envelope.commandId, code: String(body.code || 'BROWSER_TAB_QUARANTINED'), message: String(body.message || body.reason || 'Browser tab release could not be proven') };
  return { ...body };
}

export class ProtocolV5Adapter {
  #sources = new Map();
  #owners = new Map();
  #seen = new Set();
  #seenOrder = [];
  #journal = [];

  prepare(raw, client = {}) {
    const unwrapped = unwrapExtensionEnvelope(raw, { direction: 'extension_to_server', requireClientId: true });
    if (!unwrapped.valid) return this.#reject('invalid_envelope', { diagnostics: unwrapped.errors });
    const { envelope, body } = unwrapped;
    const payload = internalPayloadForEnvelope(envelope, body);
    if (this.#seen.has(envelope.messageId)) return this.#reject('duplicate_message', { envelope, payload });

    const ownerKey = tabOwnerKey(envelope, client);
    const source = sourceIdentity(envelope, client);
    const owner = this.#owners.get(ownerKey);

    if (envelope.messageType !== ExtensionMessageType.TRANSPORT_HELLO) {
      if (!owner) return this.#reject('handshake_required', { envelope, payload, ownerKey });
      if (owner.clientId !== source.clientId) return this.#reject('stale_source_owner', { envelope, payload, ownerKey });
      if (owner.backgroundEpoch !== source.backgroundEpoch) return this.#reject('stale_background_epoch', { envelope, payload, ownerKey });
      if (owner.contentEpoch !== source.contentEpoch) return this.#reject('stale_content_epoch', { envelope, payload, ownerKey });
    }

    const sourceKey = [ownerKey, source.clientId, source.backgroundEpoch, source.contentEpoch].join(':');
    const previous = this.#sources.get(sourceKey);
    if (previous != null && envelope.source.sequence <= previous) {
      return this.#reject('stale_sequence', { envelope, payload, previousSequence: previous, ownerKey });
    }

    return { accepted: true, envelope, payload, ownerKey, source, sourceKey };
  }

  commit(prepared) {
    if (!prepared?.accepted) return prepared;
    const { envelope, payload, ownerKey, source, sourceKey } = prepared;
    if (this.#seen.has(envelope.messageId)) return this.#reject('duplicate_message', { envelope, payload, ownerKey });
    const owner = this.#owners.get(ownerKey);
    if (envelope.messageType !== ExtensionMessageType.TRANSPORT_HELLO) {
      if (!owner) return this.#reject('handshake_required', { envelope, payload, ownerKey });
      if (owner.clientId !== source.clientId) return this.#reject('stale_source_owner', { envelope, payload, ownerKey });
      if (owner.backgroundEpoch !== source.backgroundEpoch) return this.#reject('stale_background_epoch', { envelope, payload, ownerKey });
      if (owner.contentEpoch !== source.contentEpoch) return this.#reject('stale_content_epoch', { envelope, payload, ownerKey });
    }
    const previous = this.#sources.get(sourceKey);
    if (previous != null && envelope.source.sequence <= previous) {
      return this.#reject('stale_sequence', { envelope, payload, previousSequence: previous, ownerKey });
    }

    this.#sources.set(sourceKey, envelope.source.sequence);
    if (envelope.messageType === ExtensionMessageType.TRANSPORT_HELLO) {
      const replaced = owner && !sameOwner(owner, source) ? { ...owner } : null;
      this.#owners.set(ownerKey, { ...source, acceptedAt: Date.now(), messageId: envelope.messageId });
      if (replaced) this.#record({ accepted: true, reason: 'owner_replaced', ownerKey, envelope, previousOwner: replaced });
    }
    this.#remember(envelope.messageId);
    this.#record({ accepted: true, reason: '', ownerKey, envelope });
    return { ...prepared, committed: true };
  }

  ingest(raw, client = {}) {
    const prepared = this.prepare(raw, client);
    return prepared.accepted ? this.commit(prepared) : prepared;
  }

  command(payload, options = {}) {
    return createExtensionEnvelope(ExtensionMessageType.COMMAND_EXECUTE, payload, options);
  }

  ack(envelope, options = {}) {
    return createExtensionEnvelope(ExtensionMessageType.TRANSPORT_ACK, {
      ackMessageId: envelope.messageId,
      acceptedSequence: envelope.source.sequence,
    }, { ...options, causationId: envelope.messageId });
  }

  ownerForTab(tabId) {
    const owner = this.#owners.get(`tab:${tabId}`);
    return owner ? { ...owner } : null;
  }

  diagnostics() {
    return this.#journal.map((entry) => ({ ...entry }));
  }

  #reject(reason, details = {}) {
    this.#record({ accepted: false, reason, ownerKey: details.ownerKey || '', envelope: details.envelope, diagnostics: details.diagnostics });
    return { accepted: false, reason, ...details };
  }

  #record({ accepted, reason, ownerKey = '', envelope = null, previousOwner = null, diagnostics = null }) {
    this.#journal.push({
      accepted,
      reason,
      ownerKey,
      messageId: String(envelope?.messageId || ''),
      messageType: String(envelope?.messageType || ''),
      source: envelope?.source ? { ...envelope.source } : null,
      previousOwner,
      diagnostics: Array.isArray(diagnostics) ? diagnostics.slice(0, 20) : [],
      at: Date.now(),
    });
    if (this.#journal.length > MAX_DIAGNOSTICS) this.#journal.splice(0, this.#journal.length - MAX_DIAGNOSTICS);
  }

  #remember(messageId) {
    this.#seen.add(messageId);
    this.#seenOrder.push(messageId);
    while (this.#seenOrder.length > MAX_SEEN_MESSAGES) this.#seen.delete(this.#seenOrder.shift());
  }
}
