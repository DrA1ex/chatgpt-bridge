import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  commandResult,
  emitPromptSubmitted,
  emitTabObservation,
} from './support/bridgeObservation.js';

async function readExtensionContentRuntime() {
  const root = path.resolve('tools/chrome-bridge-extension');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  return (await Promise.all(manifest.content_scripts[1].js.map((file) => fs.readFile(path.join(root, file), 'utf8')))).join('\n');
}

process.env.FORCED_SNAPSHOT_AFTER_MS = process.env.FORCED_SNAPSHOT_AFTER_MS || '60000';
process.env.REQUEST_MEANINGFUL_PROGRESS_TIMEOUT_MS = process.env.REQUEST_MEANINGFUL_PROGRESS_TIMEOUT_MS || '250';
process.env.REQUEST_POST_GENERATION_PROGRESS_TIMEOUT_MS = process.env.REQUEST_POST_GENERATION_PROGRESS_TIMEOUT_MS || '60';
process.env.REQUEST_GENERATION_ACTIVITY_GRACE_MS = process.env.REQUEST_GENERATION_ACTIVITY_GRACE_MS || '10';
process.env.REQUIRED_ARTIFACT_SETTLE_MS = process.env.REQUIRED_ARTIFACT_SETTLE_MS || '120';

const { BrowserBridge } = await import('../src/browserBridge.js');

