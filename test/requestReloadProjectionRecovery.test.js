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
    if (payload.type === 'prompt.cancel') {
      setImmediate(() => this.emit('client.message', {
        clientId,
        payload: {
          type: 'request.effect.succeeded',
          commandId: payload.commandId,
          requestId: payload.requestId,
          effectId: payload.effect.effectId,
          effectType: 'prompt.cancel',
          result: { cancelled: true },
        },
      }));
    }
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


test('page change after reload reconciles a request that has not proved prompt submission yet', async () => {
  const hub = new ReloadHub();
  const bridge = new BrowserBridge(hub);
  try {
    const responsePromise = bridge.sendRequest({ message: 'reload before prompt submit' });
    await nextTick();
    const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
    assert.ok(prompt);

    hub.emit('client.message', {
      clientId: 'client-1',
      payload: {
        type: 'request.effect.started',
        requestId: prompt.requestId,
        effectId: 'effect-model-apply',
        effectType: 'model.apply',
      },
    });
    await nextTick();

    hub.emit('client.changed', {
      id: 'client-1',
      ready: true,
      compatible: true,
      url: 'https://chatgpt.com/c/session-1',
      activeRequest: null,
      tabObservation: {
        observerId: 'observer-after-page-reload',
        activeRequest: null,
      },
    });
    await nextTick();

    const diagnostics = bridge.requestStateDiagnostics(prompt.requestId);
    assert.ok(
      diagnostics?.state?.diagnostics?.some?.((item) => (
        item?.data?.code === 'PROMPT_SUBMISSION_UNCERTAIN_AFTER_RELOAD'
        || item?.code === 'effect_uncertain'
      ))
      || diagnostics?.state?.blocker === 'recovery',
      'page reload must enter canonical effect reconciliation instead of silently waiting',
    );

    bridge.cancelActive('test cleanup');
    await assert.rejects(responsePromise);
  } finally {
    await bridge.close();
  }
});

test('late page activity reattaches a submitted request when activeRequest appears after reload', async () => {
  const hub = new ReloadHub();
  const bridge = new BrowserBridge(hub);
  try {
    const responsePromise = bridge.sendRequest({ message: 'continue after late reload projection' });
    await nextTick();
    const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
    assert.ok(prompt);

    emitPromptSubmitted(hub, { requestId: prompt.requestId });
    emitTabObservation(hub, {
      requestId: prompt.requestId,
      conversationId: 'session-1',
      userTurnKey: 'user-late-reload',
      assistantTurnKey: 'assistant-late-reload',
      generation: 'active',
      outputState: 'streaming',
      answer: 'partial',
      finalMessage: false,
      stableForMs: 0,
    });

    hub.emit('client.ready', {
      id: 'client-1',
      compatible: true,
      url: 'https://chatgpt.com/c/session-1',
      tabObservation: { observerId: 'observer-reload-empty', activeRequest: null },
      activeRequest: null,
    });
    await nextTick();
    assert.equal(
      hub.sent.filter((entry) => entry.payload.type === 'request.resume').length,
      0,
      'initial reload readiness without activeRequest cannot reattach yet',
    );

    hub.emit('client.activity', {
      clientId: 'client-1',
      client: {
        id: 'client-1',
        ready: true,
        compatible: true,
        url: 'https://chatgpt.com/c/session-1',
        activeRequest: {
          requestId: prompt.requestId,
          leaseId: prompt.leaseId,
          ownerServerInstanceId: prompt.ownerServerInstanceId,
          responseEpoch: 0,
        },
        tabObservation: {
          observerId: 'observer-reload-restored',
          activeRequest: {
            requestId: prompt.requestId,
            leaseId: prompt.leaseId,
            ownerServerInstanceId: prompt.ownerServerInstanceId,
            responseEpoch: 0,
          },
        },
      },
      payload: {
        type: 'page.status',
        activeRequest: {
          requestId: prompt.requestId,
          leaseId: prompt.leaseId,
          ownerServerInstanceId: prompt.ownerServerInstanceId,
          responseEpoch: 0,
        },
      },
    });
    await nextTick();

    const resume = hub.sent.findLast((entry) => entry.payload.type === 'request.resume');
    assert.ok(resume, 'late restored activeRequest must trigger projection rehydration');
    assert.equal(resume.payload.requestId, prompt.requestId);

    hub.emit('client.message', {
      clientId: 'client-1',
      payload: commandResult(resume.payload.commandId, 'request.resumed', {
        activeRequest: { requestId: prompt.requestId },
        boundaryStatus: 'matched',
        submittedUserTurnKey: 'user-late-reload',
        submittedUserTurnIndex: 0,
        assistantTurnKey: 'assistant-late-reload',
        assistantTurnIndex: 1,
      }),
    });

    emitTabObservation(hub, {
      requestId: prompt.requestId,
      conversationId: 'session-1',
      userTurnKey: 'user-late-reload',
      assistantTurnKey: 'assistant-late-reload',
      answer: 'finished after late reload projection',
      activeRequest: {
        submittedUserTurnKey: '',
        assistantTurnKey: '',
      },
    });

    const response = await responsePromise;
    assert.equal(response.answer, 'finished after late reload projection');
  } finally {
    await bridge.close();
  }
});
