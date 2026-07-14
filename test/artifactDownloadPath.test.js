import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserBridge } from '../src/browserBridge.js';
import { FileStore } from '../src/fileStore.js';

class ArtifactHub extends EventEmitter {
  constructor({ requestedPath }) {
    super();
    this.requestedPath = requestedPath;
    this.activeClient = { id: 'client-1' };
    this.clients = [{ id: 'client-1', ready: true }];
    this.selectedClientId = 'client-1';
    this.needsSelection = false;
    this.debugEvents = [];
  }

  sendToActive(payload) {
    setImmediate(() => {
      if (payload.type === 'response.recover.latest') {
        this.emit('client.message', {
          clientId: 'client-1',
          payload: {
            type: 'response.recovered',
            commandId: payload.commandId,
            answer: 'See attached artifact.',
            artifacts: [{ id: 'artifact-zip', name: 'project.zip', mime: 'application/zip', kind: 'file' }],
          },
        });
        return;
      }

      if (payload.type === 'artifact.fetch') {
        this.emit('client.message', {
          clientId: 'client-1',
          payload: {
            type: 'artifact.data.done',
            commandId: payload.commandId,
            artifactId: 'artifact-zip',
            name: 'project.zip',
            mime: 'application/zip',
            filePath: this.requestedPath,
            size: 11,
            captureSource: 'chrome-downloads',
            downloadId: 77,
            browserCaptureStartedAt: Date.now() - 1_000,
            browserCapturedAt: Date.now(),
            browserExpectedNames: ['project.zip'],
          },
        });
      }
    });
    return this.activeClient;
  }
}

test('fetchArtifact resolves browser-renamed download paths before importing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-download-path-'));
  const downloads = path.join(root, 'Downloads');
  await fs.mkdir(downloads, { recursive: true });
  const requestedPath = path.join(downloads, 'project.zip');
  const actualPath = path.join(downloads, 'project (1).zip');
  await fs.writeFile(actualPath, 'zip payload');

  const fileStore = new FileStore(path.join(root, 'store'));
  const bridge = new BrowserBridge(new ArtifactHub({ requestedPath }), fileStore);
  await bridge.recoverLatestResponse({ timeoutMs: 1000 });
  const stored = await bridge.fetchArtifact('artifact-zip', { timeoutMs: 1000 });

  assert.equal(stored.name, 'project (1).zip');
  assert.equal(stored.source.browserDownloadPath, actualPath);
  assert.equal(stored.source.requestedBrowserDownloadPath, requestedPath);
  const readable = await fileStore.getReadable(stored.id);
  assert.equal(await fs.readFile(readable.absolutePath, 'utf8'), 'zip payload');
  await assert.rejects(() => fs.stat(actualPath));
});
