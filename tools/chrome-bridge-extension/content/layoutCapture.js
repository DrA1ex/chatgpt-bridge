(() => {
  'use strict';

  const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK']);
  const BOOLEAN_ATTRIBUTES = new Set(['disabled', 'checked', 'selected', 'hidden', 'open', 'multiple', 'required']);
  const SAFE_ATTRIBUTES = new Set([
    'role', 'type', 'name', 'contenteditable', 'tabindex', 'draggable',
    'aria-expanded', 'aria-haspopup', 'aria-selected', 'aria-checked', 'aria-disabled',
    'aria-hidden', 'aria-current', 'aria-live', 'aria-busy', 'aria-modal',
    'data-testid', 'data-sidebar-item', 'data-message-author-role', 'data-turn',
    'data-state', 'data-fill', 'data-size', 'data-active', 'data-revealed',
    'data-scrolled-from-end', 'data-scrolled-from-top', 'data-trailing-button',
  ]);
  const SENSITIVE_SELECTOR = [
    '[data-message-author-role]',
    '[data-turn]',
    '#history',
    '[data-sidebar-item][href*="/c/"]',
    '[data-conversation-options-trigger]',
    '[data-testid="accounts-profile-button"]',
    '[contenteditable="true"]',
    'textarea',
    'input',
  ].join(',');
  const INTERACTIVE_SELECTOR = 'button,[role="button"],[role="menuitem"],[role="option"],[role="tab"],summary,label';

  function createLayoutCapture(deps = {}) {
    const { isVisible = () => true, normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim(), send = () => false } = deps;

    function hashText(value = '') {
      let hash = 2166136261;
      const text = String(value || '');
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    }

    function escapeHtml(value = '') {
      return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    }

    function semanticId(value = '') {
      const id = String(value || '').trim();
      if (!id) return '';
      if (/^(?:history|sidebar-header|prompt-textarea|chatgpt-bridge-panel-root|cgb-[a-z0-9_-]+)$/i.test(id)) return id;
      return `id-${hashText(id)}`;
    }

    function safePath(value = '') {
      try {
        const url = new URL(String(value || ''), location.href);
        const pathname = url.pathname.replace(/\/c\/[^/]+/g, '/c/<conversation>').replace(/\/g\/[^/]+/g, '/g/<gpt>');
        return `${url.origin}${pathname}`;
      } catch {
        return '';
      }
    }

    function safeAttribute(node, attribute, sensitive) {
      const name = String(attribute?.name || '').toLowerCase();
      const rawValue = String(attribute?.value || '');
      if (!name || name === 'style' || name.startsWith('on') || name === 'src' || name === 'srcset' || name === 'value') return null;
      if (BOOLEAN_ATTRIBUTES.has(name)) return { name, value: '' };
      if (name === 'class') {
        const classes = rawValue.split(/\s+/).filter(Boolean).slice(0, 40).join(' ');
        return classes ? { name, value: classes } : null;
      }
      if (name === 'id') return { name, value: semanticId(rawValue) };
      if (name === 'href' || name === 'action') {
        const value = safePath(rawValue);
        return value ? { name, value } : null;
      }
      if (name === 'aria-controls' || name === 'aria-owns' || name === 'for') {
        return rawValue ? { name, value: semanticId(rawValue) } : null;
      }
      if (name === 'aria-label' || name === 'title' || name === 'placeholder' || name === 'alt') {
        if (!rawValue) return null;
        const redact = sensitive || name === 'alt';
        return redact
          ? { name, value: `<redacted:${rawValue.length}:${hashText(rawValue)}>` }
          : { name, value: normalizeText(rawValue).slice(0, 180) };
      }
      if (SAFE_ATTRIBUTES.has(name) || name.startsWith('data-cgb-')) return { name, value: rawValue.slice(0, 180) };
      return null;
    }

    function nodeIsSensitive(node, inherited) {
      if (inherited) return true;
      try { return Boolean(node?.matches?.(SENSITIVE_SELECTOR) || node?.closest?.(SENSITIVE_SELECTOR)); } catch { return false; }
    }

    function interactiveTextAllowed(node, sensitive) {
      if (sensitive) return false;
      try { return Boolean(node?.closest?.(INTERACTIVE_SELECTOR)); } catch { return false; }
    }

    function layoutAttributes(node) {
      let visible = false;
      try { visible = Boolean(isVisible(node)); } catch {}
      const attributes = [{ name: 'data-cgb-visible', value: visible ? 'true' : 'false' }];
      try {
        const rect = node.getBoundingClientRect?.();
        if (rect && [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) {
          const rounded = [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value * 10) / 10);
          attributes.push({ name: 'data-cgb-rect', value: rounded.join(',') });
        }
      } catch {}
      try {
        const style = window.getComputedStyle?.(node);
        if (style) {
          attributes.push({ name: 'data-cgb-display', value: String(style.display || '') });
          attributes.push({ name: 'data-cgb-position', value: String(style.position || '') });
        }
      } catch {}
      return attributes;
    }

    function capturePageLayout(options = {}) {
      const maxNodes = Math.max(500, Math.min(30_000, Number(options.maxNodes) || 15_000));
      const maxBytes = Math.max(100_000, Math.min(5_000_000, Number(options.maxBytes) || 2_000_000));
      const state = { nodeCount: 0, textNodes: 0, redactedTextNodes: 0, truncated: false, bytes: 0 };

      function append(parts, value) {
        if (state.truncated) return;
        const text = String(value || '');
        state.bytes += text.length;
        if (state.bytes > maxBytes) {
          state.truncated = true;
          parts.push('<!-- layout capture truncated by byte limit -->');
          return;
        }
        parts.push(text);
      }

      function serialize(node, parts, inheritedSensitive = false, depth = 0) {
        if (!node || state.truncated || depth > 64) return;
        if (node.nodeType === 3) {
          const text = normalizeText(node.textContent || '');
          if (!text) return;
          state.textNodes += 1;
          const parent = node.parentElement || null;
          const sensitive = nodeIsSensitive(parent, inheritedSensitive);
          if (interactiveTextAllowed(parent, sensitive)) append(parts, escapeHtml(text.slice(0, 180)));
          else {
            state.redactedTextNodes += 1;
            append(parts, `<!-- text redacted length=${text.length} hash=${hashText(text)} -->`);
          }
          return;
        }
        if (node.nodeType !== 1 || SKIPPED_TAGS.has(String(node.tagName || '').toUpperCase())) return;
        state.nodeCount += 1;
        if (state.nodeCount > maxNodes) {
          state.truncated = true;
          append(parts, '<!-- layout capture truncated by node limit -->');
          return;
        }
        const tag = String(node.tagName || 'div').toLowerCase();
        const sensitive = nodeIsSensitive(node, inheritedSensitive);
        const attributes = [];
        for (const attribute of Array.from(node.attributes || [])) {
          const sanitized = safeAttribute(node, attribute, sensitive);
          if (sanitized?.name) attributes.push(sanitized);
        }
        attributes.push(...layoutAttributes(node));
        const serializedAttributes = attributes
          .filter((item, index, all) => all.findIndex((candidate) => candidate.name === item.name) === index)
          .map(({ name, value }) => value === '' ? name : `${name}="${escapeHtml(value)}"`)
          .join(' ');
        append(parts, `<${tag}${serializedAttributes ? ` ${serializedAttributes}` : ''}>`);
        for (const child of Array.from(node.childNodes || [])) serialize(child, parts, sensitive, depth + 1);
        append(parts, `</${tag}>`);
      }

      const parts = [];
      const root = document.body || document.documentElement;
      append(parts, '<!doctype html><html><head><meta charset="utf-8"><title>Sanitized ChatGPT layout capture</title></head>');
      serialize(root, parts, false, 0);
      append(parts, '</html>');
      return {
        html: parts.join(''),
        metadata: {
          version: 1,
          capturedAt: Date.now(),
          url: safePath(location.href),
          title: `<redacted:${String(document.title || '').length}:${hashText(document.title || '')}>`,
          viewport: { width: Number(window.innerWidth) || 0, height: Number(window.innerHeight) || 0 },
          ...state,
        },
      };
    }

    function handleLayoutCapture(payload = {}) {
      const capture = capturePageLayout(payload.options || {});
      send({
        type: 'page.layout.captured',
        commandId: String(payload.commandId || ''),
        requestId: String(payload.requestId || ''),
        ...capture,
      });
      return capture;
    }

    return Object.freeze({ capturePageLayout, handleLayoutCapture });
  }

  globalThis.ChatGptLayoutCapture = Object.freeze({ createLayoutCapture });
})();
