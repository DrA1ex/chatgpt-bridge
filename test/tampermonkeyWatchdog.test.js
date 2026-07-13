import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

process.env.FORCED_SNAPSHOT_AFTER_MS = process.env.FORCED_SNAPSHOT_AFTER_MS || '60000';
process.env.REQUEST_WATCHDOG_INTERVAL_MS = process.env.REQUEST_WATCHDOG_INTERVAL_MS || '25';
process.env.REQUEST_MEANINGFUL_PROGRESS_TIMEOUT_MS = process.env.REQUEST_MEANINGFUL_PROGRESS_TIMEOUT_MS || '100';
process.env.REQUEST_POST_GENERATION_PROGRESS_TIMEOUT_MS = process.env.REQUEST_POST_GENERATION_PROGRESS_TIMEOUT_MS || '60';
process.env.REQUEST_GENERATION_ACTIVITY_GRACE_MS = process.env.REQUEST_GENERATION_ACTIVITY_GRACE_MS || '10';
process.env.REQUIRED_ARTIFACT_SETTLE_MS = process.env.REQUIRED_ARTIFACT_SETTLE_MS || '120';

const { TampermonkeyBridge } = await import('../src/tampermonkeyBridge.js');

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
    this.sent.push({ clientId: this.activeClient.id, payload });
    return { client: this.activeClient, delivered: Promise.resolve() };
  }
  sendToActive(payload) {
    this.sent.push({ clientId: this.activeClient.id, payload });
    return this.activeClient;
  }
  sendToClient(clientId, payload) {
    this.sent.push({ clientId, payload });
    return this.readyClients.get(clientId) || { id: clientId, ready: true };
  }
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('forced snapshots are requested from the source client, not the active client', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);
  const events = [];

  const requestPromise = bridge.sendRequest({ message: 'long project task' }, { onEvent: (event) => events.push(event) });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'request.progress', requestId: prompt.requestId, phase: 'generating', meaningful: true, assistantTurnKey: 'assistant-source', sawGenerating: true, stopButtonVisible: true } });

  hub.activeClient = { id: 'client-2', ready: true, url: 'https://chatgpt.com/other' };
  const snapshotPromise = bridge.requestForcedSnapshot(prompt.requestId, { reason: 'test' });
  await nextTick();

  const command = hub.sent.find((entry) => entry.payload.type === 'response.snapshot.request');
  assert.ok(command, 'response.snapshot.request should be sent');
  assert.equal(command.clientId, 'client-1');
  assert.equal(command.payload.turnKey, 'assistant-source');

  hub.emit('client.message', { clientId: 'client-2', payload: { type: 'request.snapshot', commandId: command.payload.commandId, requestId: prompt.requestId, answer: 'wrong active tab', terminal: true } });
  await nextTick();
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'request.snapshot', commandId: command.payload.commandId, requestId: prompt.requestId, answer: 'right source tab', artifacts: [], turnKey: 'assistant-source', terminal: true } });

  const snapshot = await snapshotPromise;
  assert.equal(snapshot.answer, 'right source tab');
  const result = await requestPromise;
  assert.equal(result.answer, 'right source tab');
  assert.equal(result.finishReason, 'forced_snapshot');
  assert.ok(events.some((event) => event.type === 'forced_snapshot.requested'));
  assert.ok(events.some((event) => event.type === 'forced_snapshot.received'));
});

test('weak heartbeats do not count as meaningful request progress', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);

  const requestPromise = bridge.sendRequest({ message: 'heartbeat only' });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  const before = bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId)?.lastMeaningfulProgressAt;
  assert.ok(before);

  await new Promise((resolve) => setTimeout(resolve, 15));
  hub.emit('client.activity', {
    clientId: 'client-1',
    client: { id: 'client-1', ready: true, activeRequest: { requestId: prompt.requestId, phase: 'generating', sawGenerating: true } },
    payload: { type: 'pong', activeRequest: { requestId: prompt.requestId, phase: 'generating', sawGenerating: true } },
  });
  const afterHeartbeat = bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId);
  assert.equal(afterHeartbeat.lastMeaningfulProgressAt, before);
  assert.ok(afterHeartbeat.lastHeartbeatAt >= before);

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'done', requestId: prompt.requestId, answer: 'ok' } });
  const result = await requestPromise;
  assert.equal(result.answer, 'ok');
});

