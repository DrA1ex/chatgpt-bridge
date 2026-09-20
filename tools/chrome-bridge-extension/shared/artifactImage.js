// Shared byte-based image normalization for content materialization and server storage.
// Classic content-script global; also loaded by the Node artifact adapter.
(() => {
  'use strict';
  const starts = (bytes, signature, offset = 0) => bytes.length >= offset + signature.length
    && signature.every((value, index) => bytes[offset + index] === value);
  const ascii = (bytes, text, offset = 0) => starts(bytes, Array.from(text, (char) => char.charCodeAt(0)), offset);

  function detectImageMime(bytes) {
    if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (starts(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (ascii(bytes, 'RIFF') && ascii(bytes, 'WEBP', 8)) return 'image/webp';
    if (ascii(bytes, 'GIF87a') || ascii(bytes, 'GIF89a')) return 'image/gif';
    // ISO BMFF: inspect only the declared ftyp box's major and compatible brands.
    if (bytes.length >= 16 && ascii(bytes, 'ftyp', 4)) {
      const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
      if (size >= 16 && size <= bytes.length) {
        for (let offset = 8; offset + 4 <= size; offset += 4) {
          if (offset !== 12 && (ascii(bytes, 'avif', offset) || ascii(bytes, 'avis', offset))) return 'image/avif';
        }
      }
    }
    return '';
  }

  function isImageArtifact(artifact = {}) {
    return artifact.kind === 'image' || String(artifact.mime || '').toLowerCase().startsWith('image/');
  }

  function normalizeImageArtifact(bytes, artifact = {}) {
    if (!isImageArtifact(artifact)) return artifact;
    const mime = detectImageMime(bytes);
    if (!mime) {
      const error = new Error(`Artifact source returned invalid IMAGE bytes for ${artifact.name || artifact.id || 'artifact'}`);
      error.code = 'ARTIFACT_IMAGE_INVALID';
      throw error;
    }
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' }[mime];
    const originalName = String(artifact.name || artifact.fileName || 'generated-image');
    const stem = originalName.replace(/\.[a-z0-9]{1,10}$/i, '').slice(0, 175);
    return { ...artifact, kind: 'image', mime, name: `${stem || 'generated-image'}.${extension}` };
  }

  globalThis.ChatGptArtifactImage = Object.freeze({ detectImageMime, isImageArtifact, normalizeImageArtifact });
})();