class FakeHub extends EventEmitter {
  constructor() {
    super();
    this.activeClient = { id: 'client-1', ready: true, url: 'https://chatgpt.com/source' };
    this.sent = [];
    this.readyClients = new Map([
      ['client-1', { id: 'client-1', ready: true, url: 'https://chatgpt.com/source', activeRequest: null }],
      ['client-2', { id: 'client-2', ready: true, url: 'https://chatgpt.com/other', activeRequest: null }],
    ]);
  }
  get clients() { return Array.from(this.readyClients.values()); }
  get selectedClientId() { return ''; }
  get needsSelection() { return false; }
  get debugEvents() { return []; }
  sendToActiveWithDelivery(payload) {
    return this.sendToClientWithDelivery(this.activeClient.id, payload);
  }
  sendToClientWithDelivery(clientId, payload) {
    const client = this.sendToClient(clientId, payload);
    return { client, delivered: Promise.resolve() };
  }
  sendToActive(payload) {
    this.sent.push({ clientId: this.activeClient.id, payload });
    return this.activeClient;
  }
  sendToClient(clientId, payload) {
    this.sent.push({ clientId, payload });
    const client = this.readyClients.get(clientId) || { id: clientId, ready: true };
    if (payload.type === 'prompt.cancel') {
      setImmediate(() => this.emit('client.message', {
        clientId,
        payload: {
          type: 'request.effect.succeeded',
          commandId: payload.commandId,
          requestId: payload.requestId,
          effectId: payload.effect.effectId,
          effectType: 'prompt.cancel',
          responseEpoch: Number(payload.effect.responseEpoch) || 0,
          result: { cancelled: true },
        },
      }));
    }
    if (payload.type === 'request.release') {
      setImmediate(() => this.emit('client.message', {
        clientId,
        payload: { type: 'lease.released', commandId: payload.commandId, released: true, activeRequest: null },
      }));
    }
    return client;
  }
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function startRequest(bridge, hub, input, callbacks = {}) {
  const promise = bridge.sendRequest(input, callbacks);
  await nextTick();
  const prompt = hub.sent.findLast((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt, 'prompt.send should be sent');
  emitPromptSubmitted(hub, { requestId: prompt.requestId });
  return { promise, prompt };
}

function sendCommandResult(hub, command, resultType, data = {}, clientId = 'client-1') {
  hub.emit('client.message', {
    clientId,
    payload: commandResult(command.payload.commandId, resultType, data),
  });
}

test('forced snapshots are source-bound read-only reconciliation and cannot terminate the request', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const events = [];
  const { promise: requestPromise, prompt } = await startRequest(
    bridge,
    hub,
    { message: 'long project task' },
    { onEvent: (event) => events.push(event) },
  );

  emitTabObservation(hub, {
    requestId: prompt.requestId,
    assistantTurnKey: 'assistant-source',
    generation: 'active',
    outputState: 'streaming',
    answer: 'partial',
    finalMessage: false,
    stableForMs: 0,
  });
  hub.activeClient = { id: 'client-2', ready: true, url: 'https://chatgpt.com/other' };

  const snapshotPromise = bridge.requestForcedSnapshot(prompt.requestId, { reason: 'test' });
  await nextTick();
  const command = hub.sent.findLast((entry) => entry.payload.type === 'response.snapshot.request');
  assert.ok(command);
  assert.equal(command.clientId, 'client-1');
  assert.equal(command.payload.turnKey, 'assistant-source');

  let snapshotSettled = false;
  snapshotPromise.finally(() => { snapshotSettled = true; }).catch(() => {});
  sendCommandResult(hub, command, 'request.snapshot', {
    requestId: prompt.requestId,
    answer: 'wrong active tab',
    turnKey: 'assistant-source',
    terminal: true,
  }, 'client-2');
  await nextTick();
  assert.equal(snapshotSettled, false, 'a response from another tab must not settle source-bound correlation');

  sendCommandResult(hub, command, 'request.snapshot', {
    requestId: prompt.requestId,
    answer: 'right source tab',
    artifacts: [],
    turnKey: 'assistant-source',
    terminal: true,
  });
  const snapshot = await snapshotPromise;
  assert.equal(snapshot.answer, 'right source tab');

  let requestSettled = false;
  requestPromise.finally(() => { requestSettled = true; }).catch(() => {});
  await nextTick();
  assert.equal(requestSettled, false, 'forced read-only snapshots must not materialize terminal state');

  emitTabObservation(hub, {
    requestId: prompt.requestId,
    assistantTurnKey: 'assistant-source',
    answer: 'right source tab',
  });
  const result = await requestPromise;
  assert.equal(result.answer, 'right source tab');
  assert.equal(result.finishReason, 'stable_normalized_observation');
  assert.ok(events.some((event) => event.type === 'forced_snapshot.requested'));
  assert.ok(events.some((event) => event.type === 'forced_snapshot.received'));
  await bridge.close();
});

test('an exact inactive active-request snapshot demotes generation without terminalizing', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const { promise, prompt } = await startRequest(bridge, hub, { message: 'inactive generation snapshot' });
  promise.catch(() => {});

  try {
    emitTabObservation(hub, {
      requestId: prompt.requestId,
      userTurnKey: 'user-inactive-snapshot',
      assistantTurnKey: 'assistant-inactive-snapshot',
      generation: 'active',
      outputState: 'none',
      finalMessage: false,
      stableForMs: 0,
    });

    const canonical = bridge.requestStateDiagnostics(prompt.requestId).state;
    assert.equal(canonical.generation, 'active');
    assert.equal(canonical.response.userTurnKey, 'user-inactive-snapshot');
    const identity = {
      requestId: prompt.requestId,
      leaseId: canonical.source.leaseId,
      ownerServerInstanceId: canonical.source.ownerServerInstanceId,
      responseEpoch: canonical.response.epoch,
      submittedUserTurnKey: canonical.response.userTurnKey,
      assistantTurnKey: canonical.lastObservation.data.turnKey,
    };

    const snapshotPromise = bridge.requestForcedSnapshot(prompt.requestId, { reason: 'inactive-generation-reconciliation' });
    await nextTick();
    const command = hub.sent.findLast((entry) => entry.payload.type === 'response.snapshot.request');
    assert.ok(command);
    sendCommandResult(hub, command, 'request.snapshot', {
      requestId: prompt.requestId,
      active: true,
      activeRequest: identity,
      session: { id: canonical.source.conversationId },
      generating: false,
      answer: '',
      thinking: '',
      progress: '',
      artifacts: [],
      turnKey: identity.assistantTurnKey,
      phase: 'waiting_for_assistant_turn',
      completionEvidence: {
        generationStopped: true,
        finalMessage: false,
        actionBarVisible: false,
      },
    });
    await snapshotPromise;

    const after = bridge.requestStateDiagnostics(prompt.requestId);
    assert.equal(after.state.generation, 'stopped');
    assert.equal(after.state.lifecycle, 'awaiting_assistant');
    assert.equal(after.state.terminal, null, 'inactive empty output is not successful terminal evidence');
    assert.equal(after.deadlines.some((deadline) => deadline.kind === 'progress_liveness'), false);
    assert.ok(after.deadlines.some((deadline) => deadline.kind === 'forced_snapshot'));
  } finally {
    await bridge.close();
  }
});

