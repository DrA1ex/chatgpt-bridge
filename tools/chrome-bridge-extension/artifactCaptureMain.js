(() => {
  'use strict';

  const INSTANCE_KEY = '__chatgptBridgeArtifactCaptureMainV1';
  const CONTENT_SOURCE = 'chatgpt-browser-bridge-artifact-content-v1';
  const MAIN_SOURCE = 'chatgpt-browser-bridge-artifact-main-v1';
  if (window[INSTANCE_KEY]) return;
  window[INSTANCE_KEY] = { startedAt: Date.now() };

  const captures = new Map();
  const blobsByUrl = new Map();
  const MAX_BLOB_AGE_MS = 10 * 60_000;

  function now() { return Date.now(); }

  function post(type, payload = {}) {
    window.postMessage({ source: MAIN_SOURCE, type, ...payload }, '*');
  }

  function normalizeName(value = '') {
    return String(value || '').trim().split(/[\\/]/).pop() || '';
  }

  function normalizeConflictName(value = '') {
    const name = normalizeName(value).toLowerCase();
    const dot = name.lastIndexOf('.');
    const stem = dot >= 0 ? name.slice(0, dot) : name;
    const ext = dot >= 0 ? name.slice(dot) : '';
    return `${stem.replace(/ \([0-9]+\)$/i, '')}${ext}`;
  }

  function captureExpectedNames(capture = {}) {
    return [...new Set([
      capture.expectedName,
      ...(Array.isArray(capture.expectedNames) ? capture.expectedNames : []),
    ].map(normalizeConflictName).filter(Boolean))];
  }

  function candidateMatchesCapture(capture, candidate = {}) {
    const expectedNames = captureExpectedNames(capture);
    const actual = normalizeConflictName(candidate.downloadName || '');
    if (!expectedNames.length || !actual) return true;
    return expectedNames.includes(actual);
  }

  function cleanup() {
    const time = now();
    for (const [captureId, capture] of captures.entries()) {
      if (capture.expiresAt <= time) captures.delete(captureId);
    }
    for (const [url, entry] of blobsByUrl.entries()) {
      if (time - entry.createdAt > MAX_BLOB_AGE_MS) blobsByUrl.delete(url);
    }
  }

  function activeCaptures() {
    cleanup();
    return [...captures.values()].sort((a, b) => a.armedAt - b.armedAt);
  }

  function reportCandidate(candidate = {}) {
    const active = activeCaptures();
    if (!active.length) return false;
    let emitted = false;
    for (const capture of active) {
      if (!candidateMatchesCapture(capture, candidate)) continue;
      emitted = true;
      post('artifact.capture.candidate', {
        captureId: capture.captureId,
        kind: candidate.kind || 'url',
        url: String(candidate.url || ''),
        downloadName: normalizeName(candidate.downloadName || capture.expectedName || ''),
        mime: String(candidate.mime || candidate.blob?.type || ''),
        size: Number(candidate.size || candidate.blob?.size || 0),
        blob: candidate.blob instanceof Blob ? candidate.blob : null,
        observedAt: now(),
      });
    }
    return emitted;
  }

  function reportAnchor(anchor) {
    if (!anchor) return false;
    const href = String(anchor.href || anchor.getAttribute?.('href') || '');
    if (!href) return false;
    const blobEntry = blobsByUrl.get(href) || null;
    const reported = reportCandidate({
      kind: blobEntry ? 'blob' : 'url',
      url: href,
      downloadName: anchor.getAttribute?.('download') || anchor.textContent || '',
      mime: blobEntry?.blob?.type || '',
      size: blobEntry?.blob?.size || 0,
      blob: blobEntry?.blob || null,
    });
    return Boolean(reported && (blobEntry || href.startsWith('data:')));
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data || {};
    if (message.source !== CONTENT_SOURCE) return;

    if (message.type === 'artifact.capture.arm') {
      const captureId = String(message.captureId || '');
      if (!captureId) return;
      const timeoutMs = Math.max(1_000, Math.min(Number(message.timeoutMs) || 120_000, 15 * 60_000));
      captures.set(captureId, {
        captureId,
        expectedName: normalizeName(message.expectedName || ''),
        expectedNames: Array.from(message.expectedNames || []).map(normalizeName).filter(Boolean),
        armedAt: now(),
        expiresAt: now() + timeoutMs,
      });
      post('artifact.capture.armed', { captureId });
      return;
    }

    if (message.type === 'artifact.capture.expect') {
      const captureId = String(message.captureId || '');
      const capture = captures.get(captureId);
      if (!capture) return;
      capture.expectedNames = [...new Set([
        ...(capture.expectedNames || []),
        ...Array.from(message.expectedNames || []).map(normalizeName).filter(Boolean),
      ])];
      post('artifact.capture.expected', { captureId, expectedNames: capture.expectedNames });
      return;
    }

    if (message.type === 'artifact.capture.cancel') {
      const captureId = String(message.captureId || '');
      if (captureId) captures.delete(captureId);
      post('artifact.capture.cancelled', { captureId });
    }
  });

  document.addEventListener('click', (event) => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const anchor = path.find((item) => item instanceof HTMLAnchorElement)
      || event.target?.closest?.('a[href]')
      || null;
    if (reportAnchor(anchor)) {
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
    }
  }, true);

  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function chatgptBridgeCapturedAnchorClick(...args) {
    const safelyCaptured = reportAnchor(this);
    // Blob/data downloads can be consumed directly by the isolated content
    // script. Suppress the temporary browser download so the user's Downloads
    // folder is not polluted with a duplicate file.
    if (safelyCaptured) return undefined;
    return originalAnchorClick.apply(this, args);
  };

  const originalCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function chatgptBridgeCreateObjectURL(value) {
    const url = originalCreateObjectURL(value);
    if (value instanceof Blob) {
      blobsByUrl.set(url, { blob: value, createdAt: now() });
    }
    return url;
  };

  const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = function chatgptBridgeRevokeObjectURL(url) {
    // Keep the Blob reference briefly. ChatGPT commonly revokes the URL
    // immediately after clicking a temporary anchor, while the bridge still
    // needs to read the generated bytes.
    return originalRevokeObjectURL(url);
  };

  const originalOpen = window.open;
  window.open = function chatgptBridgeCapturedWindowOpen(url, ...args) {
    const href = String(url || '');
    if (href) {
      const blobEntry = blobsByUrl.get(href) || null;
      const safelyCaptured = reportCandidate({
        kind: blobEntry ? 'blob' : 'url',
        url: href,
        mime: blobEntry?.blob?.type || '',
        size: blobEntry?.blob?.size || 0,
        blob: blobEntry?.blob || null,
      });
      if (safelyCaptured && (blobEntry || href.startsWith('data:'))) return null;
    }
    return originalOpen.call(this, url, ...args);
  };
})();
