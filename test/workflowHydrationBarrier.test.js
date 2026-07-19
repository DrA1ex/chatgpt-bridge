import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkflowStore } from '../src/workflow/store.js';
import {
  canonicalWorkflowBinding,
  completeWorkflowHydration,
  observedTurnMatches,
  routeObservedTurn,
} from '../src/workflow/support/observedTurnRouter.js';

function runtimeFixture() {
  return {
    id: 'workflow-hydration',
    hydrationStatus: 'hydrating',
    config: {
      configPath: '/tmp/workflow.json',
      watch: { mode: 'passive', clientId: 'stale-config-client', sessionId: 'stale-config-session' },
      automation: {},
      execution: { maxDeferredTurns: 10 },
    },
    workflowState: {
      lifecycle: 'ready',
      subscription: { enabled: true },
      queueLimit: 10,
      binding: { clientId: 'canonical-client', sessionId: 'canonical-session', epoch: 4 },
      run: { phase: 'none' },
    },
  };
}

test('observed inputs received during hydration survive a store restart and drain exactly once', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-hydration-store-'));
  try {
    const firstStore = new WorkflowStore(root);
    const runtime = runtimeFixture();
    const turn = {
      sourceClientId: 'canonical-client',
      sessionId: 'canonical-session',
      turnKey: 'assistant-turn-1',
      answer: 'Persist me before restore completes',
    };
    await routeObservedTurn({
      workflows: new Map([[runtime.id, runtime]]),
      turn,
      enqueue: async () => assert.fail('hydrating input must not enter the live project queue'),
      processObserved: async () => assert.fail('hydrating input must not execute before restore'),
      failRuntime: async () => {},
      isWorkflowActive: () => false,
      store: firstStore,
    });
    const persistedBeforeRestart = await firstStore.listStartupInputs(runtime.id);
    assert.equal(persistedBeforeRestart.length, 1);
    assert.equal(persistedBeforeRestart[0].bindingEpoch, 4);

    const restartedStore = new WorkflowStore(root);
    const processed = [];
    const restored = await completeWorkflowHydration({
      runtime,
      snapshot: { id: runtime.id },
      restore: async () => ({ restored: true }),
      enqueue: async (_workflowId, task) => await task(),
      processObserved: async (_runtime, observed) => processed.push(observed.turnKey),
      syncRefresh: () => {},
      publish: async () => {},
      store: restartedStore,
    });
    assert.deepEqual(restored, { restored: true });
    assert.deepEqual(processed, ['assistant-turn-1']);
    assert.equal(runtime.hydrationStatus, 'ready');
    assert.deepEqual(await restartedStore.listStartupInputs(runtime.id), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('failed hydration processing leaves the durable startup input for deterministic restart recovery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-hydration-failure-'));
  try {
    const store = new WorkflowStore(root);
    const runtime = runtimeFixture();
    await routeObservedTurn({
      workflows: new Map([[runtime.id, runtime]]),
      turn: { sourceClientId: 'canonical-client', sessionId: 'canonical-session', turnKey: 'turn-failure' },
      enqueue: async () => {}, processObserved: async () => {}, failRuntime: async () => {}, isWorkflowActive: () => false, store,
    });
    await assert.rejects(() => completeWorkflowHydration({
      runtime,
      snapshot: {},
      restore: async () => ({}),
      enqueue: async (_workflowId, task) => await task(),
      processObserved: async () => { throw new Error('simulated process crash'); },
      syncRefresh: () => {},
      publish: async () => {},
      store,
    }), /simulated process crash/);
    assert.equal(runtime.hydrationStatus, 'failed');
    assert.equal((await store.listStartupInputs(runtime.id)).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('canonical workflow binding overrides stale configuration after session handoff', () => {
  const runtime = runtimeFixture();
  assert.deepEqual(canonicalWorkflowBinding(runtime), {
    clientId: 'canonical-client', sessionId: 'canonical-session', epoch: 4,
  });
  assert.equal(observedTurnMatches(runtime, {
    sourceClientId: 'canonical-client', sessionId: 'canonical-session',
  }, { isWorkflowActive: () => false }), true);
  assert.equal(observedTurnMatches(runtime, {
    sourceClientId: 'stale-config-client', sessionId: 'stale-config-session',
  }, { isWorkflowActive: () => false }), false);
});

test('workflow services cannot reintroduce mutable binding mirrors or overwrite configured watch binding', async () => {
  const root = path.resolve('src/workflow');
  const files = [];
  async function collect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(absolute);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(absolute);
    }
  }
  await collect(root);
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    const relative = path.relative(process.cwd(), file);
    assert.doesNotMatch(source, /runtime\.config\.watch\.(?:clientId|sessionId)\s*=/, `config binding mutation in ${relative}`);
    assert.doesNotMatch(source, /runtime\.(?:boundSourceClientId|boundSessionId)\s*=/, `runtime binding mirror in ${relative}`);
  }
});