test('an inactive snapshot without explicit generation evidence cannot demote canonical generation', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const { promise, prompt } = await startRequest(bridge, hub, { message: 'missing inactive generation evidence' });
  promise.catch(() => {});

  try {
    emitTabObservation(hub, {
      requestId: prompt.requestId,
      userTurnKey: 'user-missing-generation-evidence',
      assistantTurnKey: 'assistant-missing-generation-evidence',
      generation: 'active',
      outputState: 'none',
      finalMessage: false,
      stableForMs: 0,
    });
    const canonical = bridge.requestStateDiagnostics(prompt.requestId).state;
    const identity = {
      requestId: prompt.requestId,
      leaseId: canonical.source.leaseId,
      ownerServerInstanceId: canonical.source.ownerServerInstanceId,
      responseEpoch: canonical.response.epoch,
      submittedUserTurnKey: canonical.response.userTurnKey,
      assistantTurnKey: canonical.lastObservation.data.turnKey,
    };

    const snapshotPromise = bridge.requestForcedSnapshot(prompt.requestId, { reason: 'missing-inactive-generation-evidence' });
    await nextTick();
    const command = hub.sent.findLast((entry) => entry.payload.type === 'response.snapshot.request');
    sendCommandResult(hub, command, 'request.snapshot', {
      requestId: prompt.requestId,
      active: true,
      activeRequest: identity,
      session: { id: canonical.source.conversationId },
      answer: '',
    });
    await snapshotPromise;

    const after = bridge.requestStateDiagnostics(prompt.requestId);
    assert.equal(after.state.generation, 'active', 'missing generation evidence must fail closed');
    assert.equal(after.state.terminal, null);
    assert.equal(after.deadlines.some((deadline) => deadline.kind === 'progress_liveness'), false);
  } finally {
    await bridge.close();
  }
});

test('inactive snapshots with a mismatched lease cannot demote the current generation', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const { promise, prompt } = await startRequest(bridge, hub, { message: 'mismatched inactive generation snapshot' });
  promise.catch(() => {});

  try {
    emitTabObservation(hub, {
      requestId: prompt.requestId,
      userTurnKey: 'user-mismatched-snapshot',
      assistantTurnKey: 'assistant-mismatched-snapshot',
      generation: 'active',
      outputState: 'none',
      finalMessage: false,
      stableForMs: 0,
    });
    const canonical = bridge.requestStateDiagnostics(prompt.requestId).state;
    const identity = {
      requestId: prompt.requestId,
      leaseId: 'different-lease',
      ownerServerInstanceId: canonical.source.ownerServerInstanceId,
      responseEpoch: canonical.response.epoch,
      submittedUserTurnKey: canonical.response.userTurnKey,
      assistantTurnKey: canonical.lastObservation.data.turnKey,
    };

    const snapshotPromise = bridge.requestForcedSnapshot(prompt.requestId, { reason: 'mismatched-inactive-generation-reconciliation' });
    await nextTick();
    const command = hub.sent.findLast((entry) => entry.payload.type === 'response.snapshot.request');
    sendCommandResult(hub, command, 'request.snapshot', {
      requestId: prompt.requestId,
      active: true,
      activeRequest: identity,
      session: { id: canonical.source.conversationId },
      generating: false,
      answer: '',
      artifacts: [],
      turnKey: identity.assistantTurnKey,
    });
    await snapshotPromise;

    const after = bridge.requestStateDiagnostics(prompt.requestId);
    assert.equal(after.state.generation, 'active');
    assert.equal(after.state.terminal, null);
    assert.equal(after.deadlines.some((deadline) => deadline.kind === 'progress_liveness'), false);
  } finally {
    await bridge.close();
  }
});

