import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TampermonkeyBridge } from '../src/tampermonkeyBridge.js';
import { TampermonkeyHub } from '../src/tampermonkeyHub.js';
import { FileStore } from '../src/fileStore.js';

class FakeHub extends EventEmitter {
  constructor() {
    super();
    this.activeClient = { id: 'client-1', url: 'https://chatgpt.com/' };
    this.sent = [];
  }
  get clients() { return [{ id: 'client-1', url: 'https://chatgpt.com/' }]; }
  get selectedClientId() { return ''; }
  get needsSelection() { return false; }
  get debugEvents() { return []; }
  sendToActive(payload) {
    this.sent.push({ clientId: 'client-1', payload });
    return this.activeClient;
  }
  sendToClient(clientId, payload) {
    this.sent.push({ clientId, payload });
    return { id: clientId, url: `https://chatgpt.com/${clientId}` };
  }
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('TampermonkeyBridge resolves stored attachments as local URLs instead of base64 by default', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-file-store-'));
  const fileStore = new FileStore(dir);
  const stored = await fileStore.putUpload({ name: 'project.zip', mime: 'application/zip', content: 'zip-bytes' });
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub, fileStore);

  const promise = bridge.sendRequest({ message: 'hello', attachments: [stored.id] });
  await nextTick();

  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt, 'prompt.send should be sent');
  assert.equal(prompt.attachments.length, 1);
  assert.equal(prompt.attachments[0].name, 'project.zip');
  assert.match(prompt.attachments[0].url, /\/tm\/files\/file_.*\/download\?token=/);
  assert.equal(prompt.attachments[0].contentBase64, undefined);

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'done', requestId: prompt.requestId, answer: 'ok' } });
  const result = await promise;
  assert.equal(result.answer, 'ok');
});

test('TampermonkeyBridge stores artifact downloads from chunked userscript messages', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-artifact-store-'));
  const fileStore = new FileStore(dir);
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub, fileStore);

  const requestPromise = bridge.sendRequest({ message: 'make artifact' });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);

  const artifact = { id: 'artifact_zip', kind: 'file', name: 'result.zip', mime: 'application/zip', downloadUrl: 'blob:https://chatgpt.com/result' };
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'artifact.snapshot', requestId: prompt.requestId, artifacts: [artifact] } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'done', requestId: prompt.requestId, answer: 'done', artifacts: [artifact] } });
  await requestPromise;

  const fetchPromise = bridge.fetchArtifact('artifact_zip');
  await nextTick();
  const command = hub.sent.find((entry) => entry.payload.type === 'artifact.fetch')?.payload;
  assert.ok(command, 'artifact.fetch command should be sent');

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'artifact.data.started', commandId: command.commandId, artifactId: 'artifact_zip', name: 'result.zip', mime: 'application/zip', totalChunks: 2 } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'artifact.data.chunk', commandId: command.commandId, artifactId: 'artifact_zip', index: 0, contentBase64: 'aGVs' } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'artifact.data.chunk', commandId: command.commandId, artifactId: 'artifact_zip', index: 1, contentBase64: 'bG8=' } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'artifact.data.done', commandId: command.commandId, artifactId: 'artifact_zip', name: 'result.zip', mime: 'application/zip' } });

  const stored = await fetchPromise;
  assert.equal(stored.id, 'artifact_zip');
  const readable = await fileStore.getReadable(stored.id);
  assert.ok(readable);
  const bytes = await fs.readFile(readable.absolutePath, 'utf8');
  assert.equal(bytes, 'hello');
});