test('frequent weak heartbeats cannot postpone the meaningful-progress watchdog forever', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);
  let heartbeatTimer = null;
  try {
    const requestPromise = bridge.sendRequest({ message: 'heartbeat starvation guard' });
    await nextTick();
    const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
    assert.ok(prompt);
    hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });

    heartbeatTimer = setInterval(() => {
      hub.emit('client.activity', {
        clientId: 'client-1',
        client: { id: 'client-1', ready: true, activeRequest: { requestId: prompt.requestId, phase: 'waiting_for_assistant_turn', generating: false, stopButtonVisible: false } },
        payload: { type: 'pong', activeRequest: { requestId: prompt.requestId, phase: 'waiting_for_assistant_turn', generating: false, stopButtonVisible: false } },
      });
    }, 5);

    await assert.rejects(requestPromise, /Timed out waiting for ChatGPT request progress/);
  } finally {
    clearInterval(heartbeatTimer);
  }
});



test('active generation is not cancelled by the meaningful-progress timeout', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);

  const requestPromise = bridge.sendRequest({ message: 'long active generation' });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'request.progress',
      requestId: prompt.requestId,
      phase: 'assistant_reasoning',
      meaningful: true,
      generating: true,
      stopButtonVisible: true,
      sawGenerating: true,
    },
  });

  let settled = false;
  requestPromise.finally(() => { settled = true; }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 175));
  assert.equal(settled, false, 'an actively generating request may outlive the non-generating idle timeout');

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'done', requestId: prompt.requestId, answer: 'finished' } });
  assert.equal((await requestPromise).answer, 'finished');
});



test('post-generation phases use the shorter pipeline watchdog instead of the long result watchdog', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);

  const requestPromise = bridge.sendRequest({ message: 'post-generation stall' });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'request.progress',
      requestId: prompt.requestId,
      phase: 'post_stop_settle',
      meaningful: true,
      generating: false,
      stopButtonVisible: false,
    },
  });

  const started = Date.now();
  await assert.rejects(requestPromise, /Timed out waiting for ChatGPT request progress/);
  assert.ok(Date.now() - started < 100, 'post-generation timeout should be shorter than the general result timeout');
});
test('extension implements source-bound forced snapshot command', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  assert.match(source, /response\.snapshot\.request/);
  assert.match(source, /handleResponseSnapshotRequest/);
  assert.match(source, /readAssistantSnapshotByTurnKey/);
  assert.match(source, /No active request in this tab and no assistantTurnKey/);
});

test('historical sawGenerating does not keep generation active after current signals stop', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);

  const requestPromise = bridge.sendRequest({ message: 'generation state transition' });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.activity', {
    clientId: 'client-1',
    client: { id: 'client-1', ready: true, activeRequest: { requestId: prompt.requestId, phase: 'generating', sawGenerating: true, generating: true, stopButtonVisible: true } },
    payload: { type: 'pong', activeRequest: { requestId: prompt.requestId, phase: 'generating', sawGenerating: true, generating: true, stopButtonVisible: true } },
  });
  assert.equal(bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId)?.currentGenerationActive, true);

  hub.emit('client.activity', {
    clientId: 'client-1',
    client: { id: 'client-1', ready: true, activeRequest: { requestId: prompt.requestId, phase: 'post_stop_settle', sawGenerating: true, generating: false, stopButtonVisible: false } },
    payload: { type: 'pong', activeRequest: { requestId: prompt.requestId, phase: 'post_stop_settle', sawGenerating: true, generating: false, stopButtonVisible: false } },
  });
  assert.equal(bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId)?.currentGenerationActive, false);

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'done', requestId: prompt.requestId, answer: 'ok' } });
  assert.equal((await requestPromise).answer, 'ok');
});

