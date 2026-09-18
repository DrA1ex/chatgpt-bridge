(() => {
  'use strict';

  const INSTANCE_KEY = '__chatgptBridgeArtifactCaptureMainV1';
  const CONTENT_SOURCE = 'chatgpt-browser-bridge-artifact-content-v1';
  const MAIN_SOURCE = 'chatgpt-browser-bridge-artifact-main-v1';
  if (window[INSTANCE_KEY]) return;

  const captures = new Map();
  const blobsByUrl = new Map();
  const PAGE_RELOAD_STATE_KEY = '__chatgptBridgePageReloadV1';
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalOpen = window.open;
  let hooksInstalled = false;

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

  function removeCapture(captureId) {
    const capture = captures.get(captureId);
    if (!capture) return false;
    if (capture.timer) clearTimeout(capture.timer);
    captures.delete(captureId);
    uninstallHooksIfIdle();
    return true;
  }

  function activeCaptures() {
    return [...captures.values()].sort((a, b) => a.armedAt - b.armedAt);
  }

  function reportCandidate(candidate = {}) {
    const matching = activeCaptures().filter((capture) => candidateMatchesCapture(capture, candidate));
    if (!matching.length) return false;
    for (const capture of matching) {
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
      removeCapture(capture.captureId);
    }
    return true;
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

  function handleDocumentClick(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const anchor = path.find((item) => item instanceof HTMLAnchorElement)
      || event.target?.closest?.('a[href]')
      || null;
    if (reportAnchor(anchor)) {
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
    }
  }

  function capturedAnchorClick(...args) {
    const safelyCaptured = reportAnchor(this);
    if (safelyCaptured) return undefined;
    return originalAnchorClick.apply(this, args);
  }

  function capturedCreateObjectURL(value) {
    const url = originalCreateObjectURL.call(URL, value);
    if (captures.size && value instanceof Blob) blobsByUrl.set(url, { blob: value, createdAt: now() });
    return url;
  }

  function capturedWindowOpen(url, ...args) {
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
  }

  function installHooks() {
    if (hooksInstalled) return;
    hooksInstalled = true;
    document.addEventListener('click', handleDocumentClick, true);
    HTMLAnchorElement.prototype.click = capturedAnchorClick;
    URL.createObjectURL = capturedCreateObjectURL;
    window.open = capturedWindowOpen;
  }

  function uninstallHooksIfIdle() {
    if (captures.size || !hooksInstalled) return;
    hooksInstalled = false;
    document.removeEventListener?.('click', handleDocumentClick, true);
    if (HTMLAnchorElement.prototype.click === capturedAnchorClick) HTMLAnchorElement.prototype.click = originalAnchorClick;
    if (URL.createObjectURL === capturedCreateObjectURL) URL.createObjectURL = originalCreateObjectURL;
    if (window.open === capturedWindowOpen) window.open = originalOpen;
    blobsByUrl.clear();
  }

  function armCapture(message) {
    const captureId = String(message.captureId || '');
    if (!captureId) return;
    removeCapture(captureId);
    const timeoutMs = Math.max(1_000, Math.min(Number(message.timeoutMs) || 120_000, 15 * 60_000));
    const timer = typeof setTimeout === 'function' ? setTimeout(() => {
      if (!removeCapture(captureId)) return;
      post('artifact.capture.expired', { captureId });
    }, timeoutMs) : null;
    captures.set(captureId, {
      captureId,
      expectedName: normalizeName(message.expectedName || ''),
      expectedNames: Array.from(message.expectedNames || []).map(normalizeName).filter(Boolean),
      armedAt: now(),
      timer,
    });
    installHooks();
    post('artifact.capture.armed', { captureId });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data || {};
    if (message.source !== CONTENT_SOURCE) return;

    if (message.type === 'page.reload.arm') {
      const reloadId = String(message.reloadId || '');
      if (!reloadId) return;
      const delayMs = Math.max(300, Math.min(Number(message.delayMs) || 900, 15_000));
      const existing = window[PAGE_RELOAD_STATE_KEY];
      if (existing?.reloadId === reloadId) {
        post('page.reload.armed', { reloadId, delayMs: existing.delayMs, duplicate: true });
        return;
      }
      if (existing?.timer) clearTimeout(existing.timer);
      const timer = setTimeout(() => {
        try { window.location.reload(); } catch { window.location.href = window.location.href; }
      }, delayMs);
      window[PAGE_RELOAD_STATE_KEY] = { reloadId, delayMs, timer, armedAt: now() };
      post('page.reload.armed', { reloadId, delayMs, duplicate: false });
      return;
    }

    if (message.type === 'page.reload.cancel') {
      const reloadId = String(message.reloadId || '');
      const existing = window[PAGE_RELOAD_STATE_KEY];
      if (!reloadId || existing?.reloadId !== reloadId) return;
      if (existing.timer) clearTimeout(existing.timer);
      delete window[PAGE_RELOAD_STATE_KEY];
      post('page.reload.cancelled', { reloadId });
      return;
    }

    if (message.type === 'artifact.capture.arm') {
      armCapture(message);
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
      if (captureId) removeCapture(captureId);
      post('artifact.capture.cancelled', { captureId });
    }
  });

  window[INSTANCE_KEY] = Object.freeze({
    startedAt: now(),
    activeCaptureCount: () => captures.size,
    hooksInstalled: () => hooksInstalled,
  });
})();

