import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserBridge } from '../src/browserBridge.js';
import { EventBus } from '../src/eventBus.js';
import { emitPromptSubmitted, emitTabObservation } from './support/bridgeObservation.js';

class FakeHub extends EventEmitter {
  constructor() {
    super();
    this.activeClient = { id: 'client-1', ready: true, url: 'https://chatgpt.com/c/session-1' };
    this.sent = [];
    this.readyClients = new Map([['client-1', {
      ...this.activeClient,
      activeRequest: null,
      compatible: true,
    }]]);
    this.serverInstanceId = 'server-test';
    this.deliveryError = null;
    this.releaseResponse = 'success';
  }

  get clients() { return Array.from(this.readyClients.values()); }
  get selectedClientId() { return ''; }
  get needsSelection() { return false; }

  sendToActiveWithDelivery(payload) {
    this.sent.push({ clientId: this.activeClient.id, payload });
    return {
      client: this.activeClient,
      delivered: this.deliveryError ? Promise.reject(this.deliveryError) : Promise.resolve(),
    };
  }

  sendToClientWithDelivery(clientId, payload) {
    this.sent.push({ clientId, payload });
    return {
      client: this.readyClients.get(clientId) || { id: clientId, ready: true },
      delivered: this.deliveryError
        ? Promise.reject(this.deliveryError)
        : Promise.resolve({ clientId, deliveredAt: Date.now() }),
    };
  }

  sendToClient(clientId, payload) {
    this.sent.push({ clientId, payload });
    if (payload.type === 'request.release' && payload.commandId) {
      if (this.releaseResponse === 'success') {
        queueMicrotask(() => this.emit('client.message', {
          clientId,
          payload: { type: 'command.result', commandId: payload.commandId, requestId: payload.requestId, released: true },
        }));
      } else if (this.releaseResponse === 'error') {
        queueMicrotask(() => this.emit('client.message', {
          clientId,
          payload: { type: 'command.error', commandId: payload.commandId, requestId: payload.requestId, code: 'RELEASE_FAILED', message: 'Release failed after terminal publication' },
        }));
      }
    }
    return this.readyClients.get(clientId) || { id: clientId, ready: true };
  }
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('BrowserBridge feeds the authoritative canonical request machine', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const requestPromise = bridge.sendRequest({ message: 'canonical state test' });
  await nextTick();

  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);

  const initial = bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId);
  assert.ok(initial?.canonicalState);
  assert.equal(initial.canonicalState.source.clientId, 'client-1');
  assert.ok(initial.canonicalState.revision >= 2);

  emitPromptSubmitted(hub, { requestId: prompt.requestId });
  emitTabObservation(hub, {
    requestId: prompt.requestId,
    conversationId: 'session-1',
    assistantTurnKey: 'assistant-generating',
    generation: 'active',
    outputState: 'reasoning',
    thinking: 'Working',
    finalMessage: false,
    stableForMs: 0,
  });

  const generating = bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId)?.canonicalState;
  assert.equal(generating.lifecycle, 'generating');
  assert.equal(generating.displayPhase, 'reasoning');
  assert.equal(generating.generation, 'active');

  emitTabObservation(hub, {
    requestId: prompt.requestId,
    conversationId: 'session-1',
    assistantTurnKey: 'assistant-complete',
    answer: 'complete',
  });
  assert.equal((await requestPromise).answer, 'complete');

  const completed = bridge.requestStateDiagnostics(prompt.requestId);
  assert.equal(completed.state.lifecycle, 'completed');
  assert.equal(completed.state.terminal.code, 'completed');
  assert.ok(completed.history.some((entry) => entry.event.type === 'effect.started' && entry.event.data.effectType === 'prompt.delivery'));
  assert.ok(completed.history.some((entry) => entry.event.type === 'effect.succeeded' && entry.event.data.effectType === 'prompt.delivery'));
  assert.ok(completed.history.some((entry) => entry.event.type === 'observation.updated'));
  assert.equal(completed.history.at(-1).event.type, 'observation.updated');
});