test('unchanged forced snapshots do not reset meaningful progress', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);

  const requestPromise = bridge.sendRequest({ message: 'stable partial output' });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'answer.snapshot', requestId: prompt.requestId, text: 'partial answer' } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'request.progress', requestId: prompt.requestId, phase: 'generating', meaningful: true, assistantTurnKey: 'assistant-stable', generating: true, stopButtonVisible: true } });
  const before = bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId)?.lastMeaningfulProgressAt;
  assert.ok(before);

  await new Promise((resolve) => setTimeout(resolve, 15));
  const snapshotPromise = bridge.requestForcedSnapshot(prompt.requestId, { reason: 'test-unchanged' });
  await nextTick();
  const command = hub.sent.findLast((entry) => entry.payload.type === 'response.snapshot.request');
  assert.ok(command);
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'request.snapshot',
      commandId: command.payload.commandId,
      requestId: prompt.requestId,
      answer: 'partial answer',
      artifacts: [],
      turnKey: 'assistant-stable',
      phase: 'generating',
      generating: true,
      stopButtonVisible: true,
      terminal: false,
    },
  });
  await snapshotPromise;

  const after = bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId)?.lastMeaningfulProgressAt;
  assert.equal(after, before);

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'done', requestId: prompt.requestId, answer: 'finished' } });
  assert.equal((await requestPromise).answer, 'finished');
});


test('forced snapshot clears stale partial answer and required ZIP waits for a later artifact', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);
  const events = [];

  const requestPromise = bridge.sendRequest({
    message: 'project task with delayed ZIP',
    output: { expected: 'zip', required: true },
  }, { onEvent: (event) => events.push(event) });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);
  assert.deepEqual(prompt.options.expectedOutput, { expected: 'zip', required: true });

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'answer.snapshot', requestId: prompt.requestId, text: 'Думаю' } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'request.progress', requestId: prompt.requestId, phase: 'assistant_reasoning', meaningful: true, assistantTurnKey: 'assistant-delayed', generating: true, stopButtonVisible: true } });

  const snapshotPromise = bridge.requestForcedSnapshot(prompt.requestId, { reason: 'regression' });
  await nextTick();
  const command = hub.sent.findLast((entry) => entry.payload.type === 'response.snapshot.request');
  assert.ok(command);
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'request.snapshot',
      commandId: command.payload.commandId,
      requestId: prompt.requestId,
      answer: '',
      artifacts: [],
      turnKey: 'assistant-delayed',
      phase: 'ASSISTANT_PLACEHOLDER',
      generating: false,
      stopButtonVisible: false,
      terminal: true,
    },
  });
  await snapshotPromise;

  let settled = false;
  requestPromise.finally(() => { settled = true; }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, 'empty nonterminal data must not complete from the stale partial answer');
  assert.equal(bridge.requestDiagnostics().find((item) => item.requestId === prompt.requestId)?.answerLength, 0);

  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'done',
      requestId: prompt.requestId,
      answer: 'Final project answer',
      artifacts: [],
      turnKey: 'assistant-delayed',
      terminal: true,
    },
  });
  await nextTick();
  assert.equal(settled, false, 'required ZIP contract must defer a text-only done message');
  assert.ok(events.some((event) => event.type === 'artifact.required_wait_started'));

  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'artifact.snapshot',
      requestId: prompt.requestId,
      artifacts: [{ id: 'artifact-delayed', name: 'updated-project.zip', phase: 'READY', downloadActionPresent: true }],
    },
  });

  const result = await requestPromise;
  assert.equal(result.answer, 'Final project answer');
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].id, 'artifact-delayed');
  assert.ok(events.some((event) => event.type === 'artifact.required_wait_satisfied'));
});



test('required ZIP output accepts one READY action whose display title semantically identifies a ZIP', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);
  const events = [];

  const requestPromise = bridge.sendRequest({
    message: 'return the updated project ZIP',
    output: { expected: 'zip', required: true },
  }, { onEvent: (event) => events.push(event) });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'done',
      requestId: prompt.requestId,
      answer: 'The updated project is ready.',
      terminal: true,
      artifacts: [{
        id: 'display-title-zip',
        name: 'Download the updated project ZIP',
        actionLabel: 'Download the updated project ZIP',
        blockText: 'Download the updated project ZIP',
        phase: 'READY',
        downloadActionPresent: true,
      }],
    },
  });

  const result = await requestPromise;
  assert.equal(result.artifacts[0].id, 'display-title-zip');
  assert.equal(events.some((event) => event.type === 'artifact.required_wait_started'), false);
});


