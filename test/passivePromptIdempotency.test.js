import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { BrowserBridge } from '../src/browserBridge.js';
import { config } from '../src/config.js';
import { createApp } from '../src/server.js';
import { MetadataStore } from '../src/metadataStore.js';
import { PassivePromptLedger } from '../src/bridge/passivePromptLedger.js';
import { BridgeCommandRegistry } from '../src/bridge/coordinator/bridgeCommandRegistry.js';

const SESSION_ID = 'passive-session';
const CLIENT_ID = 'passive-client';

function submittedPayload(commandId, turnKey = 'passive-turn') {
  return {
    type: 'command.result',
    resultType: 'passive.prompt.submitted',
    commandId,
    sourceClientId: CLIENT_ID,
    submittedUserTurnKey: turnKey,
    session: { id: SESSION_ID },
  };
}

class PassiveHub extends EventEmitter {
  constructor({ respond = true } = {}) {
    super();
    this.serverInstanceId = 'passive-test-server';
    this.selectedClientId = CLIENT_ID;
    this.needsSelection = false;
    this.respond = respond;
    this.commands = [];
    this._client = {
      id: CLIENT_ID,
      ready: true,
      selected: true,
      compatible: true,
      focused: true,
      visibilityState: 'visible',
      capabilities: { browserTabs: true },
      url: `https://chatgpt.com/c/${SESSION_ID}`,
      session: { id: SESSION_ID, url: `https://chatgpt.com/c/${SESSION_ID}` },
    };
    this.canonicalHandler = null;
  }

  get clients() { return [this._client]; }
  get activeClient() { return this._client; }

  setCanonicalMessageHandler(handler) { this.canonicalHandler = handler; }

  sendToClientWithDelivery(clientId, payload, options = {}) {
    if (clientId !== CLIENT_ID) throw new Error(`unknown client ${clientId}`);
    this.commands.push({ clientId, payload, options });
    if (this.respond && payload.type === 'passive.prompt.submit') {
      queueMicrotask(() => this.canonicalHandler?.({
        eventName: 'client.message',
        data: { clientId, payload: submittedPayload(payload.commandId) },
      }));
    }
    return { client: this._client, delivered: Promise.resolve() };
  }

  sendToClient(clientId, payload, options = {}) {
    return this.sendToClientWithDelivery(clientId, payload, options).client;
  }

  sendToActiveWithDelivery(payload, options = {}) {
    return this.sendToClientWithDelivery(CLIENT_ID, payload, options);
  }

  sendToActive(payload, options = {}) {
    return this.sendToClient(CLIENT_ID, payload, options);
  }
}

async function makeFixture({ respond = true, now, reviewAfterMs } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'passive-prompt-ledger-'));
  const metadataStore = new MetadataStore(root);
  await metadataStore.ready;
  const hub = new PassiveHub({ respond });
  const bridge = new BrowserBridge(hub, null, null, { metadataStore, passivePromptNow: now, passivePromptReviewAfterMs: reviewAfterMs });
  return { root, metadataStore, hub, bridge };
}

async function cleanup(root) {
  await fs.rm(root, { recursive: true, force: true });
}

test('atomic passive reservations have exactly one winner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'passive-reserve-'));
  try {
    const metadataStore = new MetadataStore(root);
    await metadataStore.ready;
    const ledger = new PassivePromptLedger({ metadataStore });
    const results = await Promise.all([
      ledger.reserve('same-request', { message: 'wake' }),
      ledger.reserve('same-request', { message: 'wake' }),
    ]);
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(results.filter((result) => !result.created).length, 1);
    assert.deepEqual(results.map((result) => result.status), ['INFLIGHT', 'INFLIGHT']);
  } finally {
    await cleanup(root);
  }
});

test('simultaneous passive POSTs submit one physical command and duplicate INFLIGHT stays uncertain', async () => {
  const fixture = await makeFixture({ respond: false });
  try {
    const first = fixture.bridge.submitPassivePrompt({
      requestId: 'same-request', message: 'wake', sessionId: SESSION_ID, sourceClientId: CLIENT_ID,
    });
    while (fixture.hub.commands.length < 1) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      () => fixture.bridge.submitPassivePrompt({
        requestId: 'same-request', message: 'wake', sessionId: SESSION_ID, sourceClientId: CLIENT_ID,
      }),
      (error) => error.submissionStatus === 'UNCERTAIN_AFTER_SUBMIT',
    );
    assert.equal(fixture.hub.commands.filter((entry) => entry.payload.type === 'passive.prompt.submit').length, 1);
    fixture.bridge.close();
    await assert.rejects(first);
    const status = await fixture.bridge.getPassivePromptStatus('same-request');
    assert.equal(status.status, PassivePromptLedger.states.INFLIGHT);
  } finally {
    await cleanup(fixture.root);
  }
});

