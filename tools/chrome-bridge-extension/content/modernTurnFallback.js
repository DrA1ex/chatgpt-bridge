// Compatibility turn discovery for the current ChatGPT message surface.
// Loaded before turnSnapshots.js; canonical data-* turn metadata remains the
// primary parser contract.
(() => {
  'use strict';

  function createModernTurnFallback({ normalizeText, visibleText } = {}) {
    const nodeRoles = new WeakMap();
    const nodeKeys = new WeakMap();
    const stableKeys = new Map();

    function roots() {
      const result = Array.from(document.querySelectorAll?.('main, [role="main"]') || []);
      return result.length ? result : [document.body || document.documentElement || document].filter(Boolean);
    }

    function excluded(node) {
      return Boolean(node?.closest?.('nav, aside, form, [data-testid*="composer" i], #cgb-panel'));
    }

    function markdownNodes(root) {
      if (!root) return [];
      const result = [];
      if (root.matches?.('[class*="MarkdownRoot"]') && !root.matches?.('.rich-text-user-turn')) result.push(root);
      result.push(...Array.from(root.querySelectorAll?.('[class*="MarkdownRoot"]') || []));
      return result.filter((node, index, all) => (
        !node.matches?.('.rich-text-user-turn')
        && !node.closest?.('.bg-user-message')
        && all.indexOf(node) === index
      ));
    }

    function finalAnswerNode(root) {
      const result = markdownNodes(root);
      return result[result.length - 1] || null;
    }

    function userNodes() {
      const result = [];
      for (const root of roots()) {
        for (const node of Array.from(root.querySelectorAll?.('.bg-user-message') || [])) {
          if (!excluded(node)) result.push(node);
        }
      }
      return result;
    }

    function assistantNodes() {
      const result = [];
      for (const root of roots()) {
        for (const heading of Array.from(root.querySelectorAll?.('h4.sr-only') || [])) {
          const candidate = heading.parentElement;
          if (!candidate || excluded(candidate) || candidate.matches?.('.bg-user-message')) continue;
          if (!markdownNodes(candidate).length || result.includes(candidate)) continue;
          result.push(candidate);
        }
      }
      return result;
    }

    function compareDocumentOrder(left, right) {
      if (left === right) return 0;
      const relation = left?.compareDocumentPosition?.(right) || 0;
      const preceding = globalThis.Node?.DOCUMENT_POSITION_PRECEDING || 2;
      const following = globalThis.Node?.DOCUMENT_POSITION_FOLLOWING || 4;
      if (relation & following) return -1;
      if (relation & preceding) return 1;
      return 0;
    }

    function getTurnNodes() {
      const assistants = assistantNodes();
      const result = [...userNodes(), ...assistants]
        .filter((node, index, all) => all.indexOf(node) === index)
        .sort(compareDocumentOrder);
      const ordinals = { user: 0, assistant: 0 };
      for (const node of result) {
        const role = assistants.includes(node) ? 'assistant' : 'user';
        const ordinal = ordinals[role]++;
        nodeRoles.set(node, role);
        if (!nodeKeys.has(node)) {
          const stableId = `${role}:${ordinal}`;
          const key = stableKeys.get(stableId) || `modern-${role}-${ordinal}`;
          stableKeys.set(stableId, key);
          nodeKeys.set(node, key);
        }
      }
      return result;
    }

    function role(node) {
      const known = nodeRoles.get(node);
      if (known) return known;
      if (node?.matches?.('.bg-user-message')) return 'user';
      if (node && markdownNodes(node).length && node.querySelector?.('h4.sr-only')) return 'assistant';
      return '';
    }

    function key(node) {
      if (!node) return '';
      const known = nodeKeys.get(node);
      if (known) return known;
      getTurnNodes();
      return nodeKeys.get(node) || '';
    }

    function getFinalAssistantNode(root) {
      if (!root) return null;
      if (role(root) === 'assistant') return finalAnswerNode(root);
      return assistantNodes().filter((node) => root === node || root.contains?.(node)).map(finalAnswerNode).find(Boolean) || null;
    }

    return Object.freeze({
      assistantNodes,
      finalAnswerNode,
      getAssistantNodes: assistantNodes,
      getFinalAssistantNode,
      getTurnNodes,
      key,
      role,
    });
  }

  globalThis.ChatGptModernTurnFallback = Object.freeze({ createModernTurnFallback });
})();
