import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TampermonkeyBridge } from '../src/tampermonkeyBridge.js';
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
    return true;
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

test('userscript contains reliability hardening for chunks, nonce, upload completion, and request timeout warnings', async () => {
  const source = await fs.readFile(new URL('../userscripts/chatgpt-bridge.user.js', import.meta.url), 'utf8');
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
  assert.match(source, /pollingOutbox/);
  assert.match(source, /sendCritical/);
  assert.match(source, /\/diagnostics/);
  assert.match(source, /Extension WebSocket/);
  assert.match(source, /connectExtensionTransport/);
  assert.match(source, /@noframes/);
  assert.match(source, /window\.top !== window\.self/);
  assert.match(source, /send\(\{ type: 'prompt\.accepted', requestId \}, \{ priority: true, immediatePost: true, timeout: 5_000 \}\)/);
  assert.doesNotMatch(source, /await\s+sendCritical\(\{ type: 'prompt\.accepted'/);
  assert.match(source, /transform:translateX\(calc\(100% - 34px\)\)/);
  assert.match(source, /chatgptBrowserBridgeCompanionInstance/);
  assert.match(source, /chatgptBridgeTabClientId/);
  assert.match(source, /sessionStorage\.getItem\(CLIENT_ID_STORAGE_KEY\)/);
  assert.doesNotMatch(source, /localStorage\.getItem\(CLIENT_ID_STORAGE_KEY\)/);
  const bridgeSource = await fs.readFile(new URL('../src/tampermonkeyBridge.js', import.meta.url), 'utf8');
  assert.doesNotMatch(bridgeSource, /prompt\.accepted\.timeout/);
  assert.doesNotMatch(bridgeSource, /startAcceptedTimer/);
  assert.doesNotMatch(bridgeSource, /Timed out waiting for ChatGPT answer after/);
  assert.match(bridgeSource, /Timed out waiting for ChatGPT activity after/);
  assert.match(bridgeSource, /lastActivityReason/);
  assert.match(bridgeSource, /#handleClientActivity/);
  assert.match(bridgeSource, /client\.activeRequest/);
  const extensionContentSource = await fs.readFile(new URL('../tools/chrome-bridge-extension/content.js', import.meta.url), 'utf8');
  assert.match(extensionContentSource, /GM_xmlhttpRequest/);
  assert.match(extensionContentSource, /bridge\.connect/);
  const extensionBackgroundSource = await fs.readFile(new URL('../tools/chrome-bridge-extension/background.js', import.meta.url), 'utf8');
  assert.match(extensionBackgroundSource, /new WebSocket/);
  assert.match(extensionBackgroundSource, /chrome\.runtime\.onConnect/);
  const hubSource = await fs.readFile(new URL('../src/tampermonkeyHub.js', import.meta.url), 'utf8');
  assert.match(hubSource, /isAllowedExtensionOrigin/);
  assert.match(hubSource, /pruneQueuedPings/);
  assert.match(hubSource, /client\.ready && client\.poll/);
  assert.match(hubSource, /client\.activity/);
  assert.match(hubSource, /activeRequest/);
});

import { TampermonkeyHub } from '../src/tampermonkeyHub.js';

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
