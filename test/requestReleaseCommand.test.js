import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

async function createReleaseHandler({ findStopButton, isGenerating }) {
  const context = vm.createContext({});
  context.globalThis = context;
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestReleaseCommand.js'), 'utf8');
  vm.runInContext(source, context);
  const releaseCalls = [];
  const settlements = [];
  const activeRequest = { requestId: 'request-1' };
  const handler = context.ChatGptRequestReleaseCommand.createRequestReleaseCommand({
    diagnostic: () => {},
    findStopButton,
    getActiveRequest: () => activeRequest,
    isGenerating,
    releaseRequest: (...args) => { releaseCalls.push(args); return true; },
    settleReleaseCleanup: async (value) => { settlements.push(value); },
  });
  return { handler, releaseCalls, settlements };
}

const staleRelease = {
  requestId: 'request-1',
  commandId: 'command-1',
  leaseId: 'lease-1',
  ownerServerInstanceId: 'server-1',
  recoveryMode: 'stale_lease',
};

test('stale release refuses a visible Stop control', async () => {
  const state = await createReleaseHandler({ findStopButton: () => ({}), isGenerating: () => false });
  await state.handler.handleRequestRelease(staleRelease);

  assert.equal(state.releaseCalls.length, 0);
  assert.equal(state.settlements[0]?.code, 'STALE_RELEASE_GENERATION_ACTIVE');
});

test('stale release refuses unknown generation evidence', async () => {
  const state = await createReleaseHandler({ findStopButton: () => null, isGenerating: () => { throw new Error('probe failed'); } });
  await state.handler.handleRequestRelease(staleRelease);

  assert.equal(state.releaseCalls.length, 0);
  assert.equal(state.settlements[0]?.code, 'STALE_RELEASE_GENERATION_UNKNOWN');
});

test('stale release clears the exact request only after an idle probe', async () => {
  const state = await createReleaseHandler({ findStopButton: () => null, isGenerating: () => false });
  await state.handler.handleRequestRelease(staleRelease);

  assert.deepEqual(state.releaseCalls, [[{ requestId: 'request-1' }, 'server_terminal']]);
  assert.equal(state.settlements[0]?.status, 'completed');
});
