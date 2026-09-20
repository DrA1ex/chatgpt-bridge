import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { ArtifactRegistry } from '../src/bridge/artifacts/artifactRegistry.js';
import { BridgeOperations } from '../src/bridge/coordinator/bridgeOperations.js';
import { FileStore } from '../src/fileStore.js';
import { createApp } from '../src/server.js';
import { CodexRpcServer } from '../src/codexRpcServer.js';
import { config } from '../src/config.js';
import { performHttp } from '../tools/chrome-bridge-extension/background/httpTransport.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
const candidate = () => ({ id: 'session-image', kind: 'image', mime: 'image/*', phase: 'READY',
  name: 'Generated image', sourceClientId: 'authenticated-tab',
  downloadUrl: 'https://chatgpt.com/backend-api/estuary/content?id=test&sig=private' });

// Execute the production content -> extension API -> background transport
// boundary. Only the browser's cookie jar/network service is simulated.
async function browserTransport({ fallback = false, status = 200, body = png, expired = () => false } = {}) {
  const contexts = [];
  const sandbox = vm.createContext({ crypto: globalThis.crypto, URL, TextDecoder, Uint8Array, ArrayBuffer, Blob, atob, btoa,
    console, queueMicrotask, setTimeout, clearTimeout,
    localStorage: { getItem() { return null; }, setItem() {} },
    chrome: { runtime: { lastError: null, sendMessage(message, callback) {
      performHttp(message.request, async (url, options) => {
        contexts.push({ context: 'background', credentials: options.credentials });
        assert.equal(url, candidate().downloadUrl);
        const allowed = options.credentials === 'include';
        return new Response(allowed ? body : 'Authentication required', {
          status: expired() ? 403 : allowed ? status : 401,
          headers: { 'content-type': 'text/plain' },
        });
      }).then((result) => callback({ result }), (error) => callback({ error: error.message }));
    } } },
    fetch: async (url, options) => {
      contexts.push({ context: 'content', credentials: options.credentials });
      assert.equal(url, candidate().downloadUrl);
      if (fallback) throw new TypeError('Failed to fetch');
      return new Response(body, { status: expired() ? 403 : status, headers: { 'content-type': 'text/plain' } });
    },
  });
  for (const file of ['shared/transferIntegrity.js', 'shared/artifactImage.js', 'content/extensionApi.js', 'content/artifactTransfer.js']) {
    vm.runInContext(await fs.readFile(`tools/chrome-bridge-extension/${file}`, 'utf8'), sandbox);
  }
  return { contexts, async sendCommand(type, payload, options) {
    assert.equal(type, 'artifact.fetch');
    assert.equal(options.sourceClientId, 'authenticated-tab');
    const messages = [];
    const transfer = sandbox.ChatGptArtifactTransfer.createArtifactTransfer({
      CONFIG: { artifactChunkSize: 256 * 1024 }, EXTENSION_API: sandbox.ChatGptExtensionApi,
      isBrowserOnlyArtifactUrl: () => false, isCurrentPageNavigationUrl: () => false,
      diagnostic() {}, send: (message) => messages.push(message), delay: async () => {}, guessNameFromUrl: () => '',
    });
    await transfer.handleArtifactFetch({ commandId: 'capture', artifact: payload.artifact });
    const error = messages.find((message) => message.type === 'command.error');
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    return { ...messages.find((message) => message.type === 'artifact.data.done'),
      contentBase64: messages.filter((message) => message.type === 'artifact.data.chunk').map((message) => message.contentBase64).join('') };
  } };
}

async function setup(t, transport) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fileStore = new FileStore(root);
  let bridge;
  const registry = new ArtifactRegistry({ capture: (id) => bridge.fetchArtifact(id) });
  bridge = new BridgeOperations({ fileStore, artifacts: registry, sendCommand: transport.sendCommand });
  const server = http.createServer(createApp(bridge, fileStore));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const download = () => fetch(`http://127.0.0.1:${server.address().port}/artifacts/session-image/download`, {
    headers: { Authorization: `Bearer ${config.apiToken}` },
  });
  const rpc = () => new CodexRpcServer({ bridge, fileStore }).handleMessage({ id: 1, method: 'artifact/download',
    params: { artifactId: 'session-image', token: config.apiToken } });
  return { registry, bridge, fileStore, download, rpc };
}

