import { browserLaunchMetadataFromUrl } from '../../browserLaunch.js';
import { evaluateExtensionCompatibility } from '../../extensionCompatibility.js';
import { log } from '../../logger.js';
import { ExtensionMessageKind } from '../protocol/v4.js';
import { activeRequestFromPayload, normalizeClientSession, normalizeTabObservation } from './clientProjection.js';

function applyPageState(client, payload, observation = null) {
  const source = observation || payload;
  client.visibilityState = source.visibility || payload.visibilityState || client.visibilityState || '';
  client.focused = typeof source.focused === 'boolean' ? source.focused : Boolean(client.focused);
  client.documentReadyState = String(source.document?.readyState || payload.documentReadyState || client.documentReadyState || '');
  client.chatMainReady = typeof source.document?.chatMainReady === 'boolean' ? source.document.chatMainReady : typeof payload.chatMainReady === 'boolean' ? payload.chatMainReady : Boolean(client.chatMainReady);
  client.composerReady = typeof source.composer?.ready === 'boolean' ? source.composer.ready : typeof payload.composerReady === 'boolean' ? payload.composerReady : Boolean(client.composerReady);
  client.pageReady = typeof source.document?.pageReady === 'boolean' ? source.document.pageReady : typeof payload.pageReady === 'boolean' ? payload.pageReady : Boolean(client.pageReady);
}

export class HubClientMessageRouter {
  constructor({ clients, getSelectedClientId, setSelectedClientId, serverInstanceId, recordDebugEvent, publicClient, emit, removeClient, sendCompatibility, settleRequestRelease } = {}) {
    Object.assign(this, { clients, getSelectedClientId, setSelectedClientId, serverInstanceId, recordDebugEvent, publicClient, emit, removeClient, sendCompatibility, settleRequestRelease });
  }

  preflight(client, payload, envelope) {
    if (envelope.kind === ExtensionMessageKind.TRANSPORT_HELLO && envelope.request) return { accepted: true };
    if (!envelope.request) return { accepted: true };
    const lease = client.requestLeases?.get(envelope.request.requestId) || null;
    if (!lease || lease.leaseId !== envelope.request.leaseId || lease.ownerServerInstanceId !== envelope.request.ownerServerInstanceId) {
      this.recordDebugEvent(client.id, { type: 'protocol.v4.lease_rejected', requestId: envelope.request.requestId, leaseId: envelope.request.leaseId });
      return { accepted: false, reason: 'lease_rejected' };
    }
    return { accepted: true };
  }

  preview(client, payload, envelope) {
    if (payload.type === 'hello') return null;
    const preview = {
      ...client,
      requestLeases: client.requestLeases ? new Map(client.requestLeases) : new Map(),
      activeRequest: client.activeRequest ? { ...client.activeRequest } : null,
      session: client.session ? { ...client.session } : null,
      tabObservation: client.tabObservation ? structuredClone(client.tabObservation) : null,
    };
    if (payload.type === 'tab.observation') this.#applyObservation(preview, payload);
    else if (payload.type === 'pong' || payload.type === 'page.status') this.#applyStatus(preview, payload);
    else if (payload.type === 'page.changed') this.#applyPageChanged(preview, payload);
    const eventName = payload.type === 'tab.observation' || payload.type === 'pong' || payload.type === 'page.status' || payload.type === 'page.changed'
      ? 'client.activity'
      : 'client.message';
    return {
      eventName,
      data: eventName === 'client.activity'
        ? { clientId: client.id, client: this.publicClient(preview), payload, envelope }
        : { clientId: client.id, payload, envelope, client: this.publicClient(preview) },
    };
  }

  handle(client, payload, envelope) {
    client.lastSeenAt = Date.now();
    this.recordDebugEvent(client.id, { ...payload, protocolMessageId: envelope.messageId, protocolKind: envelope.kind });
    if (envelope.kind === ExtensionMessageKind.TRANSPORT_HELLO && envelope.request) {
      client.requestLeases ||= new Map();
      client.requestLeases.set(envelope.request.requestId, { ...envelope.request });
    } else if (!this.preflight(client, payload, envelope).accepted) {
      return false;
    }
    if ((payload.type === 'command.result' || payload.type === 'command.error' || payload.error)
      && client.releasePending?.commandId === String(payload.commandId || '')) {
      const error = payload.type === 'command.error' || payload.error || payload.released === false
        ? new Error(payload.message || payload.error || `Browser did not release request ${client.releasePending.requestId}`)
        : null;
      this.settleRequestRelease(client, payload, error);
    }
    if ((payload.type === 'command.result' || payload.type === 'command.error' || payload.type === 'command.rejected')
      && payload.releaseLease === true && envelope.request?.requestId) {
      client.requestLeases?.delete(envelope.request.requestId);
      if (client.activeRequest?.requestId === envelope.request.requestId) client.activeRequest = null;
    }
    if (payload.type === 'hello') return this.#hello(client, payload);
    if (payload.type === 'tab.observation') return this.#observation(client, payload, envelope);
    if (payload.type === 'pong' || payload.type === 'page.status') return this.#status(client, payload, envelope);
    if (payload.type === 'page.changed') return this.#pageChanged(client, payload, envelope);
    if (payload.type === 'command.result' && payload.activeRequest === null) {
      client.activeRequest = null;
      if (payload.requestId) client.requestLeases?.delete(String(payload.requestId));
    }
    this.emit('client.message', { clientId: client.id, payload, envelope, client: this.publicClient(client) });
    return undefined;
  }

