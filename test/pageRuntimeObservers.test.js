import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

async function createHarness({ activeRequest = null } = {}) {
  const scheduled = [];
  const diagnostics = [];
  const collected = [];
  let currentSessionId = 'session-1';
  let currentActiveRequest = activeRequest;
  let turns = [
    { key: 'user-1', role: 'user', text: 'Please fix the project' },
    { key: 'assistant-1', role: 'assistant', text: 'Done', assistantNode: { isConnected: true } },
  ];

  const context = vm.createContext({
    console,
    document: { visibilityState: 'visible' },
    window: {},
    history: {},
    setTimeout(callback) { callback(); return 1; },
    Date,
    Math,
  });
  context.globalThis = context;
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/pageRuntimeObservers.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'pageRuntimeObservers.js' });

  const observers = context.ChatGptPageRuntimeObservers.createPageRuntimeObservers({
    CONFIG: { networkStreamEnabled: false },
    connect() {},
    diagnostic(name, details) { diagnostics.push({ name, details }); },
    getActiveRequest() { return currentActiveRequest; },
    getAssistantNodeFromTurn(turn) { return turn.assistantNode || null; },
    getCurrentSession() { return { id: currentSessionId }; },
    getTurnNodes() { return turns; },
    scheduleCollect(request, reason, delayMs) { collected.push({ request, reason, delayMs }); },
    schedulePageStatus(reason, delayMs) { scheduled.push({ kind: 'page', reason, delayMs }); },
    scheduleTabObservation(reason, delayMs) { scheduled.push({ kind: 'observation', reason, delayMs }); },
    startPageReadinessMonitor() {},
    startTabObserver() {},
    syncFloatingPanelVisibility() {},
    turnKey(turn) { return turn.key; },
    turnRole(turn) { return turn.role; },
    visibleText(turn) { return turn.text || ''; },
  });

  return {
    observers,
    scheduled,
    diagnostics,
    collected,
    setActiveRequest(value) { currentActiveRequest = value; },
    setSession(value) { currentSessionId = value; },
    setTurns(value) { turns = value; },
    context,
  };
}

test('shared observation context pairs the assistant turn with its preceding user turn', async () => {
  const harness = await createHarness();
  const context = harness.observers.readObservedTurnContext({ turnKey: 'assistant-1', turnIndex: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(context)), {
    turnKey: 'assistant-1',
    turnIndex: 1,
    userTurnKey: 'user-1',
    userTurnIndex: 0,
    userPrompt: 'Please fix the project',
    promptBoundary: null,
  });
});

test('registered prompt boundary is immutable evidence in the next shared observation', async () => {
  const harness = await createHarness();
  harness.observers.registerPassivePromptBoundary({
    submittedUserTurnKey: 'user-1',
    submittedUserTurnIndex: 0,
  });
  const context = harness.observers.readObservedTurnContext({ turnKey: 'assistant-1', turnIndex: 1 });
  assert.equal(context.promptBoundary.submittedUserTurnKey, 'user-1');
  assert.equal(context.promptBoundary.submittedUserTurnIndex, 0);
  assert.ok(context.promptBoundary.registeredAt > 0);
  assert.deepEqual(harness.scheduled.at(-1), {
    kind: 'observation', reason: 'passive.prompt_boundary', delayMs: 0,
  });
});

test('session changes invalidate the prior prompt boundary before another observation is emitted', async () => {
  const harness = await createHarness();
  harness.observers.registerPassivePromptBoundary({ submittedUserTurnKey: 'user-1', submittedUserTurnIndex: 0 });
  harness.setSession('session-2');
  assert.equal(harness.observers.ensurePassiveSession('location-change'), 'session-2');
  const context = harness.observers.readObservedTurnContext({ turnKey: 'assistant-1', turnIndex: 1 });
  assert.equal(context.promptBoundary, null);
});

test('legacy passive entry points only schedule the one shared TabObservation pipeline', async () => {
  const harness = await createHarness();
  harness.observers.baselinePassiveTurns('startup');
  harness.observers.schedulePassiveTurnScan('mutation', 25);
  harness.observers.markPassiveTurnDirty();
  harness.observers.attachPassiveTurnObserver();
  assert.equal(harness.observers.emitPassiveUserTurn(), true);

  assert.deepEqual(harness.scheduled.map((entry) => entry.reason), [
    'passive.baseline:startup',
    'mutation',
    'passive.turn_dirty',
    'passive.observer_attached',
    'passive.user_turn',
  ]);
  assert.equal(harness.scheduled.every((entry) => entry.kind === 'observation'), true);
});

test('foreground resync schedules one shared observation and active-request collection', async () => {
  const request = { requestId: 'request-1' };
  const harness = await createHarness({ activeRequest: request });
  harness.observers.handleForegroundResync('window.focus');
  assert.deepEqual(harness.scheduled, [
    { kind: 'page', reason: 'page.changed', delayMs: 0 },
    { kind: 'observation', reason: 'window.focus', delayMs: 0 },
  ]);
  assert.deepEqual(harness.collected, [{ request, reason: 'window.focus', delayMs: 0 }]);
});

test('page runtime observers contain no passive terminal state machine or fragmented transport', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/pageRuntimeObservers.js'), 'utf8');
  assert.doesNotMatch(source, /pendingTerminal|dirtyTurns|emittedDedupe|terminalSettle|scanTimer/);
  assert.doesNotMatch(source, /observed\.turn\.|request\.terminal_|assistant\.progress\.snapshot/);
  assert.match(source, /scheduleTabObservation/);
  assert.match(source, /readObservedTurnContext/);
});