test('submitted passive prompts are monotonic, cached, and survive Bridge restart', async () => {
  const fixture = await makeFixture();
  try {
    const proof = await fixture.bridge.submitPassivePrompt({
      requestId: 'submitted-request', message: 'wake', sessionId: SESSION_ID, sourceClientId: CLIENT_ID,
    });
    assert.equal(fixture.hub.commands[0].payload.commandId, 'submitted-request');
    const duplicate = await fixture.bridge.submitPassivePrompt({
      requestId: 'submitted-request', message: 'different text', sessionId: SESSION_ID, sourceClientId: CLIENT_ID,
    });
    assert.deepEqual(duplicate, proof);
    assert.equal(fixture.hub.commands.filter((entry) => entry.payload.type === 'passive.prompt.submit').length, 1);
    await fixture.bridge.close();

    const restartedStore = new MetadataStore(fixture.root);
    await restartedStore.ready;
    const restartedHub = new PassiveHub({ respond: false });
    const restartedBridge = new BrowserBridge(restartedHub, null, null, { metadataStore: restartedStore });
    const afterRestart = await restartedBridge.submitPassivePrompt({
      requestId: 'submitted-request', message: 'another text', sessionId: SESSION_ID, sourceClientId: CLIENT_ID,
    });
    assert.deepEqual(afterRestart, proof);
    assert.equal(restartedHub.commands.length, 0);
    await restartedBridge.close();
  } finally {
    await cleanup(fixture.root);
  }
});

test('rejected passive prompts are terminal and duplicate rejection is cached', async () => {
  const fixture = await makeFixture();
  try {
    await assert.rejects(
      () => fixture.bridge.submitPassivePrompt({ requestId: 'rejected-request', message: '', sessionId: SESSION_ID, sourceClientId: CLIENT_ID }),
      (error) => error.submissionStatus === 'REJECTED_BEFORE_SUBMIT',
    );
    await assert.rejects(
      () => fixture.bridge.submitPassivePrompt({ requestId: 'rejected-request', message: 'now valid', sessionId: SESSION_ID, sourceClientId: CLIENT_ID }),
      (error) => error.submissionStatus === 'REJECTED_BEFORE_SUBMIT',
    );
    assert.equal(fixture.hub.commands.length, 0);
    const status = await fixture.bridge.getPassivePromptStatus('rejected-request');
    assert.equal(status.status, PassivePromptLedger.states.REJECTED_BEFORE_SUBMIT);
    assert.equal(PassivePromptLedger.proof(status).submissionStatus, 'REJECTED_BEFORE_SUBMIT');
  } finally {
    await fixture.bridge.close();
    await cleanup(fixture.root);
  }
});