test('inactive snapshots with a mismatched response epoch or conversation cannot demote generation', async () => {
  for (const mismatch of [
    {
      name: 'response epoch',
      mutateIdentity(identity) { return { ...identity, responseEpoch: identity.responseEpoch + 1 }; },
      conversationId: 'conversation-1',
    },
    {
      name: 'conversation',
      mutateIdentity(identity) { return identity; },
      conversationId: 'different-conversation',
    },
  ]) {
    const hub = new FakeHub();
    const bridge = new BrowserBridge(hub);
    const { promise, prompt } = await startRequest(bridge, hub, { message: `mismatched ${mismatch.name} snapshot` });
    promise.catch(() => {});

    try {
      emitTabObservation(hub, {
        requestId: prompt.requestId,
        userTurnKey: `user-mismatched-${mismatch.name}`,
        assistantTurnKey: `assistant-mismatched-${mismatch.name}`,
        generation: 'active',
        outputState: 'none',
        finalMessage: false,
        stableForMs: 0,
      });
      const canonical = bridge.requestStateDiagnostics(prompt.requestId).state;
      const identity = mismatch.mutateIdentity({
        requestId: prompt.requestId,
        leaseId: canonical.source.leaseId,
        ownerServerInstanceId: canonical.source.ownerServerInstanceId,
        responseEpoch: canonical.response.epoch,
        submittedUserTurnKey: canonical.response.userTurnKey,
        assistantTurnKey: canonical.lastObservation.data.turnKey,
      });

      const snapshotPromise = bridge.requestForcedSnapshot(prompt.requestId, { reason: 'mismatched-inactive-generation-reconciliation' });
      await nextTick();
      const command = hub.sent.findLast((entry) => entry.payload.type === 'response.snapshot.request');
      sendCommandResult(hub, command, 'request.snapshot', {
        requestId: prompt.requestId,
        active: true,
        activeRequest: identity,
        session: { id: mismatch.conversationId },
        generating: false,
        answer: '',
        artifacts: [],
        turnKey: identity.assistantTurnKey,
      });
      await snapshotPromise;

      const after = bridge.requestStateDiagnostics(prompt.requestId);
      assert.equal(after.state.generation, 'active', `${mismatch.name} mismatch must fail closed`);
      assert.equal(after.state.terminal, null);
      assert.equal(after.deadlines.some((deadline) => deadline.kind === 'progress_liveness'), false);
    } finally {
      await bridge.close();
    }
  }
});

test('weak heartbeats do not count as meaningful request progress', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const { promise, prompt } = await startRequest(bridge, hub, { message: 'heartbeat only' });
  const before = bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId)?.lastMeaningfulProgressAt;
  assert.ok(before);

  await new Promise((resolve) => setTimeout(resolve, 15));
  hub.emit('client.activity', {
    clientId: 'client-1',
    client: { id: 'client-1', ready: true, activeRequest: { requestId: prompt.requestId } },
    payload: { type: 'pong', activeRequest: { requestId: prompt.requestId } },
  });
  const afterHeartbeat = bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId);
  assert.equal(afterHeartbeat.lastMeaningfulProgressAt, before);
  assert.ok(afterHeartbeat.lastHeartbeatAt >= before);

  emitTabObservation(hub, { requestId: prompt.requestId, answer: 'ok' });
  assert.equal((await promise).answer, 'ok');
  await bridge.close();
});

test('submitted request remains active when only weak heartbeats arrive', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  let heartbeatTimer = null;
  try {
    const { promise, prompt } = await startRequest(bridge, hub, { message: 'heartbeat starvation guard' });
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    heartbeatTimer = setInterval(() => {
      hub.emit('client.activity', {
        clientId: 'client-1',
        client: { id: 'client-1', ready: true, activeRequest: { requestId: prompt.requestId } },
        payload: { type: 'pong', activeRequest: { requestId: prompt.requestId } },
      });
    }, 5);
    await new Promise((resolve) => setTimeout(resolve, 325));

    const diagnostics = bridge.requestStateDiagnostics(prompt.requestId);
    assert.equal(settled, false, 'weak heartbeats must not stop a submitted request');
    assert.equal(diagnostics.deadlines.some((deadline) => deadline.kind === 'progress_liveness'), false);
    assert.equal(hub.sent.some((entry) => entry.payload.type === 'prompt.cancel'), false);

    emitTabObservation(hub, { requestId: prompt.requestId, answer: 'finished' });
    assert.equal((await promise).answer, 'finished');
  } finally {
    clearInterval(heartbeatTimer);
    await bridge.close();
  }
});

