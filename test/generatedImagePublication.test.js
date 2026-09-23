import test from 'node:test';
import { describeTransfer } from '../src/bridge/transferIntegrity.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserBridge } from '../src/browserBridge.js';
import { BrowserExtensionHub } from '../src/browserExtensionHub.js';
import { FileStore } from '../src/fileStore.js';
import { connectExtensionClient } from './helpers/extensionClient.js';
import { RequestResultMaterializer } from '../src/bridge/coordinator/requestResultMaterializer.js';
import { ArtifactRegistry } from '../src/bridge/artifacts/artifactRegistry.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
const image = () => ({ id: 'publication-image', kind: 'image', mime: 'image/*', phase: 'READY',
  name: 'Generated image', url: 'https://chatgpt.com/backend-api/estuary/content?id=test' });
async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for image publication');
}

for (const mode of ['recovery', 'passive']) {
  test(`${mode} publication waits for durable capture without blocking incoming Protocol 5 results`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-publication-'));
    const fileStore = new FileStore(root);
    const hub = new BrowserExtensionHub();
    const bridge = new BrowserBridge(hub, fileStore);
    const connection = await connectExtensionClient(hub, { clientId: 'image-tab' });
    t.after(async () => {
      await bridge.close({ cancelPending: false });
      await connection.close();
      await fs.rm(root, { recursive: true, force: true });
    });
    const commands = [];
    connection.ws.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (message.messageType !== 'command.execute') return;
      commands.push(message.body);
      if (message.body.type === 'response.recover.latest') connection.send({
        type: 'command.result', commandId: message.commandId, resultType: 'response.recovered', artifacts: [image()],
      });
    });
    let published = false;
    let completion;
    if (mode === 'recovery') {
      completion = bridge.recoverLatestResponse({ sourceClientId: 'image-tab' }).then((result) => { published = true; return result; });
    } else {
      completion = new Promise((resolve) => bridge.onObservedTurn((turn) => { published = true; resolve(turn); }));
      connection.send({ type: 'tab.observation', observation: {
        schemaVersion: 1, revision: 1, observedAt: Date.now(), stableForMs: 2000,
        conversationId: 'image-session', activeRequest: null,
        turn: { key: 'image-turn', userKey: 'image-user', userPrompt: 'Generate an image',
          promptBoundary: { submittedUserTurnKey: 'image-user' } },
        generation: { state: 'stopped' }, blocker: { state: 'none' },
        output: { state: 'final', answer: '', finalMessage: true }, artifacts: [image()],
      } });
    }
    const capture = await waitFor(() => commands.find((command) => command.type === 'artifact.image.read'));
    assert.equal(capture.commandScope, 'standalone');
    assert.equal(published, false);
    assert.equal(bridge.listKnownArtifacts()[0].phase, 'MATERIALIZING');
    assert.deepEqual(await fileStore.listArtifacts(), []);
    connection.send({ type: 'command.result', commandId: capture.commandId, resultType: 'artifact.data.done',
      ...describeTransfer(png), artifactId: capture.artifact.id,
      contentBase64: png.toString('base64'), name: 'image', mime: 'text/plain' });
    await waitFor(() => published);
    const result = await completion;
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].phase, 'READY');
    assert.equal(result.artifacts[0].mime, 'image/png');
    assert.equal((await fileStore.getReadable(image().id)).size, png.length);
    assert.equal(commands.filter((command) => command.type === 'artifact.image.read').length, 1);
  });
}

test('canonical completion publishes only after image capture settles', async () => {
  let resolveCapture;
  const artifacts = new ArtifactRegistry({ capture: () => new Promise((resolve) => { resolveCapture = resolve; }) });
  const candidate = image();
  artifacts.set(candidate.id, candidate);
  const state = { artifacts: [candidate], deferredDone: { answer: '' } };
  let published;
  const materializer = new RequestResultMaterializer({ artifacts });
  materializer.finish = (_state, error, _answer, metadata) => { assert.equal(error, null); published = metadata; };
  const pending = materializer.finishFromCanonicalState(state, { terminal: { code: 'completed' } });
  await waitFor(() => resolveCapture);
  assert.equal(published, undefined);
  resolveCapture({ kind: 'artifact', id: candidate.id, size: png.length, mime: 'image/png', name: 'image.png' });
  await pending;
  assert.equal(published.artifacts[0].phase, 'READY');
});