test('canonical explicit UI errors terminate a pending bridge request immediately', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const requestPromise = bridge.sendRequest({ message: 'fail from canonical observation' });
  const rejection = assert.rejects(requestPromise, (error) => {
    assert.equal(error.name, 'CanonicalRequestStateError');
    assert.equal(error.code, 'CANONICAL_EXPLICIT_UI_ERROR');
    assert.match(error.message, /rejected this request/i);
    return true;
  });
  await nextTick();

  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);
  emitPromptSubmitted(hub, { requestId: prompt.requestId });
  hub.emit('client.activity', {
    clientId: 'client-1',
    client: { ...hub.activeClient, activeRequest: { requestId: prompt.requestId } },
    payload: {
      type: 'tab.observation',
      observation: {
        observerId: 'observer-error',
        revision: 1,
        observedAt: Date.now(),
        conversationId: 'session-1',
        activeRequest: { requestId: prompt.requestId },
        generation: { state: 'stopped' },
        blocker: { state: 'explicit_error' },
        output: { state: 'none' },
        artifact: { state: 'none', count: 0 },
        error: { explicit: true, message: 'ChatGPT rejected this request' },
      },
    },
  });

  await rejection;
  const diagnostics = bridge.requestStateDiagnostics(prompt.requestId);
  assert.equal(diagnostics.state.terminal.code, 'explicit_ui_error');
  assert.equal(diagnostics.state.lifecycle, 'failed');
});

test('canonical mismatch protection waits until prompt acceptance before failing', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const requestPromise = bridge.sendRequest({ message: 'bind before mismatch', sessionId: 'session-1' });
  await nextTick();

  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);
  const mismatchObservation = {
    observerId: 'observer-switch',
    revision: 1,
    observedAt: Date.now(),
    conversationId: 'session-other',
    activeRequest: { requestId: 'req-other' },
    generation: { state: 'idle' },
    blocker: { state: 'none' },
    output: { state: 'none' },
    artifact: { state: 'none', count: 0 },
    error: { explicit: false, message: '' },
  };
  hub.emit('client.activity', {
    clientId: 'client-1',
    client: hub.activeClient,
    payload: { type: 'tab.observation', observation: mismatchObservation },
  });
  await nextTick();
  assert.equal(bridge.requestDiagnostics().some((item) => item.requestId === prompt.requestId), true);

  emitPromptSubmitted(hub, { requestId: prompt.requestId });
  const rejection = assert.rejects(requestPromise, (error) => {
    assert.equal(error.code, 'CANONICAL_CONVERSATION_CHANGED');
    return true;
  });
  hub.emit('client.activity', {
    clientId: 'client-1',
    client: hub.activeClient,
    payload: {
      type: 'tab.observation',
      observation: {
        ...mismatchObservation,
        revision: 2,
        activeRequest: { requestId: prompt.requestId },
      },
    },
  });
  await rejection;
});

test('prompt delivery failures are recorded as canonical effect failures', async () => {
  const hub = new FakeHub();
  const deliveryError = new Error('Extension delivery channel closed');
  deliveryError.code = 'DELIVERY_CHANNEL_CLOSED';
  hub.deliveryError = deliveryError;
  const bridge = new BrowserBridge(hub);
  const requestPromise = bridge.sendRequest({ message: 'delivery failure' });
  const rejection = assert.rejects(requestPromise, (error) => {
    assert.equal(error.code, 'DELIVERY_CHANNEL_CLOSED');
    assert.match(error.message, /delivery channel closed/i);
    return true;
  });
  await rejection;

  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);
  const diagnostics = bridge.requestStateDiagnostics(prompt.requestId);
  assert.equal(diagnostics.state.terminal.code, 'effect_failed');
  assert.ok(diagnostics.history.some((entry) => entry.event.type === 'effect.failed'));
});



test('stable Protocol 5 observations are finalized by the server before the tab is explicitly released', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const requestPromise = bridge.sendRequest({ message: 'server authoritative terminal snapshot' });
  await nextTick();

  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);
  emitPromptSubmitted(hub, { requestId: prompt.requestId });
  emitTabObservation(hub, {
    requestId: prompt.requestId,
    conversationId: 'session-1',
    assistantTurnKey: 'turn-terminal',
    answer: 'canonical final answer',
  });

  const response = await requestPromise;
  assert.equal(response.answer, 'canonical final answer');
  const releaseIndex = hub.sent.findIndex((entry) => entry.payload.type === 'request.release' && entry.payload.requestId === prompt.requestId);
  assert.ok(releaseIndex >= 0);
  assert.equal(hub.sent[releaseIndex].payload.terminalCode, 'completed');
  assert.equal(bridge.requestDiagnostics().some((item) => item.requestId === prompt.requestId), false);
});