test('HTTP status endpoint returns cached proof and keeps unknown requests unknown', async () => {
  const fixture = await makeFixture();
  const server = http.createServer(createApp(fixture.bridge, null));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${config.apiToken}` };
  try {
    const posted = await fetch(`${baseUrl}/browser/passive-prompt`, {
      method: 'POST',
      headers: { ...headers, 'x-yazhan-request-id': 'http-request' },
      body: JSON.stringify({
        requestId: 'http-request',
        message: 'wake',
        sessionId: SESSION_ID,
        sourceClientId: CLIENT_ID,
      }),
    });
    assert.equal(posted.status, 200);
    const submitted = await posted.json();
    assert.equal(submitted.requestId, 'http-request');
    assert.equal(submitted.submissionStatus, 'SUBMITTED');

    const status = await fetch(`${baseUrl}/browser/passive-prompt/status/http-request`, { headers });
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.deepEqual(statusBody.result, submitted.result);

    const unknown = await fetch(`${baseUrl}/browser/passive-prompt/status/does-not-exist`, { headers });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).submissionStatus, 'UNKNOWN');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fixture.bridge.close();
    await cleanup(fixture.root);
  }
});

test('old INFLIGHT requests expose owner review without changing resend safety', async () => {
  const now = Date.now() + 5_000;
  const fixture = await makeFixture({ now: () => now, reviewAfterMs: 1_000 });
  const ledger = new PassivePromptLedger({ metadataStore: fixture.metadataStore, now: () => now, reviewAfterMs: 1_000 });
  try {
    await ledger.reserve('old-inflight', {
      message: 'wake', sessionId: SESSION_ID, sourceClientId: CLIENT_ID,
    });
    const state = await fixture.bridge.getPassivePromptStatus('old-inflight');
    assert.equal(state.status, PassivePromptLedger.states.INFLIGHT);
    assert.equal(state.storage_status, 'INFLIGHT');
    assert.equal(state.operator_status, 'NEEDS_OWNER_REVIEW');
    assert.equal(state.can_retry, false);
    assert.equal(state.reconciliation_required, true);
    assert.equal(fixture.hub.commands.length, 0);
  } finally {
    await fixture.bridge.close();
    await cleanup(fixture.root);
  }
});

test('owner reconciliation is audited, remains INFLIGHT, and never enables resend', async () => {
  const now = Date.now() + 5_000;
  const fixture = await makeFixture({ now: () => now, reviewAfterMs: 1_000 });
  const ledger = new PassivePromptLedger({ metadataStore: fixture.metadataStore, now: () => now, reviewAfterMs: 1_000 });
  const message = 'wake';
  try {
    await ledger.reserve('owner-reconcile', {
      message, sessionId: SESSION_ID, sourceClientId: CLIENT_ID,
    });
    const state = await fixture.bridge.reconcilePassivePrompt('owner-reconcile', {
      actor: 'test-owner',
      evidence: {
        proofType: 'NO_MATCHING_USER_TURN',
        notFound: true,
        sessionId: SESSION_ID,
        sourceClientId: CLIENT_ID,
        matchingUserTurnKeys: [],
        promptSha256: createHash('sha256').update(message).digest('hex'),
        observedAt: new Date(now).toISOString(),
      },
    });
    assert.equal(state.status, PassivePromptLedger.states.INFLIGHT);
    assert.equal(state.storage_status, 'INFLIGHT');
    assert.equal(state.operator_status, 'OWNER_RECONCILED_NOT_SENT');
    assert.equal(state.can_retry, false);
    assert.equal(state.reconciliation_required, false);
    assert.equal(state.reconciliation.actor, 'test-owner');
    assert.equal((await fixture.bridge.getPassivePromptStatus('owner-reconcile')).operator_status, 'OWNER_RECONCILED_NOT_SENT');
    await assert.rejects(
      () => fixture.bridge.submitPassivePrompt({
        requestId: 'owner-reconcile', message, sessionId: SESSION_ID, sourceClientId: CLIENT_ID,
      }),
      (error) => error.submissionStatus === 'UNCERTAIN_AFTER_SUBMIT',
    );
    assert.equal(fixture.hub.commands.length, 0);

    // The audit event is durable, so a Bridge restart must retain the
    // operator projection and the resend block.
    await fixture.bridge.close();
    const restarted = new BrowserBridge(fixture.hub, null, null, {
      metadataStore: fixture.metadataStore,
      passivePromptNow: () => now,
      passivePromptReviewAfterMs: 1_000,
    });
    try {
      const recovered = await restarted.getPassivePromptStatus('owner-reconcile');
      assert.equal(recovered.storage_status, 'INFLIGHT');
      assert.equal(recovered.operator_status, 'OWNER_RECONCILED_NOT_SENT');
      assert.equal(recovered.can_retry, false);
      assert.equal(recovered.reconciliation.actor, 'test-owner');
    } finally {
      await restarted.close();
    }
  } finally {
    await fixture.bridge.close();
    await cleanup(fixture.root);
  }
});

test('owner reconciliation rejects incomplete negative evidence', async () => {
  const now = Date.now() + 5_000;
  const fixture = await makeFixture({ now: () => now, reviewAfterMs: 1_000 });
  const ledger = new PassivePromptLedger({ metadataStore: fixture.metadataStore, now: () => now, reviewAfterMs: 1_000 });
  try {
    await ledger.reserve('bad-owner-reconcile', {
      message: 'wake', sessionId: SESSION_ID, sourceClientId: CLIENT_ID,
    });
    await assert.rejects(
      () => fixture.bridge.reconcilePassivePrompt('bad-owner-reconcile', { evidence: {} }),
      (error) => error.code === 'PASSIVE_PROMPT_NEGATIVE_EVIDENCE_INVALID' && error.statusCode === 422,
    );
    assert.equal((await fixture.bridge.getPassivePromptStatus('bad-owner-reconcile')).operator_status, 'NEEDS_OWNER_REVIEW');
    assert.equal(fixture.hub.commands.length, 0);
  } finally {
    await fixture.bridge.close();
    await cleanup(fixture.root);
  }
});

test('HTTP status exposes the shared review contract and owner reconcile is not a send', async () => {
  const now = Date.now() + 5_000;
  const fixture = await makeFixture({ now: () => now, reviewAfterMs: 1_000 });
  const ledger = new PassivePromptLedger({ metadataStore: fixture.metadataStore, now: () => now, reviewAfterMs: 1_000 });
  const server = http.createServer(createApp(fixture.bridge, null));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${config.apiToken}` };
  try {
    await ledger.reserve('http-owner-reconcile', {
      message: 'wake', sessionId: SESSION_ID, sourceClientId: CLIENT_ID,
    });
    const statusResponse = await fetch(`${baseUrl}/browser/passive-prompt/status/http-owner-reconcile`, { headers });
    assert.equal(statusResponse.status, 503);
    const status = await statusResponse.json();
    assert.equal(status.storage_status, 'INFLIGHT');
    assert.equal(status.operator_status, 'NEEDS_OWNER_REVIEW');
    assert.equal(status.can_retry, false);
    assert.equal(status.reconciliation_required, true);

    const reconcile = await fetch(`${baseUrl}/browser/passive-prompt/reconcile/http-owner-reconcile`, {
      method: 'POST',
      headers: { ...headers, 'x-yazhan-owner': 'http-test-owner' },
      body: JSON.stringify({ evidence: {
        proofType: 'NO_MATCHING_USER_TURN',
        notFound: true,
        sessionId: SESSION_ID,
        sourceClientId: CLIENT_ID,
        matchingUserTurnKeys: [],
        promptSha256: createHash('sha256').update('wake').digest('hex'),
      } }),
    });
    assert.equal(reconcile.status, 200);
    const reconciled = await reconcile.json();
    assert.equal(reconciled.storage_status, 'INFLIGHT');
    assert.equal(reconciled.operator_status, 'OWNER_RECONCILED_NOT_SENT');
    assert.equal(reconciled.can_retry, false);
    assert.equal(fixture.hub.commands.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fixture.bridge.close();
    await cleanup(fixture.root);
  }
});