for (const fallback of [false, true]) {
  test(`authenticated ${fallback ? 'background fallback' : 'content'} capture survives URL expiry through HTTP and RPC`, async (t) => {
    let expired = false;
    const transport = await browserTransport({ fallback, expired: () => expired });
    const { registry, bridge, fileStore, download, rpc } = await setup(t, transport);
    const image = candidate();
    registry.set(image.id, image);
    assert.equal(image.phase, 'MATERIALIZING');
    assert.equal(image.downloadable, false);
    const [first, second] = await Promise.all([bridge.fetchArtifact(image.id), bridge.fetchArtifact(image.id)]);
    assert.equal(first.id, second.id);
    assert.equal(first.source.captureSource, fallback ? 'extension-background-fetch' : 'direct-fetch');
    await registry.settled([image]);
    assert.equal(image.phase, 'READY');
    assert.equal(image.mime, 'image/png');
    assert.equal(image.size, png.length);
    expired = true;
    const changed = { ...candidate(), downloadUrl: 'https://chatgpt.com/expired' };
    registry.set(changed.id, changed);
    assert.equal(changed.storedFileId, first.id);
    const response = await download();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    const result = await rpc();
    assert.equal(result.result.file.mime, 'image/png');
    assert.equal(result.result.file.metadata.kind, 'image');
    assert.deepEqual(Buffer.from((await fileStore.readForTransport(first.id)).contentBase64, 'base64'), png);
    assert.equal(transport.contexts.length, fallback ? 2 : 1);
    assert.ok(transport.contexts.every((context) => context.credentials === 'include'));
    // Local lifetime also survives a new operations instance without the tab.
    const restarted = new BridgeOperations({ fileStore, sendCommand: () => assert.fail('must use local bytes') });
    assert.equal((await restarted.fetchArtifact(image.id)).mime, 'image/png');
  });
}

for (const [status, body] of [[401, 'unauthorized'], [403, 'expired'], [200, '<html>login</html>'],
  [200, '{"error":"expired"}'], [200, 'Authentication required']]) {
  test(`upstream ${status} ${body.slice(0, 15)} fails HTTP and RPC without storing a text file`, async (t) => {
    const transport = await browserTransport({ fallback: true, status, body });
    const { registry, fileStore, download, rpc } = await setup(t, transport);
    const image = candidate();
    registry.set(image.id, image);
    await registry.settled([image]);
    assert.equal(image.phase, 'FAILED');
    assert.equal(image.downloadable, false);
    assert.deepEqual(await fileStore.listArtifacts(), []);
    assert.deepEqual(await fs.readdir(fileStore.artifactsDir), []);
    const response = await download();
    assert.ok(response.status >= 400);
    const error = await response.json();
    assert.match(error.code, /^ARTIFACT_/);
    assert.ok(error.detail);
    const result = await rpc();
    assert.ok(result.error);
    assert.equal(result.result, undefined);
  });
}

test('background credential policy preserves explicit anonymous requests', async () => {
  let credentials;
  const result = await performHttp({ url: candidate().downloadUrl, responseType: 'arraybuffer', anonymous: true }, async (_, options) => {
    credentials = options.credentials;
    return new Response('Unauthorized', { status: 401 });
  });
  assert.equal(credentials, 'omit');
  assert.equal(result.status, 401);
});


test('legacy cached text cannot bypass image validation', async (t) => {
  const transport = { sendCommand: () => assert.fail('cached image must be validated locally') };
  const { bridge, registry, fileStore, download, rpc } = await setup(t, transport);
  await fileStore.putArtifact({ artifactId: 'session-image', name: 'error.txt', mime: 'text/plain',
    content: 'Authentication required', metadata: { kind: 'file' } });
  const image = candidate();
  registry.set(image.id, image);
  await registry.settled([image]);
  assert.equal(image.phase, 'FAILED');
  await assert.rejects(bridge.fetchArtifact(image.id), { code: 'ARTIFACT_IMAGE_INVALID' });
  assert.ok((await download()).status >= 400);
  assert.equal((await rpc()).error.code, 'ARTIFACT_IMAGE_INVALID');
});
