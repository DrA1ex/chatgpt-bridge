import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

async function createHarness({ activeRequest = null } = {}) {
  const timers = [];
  const storage = new Map();
  const sent = [];
  let now = 1_000;
  let currentActiveRequest = activeRequest;
  let currentSessionId = 'session-1';

  const context = vm.createContext({
    console,
    location: { href: 'https://chatgpt.com/c/session-1' },
    document: { title: 'Conversation' },
    sessionStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    setTimeout(callback, delay = 0) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cancelled = true;
    },
    setInterval() { return null; },
    clearInterval() {},
    Date: class FakeDate extends Date {
      static now() { return now; }
    },
  });

  for (const relative of [
    'tools/chrome-bridge-extension/content/passiveTurnPolicy.js',
    'tools/chrome-bridge-extension/content/pageRuntimeObservers.js',
  ]) {
    const source = await fs.readFile(path.resolve(relative), 'utf8');
    vm.runInContext(source, context, { filename: relative });
  }

  const assistantNode = { isConnected: true };
  const turns = [
    { key: 'user-1', role: 'user' },
    { key: 'assistant-1', role: 'assistant', assistantNode },
  ];
  const requestPolicy = {
    snapshotBelongsToRequest(snapshot, request) {
      return snapshot.turnIndex > request.submittedUserTurnIndex;
    },
  };
  const observers = context.ChatGptPageRuntimeObservers.createPageRuntimeObservers({
    CONFIG: { networkStreamEnabled: false },
    DOM_PARSER: { isCompletedSnapshot: () => true },
    PASSIVE_TURN_POLICY: context.ChatGptPassiveTurnPolicy,
    REQUEST_SNAPSHOT_POLICY: requestPolicy,
    attachDomObserver() {},
    collectAndEmit() {},
    connect() {},
    diagnostic() {},
    findChatMain() { return null; },
    getActiveRequest() { return currentActiveRequest; },
    getAssistantNodeFromTurn(turn) { return turn.assistantNode || null; },
    getClientId() { return 'primary-client'; },
    getCurrentSession() { return { id: currentSessionId }; },
    getTurnNodes() { return turns; },
    readAssistantNodeSnapshot(_node, options) {
      return {
        turnKey: options.turnKey,
        turnIndex: options.turnIndex,
        signature: 'terminal-v1',
        hasFinalMessage: true,
        answer: 'workflow completed',
        artifacts: [],
        stopVisible: false,
        hasActiveTool: false,
        needsContinue: false,
        needsConfirmation: false,
        hasError: false,
      };
    },
    scheduleCollect() {},
    schedulePageStatus() {},
    scheduleTabObservation() {},
    send(message) { sent.push(message); },
    startPageReadinessMonitor() {},
    startTabObserver() {},
    syncFloatingPanelVisibility() {},
    turnKey(turn) { return turn.key; },
  });

  function runNextTimer() {
    while (timers.length) {
      const timer = timers.shift();
      if (timer.cancelled) continue;
      timer.callback();
      return true;
    }
    return false;
  }

  return {
    observers,
    sent,
    advance(ms) { now += ms; },
    runNextTimer,
    setActiveRequest(value) { currentActiveRequest = value; },
    setCurrentSessionId(value) { currentSessionId = value; },
  };
}

test('passive prompt boundary emits a terminal assistant turn absent from the pre-submit baseline', async () => {
  const harness = await createHarness();
  harness.observers.ensurePassiveSession('observer-start');
  harness.observers.baselinePassiveTurns('passive-prompt-submit');
  harness.observers.registerPassivePromptBoundary({
    submittedUserTurnKey: 'user-1',
    submittedUserTurnIndex: 0,
  }, new Set(['user-1']));

  assert.equal(harness.runNextTimer(), true);
  assert.equal(harness.sent.length, 0);
  harness.advance(900);
  assert.equal(harness.runNextTimer(), true);

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].type, 'observed.turn.terminal');
  assert.equal(harness.sent[0].turnKey, 'assistant-1');
});

test('passive prompt boundary does not re-emit an assistant turn present before submission', async () => {
  const harness = await createHarness();
  harness.observers.ensurePassiveSession('observer-start');
  harness.observers.baselinePassiveTurns('passive-prompt-submit');
  harness.observers.registerPassivePromptBoundary({
    submittedUserTurnKey: 'user-1',
    submittedUserTurnIndex: 0,
  }, new Set(['user-1', 'assistant-1']));

  assert.equal(harness.runNextTimer(), true);
  harness.advance(900);
  assert.equal(harness.runNextTimer(), false);
  assert.equal(harness.sent.length, 0);
});

test('passive observer defers an unrelated terminal turn while another request is active, then emits it', async () => {
  const harness = await createHarness({
    activeRequest: { assistantTurnKey: 'assistant-other', submittedUserTurnIndex: 0 },
  });
  harness.observers.ensurePassiveSession('observer-start');
  harness.observers.baselinePassiveTurns('passive-prompt-submit');
  harness.observers.registerPassivePromptBoundary({
    submittedUserTurnKey: 'user-1',
    submittedUserTurnIndex: 0,
  }, new Set(['user-1']));

  assert.equal(harness.runNextTimer(), true);
  assert.equal(harness.sent.length, 0);

  harness.setActiveRequest(null);
  harness.advance(900);
  assert.equal(harness.runNextTimer(), true);

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].turnKey, 'assistant-1');
});


test('passive prompt boundary survives the post-submit transition from a new chat to its conversation id', async () => {
  const harness = await createHarness();
  harness.setCurrentSessionId('new');
  harness.observers.ensurePassiveSession('observer-start');
  harness.observers.baselinePassiveTurns('passive-prompt-submit');

  harness.setCurrentSessionId('session-1');
  harness.observers.registerPassivePromptBoundary({
    submittedUserTurnKey: 'user-1',
    submittedUserTurnIndex: 0,
  }, new Set(['user-1']));

  assert.equal(harness.runNextTimer(), true);
  harness.advance(900);
  assert.equal(harness.runNextTimer(), true);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].turnKey, 'assistant-1');
});