test('active generation is not cancelled by the meaningful-progress timeout', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const { promise, prompt } = await startRequest(bridge, hub, { message: 'long active generation' });
  emitTabObservation(hub, {
    requestId: prompt.requestId,
    generation: 'active',
    outputState: 'reasoning',
    thinking: 'Working',
    finalMessage: false,
    stableForMs: 0,
  });

  let settled = false;
  promise.finally(() => { settled = true; }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 175));
  assert.equal(settled, false);

  emitTabObservation(hub, { requestId: prompt.requestId, answer: 'finished' });
  assert.equal((await promise).answer, 'finished');
  await bridge.close();
});

test('stopped generation without final output remains active until source completion', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const { promise, prompt } = await startRequest(bridge, hub, { message: 'post-generation stall' });
  try {
    emitTabObservation(hub, {
      requestId: prompt.requestId,
      generation: 'stopped',
      outputState: 'final',
      finalMessage: false,
      stableForMs: 0,
    });
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });

    await new Promise((resolve) => setTimeout(resolve, 175));
    const diagnostics = bridge.requestStateDiagnostics(prompt.requestId);
    assert.equal(settled, false, 'missing terminal output must not expire the submitted request');
    assert.equal(diagnostics.deadlines.some((deadline) => deadline.kind === 'progress_liveness'), false);
    assert.equal(hub.sent.some((entry) => entry.payload.type === 'prompt.cancel'), false);

    emitTabObservation(hub, { requestId: prompt.requestId, answer: 'finished' });
    assert.equal((await promise).answer, 'finished');
  } finally {
    await bridge.close();
  }
});

test('extension implements source-bound forced snapshot command as a read-only effect', async () => {
  const source = await readExtensionContentRuntime();
  assert.match(source, /response\.snapshot\.request/);
  assert.match(source, /handleResponseSnapshotRequest/);
  assert.match(source, /readAssistantSnapshotByTurnKey/);
  assert.match(source, /No active request in this tab and no assistantTurnKey/);
  assert.doesNotMatch(source, /request\.terminal_snapshot|request\.terminal_failure/);
});

test('current TabObservation generation state overrides historical activity', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const { promise, prompt } = await startRequest(bridge, hub, { message: 'generation state transition' });
  emitTabObservation(hub, {
    requestId: prompt.requestId,
    generation: 'active',
    outputState: 'streaming',
    thinking: 'Working',
    finalMessage: false,
    stableForMs: 0,
  });
  assert.equal(bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId)?.currentGenerationActive, true);

  emitTabObservation(hub, {
    requestId: prompt.requestId,
    generation: 'stopped',
    outputState: 'streaming',
    thinking: 'Settling',
    finalMessage: false,
    stableForMs: 0,
  });
  assert.equal(bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId)?.currentGenerationActive, false);

  emitTabObservation(hub, { requestId: prompt.requestId, answer: 'ok' });
  assert.equal((await promise).answer, 'ok');
  await bridge.close();
});

test('unchanged forced snapshots do not reset meaningful progress', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const { promise, prompt } = await startRequest(bridge, hub, { message: 'stable partial output' });
  emitTabObservation(hub, {
    requestId: prompt.requestId,
    assistantTurnKey: 'assistant-stable',
    generation: 'active',
    outputState: 'streaming',
    answer: 'partial answer',
    finalMessage: false,
    stableForMs: 0,
  });
  const before = bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId)?.lastMeaningfulProgressAt;
  assert.ok(before);

  await new Promise((resolve) => setTimeout(resolve, 15));
  const snapshotPromise = bridge.requestForcedSnapshot(prompt.requestId, { reason: 'test-unchanged' });
  await nextTick();
  const command = hub.sent.findLast((entry) => entry.payload.type === 'response.snapshot.request');
  sendCommandResult(hub, command, 'request.snapshot', {
    requestId: prompt.requestId,
    answer: 'partial answer',
    artifacts: [],
    turnKey: 'assistant-stable',
    phase: 'generating',
    generating: true,
    stopButtonVisible: true,
    terminal: false,
  });
  await snapshotPromise;
  const after = bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId)?.lastMeaningfulProgressAt;
  assert.equal(after, before);

  emitTabObservation(hub, { requestId: prompt.requestId, assistantTurnKey: 'assistant-stable', answer: 'finished' });
  assert.equal((await promise).answer, 'finished');
  await bridge.close();
});

