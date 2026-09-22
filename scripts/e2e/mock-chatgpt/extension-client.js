import { EventEmitter } from 'node:events';
import { describeTransfer } from '../../../src/bridge/transferIntegrity.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from '../../../src/runtime/ws.js';
import { ExtensionMessageType, createExtensionEnvelope, validateExtensionEnvelope } from '../../../src/bridge/protocol/v5.js';
import { renderMockChatPage } from './render.js';
import { MockChatGptStateMachine } from './state-machine.js';
import { LOCAL_E2E_COMMAND_TYPE_SET } from './contract.js';
import { effectEnvelopeOptions, effortsListResult, intelligenceApplyResult, modelsListResult, preparationEffectResult, steerEffectResult } from './command-results.js';
import { removeCapturedBrowserDownload } from '../../../src/bridge/browserDownloads.js';
import { tabScopedClientId } from '../../../tools/chrome-bridge-extension/shared/tabClientIdentity.js';
import { EXPECTED_EXTENSION_ORIGIN } from '../../../src/bridge/hub/connectionPolicy.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value) => String(value ?? '').trim();

function bundledExtensionRuntimeIdentity() {
  const root = fileURLToPath(new URL('../../../tools/chrome-bridge-extension/', import.meta.url));
  const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', new URL(`file://${root}/`)), 'utf8'));
  const content = fs.readFileSync(new URL('content.js', new URL(`file://${root}/`)), 'utf8');
  const build = fs.readFileSync(new URL('shared/buildIdentity.js', new URL(`file://${root}/`)), 'utf8');
  return Object.freeze({
    extensionVersion: text(manifest.version),
    clientVersion: text(content.match(/\bCONTENT_SCRIPT_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1]),
    extensionBundleId: text(build.match(/\bbundleId\s*:\s*['"]([^'"]+)['"]/)?.[1]),
  });
}

export const MOCK_EXTENSION_RUNTIME_IDENTITY = bundledExtensionRuntimeIdentity();

function requestIdentity(envelope, body = {}) {
  const source = envelope?.request || {};
  const requestId = text(source.requestId || body.requestId);
  if (!requestId) return null;
  return {
    requestId,
    leaseId: text(source.leaseId || body.leaseId),
    ownerServerInstanceId: text(source.ownerServerInstanceId || body.ownerServerInstanceId),
    responseEpoch: Math.max(0, Number(source.responseEpoch ?? body.responseEpoch) || 0),
  };
}

function commandMode(body = {}) {
  return ['result', 'effect', 'release'].includes(text(body.commandMode)) ? text(body.commandMode) : 'result';
}

function effectResultBody(step = {}, request = {}, result = {}) {
  return {
    effectId: text(step.effectId),
    effectType: text(step.kind),
    requestId: text(request.requestId),
    responseEpoch: Math.max(0, Number(request.responseEpoch) || 0),
    result,
  };
}

export class MockExtensionTab extends EventEmitter {
  constructor({ bridgeUrl, bridgeToken = '', tabId, registry, pageOrigin = '', launchToken = '', requestedUrl = 'https://chatgpt.com/', active = true, focused = false, state = null, releaseDelayMs = 150, deliveryNoise = true, contentClientId = '' } = {}) {
    super();
    if (!bridgeUrl) throw new TypeError('Mock extension tab requires bridgeUrl');
    this.bridgeUrl = String(bridgeUrl).replace(/\/$/, '');
    this.bridgeToken = String(bridgeToken || '');
    this.tabId = Number(tabId);
    this.registry = registry;
    this.pageOrigin = String(pageOrigin || '').replace(/\/$/, '');
    this.launchToken = String(launchToken || '');
    this.requestedUrl = String(requestedUrl || 'https://chatgpt.com/');
    this.active = active !== false;
    this.focused = this.active && focused === true;
    this.contentClientId = text(contentClientId) || `mock-extension-${randomUUID()}`;
    this.clientId = tabScopedClientId(this.contentClientId, this.tabId);
    this.backgroundEpoch = `mock-background-${randomUUID()}`;
    this.contentEpoch = `mock-content-${randomUUID()}`;
    this.sequence = 0;
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.serverInstanceId = '';
    this.state = state || new MockChatGptStateMachine({ tabId: this.tabId, origin: 'https://chatgpt.com' });
    this.lastPrompt = '';
    this.currentGeneration = null;
    this.commandJournal = [];
    this.effectJournal = new Map();
    this.pendingTransportAcks = new Map();
    this.extensionReloadCount = 0;
    this.pageReloadCount = 0;
    this.trampolineReloadCount = 0;
    this.releaseDelayMs = Math.max(0, Number(releaseDelayMs) || 0);
    this.documentReadyState = 'interactive';
    this.deliveryNoise = deliveryNoise !== false;
    this.duplicateBudgets = new Map([[ExtensionMessageType.TAB_OBSERVATION, 2], [ExtensionMessageType.EFFECT_SUCCEEDED, 1]]);
    this.duplicateDeliveryCount = 0;
    this.lateObservationCount = 0;
    this.staleObservationCandidate = null;
  }

  publicLayoutUrl() {
    if (!this.pageOrigin) return '';
    return `${this.pageOrigin}/c/${encodeURIComponent(this.state.sessionId)}?tab=${this.tabId}`;
  }

  source() {
    return {
      clientId: this.clientId,
      tabId: this.tabId,
      backgroundEpoch: this.backgroundEpoch,
      contentEpoch: this.contentEpoch,
      sequence: ++this.sequence,
    };
  }

