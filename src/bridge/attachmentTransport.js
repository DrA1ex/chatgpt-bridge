import { randomUUID } from 'node:crypto';
import { describeTransfer } from './transferIntegrity.js';

export function withAttachmentIntegrity(attachment) {
  if (attachment.contentBase64 !== undefined) {
    const bytes = Buffer.from(attachment.contentBase64, 'base64');
    if (bytes.toString('base64') !== attachment.contentBase64) throw new Error('Attachment contains invalid base64');
    return { ...attachment, integrity: describeTransfer(bytes), size: bytes.length };
  }
  return attachment.sha256 ? { ...attachment, integrity: {
    transferId: randomUUID(), size: attachment.size, encodedSize: attachment.size,
    totalChunks: 1, encoding: 'binary', sha256: attachment.sha256,
  } } : attachment;
}