test('TampermonkeyBridge routes artifact fetch to artifact source client instead of active client', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-source-client-artifact-'));
  const fileStore = new FileStore(dir);
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub, fileStore);

  const requestPromise = bridge.sendRequest({ message: 'make artifact' });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);

  const artifact = { id: 'source-artifact', kind: 'file', name: 'result.txt', mime: 'text/plain' };
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'done', requestId: prompt.requestId, answer: 'done', artifacts: [artifact] } });
  await requestPromise;

  hub.activeClient = { id: 'client-2', url: 'https://chatgpt.com/other' };
  const fetchPromise = bridge.fetchArtifact('source-artifact');
  await nextTick();

  const command = hub.sent.find((entry) => entry.payload.type === 'artifact.fetch')
  assert.ok(command, 'artifact.fetch command should be sent');
  assert.equal(command.clientId, 'client-1');

  hub.emit('client.message', { clientId: 'client-2', payload: { type: 'artifact.data.done', commandId: command.payload.commandId, artifactId: 'source-artifact', name: 'wrong.txt', mime: 'text/plain', contentBase64: Buffer.from('wrong').toString('base64') } });
  await nextTick();
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'artifact.data.done', commandId: command.payload.commandId, artifactId: 'source-artifact', name: 'result.txt', mime: 'text/plain', contentBase64: Buffer.from('right').toString('base64') } });

  const stored = await fetchPromise;
  const readable = await fileStore.getReadable(stored.id);
  assert.equal(await fs.readFile(readable.absolutePath, 'utf8'), 'right');
});

test('TampermonkeyBridge routes turnKey recovery to requested source client', async () => {
  const hub = new FakeHub();
  hub.activeClient = { id: 'client-2', url: 'https://chatgpt.com/other' };
  const bridge = new TampermonkeyBridge(hub);

  const promise = bridge.recoverResponseByTurnKey({ requestId: 'turn-source', turnKey: 'assistant-source', sourceClientId: 'client-1', timeoutMs: 1000 });
  await nextTick();

  const command = hub.sent.find((entry) => entry.payload.type === 'response.recover.turnKey');
  assert.ok(command, 'recovery command should be sent');
  assert.equal(command.clientId, 'client-1');

  hub.emit('client.message', { clientId: 'client-2', payload: { type: 'response.recovered', commandId: command.payload.commandId, answer: 'wrong', turnKey: 'assistant-source' } });
  await nextTick();
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'response.recovered', commandId: command.payload.commandId, answer: 'right', turnKey: 'assistant-source', artifacts: [] } });

  const response = await promise;
  assert.equal(response.answer, 'right');
  assert.equal(response.sourceClientId, 'client-1');
});