test('required ZIP output accepts one scoped extensionless localized download action without a settle delay', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);
  const events = [];

  const requestPromise = bridge.sendRequest({
    message: 'return the full updated project archive',
    output: { expected: 'zip', required: true },
  }, { onEvent: (event) => events.push(event) });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'done',
      requestId: prompt.requestId,
      answer: 'Готово.',
      turnKey: 'assistant-extensionless',
      terminal: true,
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
    },
  });

  const result = await requestPromise;
  assert.equal(result.artifacts[0].id, 'artifact-extensionless');
  assert.equal(events.some((event) => event.type === 'artifact.required_wait_started'), false);
});

test('required generic file output waits for a real artifact before completing', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);
  const events = [];

  const requestPromise = bridge.sendRequest({
    message: 'create a downloadable text file',
    output: { expected: 'file', required: true },
  }, { onEvent: (event) => events.push(event) });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);
  assert.deepEqual(prompt.options.expectedOutput, { expected: 'file', required: true });

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: { type: 'done', requestId: prompt.requestId, answer: 'The file is ready', artifacts: [], terminal: true },
  });

  let settled = false;
  requestPromise.finally(() => { settled = true; }).catch(() => {});
  await nextTick();
  assert.equal(settled, false, 'required generic file must defer a text-only done message');
  assert.equal(events.find((event) => event.type === 'artifact.required_wait_started')?.expected, 'file');

  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'artifact.snapshot',
      requestId: prompt.requestId,
      artifacts: [{ id: 'artifact-text', name: 'result.txt', phase: 'READY', downloadActionPresent: true }],
    },
  });

  const result = await requestPromise;
  assert.equal(result.artifacts[0].name, 'result.txt');
  assert.equal(events.find((event) => event.type === 'artifact.required_wait_satisfied')?.expected, 'file');
});

test('progress item changes are emitted even when the aggregate progress text is unchanged', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);
  const events = [];
  const requestPromise = bridge.sendRequest({ message: 'show steps' }, { onEvent: (event) => events.push(event) });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });

  hub.emit('client.message', { clientId: 'client-1', payload: {
    type: 'assistant.progress.snapshot', requestId: prompt.requestId, text: 'Working',
    items: [{ key: 'one', kind: 'tool_status', text: 'Inspecting archive', active: true }],
  } });
  hub.emit('client.message', { clientId: 'client-1', payload: {
    type: 'assistant.progress.snapshot', requestId: prompt.requestId, text: 'Working',
    items: [{ key: 'two', kind: 'tool_status', text: 'Running tests', active: true }],
  } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'done', requestId: prompt.requestId, answer: 'done' } });
  await requestPromise;

  const progressEvents = events.filter((event) => event.type === 'assistant.progress.snapshot');
  assert.equal(progressEvents.length, 2);
  assert.equal(progressEvents[0].items[0].text, 'Inspecting archive');
  assert.equal(progressEvents[1].items[0].text, 'Running tests');
});

test('required ZIP output ignores a non-ZIP artifact and uses bounded probe scheduling', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);
  const events = [];

  const requestPromise = bridge.sendRequest({
    message: 'create one ZIP archive',
    output: { expected: 'zip', required: true },
  }, { onEvent: (event) => events.push(event) });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: { type: 'done', requestId: prompt.requestId, answer: 'The archive is ready', artifacts: [], terminal: true },
  });
  await nextTick();

  const firstProbe = events.find((event) => event.type === 'artifact.required_probe_scheduled');
  assert.equal(firstProbe?.attempt, 1);
  assert.equal(firstProbe?.delayMs, 500);

  let settled = false;
  requestPromise.finally(() => { settled = true; }).catch(() => {});
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'artifact.snapshot',
      requestId: prompt.requestId,
      artifacts: [{ id: 'wrong-text', name: 'alpha.txt', phase: 'READY', downloadActionPresent: true }],
    },
  });
  await nextTick();
  assert.equal(settled, false, 'a READY text file must not satisfy a required ZIP contract');

  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'artifact.snapshot',
      requestId: prompt.requestId,
      artifacts: [
        { id: 'wrong-text', name: 'alpha.txt', phase: 'READY', downloadActionPresent: true },
        { id: 'right-zip', name: 'bundle.zip', phase: 'READY', downloadActionPresent: true },
      ],
    },
  });

  const result = await requestPromise;
  assert.equal(result.artifacts.some((artifact) => artifact.name === 'bundle.zip'), true);
  assert.ok(events.some((event) => event.type === 'artifact.required_wait_satisfied'));
});
