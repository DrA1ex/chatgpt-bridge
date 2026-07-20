import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserBridge } from '../src/browserBridge.js';
import { commandResult, emitPromptSubmitted, emitTabObservation } from './support/bridgeObservation.js';

class ReloadHub extends EventEmitter {
  constructor() {
    super();
    this.activeClient = { id: 'client-1', url: 'https://chatgpt.com/c/session-1' };
    this.sent = [];
  }
  get clients() { return [this.activeClient]; }
  get selectedClientId() { return ''; }
  get needsSelection() { return false; }
  get debugEvents() { return []; }
  sendToActive(payload) { return this.sendToClient('client-1', payload); }
  sendToClient(clientId, payload) {
    this.sent.push({ clientId, payload });
    return { id: clientId, url: this.activeClient.url };
  }
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test('reload completion uses canonical response boundary when restored content only knows the lease', async () => {
  const hub = new ReloadHub();
  const bridge = new BrowserBridge(hub);
  try {
    const responsePromise = bridge.sendRequest({ message: 'finish after reload' });
    await nextTick();
    const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
    assert.ok(prompt);

    emitPromptSubmitted(hub, { requestId: prompt.requestId });
    emitTabObservation(hub, {
      requestId: prompt.requestId,
      conversationId: 'session-1',
      userTurnKey: 'user-reload',
      assistantTurnKey: 'assistant-reload',
      generation: 'active',
      outputState: 'streaming',
      answer: 'partial',
      finalMessage: false,
      stableForMs: 0,
    });

    hub.emit('client.ready', {
      id: 'client-1',
      compatible: true,
      tabObservation: { observerId: 'observer-after-reload' },
      activeRequest: {
        requestId: prompt.requestId,
        leaseId: prompt.leaseId,
        ownerServerInstanceId: prompt.ownerServerInstanceId,
        responseEpoch: 0,
      },
    });
    await nextTick();

    const resume = hub.sent.findLast((entry) => entry.payload.type === 'request.resume');
    assert.ok(resume, 'canonical state must rehydrate the disposable content projection');
    assert.deepEqual(resume.payload.projection, {
      responseEpoch: 0,
      submittedUserTurnKey: 'user-reload',
      submittedUserTurnIndex: 0,
      assistantTurnKey: 'assistant-reload',
      assistantTurnIndex: 1,
      sentAt: 0,
      submittedPromptText: 'finish after reload',
    });
    hub.emit('client.message', {
      clientId: 'client-1',
      payload: commandResult(resume.payload.commandId, 'request.resumed', {
        activeRequest: { requestId: prompt.requestId },
        boundaryStatus: 'matched',
        submittedUserTurnKey: 'user-reload',
        submittedUserTurnIndex: 0,
        assistantTurnKey: 'assistant-reload',
        assistantTurnIndex: 1,
      }),
    });

    emitTabObservation(hub, {
      requestId: prompt.requestId,
      conversationId: 'session-1',
      userTurnKey: 'user-reload',
      assistantTurnKey: 'assistant-reload',
      answer: 'finished after reload',
      activeRequest: {
        submittedUserTurnKey: '',
        assistantTurnKey: '',
      },
    });

    const response = await responsePromise;
    assert.equal(response.answer, 'finished after reload');
    assert.equal(response.finishReason, 'stable_normalized_observation');
  } finally {
    await bridge.close();
  }
});

test('reload fails recoverably when the submitted user turn disappeared instead of binding an older response', async () => {
  const hub = new ReloadHub();
  const bridge = new BrowserBridge(hub);
  try {
    const responsePromise = bridge.sendRequest({ message: 'prompt that must remain identifiable' });
    await nextTick();
    const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
    assert.ok(prompt);

    emitPromptSubmitted(hub, { requestId: prompt.requestId });
    emitTabObservation(hub, {
      requestId: prompt.requestId,
      userTurnKey: 'submitted-before-reload',
      assistantTurnKey: 'assistant-before-reload',
      generation: 'active',
      outputState: 'streaming',
      answer: 'partial',
    });

    hub.emit('client.ready', {
      id: 'client-1',
      compatible: true,
      tabObservation: { observerId: 'observer-missing-boundary' },
      activeRequest: {
        requestId: prompt.requestId,
        leaseId: prompt.leaseId,
        ownerServerInstanceId: prompt.ownerServerInstanceId,
        responseEpoch: 0,
      },
    });
    await nextTick();
    const resume = hub.sent.findLast((entry) => entry.payload.type === 'request.resume');
    assert.ok(resume);

    hub.emit('client.message', {
      clientId: 'client-1',
      payload: commandResult(resume.payload.commandId, 'request.resumed', {
        activeRequest: { requestId: prompt.requestId },
        boundaryStatus: 'missing',
        boundaryEvidence: { expectedKey: 'submitted-before-reload', turnCount: 2 },
      }),
    });

    let rejection = null;
    try {
      await responsePromise;
    } catch (error) {
      rejection = error;
    }
    assert.ok(rejection);
    assert.match(rejection.message, /submitted user turn disappeared|repeating prompt\.submit would be ambiguous/i);
    assert.equal(rejection.canonicalTerminal.code, 'recovery_uncertain');
    assert.equal(rejection.canonicalTerminal.evidence.reasonCode, 'SUBMITTED_TURN_MISSING_AFTER_RELOAD');
  } finally {
    await bridge.close();
  }
});
