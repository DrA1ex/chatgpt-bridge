import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

async function createHarness({ activeRequest = null, terminal = true, liveSnapshots = false } = {}) {
  const timers = [];
  const storage = new Map();
  const sent = [];
  let now = 1_000;
  let currentActiveRequest = activeRequest;
  let currentSessionId = 'session-1';
  let currentTerminal = terminal;
  let currentAnswer = 'workflow completed';
  let currentArtifacts = [];
  let currentProgressItems = [];

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
  let turns = [
    { key: 'user-1', role: 'user', text: 'Please fix the project' },
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
        answer: currentAnswer,
        artifacts: currentArtifacts,
        progressItems: currentProgressItems,
        stopVisible: !currentTerminal,
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
    turnRole: liveSnapshots ? (turn) => turn.role : undefined,
    visibleText: liveSnapshots ? (turn) => turn.text || '' : undefined,
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
    setTerminal(value) { currentTerminal = Boolean(value); },
    setAnswer(value) { currentAnswer = String(value || ''); },
    setArtifacts(value) { currentArtifacts = Array.isArray(value) ? value : []; },
    setProgressItems(value) { currentProgressItems = Array.isArray(value) ? value : []; },
    setTurns(value) { turns = Array.isArray(value) ? value : []; },
    getTurns() { return turns; },
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
  assert.equal(harness.runNextTimer(), true);
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

test('passive prompt boundary keeps rescanning an incomplete assistant turn without another DOM mutation', async () => {
  const harness = await createHarness({ terminal: false });
  harness.observers.ensurePassiveSession('observer-start');
  harness.observers.baselinePassiveTurns('passive-prompt-submit');
  harness.observers.registerPassivePromptBoundary({
    submittedUserTurnKey: 'user-1',
    submittedUserTurnIndex: 0,
  }, new Set(['user-1']));

  assert.equal(harness.runNextTimer(), true);
  assert.equal(harness.sent.length, 0);
  harness.setTerminal(true);
  harness.advance(900);
  assert.equal(harness.runNextTimer(), true);
  assert.equal(harness.sent.length, 0);
  harness.advance(900);
  assert.equal(harness.runNextTimer(), true);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].turnKey, 'assistant-1');
});



test('passive prompt boundary waits for meaningful output when ChatGPT mounts an empty final container first', async () => {
  const harness = await createHarness();
  harness.setAnswer('');
  harness.observers.ensurePassiveSession('observer-start');
  harness.observers.baselinePassiveTurns('passive-prompt-submit');
  harness.observers.registerPassivePromptBoundary({
    submittedUserTurnKey: 'user-1',
    submittedUserTurnIndex: 0,
  }, new Set(['user-1']));

  assert.equal(harness.runNextTimer(), true);
  assert.equal(harness.sent.length, 0);

  harness.setArtifacts([{ id: 'zip-1', name: 'result.zip', phase: 'READY', downloadable: true }]);
  harness.advance(900);
  assert.equal(harness.runNextTimer(), true);
  assert.equal(harness.sent.length, 0);
  harness.advance(900);
  assert.equal(harness.runNextTimer(), true);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].artifacts[0].name, 'result.zip');
});


test('passive prompt boundary ignores a remounted older assistant turn and emits only the new response', async () => {
  const harness = await createHarness();
  harness.setTurns([{ key: 'old-original', role: 'assistant', assistantNode: { isConnected: true } }]);
  harness.observers.ensurePassiveSession('observer-start');
  harness.observers.baselinePassiveTurns('passive-prompt-submit');

  const remountedOld = { key: 'old-remounted', role: 'assistant', assistantNode: { isConnected: true } };
  const user = { key: 'user-new', role: 'user' };
  const newAssistant = { key: 'assistant-new', role: 'assistant', assistantNode: { isConnected: true } };
  harness.setTurns([remountedOld, user, newAssistant]);
  harness.observers.registerPassivePromptBoundary({
    submittedUserTurnKey: 'user-new',
    submittedUserTurnIndex: 1,
  }, new Set(['old-original', 'user-new']));
  harness.observers.markPassiveTurnDirty(remountedOld, 'poll');
  harness.observers.schedulePassiveTurnScan('poll', 0);

  assert.equal(harness.runNextTimer(), true);
  assert.equal(harness.sent.length, 0);
  harness.advance(900);
  while (harness.runNextTimer()) {
    if (harness.sent.length) break;
    harness.advance(900);
  }

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].turnKey, 'assistant-new');
});


test('passive observer emits deduplicated live snapshots with the user prompt and complete reasoning', async () => {
  const harness = await createHarness({ terminal: false, liveSnapshots: true });
  harness.setAnswer('Partial answer');
  harness.setProgressItems([
    { kind: 'thinking', text: 'Inspecting files' },
    { kind: 'thinking', text: 'Inspecting files' },
    { kind: 'thinking', text: 'Running tests' },
    { kind: 'action', text: 'Reading project' },
  ]);
  harness.observers.ensurePassiveSession('observer-start');
  harness.observers.baselinePassiveTurns('passive-prompt-submit');
  harness.observers.registerPassivePromptBoundary({ submittedUserTurnKey: 'user-1', submittedUserTurnIndex: 0 }, new Set(['user-1']));
  assert.equal(harness.runNextTimer(), true);
  const live = harness.sent.find((message) => message.type === 'observed.turn.snapshot');
  assert.ok(live);
  assert.equal(live.userPrompt, 'Please fix the project');
  assert.equal(live.userTurnKey, 'user-1');
  assert.equal(live.reasoning, 'Inspecting files\nRunning tests');
  assert.equal(live.progress, 'Reading project');
  assert.equal(live.answer, 'Partial answer');
  assert.equal(live.terminal, false);
});

test('passive observer emits a new user prompt before the assistant response appears', async () => {
  const harness = await createHarness({ liveSnapshots: true });
  harness.observers.ensurePassiveSession('observer-start');
  const oldTurns = harness.getTurns();
  const newUser = { key: 'user-2', role: 'user', text: 'A prompt typed directly in ChatGPT' };
  harness.setTurns([...oldTurns, newUser]);
  assert.equal(harness.observers.emitPassiveUserTurn(newUser, oldTurns.length, 'test-user'), true);
  const live = harness.sent.at(-1);
  assert.equal(live.type, 'observed.turn.snapshot');
  assert.equal(live.userTurnKey, 'user-2');
  assert.equal(live.userPrompt, 'A prompt typed directly in ChatGPT');
  assert.equal(live.phase, 'waiting-for-assistant');
  assert.equal(harness.observers.emitPassiveUserTurn(newUser, oldTurns.length, 'test-user'), false);
});