test('terminal completion resolves without waiting for request.release acknowledgement', async () => {
  const hub = new FakeHub();
  hub.releaseResponse = 'none';
  const bridge = new BrowserBridge(hub);
  const requestPromise = bridge.sendRequest({ message: 'release must not block completion' });
  await nextTick();

  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);
  emitPromptSubmitted(hub, { requestId: prompt.requestId });
  emitTabObservation(hub, {
    requestId: prompt.requestId,
    conversationId: 'session-1',
    assistantTurnKey: 'assistant-published',
    answer: 'published first',
  });

  const response = await Promise.race([
    requestPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('terminal result waited for request.release')), 250)),
  ]);
  assert.equal(response.answer, 'published first');
  assert.ok(hub.sent.some((entry) => entry.payload.type === 'request.release' && entry.payload.requestId === prompt.requestId));
  await bridge.close({ cancelPending: false });
});

test('late request.release errors do not replace an already published terminal result', async () => {
  const hub = new FakeHub();
  hub.releaseResponse = 'error';
  const bridge = new BrowserBridge(hub);
  const requestPromise = bridge.sendRequest({ message: 'late cleanup failure' });
  await nextTick();

  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);
  emitPromptSubmitted(hub, { requestId: prompt.requestId });
  emitTabObservation(hub, {
    requestId: prompt.requestId,
    conversationId: 'session-1',
    assistantTurnKey: 'assistant-late-release',
    answer: 'terminal remains successful',
  });

  const response = await requestPromise;
  assert.equal(response.answer, 'terminal remains successful');
  await nextTick();
  assert.equal(bridge.requestStateDiagnostics(prompt.requestId).state.terminal.code, 'completed');
  await bridge.close({ cancelPending: false });
});

test('canonical terminal failures remain authoritative', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const requestPromise = bridge.sendRequest({ message: 'authoritative canonical failure' });
  await nextTick();

  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);
  emitPromptSubmitted(hub, { requestId: prompt.requestId });
  const rejection = assert.rejects(requestPromise, (error) => {
    assert.match(error.message, /explicit failure/i);
    return true;
  });
  hub.emit('client.activity', {
    clientId: 'client-1',
    client: { ...hub.activeClient, activeRequest: { requestId: prompt.requestId } },
    payload: {
      type: 'tab.observation',
      observation: {
        observerId: 'observer-authoritative',
        revision: 1,
        observedAt: Date.now(),
        conversationId: 'session-1',
        activeRequest: { requestId: prompt.requestId },
        generation: { state: 'stopped' },
        blocker: { state: 'explicit_error' },
        output: { state: 'none' },
        artifact: { state: 'none', count: 0 },
        error: { explicit: true, message: 'Explicit failure is authoritative' },
      },
    },
  });
  await rejection;
  assert.equal(bridge.requestDiagnostics().some((item) => item.requestId === prompt.requestId), false);
  assert.equal(bridge.requestStateDiagnostics(prompt.requestId).state.terminal.code, 'explicit_ui_error');
});


test('browser preparation effect observations update canonical state and clear after success', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const requestPromise = bridge.sendRequest({ message: 'browser effect success' });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);
  emitPromptSubmitted(hub, { requestId: prompt.requestId });
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'request.effect.started',
      requestId: prompt.requestId,
      effectId: `${prompt.requestId}:model.apply:1`,
      effectType: 'model.apply',
    },
  });
  assert.equal(bridge.requestStateDiagnostics(prompt.requestId).state.effect.browser.activeType, 'model.apply');
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'request.effect.succeeded',
      requestId: prompt.requestId,
      effectId: `${prompt.requestId}:model.apply:1`,
      effectType: 'model.apply',
    },
  });
  assert.equal(bridge.requestStateDiagnostics(prompt.requestId).state.effect.browser.activeId, null);
  emitTabObservation(hub, {
    requestId: prompt.requestId,
    conversationId: 'session-1',
    assistantTurnKey: 'assistant-effect-completed',
    answer: 'effect completed',
  });
  assert.equal((await requestPromise).answer, 'effect completed');
});

