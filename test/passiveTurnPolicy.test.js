import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

async function loadPolicy() {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/passiveTurnPolicy.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: 'passiveTurnPolicy.js' });
  return context.ChatGptPassiveTurnPolicy;
}

function domParser() {
  return {
    isCompletedSnapshot(snapshot) {
      const hasOutput = Boolean(snapshot.hasFinalMessage || snapshot.artifacts?.length);
      const artifactsReady = (snapshot.artifacts || []).every((item) => String(item.phase || 'READY').toUpperCase() === 'READY');
      return hasOutput && artifactsReady && !snapshot.stopVisible && !snapshot.hasActiveTool
        && !snapshot.needsContinue && !snapshot.needsConfirmation && !snapshot.hasError;
    },
  };
}

test('passive terminal policy accepts a stable ZIP action without a response action bar', async () => {
  const policy = await loadPolicy();
  assert.equal(policy.isTerminalSnapshot({
    turnKey: 'assistant-zip',
    hasFinalMessage: false,
    actionBarVisible: false,
    stopVisible: false,
    artifacts: [{ id: 'zip', phase: 'READY', downloadable: true }],
  }, domParser()), true);
});

test('passive terminal policy accepts a final text response without an action bar', async () => {
  const policy = await loadPolicy();
  assert.equal(policy.isTerminalSnapshot({
    turnKey: 'assistant-final',
    hasFinalMessage: true,
    actionBarVisible: false,
    stopVisible: false,
    answer: 'Finished.',
    artifacts: [],
  }, domParser()), true);
});

test('passive terminal policy rejects an empty final-message placeholder', async () => {
  const policy = await loadPolicy();
  assert.equal(policy.isTerminalSnapshot({
    turnKey: 'assistant-placeholder',
    hasFinalMessage: true,
    actionBarVisible: true,
    stopVisible: false,
    answer: '',
    responseBlocks: [],
    artifacts: [],
  }, { isCompletedSnapshot: () => true }), false);
});

test('passive terminal policy rejects active, blocked, or incomplete output', async () => {
  const policy = await loadPolicy();
  assert.equal(policy.isTerminalSnapshot({ turnKey: 'a', hasFinalMessage: true, stopVisible: true }, domParser()), false);
  assert.equal(policy.isTerminalSnapshot({ turnKey: 'b', artifacts: [{ phase: 'GENERATING' }] }, domParser()), false);
  assert.equal(policy.isTerminalSnapshot({ turnKey: 'c', hasFinalMessage: true, needsConfirmation: true }, domParser()), false);
});

test('passive prompt submission baselines every pre-existing assistant turn', async () => {
  const policy = await loadPolicy();
  assert.equal(policy.shouldBaselineAll('passive-prompt-submit'), true);
  assert.equal(policy.shouldBaselineAll('observer-start'), false);
  assert.equal(policy.shouldBaselineAll('custom', { markAll: true }), true);
});

test('passive observer suppresses only the exact terminal turn owned by the active request', async () => {
  const policy = await loadPolicy();
  const requestPolicy = {
    snapshotBelongsToRequest(snapshot, request) {
      return snapshot.turnIndex > request.submittedUserTurnIndex;
    },
  };
  const request = { assistantTurnKey: 'assistant-owned', submittedUserTurnIndex: 4 };
  assert.equal(policy.activeRequestDisposition({ turnKey: 'assistant-owned', turnIndex: 5 }, request, requestPolicy), 'suppress-owned');
  assert.equal(policy.activeRequestDisposition({ turnKey: 'assistant-passive', turnIndex: 6 }, request, requestPolicy), 'defer');
  assert.equal(policy.activeRequestDisposition({ turnKey: 'assistant-passive', turnIndex: 6 }, null, requestPolicy), 'emit');
});

test('passive observer defers a keyed turn until the active monitor captures its exact assistant key', async () => {
  const policy = await loadPolicy();
  const broadRequestPolicy = { snapshotBelongsToRequest: () => true };
  const request = { assistantTurnKey: '', submittedUserTurnIndex: 4 };
  assert.equal(policy.activeRequestDisposition({ turnKey: 'assistant-unknown', turnIndex: 5 }, request, broadRequestPolicy), 'defer');
});

test('passive prompt boundary recognizes assistant turns after the submitted user turn', async () => {
  const policy = await loadPolicy();
  const boundary = { sessionId: 'session-1', submittedUserTurnIndex: 6 };
  assert.equal(policy.isAfterPromptBoundary({ index: 7 }, boundary, 'session-1'), true);
  assert.equal(policy.isAfterPromptBoundary({ index: 6 }, boundary, 'session-1'), false);
  assert.equal(policy.isAfterPromptBoundary({ index: 8 }, boundary, 'session-2'), false);
});


test('passive prompt boundary suppresses remounted or unbaselined turns before the submitted user turn', async () => {
  const policy = await loadPolicy();
  const boundary = { sessionId: 'session-1', submittedUserTurnIndex: 7, baselineTurnKeys: new Set(['known-old']) };
  assert.equal(policy.shouldSuppressOutsidePromptBoundary({ key: 'remounted-old', index: 3 }, boundary, 'session-1'), true);
  assert.equal(policy.shouldSuppressOutsidePromptBoundary({ key: 'new-assistant', index: 8 }, boundary, 'session-1'), false);
});