test('extension runtime contains reliability hardening for chunks, nonce, upload completion, and request timeout warnings', async () => {
  const source = await fs.readFile(new URL('../tools/chrome-bridge-extension/content.js', import.meta.url), 'utf8');
  assert.match(source, /artifact\.data\.chunk/);
  assert.match(source, /HOOK_NONCE/);
  assert.match(source, /file\.upload\.complete/);
  assert.match(source, /request\.max_timeout_warning/);
  assert.doesNotMatch(source, /REQUEST_MAX_TIMEOUT after/);
  assert.match(source, /COMPOSER_TEXT_VERIFY_FAILED/);
  assert.match(source, /GM_xmlhttpRequest/);
  assert.match(source, /cgb-close/);
  assert.match(source, /cgb-dot/);
  assert.match(source, /cgb-loading/);
  assert.match(source, /sendCritical/);
  assert.match(source, /\/diagnostics/);
  assert.match(source, /connectExtensionTransport/);
  assert.match(source, /connectExtensionTransport/);
  assert.match(source, /@noframes/);
  assert.match(source, /window\.top !== window\.self/);
  assert.match(source, /send\(\{ type: 'prompt\.accepted', requestId \}, \{ priority: true, immediatePost: true, timeout: 5_000 \}\)/);
  assert.doesNotMatch(source, /await\s+sendCritical\(\{ type: 'prompt\.accepted'/);
  assert.match(source, /border-radius:999px/);
  assert.doesNotMatch(source, /#cgb-tab::before/);
  assert.match(source, /chatgptBrowserBridgeCompanionInstance/);
  assert.match(source, /chatgptBridgeTabClientId/);
  assert.match(source, /sessionStorage\.getItem\(CLIENT_ID_STORAGE_KEY\)/);
  assert.doesNotMatch(source, /localStorage\.getItem\(CLIENT_ID_STORAGE_KEY\)/);
  assert.match(source, /collectArtifactsForAssistantNode/);
  assert.match(source, /readAssistantVisibleBlocks/);
  assert.match(source, /assistant\.progress\.snapshot/);
  assert.match(source, /isZipLikeLabel/);
  assert.match(source, /artifactActionSignal/);
  assert.match(source, /artifactFileName/);
  assert.match(source, /artifactState/);
  assert.match(source, /artifactActionCandidateScore/);
  assert.match(source, /isBrowserOnlyArtifactUrl/);

  const bridgeSource = await fs.readFile(new URL('../src/tampermonkeyBridge.js', import.meta.url), 'utf8');
  assert.doesNotMatch(bridgeSource, /prompt\.accepted\.timeout/);
  assert.doesNotMatch(bridgeSource, /startAcceptedTimer/);
  assert.doesNotMatch(bridgeSource, /Timed out waiting for ChatGPT answer after/);
  assert.match(bridgeSource, /Timed out waiting for ChatGPT request progress after/);
  assert.match(bridgeSource, /lastActivityReason/);
  assert.match(bridgeSource, /#handleClientActivity/);
  assert.match(bridgeSource, /client\.activeRequest/);
  assert.match(bridgeSource, /forced_snapshot\.requested/);
  assert.match(bridgeSource, /response\.snapshot\.request/);
  assert.match(bridgeSource, /watchdog\.meaningful_progress_stalled/);

  const extensionBackgroundSource = await fs.readFile(new URL('../tools/chrome-bridge-extension/background.js', import.meta.url), 'utf8');
  assert.match(extensionBackgroundSource, /new WebSocket/);
  assert.match(extensionBackgroundSource, /chrome\.runtime\.onConnect/);

  const hubSource = await fs.readFile(new URL('../src/tampermonkeyHub.js', import.meta.url), 'utf8');
  assert.match(hubSource, /isAllowedExtensionOrigin/);
  assert.match(hubSource, /pruneQueuedPings/);
  assert.match(hubSource, /isWsLikeTransport/);
  assert.match(hubSource, /client\?\.transport === 'extension'/);
  assert.match(hubSource, /transport: client\.transport \|\| 'websocket'/);
  assert.match(hubSource, /client\.ready && client\.poll/);
  assert.match(hubSource, /client\.activity/);
  assert.match(hubSource, /activeRequest/);
});


test('TampermonkeyBridge treats later request events as implicit prompt acceptance', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);
  const events = [];

  const promise = bridge.sendRequest({ message: 'hello without explicit ack' }, { onEvent: (event) => events.push(event) });
  await nextTick();

  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt, 'prompt.send should be sent');

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'status', requestId: prompt.requestId, status: 'sent' } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'done', requestId: prompt.requestId, answer: 'ok' } });

  const result = await promise;
  assert.equal(result.answer, 'ok');
  assert.ok(events.find((event) => event.type === 'prompt.accepted' && event.implicit && event.via === 'status'));
});


test('TampermonkeyHub HTTP polling transport queues commands and receives events', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-polling-'));
  const fileStore = new FileStore(dir);
  const hub = new TampermonkeyHub();
  const bridge = new TampermonkeyBridge(hub, fileStore);
  const clientId = 'poll-client-1';

  const registered = hub.registerPollingClient({
    type: 'hello',
    clientId,
    url: 'https://chatgpt.com/',
    title: 'ChatGPT',
    capabilities: { pollingTransport: true },
  });
  assert.equal(registered.transport, 'polling');

  const events = [];
  const promise = bridge.sendRequest({ message: 'hello over polling' }, { onEvent: (event) => events.push(event) });
  await nextTick();

  const poll = await hub.poll(clientId);
  await nextTick();
  const prompt = poll.commands.find((command) => command.type === 'prompt.send');
  assert.ok(prompt);
  assert.equal(prompt.message, 'hello over polling');
  assert.ok(events.find((event) => event.type === 'prompt.delivered'), 'prompt.delivered should be emitted after the polling command is drained');

  hub.receivePollingPayload(clientId, { type: 'prompt.accepted', requestId: prompt.requestId });
  hub.receivePollingPayload(clientId, { type: 'thinking.snapshot', requestId: prompt.requestId, text: 'thinking' });
  hub.receivePollingPayload(clientId, { type: 'answer.snapshot', requestId: prompt.requestId, text: 'answer' });
  hub.receivePollingPayload(clientId, { type: 'done', requestId: prompt.requestId, answer: 'answer', thinking: 'thinking' });

  const result = await promise;
  assert.equal(result.answer, 'answer');
  assert.equal(result.thinking, 'thinking');
  assert.equal(bridge.health().clients[0].transport, 'polling');
});