  helloBody() {
    return {
      type: 'hello',
      clientId: this.contentClientId,
      runtime: 'extension',
      url: this.state.url,
      title: 'ChatGPT',
      browserTabId: this.tabId,
      launchToken: this.launchToken,
      requestedUrl: this.requestedUrl,
      clientVersion: MOCK_EXTENSION_RUNTIME_IDENTITY.clientVersion,
      extensionVersion: MOCK_EXTENSION_RUNTIME_IDENTITY.extensionVersion,
      extensionBundleId: MOCK_EXTENSION_RUNTIME_IDENTITY.extensionBundleId,
      extensionProtocolVersion: 5,
      visibilityState: this.active ? 'visible' : 'hidden',
      focused: this.active && this.focused,
      documentReadyState: this.documentReadyState,
      pageReady: true,
      composerReady: true,
      chatMainReady: true,
      activeRequest: this.state.activeRequest,
      session: this.state.sessionProjection(),
      capabilities: {
        browserTabs: true,
        sessionDeletion: true,
        promptSteering: true,
        pageLayoutCapture: true,
        artifactDownload: true,
        intelligenceSelection: true,
        passiveObservation: true,
        protocol5: true,
      },
      mock: {
        enabled: true,
        layoutUrl: this.publicLayoutUrl(),
        extensionReloadCount: this.extensionReloadCount,
        pageReloadCount: this.pageReloadCount,
        trampolineReloadCount: this.trampolineReloadCount,
        deliveryNoise: this.deliveryNoise,
        duplicateDeliveryCount: this.duplicateDeliveryCount,
        lateObservationCount: this.lateObservationCount,
      },
    };
  }