test('browser preparation effect failures reject immediately with the original error code', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const requestPromise = bridge.sendRequest({ message: 'browser effect failure' });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);
  emitPromptSubmitted(hub, { requestId: prompt.requestId });
  const rejection = assert.rejects(requestPromise, (error) => {
    assert.equal(error.code, 'MODEL_OPTION_NOT_FOUND');
    assert.match(error.message, /model option/i);
    return true;
  });
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'request.effect.started',
      requestId: prompt.requestId,
      effectId: `${prompt.requestId}:model.apply:1`,
      effectType: 'model.apply',
    },
  });
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'request.effect.failed',
      requestId: prompt.requestId,
      effectId: `${prompt.requestId}:model.apply:1`,
      effectType: 'model.apply',
      code: 'MODEL_OPTION_NOT_FOUND',
      message: 'Requested model option was not found',
      retryable: false,
    },
  });
  await rejection;
  assert.ok(hub.sent.some((entry) => entry.payload.type === 'request.release' && entry.payload.requestId === prompt.requestId));
});


test('model apply browser effects project stable public events with the verified picker result', async () => {
  const hub = new FakeHub();
  const eventBus = new EventBus();
  const bridge = new BrowserBridge(hub, null, eventBus);
  const requestPromise = bridge.sendRequest({ message: 'model projection test', model: 'GPT-test', effort: 'high' });
  await nextTick();

  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);
  const effectId = `${prompt.requestId}:model.apply:test`;
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'request.effect.started',
      requestId: prompt.requestId,
      effectId,
      effectType: 'model.apply',
      evidence: { model: 'GPT-test', effort: 'high' },
    },
  });
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'request.effect.succeeded',
      requestId: prompt.requestId,
      effectId,
      effectType: 'model.apply',
      result: {
        modelApplied: true,
        effortApplied: true,
        warnings: [],
        intelligence: {
          selectedModel: { id: 'model-gpt-test', label: 'GPT-test', value: 'GPT-test', selected: true },
          selectedEffort: { id: 'high', label: 'High', value: 'high', selected: true },
        },
      },
    },
  });
  // Physical redelivery must not create duplicate public lifecycle events.
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'request.effect.started', requestId: prompt.requestId, effectId,
      effectType: 'model.apply', evidence: { model: 'GPT-test', effort: 'high' },
    },
  });
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'request.effect.succeeded', requestId: prompt.requestId, effectId,
      effectType: 'model.apply', result: { modelApplied: true, effortApplied: true },
    },
  });
  await nextTick();

  const events = eventBus.recentEvents(100).filter((event) => event.requestId === prompt.requestId);
  const startedEvents = events.filter((event) => event.type === 'model.apply.started');
  const doneEvents = events.filter((event) => event.type === 'model.apply.done');
  const started = startedEvents[0];
  const done = doneEvents[0];
  assert.equal(startedEvents.length, 1);
  assert.equal(doneEvents.length, 1);
  assert.ok(started, 'Canonical browser effect start must be projected as model.apply.started');
  assert.equal(started.data.model, 'GPT-test');
  assert.equal(started.data.effort, 'high');
  assert.ok(done, 'Canonical browser effect result must be projected as model.apply.done');
  assert.equal(done.data.modelApplied, true);
  assert.equal(done.data.effortApplied, true);
  assert.equal(done.data.intelligence.selectedModel.label, 'GPT-test');
  assert.equal(done.data.intelligence.selectedEffort.value, 'high');

  emitPromptSubmitted(hub, { requestId: prompt.requestId });
  emitTabObservation(hub, {
    requestId: prompt.requestId,
    conversationId: 'session-1',
    assistantTurnKey: 'assistant-model-projection',
    answer: 'done',
  });
  assert.equal((await requestPromise).answer, 'done');
});