  #hello(client, payload) {
    const oldId = client.id;
    const newId = typeof payload.clientId === 'string' && payload.clientId ? payload.clientId : oldId;
    if (newId !== oldId) {
      this.clients.delete(oldId);
      client.id = newId;
      const existing = this.clients.get(newId);
      if (existing && existing !== client) this.removeClient(existing, 'client.replaced');
      this.clients.set(newId, client);
      if (this.getSelectedClientId() === oldId) this.setSelectedClientId(newId);
    }
    client.ready = true;
    client.url = String(payload.url || '');
    const launchMetadata = browserLaunchMetadataFromUrl(client.url);
    client.title = String(payload.title || '');
    client.browserTabId = Number.isInteger(payload.browserTabId) ? payload.browserTabId : client.browserTabId;
    client.launchToken = String(payload.launchToken || launchMetadata.launchToken || client.launchToken || '');
    client.requestedUrl = String(payload.requestedUrl || launchMetadata.requestedUrl || client.requestedUrl || '');
    client.clientVersion = String(payload.clientVersion || payload.version || client.clientVersion || '');
    client.extensionVersion = String(payload.extensionVersion || client.extensionVersion || '');
    client.extensionProtocolVersion = Number(payload.extensionProtocolVersion ?? payload.protocolVersion ?? client.extensionProtocolVersion ?? 0) || 0;
    client.compatibility = evaluateExtensionCompatibility(client);
    client.capabilities = payload.capabilities && typeof payload.capabilities === 'object' ? payload.capabilities : {};
    client.transportHealth = payload.transportHealth && typeof payload.transportHealth === 'object' ? structuredClone(payload.transportHealth) : null;
    client.activeRequest = payload.activeRequest ? activeRequestFromPayload(payload.activeRequest, client.activeRequest) : null;
    client.session = normalizeClientSession(payload, client.session);
    client.tabObservation = normalizeTabObservation(payload, client.tabObservation);
    applyPageState(client, payload);
    this.emit('client.ready', this.publicClient(client));
    this.sendCompatibility(client);
    const launchSuffix = client.launchToken ? ` launch=${client.launchToken.slice(-8)}` : '';
    log(`Browser extension client ready: ${client.id} ${client.url}${launchSuffix}${client.compatibility?.compatible === false ? ' (incompatible)' : ''}`);
    return undefined;
  }

  #applyObservation(client, payload) {
    const previousObservation = client.tabObservation;
    client.tabObservation = normalizeTabObservation(payload, previousObservation);
    if (previousObservation && client.tabObservation === previousObservation) return false;
    const observation = client.tabObservation || {};
    client.url = String(observation.url || payload.url || client.url || '');
    client.title = String(observation.title || payload.title || client.title || '');
    client.activeRequest = Object.hasOwn(observation, 'activeRequest')
      ? (observation.activeRequest ? activeRequestFromPayload(observation.activeRequest, client.activeRequest) : null)
      : (client.activeRequest || null);
    client.session = normalizeClientSession({
      ...payload,
      url: observation.url || payload.url,
      title: observation.title || payload.title,
      session: payload.session || (observation.conversationId ? { id: observation.conversationId, url: observation.url || payload.url || client.url, title: observation.title || payload.title || client.title, active: true } : undefined),
    }, client.session);
    applyPageState(client, payload, observation);
    return true;
  }

  #observation(client, payload, envelope) {
    const previousObservation = client.tabObservation;
    if (!this.#applyObservation(client, payload)) {
      this.recordDebugEvent(client.id, {
        type: 'tab.observation.ignored',
        observerId: String(payload.observation?.observerId || payload.tabObservation?.observerId || ''),
        revision: Number(payload.observation?.revision ?? payload.tabObservation?.revision ?? payload.revision) || 0,
        currentRevision: Number(previousObservation?.revision) || 0,
      });
      return undefined;
    }
    this.emit('client.activity', { clientId: client.id, client: this.publicClient(client), payload, envelope });
    return undefined;
  }

  #applyStatus(client, payload) {
    if (payload.url) {
      client.url = String(payload.url);
      const launchMetadata = browserLaunchMetadataFromUrl(client.url);
      if (!client.launchToken && launchMetadata.launchToken) client.launchToken = launchMetadata.launchToken;
      if (!client.requestedUrl && launchMetadata.requestedUrl) client.requestedUrl = launchMetadata.requestedUrl;
    }
    if (payload.title) client.title = String(payload.title);
    client.session = normalizeClientSession(payload, client.session);
    client.tabObservation = normalizeTabObservation(payload, client.tabObservation);
    applyPageState(client, payload);
  }

  #status(client, payload, envelope) {
    this.#applyStatus(client, payload);
    this.emit('client.activity', { clientId: client.id, client: this.publicClient(client), payload, envelope });
    return undefined;
  }

  #applyPageChanged(client, payload) {
    client.url = String(payload.url || client.url || '');
    client.title = String(payload.title || client.title || '');
    client.session = normalizeClientSession(payload, client.session);
    client.tabObservation = normalizeTabObservation(payload, client.tabObservation);
    applyPageState(client, payload);
    if (Object.hasOwn(payload, 'activeRequest')) client.activeRequest = payload.activeRequest ? activeRequestFromPayload(payload.activeRequest, client.activeRequest) : null;
  }

  #pageChanged(client, payload, envelope) {
    this.#applyPageChanged(client, payload);
    const publicClient = this.publicClient(client);
    this.emit('client.changed', publicClient);
    this.emit('client.activity', { clientId: client.id, client: publicClient, payload, envelope });
    return undefined;
  }
}
