import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestMonitor.js'), 'utf8');

function createHarness() {
  const context = { console, Date };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  let observer = null;
  const updates = [];
  const request = {
    requestId: 'request-boundary',
    submittedUserTurnKey: 'user-current',
    submittedUserTurnIndex: 4,
    assistantTurnKey: '',
    update(type, patch) {
      updates.push({ type, patch: structuredClone(patch) });
      Object.assign(this, patch);
    },
  };
  const monitor = context.ChatGptRequestMonitor.createRequestMonitor({
    diagnostic: () => {},
    findChatMain: () => ({}),
    findTurnByKey: () => null,
    getActiveRequest: () => request,
    refreshRequestTurnAnchors: () => {},
    schedulePageStatus: () => {},
    scheduleTabObservation: () => {},
    send: () => {},
    setActiveRequest: () => {},
    subscribeTabObservation(callback) { observer = callback; return () => {}; },
  });
  monitor.startDomMonitor(request);
  return { observer: () => observer, request, updates };
}

test('request monitor never attaches an assistant turn from an older user boundary after reload', () => {
  const harness = createHarness();
  harness.observer()({
    revision: 1,
    observerId: 'observer-reload',
    observedAt: 100,
    activeRequest: { requestId: harness.request.requestId },
    turn: { key: 'old-assistant', index: 3, userKey: 'old-user', userIndex: 2 },
  });
  assert.equal(harness.request.assistantTurnKey, '');
  assert.equal(harness.updates.some((entry) => entry.patch.assistantTurnKey === 'old-assistant'), false);
});

test('request monitor attaches an assistant turn only when the submitted user boundary matches', () => {
  const harness = createHarness();
  harness.observer()({
    revision: 2,
    observerId: 'observer-reload',
    observedAt: 200,
    activeRequest: { requestId: harness.request.requestId },
    turn: { key: 'current-assistant', index: 5, userKey: 'user-current', userIndex: 4 },
  });
  assert.equal(harness.request.assistantTurnKey, 'current-assistant');
  assert.equal(harness.request.assistantTurnIndex, 5);
});

test('stable turn keys survive virtualized history and refresh sample-local indices', () => {
  const h = createHarness();
  const observe = (userIndex, index) => h.observer()({
    revision: h.updates.length + 1,
    observerId: 'observer-1',
    activeRequest: { requestId: h.request.requestId },
    turn: { key: 'current-assistant', userKey: 'user-current', userIndex, index },
  });
  observe(0, 1);
  assert.equal(h.request.assistantTurnKey, 'current-assistant');
  assert.equal(h.request.submittedUserTurnIndex, 0);
  assert.equal(h.request.assistantTurnIndex, 1);
  observe(2, 3);
  assert.equal(h.request.submittedUserTurnIndex, 2);
  assert.equal(h.request.assistantTurnIndex, 3);
});

test('an assistant before its user cannot establish a request boundary', () => {
  const h = createHarness();
  h.observer()({
    revision: 1,
    activeRequest: { requestId: h.request.requestId },
    turn: { key: 'wrong', userKey: 'user-current', userIndex: 4, index: 3 },
  });
  assert.equal(h.request.assistantTurnKey, '');
});