test('TampermonkeyBridge stores request.progress diagnostics for active requests', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);
  const events = [];

  const promise = bridge.sendRequest({ message: 'progress task' }, { onEvent: (event) => events.push(event) });
  await nextTick();

  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt, 'prompt.send should be sent');

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.message', {
    clientId: 'client-1',
    payload: {
      type: 'request.progress',
      requestId: prompt.requestId,
      phase: 'generating',
      meaningful: true,
      submittedUserTurnKey: 'user-1',
      assistantTurnKey: 'assistant-1',
      answerLength: 42,
      thinkingLength: 100,
      artifactCount: 1,
      anchorConfidence: 'high',
      anchorReason: 'assistant_after_submitted_user',
      visibilityState: 'hidden',
      focused: false,
      stopButtonVisible: true,
    },
  });

  const diagnostics = bridge.requestDiagnostics();
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].requestId, prompt.requestId);
  assert.equal(diagnostics[0].phase, 'generating');
  assert.equal(diagnostics[0].assistantTurnKey, 'assistant-1');
  assert.equal(diagnostics[0].answerLength, 0, 'server-side answer text should still come from answer.snapshot/done');
  assert.equal(diagnostics[0].lastProgressEvent.answerLength, 42);
  assert.equal(diagnostics[0].visibilityState, 'hidden');

  assert.ok(events.some((event) => event.type === 'request.progress' && event.phase === 'generating'));

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'done', requestId: prompt.requestId, answer: 'finished' } });
  const result = await promise;
  assert.equal(result.answer, 'finished');
});

test('extension content script contains request progress and phase observability', async () => {
  const source = await fs.readFile(new URL('../tools/chrome-bridge-extension/content.js', import.meta.url), 'utf8');
  assert.match(source, /request\.progress/);
  assert.match(source, /emitRequestProgress/);
  assert.match(source, /setRequestPhase/);
  assert.match(source, /assistant_turn\.captured/);
  assert.match(source, /user_turn\.captured/);
  assert.match(source, /lastMeaningfulProgressAt/);
  assert.match(source, /anchorConfidence/);
});

test('TampermonkeyBridge forwards visible progress snapshots and returns final progress text', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);
  const progress = [];
  const events = [];

  const promise = bridge.sendRequest({ message: 'show progress' }, {
    onProgressUpdate: (text) => progress.push(text),
    onEvent: (event) => events.push(event),
  }, { fullResponse: true });
  await nextTick();

  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt, 'prompt.send should be sent');

  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'assistant.progress.snapshot', requestId: prompt.requestId, text: 'Inspecting uploaded ZIP', assistantTurnKey: 'assistant-1' } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'done', requestId: prompt.requestId, answer: 'ok', progress: 'Inspecting uploaded ZIP', artifacts: [] } });

  const result = await promise;
  assert.deepEqual(progress, ['Inspecting uploaded ZIP']);
  assert.equal(result.progressText, 'Inspecting uploaded ZIP');
  assert.ok(events.some((event) => event.type === 'assistant.progress.snapshot'));
});

test('TampermonkeyBridge forwards clearing snapshots when transient DOM progress disappears', async () => {
  const hub = new FakeHub();
  const bridge = new TampermonkeyBridge(hub);
  const progress = [];
  const thinking = [];

  const promise = bridge.sendRequest({ message: 'clear transient state' }, {
    onProgressUpdate: (text) => progress.push(text),
    onThinkingUpdate: (text) => thinking.push(text),
  }, { fullResponse: true });
  await nextTick();

  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt);
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'prompt.accepted', requestId: prompt.requestId } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'thinking.snapshot', requestId: prompt.requestId, text: 'Разработал стратегию' } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'assistant.progress.snapshot', requestId: prompt.requestId, text: 'Python tool running' } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'thinking.snapshot', requestId: prompt.requestId, text: '' } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'assistant.progress.snapshot', requestId: prompt.requestId, text: '' } });
  hub.emit('client.message', { clientId: 'client-1', payload: { type: 'done', requestId: prompt.requestId, answer: 'Final answer', thinking: '', progress: '', artifacts: [] } });

  const result = await promise;
  assert.deepEqual(thinking, ['Разработал стратегию', '']);
  assert.deepEqual(progress, ['Python tool running', '']);
  assert.equal(result.thinking, '');
  assert.equal(result.progressText, '');
});
