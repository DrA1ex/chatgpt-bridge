import { createHash, randomUUID } from 'node:crypto';
import '../../tools/chrome-bridge-extension/shared/transferIntegrity.js';

const { validate, fail } = globalThis.ChatGptTransferIntegrity;
const fields = ['transferId', 'size', 'encodedSize', 'totalChunks', 'encoding', 'sha256'];

export function describeTransfer(bytes, encodedSize = bytes.toString('base64').length, totalChunks = 1, encoding = 'base64') {
  return validate({ transferId: randomUUID(), size: bytes.length, encodedSize, totalChunks, encoding,
    sha256: createHash('sha256').update(bytes).digest('hex') });
}

// Command correlation owns lifetime; this accumulator owns only bounded bytes.
export class TransferAccumulator {
  constructor(metadata, encoding) {
    validate(metadata);
    if (metadata.encoding !== encoding) fail('unexpected encoding');
    this.metadata = Object.fromEntries(fields.map((key) => [key, metadata[key]]));
    this.chunks = [];
    this.length = 0;
  }

  check(metadata) {
    if (fields.some((key) => metadata[key] !== this.metadata[key])) fail('transfer metadata changed');
  }

  append(metadata, content) {
    this.check(metadata);
    if (!Number.isSafeInteger(metadata.index) || metadata.index !== this.chunks.length
      || metadata.index >= this.metadata.totalChunks) fail('missing, duplicate or reordered chunk');
    if (metadata.offset !== this.length || typeof content !== 'string') fail('invalid chunk offset or content');
    if (this.length + content.length > this.metadata.encodedSize) fail('encoded payload too large');
    this.chunks.push(content);
    this.length += content.length;
  }

  finish(metadata) {
    this.check(metadata);
    if (this.chunks.length !== this.metadata.totalChunks || this.length !== this.metadata.encodedSize) fail('incomplete payload');
    const content = this.chunks.join('');
    const bytes = Buffer.from(content, this.metadata.encoding);
    if (this.metadata.encoding === 'base64' && bytes.toString('base64') !== content) fail('invalid base64');
    if (bytes.length !== this.metadata.size) fail('raw size mismatch');
    if (createHash('sha256').update(bytes).digest('hex') !== this.metadata.sha256) fail('SHA-256 mismatch');
    return content;
  }
}

export function receiveInlineTransfer(metadata, content, encoding) {
  const transfer = new TransferAccumulator(metadata, encoding);
  transfer.append({ ...metadata, index: 0, offset: 0 }, content);
  return transfer.finish(metadata);
}
