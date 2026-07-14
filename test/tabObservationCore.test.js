import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

async function loadGlobal(file, name, extra = {}) {
  const source = await fs.readFile(path.resolve(file), 'utf8');
  const context = vm.createContext({ ...extra });
  vm.runInContext(source, context, { filename: path.basename(file) });
  return { value: context[name], context };
}

test('tab observation core normalizes independent tab facts without an active request', async () => {
  const { value: core } = await loadGlobal(
    'tools/chrome-bridge-extension/observation/tabObservationCore.js',
    'ChatGptTabObservationCore',
  );
  const observation = core.normalizeTabObservation({
    url: 'https://chatgpt.com/c/session-1',
    title: 'Session',
    session: { id: 'session-1' },
    presence: {
      documentReadyState: 'complete',
      chatMainReady: true,
      composerReady: true,
      pageReady: true,
      visibilityState: 'visible',
      focused: true,
    },
    snapshot: {
      phase: 'ASSISTANT_FINAL',
      turnKey: 'assistant-1',
      messageId: 'message-1',
      answer: 'Complete',
      hasFinalMessage: true,
      actionBarVisible: true,
      artifacts: [{ id: 'file-1', phase: 'READY' }],
    },
  });

  assert.equal(observation.conversationId, 'session-1');
  assert.equal(observation.document.state, 'ready');
  assert.equal(observation.composer.state, 'ready');
  assert.equal(observation.turn.state, 'final');
  assert.equal(observation.generation.state, 'stopped');
  assert.equal(observation.output.state, 'final');
  assert.equal(observation.artifact.state, 'ready');
  assert.equal(observation.activeRequest, null);
  assert.equal(observation.degraded, false);
});

test('tab observation core keeps blockers and generation orthogonal', async () => {
  const { value: core } = await loadGlobal(
    'tools/chrome-bridge-extension/observation/tabObservationCore.js',
    'ChatGptTabObservationCore',
  );
  const observation = core.normalizeTabObservation({
    presence: { documentReadyState: 'complete', chatMainReady: true, composerReady: true },
    snapshot: {
      phase: 'NEEDS_CONFIRMATION',
      needsConfirmation: true,
      stopVisible: true,
      thinking: 'Waiting for approval',
    },
    activeRequest: { requestId: 'req-1', phase: 'needs_confirmation' },
  });
  assert.equal(observation.generation.state, 'active');
  assert.equal(observation.blocker.state, 'confirmation');
  assert.equal(observation.activeRequest.requestId, 'req-1');
});

test('tab observation signatures ignore scheduling metadata and change on material facts', async () => {
  const { value: core } = await loadGlobal(
    'tools/chrome-bridge-extension/observation/tabObservationCore.js',
    'ChatGptTabObservationCore',
  );
  const base = core.normalizeTabObservation({
    url: 'https://chatgpt.com/c/one',
    presence: { documentReadyState: 'complete', chatMainReady: true, composerReady: true },
    snapshot: { phase: 'ASSISTANT_REASONING', thinking: 'One', stopVisible: true },
  });
  assert.equal(core.isMateriallyEqual(base, { ...base, revision: 9, observedAt: 50, reason: 'poll' }), true);
  assert.equal(core.isMateriallyEqual(base, { ...base, conversationId: 'two' }), false);
  assert.equal(core.isMateriallyEqual(base, { ...base, blocker: { state: 'continue' } }), false);
});

test('always-on tab observer emits initial and changed revisions without request ownership', async () => {
  let mutationListener = null;
  class FakeMutationObserver {
    constructor(listener) { mutationListener = listener; }
    observe() {}
    disconnect() {}
  }
  const timers = new Set();
  const setIntervalFake = (callback) => { timers.add(callback); return callback; };
  const clearIntervalFake = (callback) => timers.delete(callback);
  const { value: factory } = await loadGlobal(
    'tools/chrome-bridge-extension/observation/tabObserver.js',
    'ChatGptTabObserver',
    {
      MutationObserver: FakeMutationObserver,
      setTimeout,
      clearTimeout,
      setInterval: setIntervalFake,
      clearInterval: clearIntervalFake,
      Date,
      Math,
    },
  );

  let current = { degraded: false, state: 'idle', activeRequest: null };
  const emitted = [];
  const observer = factory.createTabObserver({
    MutationObserver: FakeMutationObserver,
    pollMs: 100_000,
    settleMs: 1,
    degradedSettleMs: 5,
    resolveRoot: () => ({ tagName: 'MAIN', getAttribute: () => '' }),
    read: () => current,
    signature: (value) => JSON.stringify(value),
    emit: (value) => emitted.push(value),
  });
  observer.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].revision, 1);
  assert.equal(emitted[0].activeRequest, null);
  assert.ok(emitted[0].observerId);

  mutationListener?.([]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(emitted.length, 1, 'duplicate observations should be deduplicated');

  current = { degraded: false, state: 'generating', activeRequest: { requestId: 'req-1' } };
  mutationListener?.([]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].revision, 2);
  assert.equal(emitted[1].activeRequest.requestId, 'req-1');
  observer.stop();
});

test('always-on tab observer suppresses transient degraded DOM snapshots but emits a stable degradation', async () => {
  let mutationListener = null;
  class FakeMutationObserver {
    constructor(listener) { mutationListener = listener; }
    observe() {}
    disconnect() {}
  }
  const { value: factory } = await loadGlobal(
    'tools/chrome-bridge-extension/observation/tabObserver.js',
    'ChatGptTabObserver',
    {
      MutationObserver: FakeMutationObserver,
      setTimeout,
      clearTimeout,
      setInterval: () => 1,
      clearInterval: () => {},
      Date,
      Math,
    },
  );

  let current = { degraded: false, document: { state: 'ready' }, composer: { state: 'ready' } };
  const emitted = [];
  const observer = factory.createTabObserver({
    MutationObserver: FakeMutationObserver,
    pollMs: 100_000,
    settleMs: 1,
    degradedSettleMs: 20,
    resolveRoot: () => ({ tagName: 'MAIN', getAttribute: () => '' }),
    read: () => current,
    signature: (value) => JSON.stringify(value),
    emit: (value) => emitted.push(value),
  });
  observer.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(emitted.length, 1);

  current = { degraded: true, document: { state: 'degraded' }, composer: { state: 'missing' } };
  mutationListener?.([]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  current = { degraded: false, document: { state: 'ready' }, composer: { state: 'ready' } };
  mutationListener?.([]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(emitted.length, 1, 'a short React replacement must not publish a degraded observation');

  current = { degraded: true, document: { state: 'degraded' }, composer: { state: 'missing' } };
  mutationListener?.([]);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].degraded, true);
  assert.equal(emitted[1].revision, 2);
  observer.stop();
});