test('command timeout removes only the physical registry entry and does not invent a second identity', async () => {
  const delivered = [];
  let registry;
  const hub = {
    sendToClientWithDelivery(clientId, payload) {
      delivered.push({ clientId, payload });
      if (payload.type === 'command.cancel') {
        setImmediate(() => registry.handleResponse(clientId, {
          type: 'command.result',
          commandId: payload.commandId,
          resultType: 'command.cancelled',
          targetCommandId: payload.targetCommandId,
          cancelled: false,
        }));
      }
      return { client: { id: clientId }, delivered: Promise.resolve() };
    },
  };
  registry = new BridgeCommandRegistry({ hub });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'passive-timeout-'));
  try {
    const metadataStore = new MetadataStore(root);
    await metadataStore.ready;
    const ledger = new PassivePromptLedger({ metadataStore });
    await ledger.reserve('timeout-request', { message: 'wake' });
    const keepAlive = setTimeout(() => {}, 100);
    try {
      await assert.rejects(
        () => registry.send('passive.prompt.submit', { message: 'wake' }, {
          sourceClientId: CLIENT_ID, commandId: 'timeout-request', timeoutMs: 20,
        }),
        /Timed out waiting/,
      );
    } finally {
      clearTimeout(keepAlive);
    }
    assert.equal(delivered.length, 2); // passive command plus best-effort command.cancel
    assert.equal(delivered[0].payload.commandId, 'timeout-request');
    assert.equal(registry.has('timeout-request'), false);
    assert.equal((await ledger.get('timeout-request')).status, PassivePromptLedger.states.INFLIGHT);
  } finally {
    registry.close();
    await cleanup(root);
  }
});
