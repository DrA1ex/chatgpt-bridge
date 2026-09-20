(() => {
  'use strict';

  const MAX_RAW_SIZE = 128 * 1024 * 1024;
  const MAX_ENCODED_SIZE = Math.ceil(MAX_RAW_SIZE / 3) * 4;
  const MAX_CHUNKS = 4096;
  function fail(message) {
    throw Object.assign(new Error(`Transfer integrity: ${message}`), { code: 'TRANSFER_INTEGRITY_INVALID' });
  }
  function validate(metadata) {
    if (!metadata || typeof metadata.transferId !== 'string' || !metadata.transferId || metadata.transferId.length > 200) fail('invalid transfer ID');
    for (const [key, max] of [['size', MAX_RAW_SIZE], ['encodedSize', MAX_ENCODED_SIZE], ['totalChunks', MAX_CHUNKS]]) {
      if (!Number.isSafeInteger(metadata[key]) || metadata[key] < 0 || metadata[key] > max) fail(`invalid ${key}`);
    }
    if (metadata.totalChunks < 1 || !/^[a-f0-9]{64}$/.test(metadata.sha256 || '')) fail('missing chunk count or SHA-256');
    if (!['base64', 'utf8', 'binary'].includes(metadata.encoding)) fail('invalid encoding');
    if (metadata.encoding === 'binary' && metadata.encodedSize !== metadata.size) fail('binary size mismatch');
    return metadata;
  }
  async function sha256(bytes) {
    return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  async function describe(bytes, encodedSize, totalChunks, encoding = 'base64') {
    if (bytes.byteLength > MAX_RAW_SIZE) fail('payload too large');
    return validate({ transferId: globalThis.crypto.randomUUID(), size: bytes.byteLength, encodedSize,
      totalChunks, encoding, sha256: await sha256(bytes) });
  }
  async function verifyBytes(bytes, metadata) {
    validate(metadata);
    if (bytes.byteLength !== metadata.size) fail('raw size mismatch');
    if (await sha256(bytes) !== metadata.sha256) fail('SHA-256 mismatch');
  }
  globalThis.ChatGptTransferIntegrity = Object.freeze({ validate, describe, sha256, verifyBytes, fail });
})();