test('required ZIP output waits for a later artifact after a read-only snapshot clears stale partial output', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const events = [];
  const { promise, prompt } = await startRequest(bridge, hub, {
    message: 'project task with delayed ZIP',
    output: { expected: 'zip', required: true },
  }, { onEvent: (event) => events.push(event) });

  emitTabObservation(hub, {
    requestId: prompt.requestId,
    assistantTurnKey: 'assistant-delayed',
    generation: 'active',
    outputState: 'streaming',
    answer: 'Думаю',
    finalMessage: false,
    stableForMs: 0,
  });
  const snapshotPromise = bridge.requestForcedSnapshot(prompt.requestId, { reason: 'regression' });
  await nextTick();
  const command = hub.sent.findLast((entry) => entry.payload.type === 'response.snapshot.request');
  sendCommandResult(hub, command, 'request.snapshot', {
    requestId: prompt.requestId,
    answer: '',
    artifacts: [],
    turnKey: 'assistant-delayed',
    phase: 'ASSISTANT_PLACEHOLDER',
    generating: false,
    stopButtonVisible: false,
    terminal: false,
  });
  await snapshotPromise;
  assert.equal(bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId)?.answerLength, 0);

  emitTabObservation(hub, {
    requestId: prompt.requestId,
    assistantTurnKey: 'assistant-delayed',
    answer: 'Final project answer',
    artifacts: [],
  });
  await nextTick();
  let settled = false;
  promise.finally(() => { settled = true; }).catch(() => {});
  assert.equal(settled, false);
  assert.ok(events.some((event) => event.type === 'artifact.required_wait_started'));

  emitTabObservation(hub, {
    requestId: prompt.requestId,
    assistantTurnKey: 'assistant-delayed',
    answer: 'Final project answer',
    artifacts: [{ id: 'artifact-delayed', name: 'updated-project.zip', phase: 'READY', downloadActionPresent: true }],
  });
  const result = await promise;
  assert.equal(result.artifacts[0].id, 'artifact-delayed');
  assert.ok(events.some((event) => event.type === 'artifact.required_wait_satisfied'));
  await bridge.close();
});

test('required ZIP output accepts a READY action whose display title identifies a ZIP', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const events = [];
  const { promise, prompt } = await startRequest(bridge, hub, {
    message: 'return the updated project ZIP',
    output: { expected: 'zip', required: true },
  }, { onEvent: (event) => events.push(event) });
  emitTabObservation(hub, {
    requestId: prompt.requestId,
    answer: 'The updated project is ready.',
    artifacts: [{
      id: 'display-title-zip',
      name: 'Download the updated project ZIP',
      actionLabel: 'Download the updated project ZIP',
      blockText: 'Download the updated project ZIP',
      phase: 'READY',
      downloadActionPresent: true,
    }],
  });
  const result = await promise;
  assert.equal(result.artifacts[0].id, 'display-title-zip');
  assert.equal(events.some((event) => event.type === 'artifact.required_wait_started'), false);
  await bridge.close();
});

test('required ZIP output accepts one scoped extensionless localized action', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const { promise, prompt } = await startRequest(bridge, hub, {
    message: 'return the full updated project archive',
    output: { expected: 'zip', required: true },
  });
  emitTabObservation(hub, {
    requestId: prompt.requestId,
    assistantTurnKey: 'assistant-extensionless',
    answer: 'Готово.',
    artifacts: [{
      id: 'artifact-extensionless',
      requestId: prompt.requestId,
      sourceTurnKey: 'assistant-extensionless',
      name: 'Скачать полный обновлённый проект',
      actionLabel: 'Скачать полный обновлённый проект',
      blockText: 'Изменения: добавлен result.txt. Скачать полный обновлённый проект',
      kind: 'action',
      phase: 'READY',
      downloadActionPresent: true,
    }],
  });
  const result = await promise;
  assert.equal(result.artifacts[0].id, 'artifact-extensionless');
  await bridge.close();
});

