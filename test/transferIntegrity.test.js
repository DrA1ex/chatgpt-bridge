import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { TransferAccumulator, describeTransfer, receiveInlineTransfer } from '../src/bridge/transferIntegrity.js';
import { withAttachmentIntegrity } from '../src/bridge/attachmentTransport.js';
import { BridgeCommandRegistry } from '../src/bridge/coordinator/bridgeCommandRegistry.js';

function fixture() {
  const bytes = Buffer.from('A binary payload\0\xff💡');
  const content = bytes.toString('base64');
  const meta = describeTransfer(bytes, content.length, 2);
  const parts = [content.slice(0, 8), content.slice(8)];
  const chunks = parts.map((part, index) => ({ ...meta, index, offset: index ? 8 : 0, contentBase64: part }));
  return { bytes, content, meta, chunks };
}

test('binary and Unicode layout payloads validate bytes independently of encoded length', () => {
  const { bytes, content, meta, chunks } = fixture();
  const accumulator = new TransferAccumulator(meta, 'base64');
  for (const chunk of chunks) accumulator.append(chunk, chunk.contentBase64);
  assert.equal(accumulator.finish(meta), content);
  assert.equal(receiveInlineTransfer(describeTransfer(bytes), content, 'base64'), content);
  const html = '<html>💡Привет</html>';
  assert.equal(receiveInlineTransfer(describeTransfer(Buffer.from(html), html.length, 1, 'utf8'), html, 'utf8'), html);
});

for (const [name, mutate] of [
  ['missing chunk', (f) => f.chunks.pop()],
  ['duplicate chunk', (f) => f.chunks.splice(1, 0, f.chunks[0])],
  ['reordered chunks', (f) => f.chunks.reverse()],
  ['negative index', (f) => { f.chunks[0].index = -1; }],
  ['fractional index', (f) => { f.chunks[0].index = 0.5; }],
  ['string index', (f) => { f.chunks[0].index = '0'; }],
  ['wrong offset', (f) => { f.chunks[1].offset = 9; }],
  ['truncated chunk', (f) => { f.chunks[1].contentBase64 = f.chunks[1].contentBase64.slice(0, -1); }],
  ['oversized chunk', (f) => { f.chunks[1].contentBase64 += 'AAAA'; }],
  ['corrupted chunk', (f) => { f.chunks[0].contentBase64 = 'AAAA' + f.chunks[0].contentBase64.slice(4); }],
  ['mixed transfer', (f) => { f.chunks[1].transferId = 'another'; }],
  ['changed chunk count', (f) => { f.chunks[1].totalChunks += 1; }],
  ['changed terminal hash', (f) => { f.meta.sha256 = '0'.repeat(64); }],
  ['changed terminal size', (f) => { f.meta.size += 1; }],
]) {
  test(`transfer rejects ${name}`, () => {
    const f = fixture();
    const accumulator = new TransferAccumulator(f.meta, 'base64');
    mutate(f);
    assert.throws(() => {
      for (const chunk of f.chunks) accumulator.append(chunk, chunk.contentBase64);
      accumulator.finish(f.meta);
    }, { code: 'TRANSFER_INTEGRITY_INVALID' });
  });
}

test('metadata bounds, decoded size and canonical base64 are checked before success', () => {
  for (const bad of [{ totalChunks: 1e9 }, { size: 2 ** 40 }, { encodedSize: -1 }, { sha256: '' }, { transferId: '' }]) {
    assert.throws(() => new TransferAccumulator({ ...fixture().meta, ...bad }, 'base64'), { code: 'TRANSFER_INTEGRITY_INVALID' });
  }
  const bytes = Buffer.from('hello');
  assert.throws(() => receiveInlineTransfer({ ...describeTransfer(bytes), size: 4 }, bytes.toString('base64'), 'base64'), /raw size mismatch/);
  assert.throws(() => receiveInlineTransfer(describeTransfer(bytes, 9), 'aGVsbG8=!', 'base64'), /invalid base64/);
});

for (const fault of ['duplicate-start', 'no-start', 'wrong-artifact', 'missing-chunk', 'wrong-terminal', 'inline-corruption', 'mode-change', 'untyped-result']) {
  test(`command rejects ${fault} and releases its transfer memory`, async () => {
    const registry = new BridgeCommandRegistry({ hub: { sendToActive: () => ({ id: 'tab' }) } });
    const pending = registry.send('artifact.fetch', { artifact: { id: 'artifact' } }, { commandId: 'cmd' });
    const rejected = assert.rejects(pending, { code: 'TRANSFER_INTEGRITY_INVALID' });
    await new Promise((resolve) => setImmediate(resolve));
    const f = fixture();
    const send = (type, body) => registry.handleResponse('tab', { type, commandId: 'cmd', artifactId: 'artifact', ...body });
    const start = () => send('command.progress', { progressType: 'artifact.data.started', ...f.meta });
    const chunk = (body) => send('command.progress', { progressType: 'artifact.data.chunk', ...body });
    const finish = (body) => send('command.result', { resultType: 'artifact.data.done', ...f.meta, ...body });
    if (!['no-start', 'inline-corruption'].includes(fault)) start();
    if (fault === 'duplicate-start') start();
    if (fault === 'no-start') chunk(f.chunks[0]);
    if (fault === 'wrong-artifact') chunk({ ...f.chunks[0], artifactId: 'other' });
    if (fault === 'missing-chunk') { chunk(f.chunks[0]); finish(); }
    if (fault === 'wrong-terminal') { for (const c of f.chunks) chunk(c); finish({ transferId: 'other' }); }
    if (fault === 'inline-corruption') finish({ ...describeTransfer(f.bytes), contentBase64: 'AAAA' + f.content.slice(4) });
    if (fault === 'mode-change') finish({ filePath: '/tmp/should-not-import' });
    if (fault === 'untyped-result') send('command.result', { resultType: 'artifact.data', contentBase64: f.content });
    await rejected;
    assert.equal(registry.size, 0);
    assert.equal(finish(), false);
    registry.close();
  });
}

