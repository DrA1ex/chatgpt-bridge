(() => {
  'use strict';

  function normalizeComparable(value) {
    return String(value || '').toLowerCase().replace(/[\s_\-.]+/g, '').trim();
  }

  function isVisible(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    if ('isConnected' in element && !element.isConnected) return false;
    try {
      if (element.closest?.('[hidden], [aria-hidden="true"]')) return false;
      if (typeof element.checkVisibility === 'function') {
        return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
      const style = window.getComputedStyle(element);
      return style.visibility !== 'hidden'
        && style.visibility !== 'collapse'
        && style.display !== 'none'
        && style.contentVisibility !== 'hidden'
        && Number(style.opacity) !== 0;
    } catch {
      return true;
    }
  }

  function normalizeText(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function visibleText(element) {
    return normalizeText(element?.innerText || element?.textContent || '');
  }

  function unique(items) {
    const seen = new Set();
    const result = [];
    for (const item of items.map(normalizeText).filter(Boolean)) {
      if (seen.has(item)) continue;
      seen.add(item);
      result.push(item);
    }
    return result;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  globalThis.ChatGptDomUtilities = Object.freeze({
    delay,
    isVisible,
    normalizeComparable,
    normalizeText,
    unique,
    visibleText,
  });
})();
