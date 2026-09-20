import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { BridgeOperations } from '../src/bridge/coordinator/bridgeOperations.js';
import { FileStore } from '../src/fileStore.js';
import { createApp } from '../src/server.js';
import { CodexRpcServer } from '../src/codexRpcServer.js';
import { config } from '../src/config.js';
import { detectImageMime, normalizeImageArtifact } from '../src/results/artifactImage.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const artifact = { id: 'generated-image', kind: 'image', mime: 'image/*', name: 'Generated image',
  downloadUrl: 'https://chatgpt.com/backend-api/estuary/content?id=image' };

async function fetchThroughContent(body, contentType) {
  const messages = [];
  const sandbox = vm.createContext({ crypto: globalThis.crypto, TextDecoder, Uint8Array, ArrayBuffer, Blob, URL, atob, btoa,
    fetch: async (url) => {
      assert.equal(url, artifact.downloadUrl);
      return new Response(body, { headers: { 'content-type': contentType } });
    } });
  for (const file of ['shared/transferIntegrity.js', 'shared/artifactImage.js', 'content/artifactTransfer.js']) {
    vm.runInContext(await fs.readFile(`tools/chrome-bridge-extension/${file}`, 'utf8'), sandbox);
  }
  const transfer = sandbox.ChatGptArtifactTransfer.createArtifactTransfer({
    CONFIG: { artifactChunkSize: 256 * 1024 }, EXTENSION_API: {},
    isBrowserOnlyArtifactUrl: () => false, isCurrentPageNavigationUrl: () => false,
    diagnostic() {}, send: (message) => messages.push(message), delay: async () => {},
    guessNameFromUrl: () => '',
  });
  await transfer.handleArtifactFetch({ commandId: 'fetch-image', artifact });
  const error = messages.find((message) => message.type === 'command.error');
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return { ...messages.find((message) => message.type === 'artifact.data.done'),
    contentBase64: messages.filter((message) => message.type === 'artifact.data.chunk').map((message) => message.contentBase64).join('') };
}

for (const [format, body, contentType] of [['png', png, 'text/plain'], ['webp', webp, 'application/octet-stream']]) {
  for (const materialization of ['direct', 'path']) {
    test(`${format} image: ${materialization} materialization preserves bytes and semantics through HTTP and Codex`, async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-image-'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const fileStore = new FileStore(path.join(root, 'store'));
      const events = [];
      let response;
      if (materialization === 'direct') {
        response = await fetchThroughContent(body, contentType);
        assert.equal(response.mime, `image/${format}`);
        assert.equal(response.name, `Generated image.${format}`);
      } else {
        const filePath = path.join(root, 'Generated image');
        await fs.writeFile(filePath, body);
        response = { filePath, name: artifact.name, mime: contentType, size: body.length, captureSource: 'chrome-downloads' };
      }
      const bridge = new BridgeOperations({ fileStore, artifacts: new Map([[artifact.id, { ...artifact }]]),
        sendCommand: async () => response, eventBus: { emitUser: (event) => events.push(event) } });
      const stored = await bridge.fetchArtifact(artifact.id);
      assert.equal(stored.mime, `image/${format}`);
      assert.equal(stored.name, `Generated image.${format}`);
      assert.equal(stored.kind, 'artifact');
      assert.equal(stored.metadata.kind, 'image');
      assert.equal(stored.metadata.id, artifact.id);
      assert.equal(stored.size, body.length);
      const done = events.find((event) => event.type === 'artifact.download.done').data;
      assert.equal(done.mime, stored.mime);
      assert.equal(done.kind, 'image');
      assert.equal(done.artifactId, artifact.id);
      assert.equal(done.source, materialization === 'path' ? 'chrome-downloads' : 'direct-fetch');
      const server = http.createServer(createApp(bridge, fileStore));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));
      const download = await fetch(`http://127.0.0.1:${server.address().port}/artifacts/${artifact.id}/download`, {
        headers: { Authorization: `Bearer ${config.apiToken}` },
      });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('content-type'), `image/${format}`);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), body);
      const rpc = new CodexRpcServer({ bridge, fileStore });
      const result = await rpc.handleMessage({ id: 1, method: 'artifact/download', params: { artifactId: artifact.id, token: config.apiToken } });
      assert.equal(result.result.file.mime, stored.mime);
      assert.equal(result.result.file.metadata.kind, 'image');
    });
  }
}

for (const body of ['<html>error</html>', '{"error":"expired"}', 'not an image']) {
  test(`invalid image fails before storage: ${body}`, async (t) => {
    await assert.rejects(fetchThroughContent(body, 'text/plain'), { code: 'ARTIFACT_IMAGE_INVALID' });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'invalid-image-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const fileStore = new FileStore(path.join(root, 'store'));
    const filePath = path.join(root, 'download');
    await fs.writeFile(filePath, body);
    for (const response of [{ contentBase64: Buffer.from(body).toString('base64') }, { filePath }]) {
      const bridge = new BridgeOperations({ fileStore, artifacts: new Map([[artifact.id, { ...artifact }]]),
        sendCommand: async () => ({ ...response, mime: 'text/plain' }) });
      await assert.rejects(bridge.fetchArtifact(artifact.id), { code: 'ARTIFACT_IMAGE_INVALID' });
      assert.deepEqual(await fileStore.listArtifacts(), []);
      assert.deepEqual(await fs.readdir(fileStore.artifactsDir), []);
    }
  });
}

test('image magic supports JPEG, GIF and AVIF and rejects unrecognized formats', () => {
  assert.equal(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  for (const version of ['GIF87a', 'GIF89a']) assert.equal(detectImageMime(Buffer.from(version)), 'image/gif');
  const avif = Buffer.from([0, 0, 0, 20, ...Buffer.from('ftypmif1'), 0, 0, 0, 0, ...Buffer.from('avif')]);
  assert.equal(detectImageMime(avif), 'image/avif');
  assert.equal(detectImageMime(Buffer.from('RIFFwrong-format')), '');
});


test('verified bytes override a misleading image subtype and filename extension', () => {
  const normalized = normalizeImageArtifact(webp, { kind: 'image', name: 'Generated image.png', mime: 'image/png' });
  assert.equal(normalized.mime, 'image/webp');
  assert.equal(normalized.name, 'Generated image.webp');
});