  async connect() {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) return this;
    const wsUrl = new URL('/extension/ws', this.bridgeUrl.replace(/^http/, 'ws'));
    wsUrl.searchParams.set('runtime', 'extension');
    if (this.bridgeToken) wsUrl.searchParams.set('token', this.bridgeToken);
    this.ws = new WebSocket(wsUrl, { origin: EXPECTED_EXTENSION_ORIGIN });
    // Install the protocol listener before awaiting `open`: the bridge sends
    // transport.hello immediately and a fast local socket can otherwise lose
    // the server epoch before the mock publishes its own hello.
    this.ws.on('message', (raw) => { void this.#handleServerMessage(raw); });
    this.ws.on('close', () => { this.connected = false; this.emit('disconnected'); });
    // Connection failures reject connect(); only later failures are events.
    this.ws.on('error', (error) => { if (this.connected) this.emit('error', error); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Mock extension tab ${this.tabId} connection timed out`)), 10_000);
      this.ws.once('open', () => { clearTimeout(timer); resolve(); });
      this.ws.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    this.connected = true;
    await this.send(ExtensionMessageType.TRANSPORT_HELLO, this.helloBody());
    await this.publishObservation('hello');
    if (this.documentReadyState !== 'complete') {
      this.documentReadyState = 'complete';
      await delay(10);
      await this.publishObservation('document.complete');
    }
    this.emit('connected', this);
    return this;
  }

  async reconnect({ replaceBackground = false, replaceContent = true } = {}) {
    const old = this.ws;
    this.connected = false;
    if (replaceBackground) {
      this.backgroundEpoch = `mock-background-${randomUUID()}`;
      this.duplicateBudgets = new Map([[ExtensionMessageType.TAB_OBSERVATION, 2], [ExtensionMessageType.EFFECT_SUCCEEDED, 1]]);
    }
    if (replaceContent) {
      this.contentEpoch = `mock-content-${randomUUID()}`;
      this.documentReadyState = 'interactive';
      this.staleObservationCandidate = null;
    }
    this.sequence = 0;
    try { old?.terminate?.(); } catch {}
    await delay(25);
    return await this.connect();
  }

  async close() {
    this.closed = true;
    this.connected = false;
    for (const pending of this.pendingTransportAcks.values()) pending.reject(new Error(`Mock extension tab ${this.tabId} closed before transport ACK`));
    this.pendingTransportAcks.clear();
    const socket = this.ws;
    this.ws = null;
    if (!socket) return;
    let closed = socket.readyState === WebSocket.CLOSED;
    const closedPromise = closed ? Promise.resolve() : new Promise((resolve) => {
      const onClose = () => { closed = true; resolve(); };
      socket.once?.('close', onClose);
      setTimeout(resolve, 100).unref?.();
    });
    try { socket.close?.(1000, 'mock tab closed'); } catch {}
    await closedPromise;
    if (!closed) {
      try { socket.terminate?.(); } catch {}
      try { socket.destroy?.(); } catch {}
      try { socket._socket?.destroy?.(); } catch {}
    }
  }

  async send(messageType, body = {}, { commandId = null, effectId = null, request = null, causationId = null, waitForAck = false, ackTimeoutMs = 5_000 } = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error(`Mock extension tab ${this.tabId} is disconnected`);
    const envelope = createExtensionEnvelope(messageType, body, {
      source: this.source(), commandId, effectId, request, causationId,
    });
    let acknowledgement = null;
    if (waitForAck) {
      acknowledgement = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingTransportAcks.delete(envelope.messageId);
          reject(new Error(`Transport ACK timed out for ${messageType} ${envelope.messageId}`));
        }, Math.max(100, Number(ackTimeoutMs) || 5_000));
        this.pendingTransportAcks.set(envelope.messageId, {
          resolve: (ack) => { clearTimeout(timer); resolve(ack); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
      });
    }
    const serialized = JSON.stringify(envelope);
    this.ws.send(serialized);
    const remainingDuplicates = Number(this.duplicateBudgets.get(messageType) || 0);
    if (this.deliveryNoise && remainingDuplicates > 0) {
      this.duplicateBudgets.set(messageType, remainingDuplicates - 1);
      this.duplicateDeliveryCount += 1;
      setTimeout(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(serialized);
      }, 5).unref?.();
    }
    if (acknowledgement) await acknowledgement;
    return envelope;
  }

  async #handleServerMessage(raw) {
    let envelope;
    try { envelope = JSON.parse(String(raw)); } catch { return; }
    const validation = validateExtensionEnvelope(envelope, { direction: 'server_to_extension' });
    if (!validation.valid) {
      this.emit('protocolError', validation.errors);
      return;
    }
    if (envelope.messageType === ExtensionMessageType.TRANSPORT_HELLO) {
      this.serverInstanceId = text(envelope.body?.serverInstanceId);
      return;
    }
    if (envelope.messageType === ExtensionMessageType.TRANSPORT_PING) {
      await this.send(ExtensionMessageType.TRANSPORT_PONG, { type: 'pong', time: Date.now() }, { causationId: envelope.messageId });
      return;
    }
    if (envelope.messageType === ExtensionMessageType.TRANSPORT_ACK) {
      const ackMessageId = text(envelope.body?.ackMessageId);
      const pending = this.pendingTransportAcks.get(ackMessageId);
      if (pending) {
        this.pendingTransportAcks.delete(ackMessageId);
        if (envelope.body?.accepted === false) pending.reject(new Error(`Transport ACK rejected ${ackMessageId}: ${text(envelope.body?.reason) || 'rejected'}`));
        else pending.resolve(envelope);
      }
      return;
    }
    if (envelope.messageType === ExtensionMessageType.TRANSPORT_DIAGNOSTIC) return;
    if (envelope.messageType !== ExtensionMessageType.COMMAND_EXECUTE) return;
    await this.#executeCommand(envelope);
  }

  async #accepted(envelope) {
    const body = envelope.body || {};
    const mode = commandMode(body);
    const effect = mode === 'effect' ? this.#step(body) : null;
    await this.send(ExtensionMessageType.COMMAND_ACCEPTED, {
      commandId: envelope.commandId,
      commandType: text(body.type),
      requestId: text(envelope.request?.requestId),
      commandMode: mode,
      commandScope: envelope.request ? 'request' : 'standalone',
      ...(effect ? { effectId: text(effect.effectId), effectType: text(effect.kind) } : {}),
      acceptedAt: Date.now(),
    }, { commandId: envelope.commandId, request: envelope.request, causationId: envelope.messageId });
  }

  async #result(envelope, resultType, result = {}) {
    await this.send(ExtensionMessageType.COMMAND_RESULT, {
      commandId: envelope.commandId,
      resultType,
      ...result,
    }, { commandId: envelope.commandId, request: envelope.request, causationId: envelope.messageId });
  }

  async #reject(envelope, code, message, extra = {}) {
    await this.send(ExtensionMessageType.COMMAND_REJECTED, {
      commandId: envelope.commandId,
      code,
      message,
      ...extra,
    }, { commandId: envelope.commandId, request: envelope.request, causationId: envelope.messageId });
  }

  async #effect(envelope, step, result = {}) {
    const request = requestIdentity(envelope, envelope.body);
    const record = {
      effectId: text(step.effectId),
      kind: text(step.kind),
      status: 'dispatched',
      request,
      result: null,
      updatedAt: Date.now(),
    };
    this.effectJournal.set(record.effectId, record);
    await this.send(ExtensionMessageType.EFFECT_STARTED, effectResultBody(step, request, {}), effectEnvelopeOptions(envelope, step, request));
    Object.assign(record, { status: 'succeeded', result, updatedAt: Date.now() });
    await this.send(ExtensionMessageType.EFFECT_SUCCEEDED, effectResultBody(step, request, result), {
      ...effectEnvelopeOptions(envelope, step, request),
      waitForAck: true,
    });
  }

  #step(body = {}) {
    const plan = body.executionPlan && typeof body.executionPlan === 'object' ? body.executionPlan : null;
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    return steps.find((step) => text(step.stepId) === text(plan?.startAtStepId)) || steps[0] || body.effect || null;
  }

  async #executeCommand(envelope) {
    const body = envelope.body || {};
    const type = text(body.type);
    this.commandJournal.push({ at: Date.now(), commandId: envelope.commandId, type, requestId: envelope.request?.requestId || '' });
    if (!LOCAL_E2E_COMMAND_TYPE_SET.has(type)) {
      await this.#reject(envelope, 'MOCK_COMMAND_UNSUPPORTED', `Mock ChatGPT does not implement command ${type || '(missing)'}`);
      return;
    }
    await this.#accepted(envelope);
    try {
      if (type === 'prompt.send') return await this.#promptSend(envelope);
      if (type === 'prompt.steer') return await this.#promptSteer(envelope);
      if (type === 'prompt.cancel') return await this.#promptCancel(envelope);
      if (type === 'request.release') return await this.#release(envelope);
      if (type === 'request.resume' || type === 'response.snapshot.request') {
        await this.publishObservation(type);
        return await this.#result(envelope, type === 'request.resume' ? 'request.resumed' : 'response.snapshot', {
          activeRequest: this.state.activeRequest,
          observation: this.createObservation(),
        });
      }
      if (type === 'request.effect.reconcile') {
        const record = this.effectJournal.get(text(body.effectId)) || null;
        return await this.#result(envelope, 'request.effect.reconciled', record?.status === 'succeeded'
          ? { reconciliationOutcome: 'succeeded', reconciliationReason: 'mock_effect_ledger_succeeded', evidence: { effectId: record.effectId, effectType: record.kind, result: record.result } }
          : { reconciliationOutcome: 'uncertain', reconciliationReason: 'mock_effect_ledger_missing', evidence: { effectId: text(body.effectId) } });
      }
      if (type === 'passive.prompt.submit') return await this.#passivePrompt(envelope);
      if (type === 'sessions.list') return await this.#result(envelope, 'sessions.list', { sessions: this.state.publicState().sessions, currentSessionId: this.state.conversationId || 'new' });
      if (type === 'sessions.new') {
        const session = this.state.newSession();
        await this.publishObservation('sessions.new');
        return await this.#result(envelope, 'session.created', { session, ...session });
      }
      if (type === 'sessions.select') {
        const session = this.state.selectSession(text(body.sessionId));
        await this.publishObservation('sessions.select');
        return await this.#result(envelope, 'session.selected', { session, ...session });
      }
      if (type === 'sessions.delete') {
        const deleted = this.state.deleteSession(text(body.sessionId));
        await this.publishObservation('sessions.delete');
        return await this.#result(envelope, 'session.deleted', deleted);
      }
      if (type === 'browser.tab.open') return await this.#openTab(envelope);
      if (type === 'browser.tab.reload') {
        await this.#result(envelope, 'browser.tab.reloading', { tabId: this.tabId, requestId: envelope.request?.requestId || '' });
        setTimeout(() => { void this.reconnect({ replaceContent: true }); }, 35);
        return;
      }
      if (type === 'browser.tab.close' || type === 'browser.tab.close-owned') {
        await this.#result(envelope, 'browser.tab.closed', { tabId: this.tabId, closed: true });
        setTimeout(() => { void this.registry?.closeTab?.(this.tabId); }, 20);
        return;
      }
      if (type === 'extension.reload') {
        this.extensionReloadCount += 1;
        await this.#result(envelope, 'extension.reload.accepted', {
          accepted: true,
          scheduled: true,
          expectedVersion: body.expectedVersion || '2.3.9',
          pageReload: { armed: true, owner: 'mock-main-world-timer', delayMs: Number(body.pageReloadDelayMs) || 2_500 },
          recoveryWake: { armed: true, owner: 'mock-extension-alarm' },
          reloadTrampoline: { planned: true, count: 1, owner: 'mock-local-bridge-page' },
        });
        // Match the real lifecycle: the acknowledged background worker goes
        // away first, then an independent recovery wake reloads the document
        // so both the background and content epochs are replaced.
        setTimeout(() => {
          this.trampolineReloadCount += 1;
          this.pageReloadCount += 1;
          void this.reconnect({ replaceBackground: true, replaceContent: true });
        }, 850);
        return;
      }
      if (type === 'debug.layout.capture') {
        const html = renderMockChatPage(this.state.publicState());
        return await this.#result(envelope, 'page.layout.captured', { type: 'page.layout.captured', ...describeTransfer(Buffer.from(html), html.length, 1, 'utf8'), html, htmlLength: html.length, chunked: false, url: this.state.url, title: 'ChatGPT' });
      }
      if (type === 'artifact.fetch' || type === 'artifact.image.read') return await this.#artifactFetch(envelope);
      if (type === 'models.list') return await this.#result(envelope, 'models.list', modelsListResult(this.state.intelligence()));
      if (type === 'efforts.list') return await this.#result(envelope, 'efforts.list', effortsListResult(this.state.intelligence()));
      if (type === 'intelligence.apply') {
        const intelligence = this.state.setIntelligence(body.options || {});
        await this.publishObservation('intelligence.apply');
        return await this.#result(envelope, 'intelligence.applied', intelligenceApplyResult(intelligence, body.options || {}));
      }
      if (type === 'composer.attachments.clear') {
        const cleared = this.state.clearAttachments();
        await this.publishObservation('composer.attachments.clear');
        return await this.#result(envelope, 'composer.attachments.cleared', { cleared: true, ...cleared });
      }
      if (type === 'response.recover.list') {
        const candidate = this.#recoveredCandidate();
        return await this.#result(envelope, 'response.recovered.list', {
          candidates: candidate ? [candidate] : [],
          session: candidate?.session || null,
          url: this.state.url,
          title: 'ChatGPT',
        });
      }
      if (type === 'response.recover.latest') {
        return await this.#result(envelope, 'response.recovered.latest', this.#recoveredCandidate() || {
          answer: '', artifacts: [], session: this.state.sessionProjection(), url: this.state.url, title: 'ChatGPT',
        });
      }
      if (type === 'response.recover.turnKey') {
        return await this.#result(envelope, 'response.recovered.turnKey', this.#recoveredCandidate(text(body.turnKey)) || {
          answer: '', artifacts: [], turnKey: text(body.turnKey), session: this.state.sessionProjection(), url: this.state.url, title: 'ChatGPT', reason: 'turn_not_found',
        });
      }
      if (type === 'command.cancel') return await this.#result(envelope, 'command.cancelled', { targetCommandId: body.targetCommandId, cancelled: true });
      await this.#reject(envelope, 'MOCK_COMMAND_UNSUPPORTED', `Mock ChatGPT does not implement command ${type}`);
    } catch (error) {
      await this.#reject(envelope, text(error.code) || 'MOCK_COMMAND_FAILED', error.message || String(error));
    }
  }

  async #promptSend(envelope) {
    const body = envelope.body || {};
    const request = requestIdentity(envelope, body);
    const step = this.#step(body);
    if (!request || !step) throw Object.assign(new Error('Mock prompt.send requires request identity and execution step'), { code: 'MOCK_EXECUTION_PLAN_INVALID' });
    const retry = body.responseRetry && typeof body.responseRetry === 'object' ? body.responseRetry : null;
    if (retry && step.kind === 'page.ready.initial') {
      const current = this.state.activeRequest || {};
      const failedUser = [...this.state.turns].reverse().find((turn) => turn.role === 'user');
      const previousResponseEpoch = Math.max(0, Number(retry.previousResponseEpoch) || 0);
      const targetResponseEpoch = Math.max(0, Number(retry.targetResponseEpoch) || 0);
      const retryProven = String(current.requestId || '') === request.requestId
        && Number(current.responseEpoch || 0) === previousResponseEpoch
        && request.responseEpoch === targetResponseEpoch
        && targetResponseEpoch === previousResponseEpoch + 1
        && String(failedUser?.key || '') === String(retry.failedUserTurnKey || '')
        && failedUser?.errorCode === 'CHATGPT_TRANSIENT_REQUEST_ERROR'
        && failedUser?.errorRetryable === true;
      if (!retryProven) {
        throw Object.assign(new Error('Mock response retry preconditions are not proven by the failed user turn'), {
          code: 'MOCK_RESPONSE_RETRY_PRECONDITION_FAILED',
          provenNotExecuted: true,
        });
      }
    }
    this.state.activeRequest = { ...(this.state.activeRequest || {}), ...request };
    let preparationResult = null;
    if (step.kind === 'session.apply') {
      const session = body.options?.newSession
        ? this.state.newSession()
        : body.options?.sessionId
          ? this.state.selectSession(body.options.sessionId)
          : this.state.sessionProjection();
      preparationResult = preparationEffectResult(step.kind, { session });
    } else if (step.kind === 'model.apply') {
      const intelligence = this.state.setIntelligence(body.options || {});
      preparationResult = preparationEffectResult(step.kind, { intelligence, options: body.options || {} });
    } else if (step.kind === 'attachments.upload') {
      const attachments = this.state.setAttachments(Array.isArray(body.attachments) ? structuredClone(body.attachments) : []);
      preparationResult = preparationEffectResult(step.kind, { attachments });
    }
    if (step.kind !== 'prompt.submit') {
      await this.#effect(envelope, step, preparationResult || preparationEffectResult(step.kind));
      await this.publishObservation(`effect:${step.kind}`);
      return;
    }

    const conversationTransition = this.state.beginConversationCanonicalization();
    const userKey = this.state.appendUser(body.message, request);
    this.state.activeRequest = { ...request, submittedUserTurnKey: userKey };
    this.lastPrompt = String(body.message || '');
    await this.publishObservation('prompt.user-appended');
    await this.#effect(envelope, step, {
      submitted: true,
      submittedUserTurnKey: userKey,
      session: this.state.sessionProjection(),
      ...(retry ? {
        retryAttempt: Math.max(1, Number(retry.attempt) || 1),
        previousResponseEpoch: Math.max(0, Number(retry.previousResponseEpoch) || 0),
        targetResponseEpoch: Math.max(0, Number(retry.targetResponseEpoch) || request.responseEpoch),
        failedUserTurnKey: String(retry.failedUserTurnKey || ''),
      } : {}),
    });
    if (conversationTransition) {
      setTimeout(() => {
        if (!this.state.completeConversationCanonicalization(conversationTransition.temporaryId)) return;
        void this.publishObservation('conversation.canonicalized');
      }, 45);
    }
    this.currentGeneration = this.state.generate(this.lastPrompt, {
      request,
      onChange: async (reason) => await this.publishObservation(reason),
    }).catch((error) => this.emit('generationError', error));
  }

  async #promptSteer(envelope) {
    const body = envelope.body || {};
    const request = requestIdentity(envelope, body);
    const step = body.effect;
    if (!request || !step?.effectId) throw Object.assign(new Error('Mock prompt.steer requires effect identity'), { code: 'MOCK_STEER_INVALID' });
    if (!this.state.canSteer()) {
      const error = new Error('Mock ChatGPT has not exposed the steering send control yet');
      error.code = 'MOCK_STEER_NOT_READY';
      throw error;
    }
    const preview = steerEffectResult({ request, body, step });
    const userKey = this.state.appendSteer(body.message, { ...request, responseEpoch: preview.targetResponseEpoch });
    const result = steerEffectResult({ request, body, step, submittedUserTurnKey: userKey });
    this.state.activeRequest = { ...request, responseEpoch: result.targetResponseEpoch, submittedUserTurnKey: userKey };
    await this.#effect(envelope, step, result);
    await this.state.steer(body.message, { onChange: async (reason) => await this.publishObservation(reason) });
  }

  async #promptCancel(envelope) {
    const body = envelope.body || {};
    const request = requestIdentity(envelope, body);
    const step = body.effect;
    this.state.cancel();
    await this.#effect(envelope, step, { cancelled: true });
    await this.publishObservation('prompt.cancelled');
  }

  async #release(envelope) {
    const request = requestIdentity(envelope, envelope.body);
    this.state.activeRequest = null;
    await this.publishObservation('request.release');
    if (this.releaseDelayMs) await delay(this.releaseDelayMs);
    await this.send(ExtensionMessageType.LEASE_RELEASED, {
      commandId: envelope.commandId,
      requestId: request.requestId,
      released: true,
      activeRequest: null,
      leaseId: request.leaseId,
      ownerServerInstanceId: request.ownerServerInstanceId,
    }, { commandId: envelope.commandId, request, causationId: envelope.messageId });
  }

  async #passivePrompt(envelope) {
    const body = envelope.body || {};
    if (body.options?.newSession) this.state.newSession();
    else if (body.options?.sessionId) this.state.selectSession(body.options.sessionId);
    if (body.options?.model || body.options?.effort) this.state.setIntelligence(body.options);
    const conversationTransition = this.state.beginConversationCanonicalization();
    const userKey = this.state.appendUser(body.message, null);
    await this.publishObservation('passive.user-appended');
    await this.#result(envelope, 'passive.prompt.submitted', {
      submittedUserTurnKey: userKey,
      session: this.state.sessionProjection(),
      url: this.state.url,
      title: 'ChatGPT',
    });
    if (conversationTransition) {
      setTimeout(() => {
        if (!this.state.completeConversationCanonicalization(conversationTransition.temporaryId)) return;
        void this.publishObservation('passive.conversation.canonicalized');
      }, 45);
    }
    const previousGeneration = this.currentGeneration;
    this.currentGeneration = (async () => {
      await previousGeneration?.catch?.(() => null);
      return await this.state.generate(body.message, {
        onChange: async (reason) => await this.publishObservation(`passive.${reason}`),
      });
    })().catch((error) => this.emit('generationError', error));
  }

  async #openTab(envelope) {
    const body = envelope.body || {};
    const opened = await this.registry.openTab({
      launchToken: body.launchToken,
      requestedUrl: body.url || 'https://chatgpt.com/',
      active: body.active !== false,
    });
    await this.#result(envelope, 'browser.tab.opened', {
      tabId: opened.tabId,
      launchToken: opened.launchToken,
      requestedUrl: opened.requestedUrl,
      targetUrl: opened.state.url,
      active: body.active !== false,
    });
  }

  async #artifactFetch(envelope) {
    const identity = envelope.body?.artifact || {};
    const artifact = this.state.artifactById(text(identity.id || identity.candidateId));
    if (!artifact) throw Object.assign(new Error(`Mock artifact not found: ${identity.id || identity.candidateId || identity.name}`), { code: 'ARTIFACT_NOT_FOUND' });
    const captureSource = text(artifact.materializationSource) || 'page-url';
    if (captureSource === 'chrome-downloads') {
      const download = await this.registry.createBrowserDownload(artifact);
      await this.#result(envelope, 'artifact.data.done', {
        type: 'artifact.data.done',
        artifactId: artifact.id,
        name: download.name,
        mime: artifact.mime,
        size: download.size,
        encodedSize: 0,
        filePath: download.filePath,
        captureSource,
        downloadId: download.downloadId,
        browserCaptureStartedAt: download.browserCaptureStartedAt,
        browserCapturedAt: download.browserCapturedAt,
        browserDownloadStartTime: download.browserDownloadStartTime,
        browserDownloadEndTime: download.browserDownloadEndTime,
      });
      return;
    }
    const encoded = artifact.buffer.toString('base64');
    await this.#result(envelope, 'artifact.data.done', {
      type: 'artifact.data.done',
      artifactId: artifact.id,
      name: artifact.fileName || artifact.name,
      mime: artifact.mime,
      size: artifact.buffer.length,
      encodedSize: encoded.length,
      contentBase64: encoded,
      ...describeTransfer(artifact.buffer),
      captureSource,
    });
  }


  #recoveredCandidate(turnKey = '') {
    const assistantTurns = this.state.turns.filter((turn) => turn.role === 'assistant' && turn.final);
    const assistant = turnKey
      ? assistantTurns.find((turn) => turn.key === turnKey || turn.messageId === turnKey)
      : assistantTurns.at(-1);
    if (!assistant) return null;
    const index = this.state.turns.indexOf(assistant);
    const projection = this.state.outputSnapshot();
    const artifacts = (assistant.artifacts || []).map((item) => ({
      id: item.id,
      candidateId: item.candidateId || item.id,
      kind: item.genericDownloadAction ? 'action' : item.kind,
      name: item.genericDownloadAction ? item.actionLabel : item.name,
      actionLabel: item.actionLabel || '',
      mime: item.mime,
      phase: item.phase || 'READY',
      downloadable: true,
      downloadActionPresent: true,
      url: `${this.pageOrigin}/artifacts/${encodeURIComponent(item.id)}`,
      sourceTurnKey: assistant.key,
      turnKey: assistant.key,
    }));
    return {
      answer: assistant.text || '',
      thinking: assistant.progressItems?.map((item) => item.text).join('\n') || '',
      progressItems: assistant.progressItems || [],
      reasoningHistory: (assistant.progressItems || []).filter((item) => item.state === 'completed'),
      responseBlocks: assistant === projection.assistant ? projection.responseBlocks : [],
      codeBlocks: assistant === projection.assistant ? projection.codeBlocks : [],
      parserAudit: assistant === projection.assistant ? projection.parserAudit : null,
      artifacts,
      session: this.state.sessionProjection(),
      url: this.state.url,
      title: 'ChatGPT',
      sourceClientId: this.clientId,
      source: 'mock-latest-assistant-turn',
      format: 'markdown',
      turnKey: assistant.key,
      turnIndex: index,
      recoveredAt: new Date().toISOString(),
    };
  }

  createObservation() {
    const snapshot = this.state.outputSnapshot();
    const assistantIndex = snapshot.assistant ? this.state.turns.indexOf(snapshot.assistant) : -1;
    const userIndex = snapshot.user ? this.state.turns.indexOf(snapshot.user) : -1;
    const active = this.state.activeRequest ? {
      ...this.state.activeRequest,
      assistantTurnKey: snapshot.assistant?.key || '',
      assistantTurnIndex: assistantIndex,
      submittedUserTurnKey: this.state.activeRequest.submittedUserTurnKey || snapshot.user?.key || '',
      submittedUserTurnIndex: userIndex,
    } : null;
    const final = Boolean(snapshot.assistant?.final && !this.state.generating);
    const hasAssistant = Boolean(snapshot.assistant);
    const userError = snapshot.user?.errorText ? {
      explicit: true,
      message: String(snapshot.user.errorText),
      code: String(snapshot.user.errorCode || 'CHATGPT_TRANSIENT_REQUEST_ERROR'),
      kind: String(snapshot.user.errorKind || 'transient_request_error'),
      retryable: snapshot.user.errorRetryable !== false,
      userTurnKey: String(snapshot.user.key || ''),
    } : { explicit: false, message: '', code: '', kind: '', retryable: false, userTurnKey: '' };
    const outputState = this.state.generating
      ? (snapshot.progressItems.length ? 'reasoning' : 'streaming')
      : final ? 'final' : 'none';
    const artifacts = snapshot.artifacts.map((item) => ({
      id: item.id,
      candidateId: item.candidateId || item.id,
      kind: item.genericDownloadAction ? 'action' : item.kind,
      name: item.genericDownloadAction ? item.actionLabel : item.name,
      actionLabel: item.actionLabel || '',
      mime: item.mime,
      phase: item.phase || 'READY',
      downloadable: true,
      downloadActionPresent: true,
      url: `${this.pageOrigin}/artifacts/${encodeURIComponent(item.id)}`,
      sourceTurnKey: snapshot.assistant?.key || '',
      turnKey: snapshot.assistant?.key || '',
    }));
    const artifactState = artifacts.length ? 'ready' : 'none';
    return {
      schemaVersion: 1,
      revision: Math.max(0, Number(this.state.revision) || 0),
      observerId: `${this.clientId}:${this.contentEpoch}`,
      observedAt: Date.now(),
      stableForMs: final ? 2_000 : 0,
      url: this.state.url,
      title: 'ChatGPT',
      conversationId: this.state.conversationId,
      visibility: this.active ? 'visible' : 'hidden',
      focused: this.active && this.focused,
      document: { state: 'ready', readyState: this.documentReadyState, chatMainReady: true, pageReady: true },
      composer: { state: 'ready', ready: true },
      activeRequest: active,
      boundLeaseProjection: active,
      turn: snapshot.assistant ? {
        state: final ? 'final' : (snapshot.progressItems.length ? 'reasoning' : 'streaming'),
        phase: this.state.phase,
        key: snapshot.assistant.key,
        index: assistantIndex,
        messageId: snapshot.assistant.messageId || snapshot.assistant.key,
        modelSlug: this.state.selectedModel,
        count: this.state.turns.filter((turn) => turn.role === 'assistant').length,
        userKey: snapshot.user?.key || '',
        userIndex,
        userPrompt: snapshot.user?.text || '',
        promptBoundary: snapshot.user ? { submittedUserTurnKey: snapshot.user.key, submittedUserTurnIndex: userIndex } : null,
      } : { state: 'none', phase: this.state.phase, key: '', index: -1, messageId: '', modelSlug: '', count: 0, userKey: snapshot.user?.key || '', userIndex, userPrompt: snapshot.user?.text || '', promptBoundary: null },
      generation: { state: this.state.generating ? 'active' : hasAssistant ? 'stopped' : 'idle', stopVisible: this.state.generating && !this.state.steerReady, streamingVisible: this.state.generating, activeTool: false },
      blocker: { state: userError.explicit ? 'explicit_error' : 'none', confirmation: false, continue: false },
      output: {
        state: outputState,
        answer: snapshot.answer,
        thinking: snapshot.thinking,
        progress: snapshot.progress,
        progressItems: snapshot.progressItems,
        reasoningHistory: snapshot.reasoningHistory,
        responseBlocks: snapshot.responseBlocks,
        codeBlocks: snapshot.codeBlocks,
        codeBlockDiagnostics: [],
        parserAudit: snapshot.parserAudit,
        format: outputState === 'none' ? 'none' : 'markdown',
        raw: snapshot.assistant?.text || '',
        answerLength: String(snapshot.answer || '').length,
        thinkingLength: String(snapshot.thinking || '').length,
        progressLength: String(snapshot.progress || '').length,
        finalMessage: final,
        actionBarVisible: final,
      },
      artifact: { state: artifactState, count: artifacts.length },
      artifacts,
      error: userError,
      degraded: false,
      evidence: { snapshotReason: hasAssistant ? 'mock_assistant_node' : 'no_assistant_node', unknownTestIds: [], assistantNodeCount: hasAssistant ? 1 : 0 },
      mock: { layoutUrl: this.publicLayoutUrl() },
    };
  }

  async publishObservation(reason = '') {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return;
    const observation = this.createObservation();
    const body = {
      type: 'tab.observation',
      observation,
      revision: observation.revision,
      reason,
      session: this.state.sessionProjection(),
      url: this.state.url,
      title: 'ChatGPT',
    };
    if (this.deliveryNoise && /generation-started$/.test(String(reason)) && !this.staleObservationCandidate) {
      this.staleObservationCandidate = structuredClone(body);
    }
    await this.send(ExtensionMessageType.TAB_OBSERVATION, body, { request: this.state.activeRequest, causationId: reason || null });
    if (this.deliveryNoise && /generation-completed$/.test(String(reason)) && this.staleObservationCandidate && this.lateObservationCount === 0) {
      const stale = this.staleObservationCandidate;
      this.staleObservationCandidate = null;
      this.lateObservationCount += 1;
      await this.send(ExtensionMessageType.TAB_OBSERVATION, {
        ...stale,
        reason: 'mock.late-stale-observation',
      }, { request: this.state.activeRequest, causationId: 'mock.late-stale-observation' });
    }
  }
}

export class MockChatGptBrowser extends EventEmitter {
  constructor({ bridgeUrl, bridgeToken = '', pageOrigin = '', windowFocused = false, contentClientId = '' } = {}) {
    super();
    this.bridgeUrl = String(bridgeUrl || '').replace(/\/$/, '');
    this.bridgeToken = String(bridgeToken || '');
    this.pageOrigin = String(pageOrigin || '').replace(/\/$/, '');
    this.windowFocused = windowFocused === true;
    this.contentClientId = text(contentClientId) || `mock-extension-${randomUUID()}`;
    this.tabs = new Map();
    this.nextTabId = 100;
    this.nextDownloadId = 1;
    this.downloadRoot = path.join(os.tmpdir(), 'chatgpt-bridge-mock-downloads');
    this.ownedDownloadRecords = [];
  }

  async createBrowserDownload(artifact = {}) {
    await fsp.mkdir(this.downloadRoot, { recursive: true });
    const requestedName = path.basename(String(artifact.fileName || artifact.name || `artifact-${randomUUID()}`));
    const ext = path.extname(requestedName);
    const stem = requestedName.slice(0, requestedName.length - ext.length) || 'artifact';
    let actualName = requestedName;
    let filePath = path.join(this.downloadRoot, actualName);
    for (let index = 1; ; index += 1) {
      try {
        await fsp.lstat(filePath);
        actualName = `${stem} (${index})${ext}`;
        filePath = path.join(this.downloadRoot, actualName);
      } catch (error) {
        if (error?.code === 'ENOENT') break;
        throw error;
      }
    }
    const browserCaptureStartedAt = Date.now();
    const browserDownloadStartTime = new Date(browserCaptureStartedAt).toISOString();
    await fsp.writeFile(filePath, artifact.buffer);
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Mock browser download did not create a regular file: ${filePath}`);
    const browserCapturedAt = Date.now();
    const downloadId = this.nextDownloadId++;
    const resolved = {
      path: filePath,
      statIdentity: {
        dev: Number(stat.dev) || 0,
        ino: Number(stat.ino) || 0,
        size: Number(stat.size) || 0,
        birthtimeMs: Number(stat.birthtimeMs) || 0,
        ctimeMs: Number(stat.ctimeMs) || 0,
        mtimeMs: Number(stat.mtimeMs) || 0,
      },
      captureIdentity: {
        captureSource: 'chrome-downloads',
        downloadId,
        browserCaptureStartedAt,
        browserCapturedAt,
        browserActualName: actualName,
      },
    };
    this.ownedDownloadRecords.push(resolved);
    return {
      name: actualName,
      filePath,
      size: stat.size,
      downloadId,
      browserCaptureStartedAt,
      browserCapturedAt,
      browserDownloadStartTime,
      browserDownloadEndTime: new Date(browserCapturedAt).toISOString(),
    };
  }

  async cleanupOwnedDownloads() {
    const results = [];
    for (const resolved of this.ownedDownloadRecords) {
      results.push(await removeCapturedBrowserDownload(resolved));
    }
    this.ownedDownloadRecords = [];
    return results;
  }

  async openTab({ launchToken = '', requestedUrl = 'https://chatgpt.com/', tabId = null, active = true } = {}) {
    const resolvedTabId = Number.isInteger(tabId) ? tabId : this.nextTabId++;
    const state = new MockChatGptStateMachine({ tabId: resolvedTabId, origin: 'https://chatgpt.com' });
    try {
      const requestedSessionId = new URL(String(requestedUrl || 'https://chatgpt.com/')).pathname.match(/^\/c\/([^/?#]+)/)?.[1] || '';
      if (requestedSessionId) state.selectSession(requestedSessionId);
    } catch {}
    if (active !== false) {
      for (const existing of this.tabs.values()) {
        existing.active = false;
        existing.focused = false;
      }
    }
    const tab = new MockExtensionTab({
      bridgeUrl: this.bridgeUrl,
      bridgeToken: this.bridgeToken,
      tabId: resolvedTabId,
      registry: this,
      pageOrigin: this.pageOrigin,
      launchToken,
      requestedUrl,
      active,
      focused: active !== false && this.windowFocused,
      state,
      contentClientId: this.contentClientId,
    });
    this.tabs.set(resolvedTabId, tab);
    tab.on('error', (error) => this.emit('error', error));
    await tab.connect();
    this.emit('tab.opened', tab);
    return tab;
  }

  async closeTab(tabId) {
    const tab = this.tabs.get(Number(tabId));
    if (!tab) return false;
    this.tabs.delete(Number(tabId));
    await tab.close();
    this.emit('tab.closed', tab);
    return true;
  }

  async close() {
    await Promise.allSettled(Array.from(this.tabs.values()).map((tab) => tab.close()));
    this.tabs.clear();
    await this.cleanupOwnedDownloads();
  }
}
