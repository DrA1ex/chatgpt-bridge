// Turn ownership and identity shared by live observation and recovery.
// Presentation-only message shapes are readable, but never invent durable IDs.
(() => {
  'use strict';

  function createTurnDom() {
    const TURN_SELECTOR = '[data-turn="user"], [data-turn="assistant"]';
    const MESSAGE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';

    // A virtualized turn may own both roles; a search unit owns one.
    const SEARCH_UNIT_SELECTOR = '[data-chatgpt-search-unit-key][data-chatgpt-search-message-ids]';

    const ASSISTANT_MARKER = '[data-chatgpt-agent-turn-start]';

    function searchRole(node) {
      const explicit = node?.getAttribute?.('data-chatgpt-search-unit-key')?.match(/:(user|assistant)$/)?.[1];
      if (explicit) return explicit;
      if (node?.matches?.('[data-chatgpt-search-message-ids][class~="group/user-message"]')) return 'user';
      return '';
    }

    const currentTurnContainer = node => node?.closest?.('[data-turn-key]') || null;

    function assistantBranch(marker) {
      const container = currentTurnContainer(marker);
      if (!container) return null;
      let branch = marker.parentElement;
      if (!branch || branch === container) return null;
      while (branch.parentElement && branch.parentElement !== container) {
        const parent = branch.parentElement;
        if (Array.from(parent.querySelectorAll?.(SEARCH_UNIT_SELECTOR) || []).some(node => searchRole(node) === 'user')
          || parent.querySelector?.('[data-turn="user"], [data-message-author-role="user"]')) break;
        branch = parent;
      }
      return branch;
    }

    function markerAssistant(node) {
      if (!node || !currentTurnContainer(node)) return false;
      return Array.from(node.querySelectorAll?.(ASSISTANT_MARKER) || []).some(marker => assistantBranch(marker) === node);
    }

    function searchMessageId(node) {
      const ids = [...new Set(String(node?.getAttribute?.('data-chatgpt-search-message-ids') || '').split(/\s+/).filter(Boolean))];
      if (searchRole(node) === 'assistant') {
        const responseId = node.querySelector?.('[data-response-body]')?.getAttribute?.('data-response-body');
        if (responseId && ids.includes(responseId)) return responseId;
      }
      return ids.length === 1 ? ids[0] : '';
    }

    function excluded(node) {
      return !globalThis.ChatGptDomUtilities.isPrimaryChatSurfaceElement(node)
        || Boolean(node?.closest?.('nav, aside, [role="navigation"], [role="complementary"], form, [hidden], [aria-hidden="true"], [inert], [data-testid*="composer" i], #cgb-panel'));
    }

    const MARKDOWN_SELECTOR = '[class*="MarkdownRoot"], [data-markdown-text-style="assistant-message"]';
    const ACTIVITY_SELECTOR = '[data-streaming-response-status], [data-testid^="cot-v5"]';

    function markdownNodes(root) {
      if (!root) return [];
      const result = [];
      if (root.matches?.(MARKDOWN_SELECTOR)) result.push(root);
      result.push(...Array.from(root.querySelectorAll?.(MARKDOWN_SELECTOR) || []));
      return result.filter((node, index, all) => (
        !node.closest?.('.rich-text-user-turn, .bg-user-message, [data-user-message-bubble]')
        && !excluded(node)
        && all.indexOf(node) === index
      ));
    }

    function finalAnswerCandidate(root, candidate) {
      if (!candidate || excluded(candidate) || candidate.closest?.(ACTIVITY_SELECTOR)) return false;
      if (!currentTurnContainer(root)) return true;
      // The grouped renderer also uses Markdown for progress commentary.
      // Only the first status boundary excludes earlier text: a later tool
      // status must not reclassify already visible answer blocks.
      const firstStatus = Array.from(root.querySelectorAll?.('[data-streaming-response-status]') || [])
        .find(node => !excluded(node) && (globalThis.ChatGptDomUtilities.isVisible?.(node) ?? true));
      if (!firstStatus) return true;
      return !candidate.contains?.(firstStatus) && compareDocumentOrder(candidate, firstStatus) >= 0;
    }

    function finalAnswerNode(root) {
      const result = markdownNodes(root).filter(node => finalAnswerCandidate(root, node));
      return result[result.length - 1] || null;
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

    function semanticRole(node) {
      return node?.getAttribute?.('data-turn') || node?.getAttribute?.('data-message-author-role') || searchRole(node);
    }

    function role(node) {
      const explicit = semanticRole(node);
      if (explicit === 'user' || explicit === 'assistant') return explicit;
      if (markerAssistant(node)) return 'assistant';
      if (node?.matches?.('.bg-user-message')) return 'user';
      if (Array.from(node?.children || []).some((child) => child.matches?.('h4.sr-only'))
        && markdownNodes(node).length) return 'assistant';
      return '';
    }

    function getTurnNodes() {
      // Resolve each message to its owning turn. Do not switch the entire page
      // to one selector family when wrapped and unwrapped messages coexist.
      const result = [];
      const presentation = [];
      const DISCOVERY_SELECTOR = `${TURN_SELECTOR}, ${MESSAGE_SELECTOR}, ${SEARCH_UNIT_SELECTOR}, ${ASSISTANT_MARKER}, .bg-user-message, h4.sr-only`;
      for (const node of Array.from(document.querySelectorAll(DISCOVERY_SELECTOR))) {
        // The marker is hidden, but its owning assistant branch is visible.
        if (node.matches?.(ASSISTANT_MARKER)) {
          const branch = assistantBranch(node);
          if (branch && !excluded(branch)) {
            for (let i = result.length - 1; i >= 0; i--) {
              if (role(result[i]) === 'assistant' && branch.contains?.(result[i])) result.splice(i, 1);
            }
            if (!result.some(turn => turn === branch || (role(turn) === 'assistant' && turn.contains?.(branch)))) result.push(branch);
          }
          continue;
        }
        if (excluded(node)) continue;
        if (node.matches?.(`${TURN_SELECTOR}, ${MESSAGE_SELECTOR}, ${SEARCH_UNIT_SELECTOR}`) && semanticRole(node)) {
          const turn = node.closest?.(TURN_SELECTOR) || node.closest?.(MESSAGE_SELECTOR) || node.closest?.(SEARCH_UNIT_SELECTOR) || node;
          if (!result.includes(turn) && !result.some((existing) => existing.contains?.(turn))) result.push(turn);
        } else {
          const candidate = node.matches?.('h4.sr-only') ? node.parentElement : node;
          if (candidate && role(candidate)) presentation.push(candidate);
        }
      }
      for (const node of presentation) {
        if (result.some((turn) => turn === node || turn.contains?.(node) || node.contains?.(turn))) continue;
        result.push(node);
      }
      return result.sort(compareDocumentOrder);
    }

    function owner(node) {
      if (!node || excluded(node)) return null;
      const explicit = node.closest?.(TURN_SELECTOR) || node.closest?.(MESSAGE_SELECTOR) || node.closest?.(SEARCH_UNIT_SELECTOR);
      if (explicit && semanticRole(explicit) === 'user') return explicit;
      for (let current = node; current && current !== currentTurnContainer(node); current = current.parentElement) {
        if (markerAssistant(current)) return current;
      }
      if (explicit && semanticRole(explicit)) return explicit;
      for (let current = node; current; current = current.parentElement) {
        if (role(current)) return current;
      }
      return null;
    }

    function key(node) {
      if (!node || excluded(node)) return '';
      const turn = owner(node) || node;
      const message = turn.matches?.(MESSAGE_SELECTOR) ? turn : turn.querySelector?.(MESSAGE_SELECTOR);
      // Indices, test IDs, text hashes and React node references are not
      // logical identities. Anonymous nodes remain diagnostic observations.
      const containerKey = currentTurnContainer(turn)?.getAttribute?.('data-turn-key');
      const turnRole = role(turn);
      const body = turnRole === 'assistant' ? turn.querySelector?.('[data-response-body]') : null;
      const units = Array.from(turn.querySelectorAll?.(SEARCH_UNIT_SELECTOR) || []).filter(unit => searchRole(unit) === turnRole);
      const unitId = units.length === 1 ? searchMessageId(units[0]) : '';
      return turn.getAttribute?.('data-turn-id')
        || turn.getAttribute?.('data-turn-id-container')
        || turn.getAttribute?.('data-message-id')
        || message?.getAttribute?.('data-message-id') || searchMessageId(turn) || body?.getAttribute?.('data-response-body') || unitId
        || (containerKey && turnRole ? `${containerKey}::${turnRole}` : '');
    }

    function credibleMessage(node) {
      return node?.matches?.('[data-message-author-role="assistant"]')
        && Boolean(node.getAttribute?.('data-message-id') || node.getAttribute?.('data-message-model-slug')
          || node.hasAttribute?.('data-turn-start-message') || node.matches?.('.markdown')
          || node.querySelector?.('.markdown, [data-start][data-end], pre, code'));
    }

    function getFinalAssistantNode(root) {
      if (!root || excluded(root) || role(root) === 'user') return null;
      if (credibleMessage(root) && finalAnswerCandidate(root, root)) return root;
      const canonical = Array.from(root.querySelectorAll?.('[data-message-author-role="assistant"]') || [])
        .find((node) => credibleMessage(node) && finalAnswerCandidate(root, node));
      if (canonical) return canonical;
      if (role(root) === 'assistant') {
        const body = Array.from(root.querySelectorAll?.('[data-response-body]') || [])
          .filter(node => finalAnswerCandidate(root, node)).at(-1);
        return body || finalAnswerNode(root);
      }
      return Array.from(root.querySelectorAll?.('h4.sr-only') || [])
        .map((heading) => heading.parentElement)
        .filter((node) => !excluded(node) && role(node) === 'assistant')
        .map(finalAnswerNode).find(Boolean) || null;
    }

    function selectAssistantForSubmittedUser(records, userKey, selectLegacyAssistant) {
      const user = records.find(record => record.key === userKey && record.role === 'user');
      if (!user) return null;
      const container = currentTurnContainer(user.turn);
      const boundary = records.find(record => record.role === 'user' && record.index > user.index);
      const scoped = records.filter(record => !boundary || record.index < boundary.index);
      if (!container) return selectLegacyAssistant(scoped, userKey);
      return scoped.filter(record => record.role === 'assistant' && record.index > user.index
        && currentTurnContainer(record.turn) === container).at(-1) || null;
    }

    return Object.freeze({
      currentTurnContainer,
      selectAssistantForSubmittedUser,
      getAssistantNodes: () => getTurnNodes().filter((node) => role(node) === 'assistant'),
      getFinalAssistantNode,
      getTurnNodes,
      key,
      role,
      owner,
      excluded,
    });
  }

  globalThis.ChatGptTurnDom = Object.freeze({ createTurnDom });
})();