// The composer helper must share the one MAIN-world bootstrap with artifact
// capture.  MV3 executes MAIN-world files in manifest order, and the runtime
// contract deliberately keeps that list to one stable parser/bootstrap file.
(() => {
  'use strict';

  const INSTANCE_KEY = '__chatgptBridgeComposerMainV1';
  const CONTENT_SOURCE = 'chatgpt-browser-bridge-composer-content-v1';
  const MAIN_SOURCE = 'chatgpt-browser-bridge-composer-main-v1';
  if (window[INSTANCE_KEY]) return;

  function isVisible(element) {
    if (!element || element.isConnected === false) return false;
    const style = window.getComputedStyle?.(element);
    return style?.display !== 'none' && style?.visibility !== 'hidden' && element.getClientRects?.().length > 0;
  }

  function isEditable(element) {
    if (!element) return false;
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') return !element.disabled && !element.readOnly;
    const value = String(element.getAttribute?.('contenteditable') || '').trim().toLowerCase();
    return value === 'true' || value === 'plaintext-only' || (value !== 'false' && element.isContentEditable === true);
  }

  function findComposer() {
    const candidates = Array.from(document.querySelectorAll(
      '#prompt-textarea[contenteditable]:not([contenteditable="false"]), textarea#prompt-textarea, .ProseMirror[contenteditable]:not([contenteditable="false"]), [role="textbox"][contenteditable]:not([contenteditable="false"]), textarea[name="prompt-textarea"]',
    )).filter((element) => isEditable(element) && isVisible(element));
    return candidates[0] || null;
  }

  function comparableText(element) {
    return String(element?.value ?? element?.innerText ?? element?.textContent ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function selectAll(element) {
    element.focus?.();
    const selection = window.getSelection?.();
    const range = document.createRange?.();
    if (!selection || !range) return false;
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function setText(element, text) {
    const expected = String(text || '').trim();
    if (!selectAll(element)) throw new Error('Composer selection is unavailable');
    let execResult = false;
    if (typeof document.execCommand === 'function') {
      execResult = Boolean(document.execCommand('insertText', false, text));
    }
    let actual = comparableText(element);
    if (!actual.includes(expected.slice(0, Math.min(expected.length, 200)))) {
      if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
        const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        descriptor?.set?.call(element, text);
      } else {
        let paragraph = element.querySelector?.('p');
        if (!paragraph) {
          paragraph = document.createElement('p');
          element.replaceChildren(paragraph);
        }
        paragraph.textContent = text;
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      actual = comparableText(element);
    }
    return {
      ok: Boolean(expected ? actual.includes(expected.slice(0, Math.min(expected.length, 200))) : true),
      execResult,
      textLength: actual.length,
      childCount: Number(element.children?.length || 0),
    };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== CONTENT_SOURCE || event.data?.type !== 'composer.set') return;
    const requestId = String(event.data.requestId || '');
    let result;
    try {
      const composer = findComposer();
      if (!composer) throw new Error('Composer is not available in the page main world');
      result = { ...setText(composer, String(event.data.text || '')), tagName: String(composer.tagName || '') };
    } catch (error) {
      result = { ok: false, error: String(error?.message || error).slice(0, 200) };
    }
    window.postMessage({ source: MAIN_SOURCE, type: 'composer.set.result', requestId, result }, '*');
  });

  window[INSTANCE_KEY] = Object.freeze({ startedAt: Date.now() });
})();