test('required generic file output waits for a real artifact', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const events = [];
  const { promise, prompt } = await startRequest(bridge, hub, {
    message: 'create a downloadable text file',
    output: { expected: 'file', required: true },
  }, { onEvent: (event) => events.push(event) });

  emitTabObservation(hub, { requestId: prompt.requestId, answer: 'The file is ready', artifacts: [] });
  await nextTick();
  let settled = false;
  promise.finally(() => { settled = true; }).catch(() => {});
  assert.equal(settled, false);
  assert.equal(events.find((event) => event.type === 'artifact.required_wait_started')?.expected, 'file');

  emitTabObservation(hub, {
    requestId: prompt.requestId,
    answer: 'The file is ready',
    artifacts: [{ id: 'artifact-text', name: 'result.txt', phase: 'READY', downloadActionPresent: true }],
  });
  const result = await promise;
  assert.equal(result.artifacts[0].name, 'result.txt');
  assert.equal(events.find((event) => event.type === 'artifact.required_wait_satisfied')?.expected, 'file');
  await bridge.close();
});

test('progress item changes are projected even when aggregate progress text is unchanged', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const events = [];
  const { promise, prompt } = await startRequest(
    bridge,
    hub,
    { message: 'show steps' },
    { onEvent: (event) => events.push(event) },
  );
  emitTabObservation(hub, {
    requestId: prompt.requestId,
    generation: 'active',
    outputState: 'streaming',
    progress: 'Working',
    progressItems: [{ key: 'one', kind: 'tool_status', text: 'Inspecting archive', active: true }],
    finalMessage: false,
    stableForMs: 0,
  });
  emitTabObservation(hub, {
    requestId: prompt.requestId,
    generation: 'active',
    outputState: 'streaming',
    progress: 'Working',
    progressItems: [{ key: 'two', kind: 'tool_status', text: 'Running tests', active: true }],
    finalMessage: false,
    stableForMs: 0,
  });
  emitTabObservation(hub, { requestId: prompt.requestId, answer: 'done' });
  await promise;
  const progressEvents = events.filter(
    (event) => event.type === 'assistant.progress.snapshot' && event.items.length > 0,
  );
  assert.equal(progressEvents.length, 2);
  assert.equal(progressEvents[0].items[0].text, 'Inspecting archive');
  assert.equal(progressEvents[1].items[0].text, 'Running tests');
  await bridge.close();
});

test('required ZIP output ignores a non-ZIP artifact and uses bounded probe scheduling', async () => {
  const hub = new FakeHub();
  const bridge = new BrowserBridge(hub);
  const events = [];
  const { promise, prompt } = await startRequest(bridge, hub, {
    message: 'create one ZIP archive',
    output: { expected: 'zip', required: true },
  }, { onEvent: (event) => events.push(event) });

  emitTabObservation(hub, { requestId: prompt.requestId, answer: 'The archive is ready', artifacts: [] });
  await nextTick();
  const firstProbe = events.find((event) => event.type === 'artifact.required_probe_scheduled');
  assert.equal(firstProbe?.attempt, 1);
  assert.equal(firstProbe?.delayMs, 500);

  let settled = false;
  promise.finally(() => { settled = true; }).catch(() => {});
  emitTabObservation(hub, {
    requestId: prompt.requestId,
    answer: 'The archive is ready',
    artifacts: [{ id: 'wrong-text', name: 'alpha.txt', phase: 'READY', downloadActionPresent: true }],
  });
  await nextTick();
  assert.equal(settled, false);

  emitTabObservation(hub, {
    requestId: prompt.requestId,
    answer: 'The archive is ready',
    artifacts: [
      { id: 'wrong-text', name: 'alpha.txt', phase: 'READY', downloadActionPresent: true },
      { id: 'right-zip', name: 'bundle.zip', phase: 'READY', downloadActionPresent: true },
    ],
  });
  const result = await promise;
  assert.equal(result.artifacts.some((artifact) => artifact.name === 'bundle.zip'), true);
  assert.ok(events.some((event) => event.type === 'artifact.required_wait_satisfied'));
  await bridge.close();
});