test('attachment corruption is rejected before any composer interaction', async () => {
  const sandbox = vm.createContext({ crypto: globalThis.crypto, Uint8Array, File, Blob, atob, btoa });
  for (const file of ['shared/transferIntegrity.js', 'content/attachmentCommands.js']) {
    vm.runInContext(await fs.readFile(`tools/chrome-bridge-extension/${file}`, 'utf8'), sandbox);
  }
  let interactions = 0;
  const api = sandbox.ChatGptAttachmentCommands.createAttachmentCommands({
    emitChatEvent() {}, diagnostic() {}, findComposerRoot() { interactions += 1; },
  });
  const attachment = withAttachmentIntegrity({ name: 'payload.txt', contentBase64: Buffer.from('correct').toString('base64') });
  attachment.contentBase64 = Buffer.from('corrupt').toString('base64');
  await assert.rejects(api.attachFiles([attachment], { requestId: 'request' }), /SHA-256 mismatch/);
  assert.equal(interactions, 0);
  const goodBytes = Buffer.from('correct');
  const urlAttachment = withAttachmentIntegrity({ name: 'payload.txt', url: 'https://example.test/file',
    size: goodBytes.length, sha256: describeTransfer(goodBytes).sha256 });
  sandbox.fetch = async () => new Response('corrupt');
  await assert.rejects(api.attachFiles([urlAttachment], { requestId: 'url-request' }), /SHA-256 mismatch/);
  assert.equal(interactions, 0);
});

for (const contentBase64 of ['cGF5bG9hZA==', '', null]) {
  test(`chunked artifact rejects an additional inline payload (${JSON.stringify(contentBase64)})`, async () => {
    const registry = new BridgeCommandRegistry({ hub: { sendToActive: () => ({ id: 'tab' }) } });
    const pending = registry.send('artifact.fetch', { artifact: { id: 'artifact' } }, { commandId: 'mixed' });
    const rejected = assert.rejects(pending, { code: 'TRANSFER_INTEGRITY_INVALID', message: 'Mixed artifact transfer modes' });
    await new Promise((resolve) => setImmediate(resolve));
    const { meta, chunks } = fixture();
    const send = (body) => registry.handleResponse('tab', { commandId: 'mixed', artifactId: 'artifact', ...meta, ...body });
    send({ type: 'command.progress', progressType: 'artifact.data.started' });
    for (const chunk of chunks) send({ type: 'command.progress', progressType: 'artifact.data.chunk', ...chunk });
    send({ type: 'command.result', resultType: 'artifact.data.done', contentBase64 });
    await rejected;
    assert.equal(registry.size, 0);
    registry.close();
  });
}

for (const scenario of [
  { name: 'missing size allows a nonempty file', attachment: {}, content: 'data', accepted: true },
  { name: 'zero size rejects a nonempty file', attachment: { size: 0 }, content: 'data', accepted: false },
  { name: 'zero size accepts an empty file', attachment: { size: 0 }, content: '', accepted: true },
]) {
  test(`URL attachment ${scenario.name}`, async () => {
    const inputEvents = [];
    const input = { dispatchEvent(event) { inputEvents.push(event.type); } };
    const sandbox = vm.createContext({ File, Blob, Event: class { constructor(type) { this.type = type; } },
      fetch: async () => new Response(scenario.content),
      document: { querySelectorAll: () => [input] },
      DataTransfer: class {
        constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; }
      },
    });
    vm.runInContext(await fs.readFile('tools/chrome-bridge-extension/content/attachmentCommands.js', 'utf8'), sandbox);
    const api = sandbox.ChatGptAttachmentCommands.createAttachmentCommands({
      CONFIG: { attachmentUploadTimeoutMs: 0 }, emitChatEvent() {}, diagnostic() {},
    });
    const pending = api.attachFiles([{ name: 'payload', url: 'https://example.test/file', ...scenario.attachment }], { requestId: 'request' });
    if (scenario.accepted) {
      await pending;
      assert.deepEqual(inputEvents, ['input', 'change']);
      assert.equal(await input.files[0].text(), scenario.content);
    } else {
      await assert.rejects(pending, /Attachment size mismatch/);
      assert.deepEqual(inputEvents, []);
    }
  });
}
