import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import {
  artifactIdentity,
  artifactsFromItem,
  historicalReasoningSteps,
  isUiActionText,
  mergeItemsById,
  recoveredArtifactItems,
} from '../tools/codex-chat-ui/ui-core.js';
import { readApiToken, startCodexChatUi } from '../tools/codex-chat-ui/server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for Codex chat UI test state');
}

test('historical reasoning keeps canonical sequence and filters ChatGPT action labels', () => {
  const items = [
    {
      id: 'reasoning-second', turnId: 'turn-history', type: 'reasoning', status: 'completed',
      createdAt: '2026-09-20T12:00:00.000Z',
      content: { sequence: 2, text: 'Render the final image', firstSeenAt: '2026-09-20T12:00:02.000Z' },
    },
    {
      id: 'reasoning-action', turnId: 'turn-history', type: 'reasoning', status: 'completed',
      createdAt: '2026-09-20T12:00:00.000Z',
      content: { sequence: 3, text: 'Редактировать', firstSeenAt: '2026-09-20T12:00:03.000Z' },
    },
    {
      id: 'reasoning-first', turnId: 'turn-history', type: 'reasoning', status: 'completed',
      createdAt: '2026-09-20T12:00:00.000Z',
      content: { sequence: 1, text: 'Plan the composition', firstSeenAt: '2026-09-20T12:00:01.000Z' },
    },
  ];

  assert.equal(isUiActionText('Edit message'), true);
  assert.equal(isUiActionText('Редактировать'), true);
  assert.deepEqual(historicalReasoningSteps(items, 'turn-history').map((step) => step.text), [
    'Plan the composition',
    'Render the final image',
  ]);
});

test('historical item merge is stable for equal timestamps and old artifact shapes remain renderable', () => {
  const ordered = mergeItemsById([], [
    { id: 'first', createdAt: '2026-09-20T12:00:00.000Z' },
    { id: 'second', createdAt: '2026-09-20T12:00:00.000Z' },
  ]);
  assert.deepEqual(ordered.map((item) => item.id), ['first', 'second']);

  assert.deepEqual(artifactsFromItem({
    id: 'item-image', type: 'artifact', artifactId: 'history-image',
    content: { name: 'history.png', mime: 'image/png', kind: 'image', phase: 'READY' },
  }), [{ id: 'history-image', name: 'history.png', mime: 'image/png', kind: 'image', phase: 'READY' }]);
});

test('conversation recovery adds every missing image and coalesces signed Estuary copies', () => {
  const existing = [{
    id: 'stored-latest', type: 'artifact', artifactId: 'old-latest',
    content: { artifact: { id: 'old-latest', kind: 'image', url: 'https://chatgpt.com/backend-api/estuary/content?id=file-latest&sig=old' } },
  }];
  const candidates = [
    { turnKey: 'assistant-latest', artifacts: [{ id: 'new-latest', kind: 'image', url: 'https://chatgpt.com/backend-api/estuary/content?id=file-latest&sig=new' }] },
    { turnKey: 'assistant-middle', artifacts: [{ id: 'middle', kind: 'image', url: 'https://chatgpt.com/backend-api/estuary/content?id=file-middle&sig=signed' }] },
    { turnKey: 'assistant-oldest', artifacts: [{ id: 'oldest', kind: 'image', url: 'https://chatgpt.com/backend-api/estuary/content?id=file-oldest&sig=signed' }] },
  ];

  assert.equal(artifactIdentity(existing[0].content.artifact), 'estuary:file-latest');
  assert.deepEqual(
    recoveredArtifactItems(candidates, existing, 'turn-current').map((item) => item.artifactId),
    ['oldest', 'middle'],
  );
});

test('integrated page eagerly requests historical image previews and keeps failed cards retryable by download', async () => {
  const html = await fs.readFile(new URL('../tools/codex-chat-ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /from '\.\/ui-core\.js'/);
  assert.match(html, /image\.loading = 'eager'/);
  assert.match(html, /hydrateHistoricalReasoning\(threadItems\)/);
  assert.match(html, /rpc\('thread\/reconcile'/);
  assert.match(html, /npm run ui:codex/);
  assert.doesNotMatch(html, /run\.py/);
  assert.doesNotMatch(html, /link\.remove\(\)/);
});

test('Node launcher keeps API_TOKEN server-side while proxying Codex RPC and artifacts', async (t) => {
  const apiToken = 'codex-ui-secret';
  const upstreamMessages = [];
  const upstreamAuth = [];
  const upstreamWss = new WebSocketServer({ noServer: true });
  const bridge = http.createServer((req, res) => {
    if (req.url === '/setup/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"clients":[]}');
      return;
    }
    if (req.url === '/artifacts/history-image/download') {
      assert.equal(req.headers.authorization, `Bearer ${apiToken}`);
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    res.writeHead(404).end();
  });
  bridge.on('upgrade', (req, socket, head) => {
    upstreamAuth.push(req.headers.authorization || '');
    upstreamWss.handleUpgrade(req, socket, head, (ws) => upstreamWss.emit('connection', ws));
  });
  upstreamWss.on('connection', (ws) => ws.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    upstreamMessages.push(message);
    ws.send(JSON.stringify({ id: message.id, result: { ok: true } }));
  }));

  const bridgePort = await listen(bridge);
  const runtime = await startCodexChatUi({ port: 0, bridgePort, apiToken });
  t.after(async () => {
    await runtime.close();
    upstreamWss.close();
    await closeServer(bridge);
  });

  const page = await fetch(runtime.url);
  assert.equal(page.status, 200);
  const cookie = page.headers.get('set-cookie').split(';', 1)[0];
  assert.doesNotMatch(await page.text(), new RegExp(apiToken));
  const bootstrap = await fetch(`${runtime.url}bootstrap`, { headers: { cookie } }).then((response) => response.json());
  assert.equal(bootstrap.tokenLoaded, true);
  assert.doesNotMatch(JSON.stringify(bootstrap), new RegExp(apiToken));

  const image = await fetch(`${runtime.url}artifact/history-image?inline=1`, { headers: { cookie } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');

  const browser = new WebSocket(bootstrap.wsUrl, { headers: { cookie } });
  const browserResponses = [];
  browser.on('message', (raw) => browserResponses.push(String(raw)));
  await once(browser, 'open');
  browser.send(JSON.stringify({ id: 1, method: 'initialize', params: {} }));
  browser.send(JSON.stringify({ id: 2, method: 'thread/list', params: {} }));
  await waitFor(() => browserResponses.length === 2);
  assert.deepEqual(upstreamAuth, [`Bearer ${apiToken}`]);
  assert.equal(upstreamMessages[0].params.token, undefined);
  assert.equal(upstreamMessages[1].params.token, apiToken);
  assert.doesNotMatch(browserResponses.join('\n'), new RegExp(apiToken));
  const closed = once(browser, 'close');
  browser.close();
  await closed;
});

test('Node launcher reads quoted API_TOKEN values from the bridge env file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-chat-ui-'));
  const envFile = path.join(root, '.env');
  try {
    await fs.writeFile(envFile, "export API_TOKEN='quoted-token' # comment\n");
    assert.equal(readApiToken(envFile), 'quoted-token');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
