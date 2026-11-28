// Turn ownership and identity shared by live observation and recovery.
// Presentation-only message shapes are readable, but never invent durable IDs.
(() => {
  'use strict';

  function createTurnDom() {
    const TURN_SELECTOR = '[data-turn="user"], [data-turn="assistant"]';
    const MESSAGE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';

    // A virtualized turn may own both roles; a search unit owns one.
    const SEARCH_UNIT_SELECTOR = '[data-chatgpt-search-unit-key][data-chatgpt-search-message-ids]';

    const ASSISTANT_MARKER = '[data-chatgpt-agent-turn-start], [data-conversation-role="assistant"]';
    const USER_BUBBLE_SELECTOR = '[data-user-message-bubble], .bg-user-message';

    function searchRole(node) {
      const explicit = node?.getAttribute?.('data-chatgpt-search-unit-key')?.match(/:(user|assistant)$/)?.[1];
      if (explicit) return explicit;
      if (node?.matches?.('[data-chatgpt-search-message-ids][class~="group/user-message"]')) return 'user';
      return '';
    }

    const currentTurnContainer = node => node?.closest?.('[data-turn-key]') || null;

    function assistantBranch(marker) {
      // The activity and final response are sibling blocks in one TALVT
      // turn. Prefer the actual agent-start branch as their shared identity;
      // the hidden final placeholder must not become a second assistant.
      const grouped = marker?.closest?.('[data-talvt-turn-state]');
      marker = grouped?.querySelector?.('[data-chatgpt-agent-turn-start]') || marker;
      const container = currentTurnContainer(marker);
      if (!container) return null;
      const containsUser = root => Boolean(root?.querySelector?.(`${USER_BUBBLE_SELECTOR}, [data-turn="user"], [data-message-author-role="user"]`)
        || Array.from(root?.querySelectorAll?.(SEARCH_UNIT_SELECTOR) || []).some(node => searchRole(node) === 'user'));
      let branch = marker.parentElement;
      if (!branch || branch === container || containsUser(branch)) {
        // A rendered role root can itself be the assistant branch. A hidden
        // heading alone cannot establish one if its parent also owns the user.
        return marker.matches?.('[data-conversation-role="assistant"]') && !excluded(marker)
          && !marker.matches?.('h4, span') && !containsUser(marker) ? marker : null;
      }
      while (branch.parentElement && branch.parentElement !== container) {
        const parent = branch.parentElement;
        if (containsUser(parent)) break;
        branch = parent;
      }
      return branch;
    }

    function markerAssistant(node) {
      if (!node || !currentTurnContainer(node)) return false;
      return (node.matches?.(ASSISTANT_MARKER) && assistantBranch(node) === node)
        || Array.from(node.querySelectorAll?.(ASSISTANT_MARKER) || []).some(marker => assistantBranch(marker) === node);
    }

    function searchMessageIds(node) {
      return [...new Set(String(node?.getAttribute?.('data-chatgpt-search-message-ids') || '').split(/\s+/)
        .filter(id => id && !/^fallback-turn-/i.test(id)))];
    }

    function searchMessageId(node) {
      const ids = searchMessageIds(node);
      if (searchRole(node) === 'assistant') {
        const body = Array.from(node.querySelectorAll?.('[data-response-body]') || [])
          .filter(candidate => !excluded(candidate) && ids.includes(candidate.getAttribute('data-response-body'))).at(-1);
        if (body) return body.getAttribute('data-response-body');
      }
      return ids.length === 1 ? ids[0] : '';
    }

    function groupedTurnState(root) {
      const node = root?.matches?.('[data-talvt-turn-state]') ? root
        : root?.closest?.('[data-talvt-turn-state]') || root?.querySelector?.('[data-talvt-turn-state]');
      const state = node?.getAttribute?.('data-talvt-turn-state') || '';
      return ['in_progress', 'complete'].includes(state) ? state : '';
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

    function firstStatusBoundary(root) {
      if (!currentTurnContainer(root)) return null;
      return Array.from(root.querySelectorAll?.('[data-streaming-response-status]') || [])
        .find(node => !excluded(node) && (globalThis.ChatGptDomUtilities.isVisible?.(node) ?? true)) || null;
    }

    function finalAnswerCandidate(candidate, firstStatus) {
      if (!candidate || excluded(candidate) || candidate.closest?.(ACTIVITY_SELECTOR)) return false;
      // Only the first status boundary excludes earlier commentary. A later
      // tool status must not reclassify already visible answer blocks.
      return !firstStatus || (!candidate.contains?.(firstStatus) && compareDocumentOrder(candidate, firstStatus) >= 0);
    }

    function finalAnswerNode(root, firstStatus = firstStatusBoundary(root)) {
      const result = markdownNodes(root).filter(node => finalAnswerCandidate(node, firstStatus));
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
      if (node?.matches?.(USER_BUBBLE_SELECTOR)) return 'user';
      if (Array.from(node?.children || []).some((child) => child.matches?.('h4.sr-only'))
        && markdownNodes(node).length) return 'assistant';
      return '';
    }

    function getTurnNodes() {
      // Resolve each message to its owning turn. Do not switch the entire page
      // to one selector family when wrapped and unwrapped messages coexist.
      const result = [];
      const presentation = [];
      const DISCOVERY_SELECTOR = `${TURN_SELECTOR}, ${MESSAGE_SELECTOR}, ${SEARCH_UNIT_SELECTOR}, ${ASSISTANT_MARKER}, ${USER_BUBBLE_SELECTOR}, h4.sr-only`;
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
          const turn = owner(node) || node;
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
      const grouped = node.closest?.('[data-talvt-turn-state]');
      const start = grouped?.querySelector?.('[data-chatgpt-agent-turn-start]');
      if (start && (semanticRole(explicit) === 'assistant' || node.closest?.('[data-conversation-role="assistant"]'))) {
        return assistantBranch(start);
      }
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
      // In the grouped renderer, commentary bodies, the placeholder and
      // the final answer have different IDs. The logical assistant turn
      // stays the same throughout generation; the final message ID is
      // published independently from the answer body.
      if (turnRole === 'assistant' && containerKey && groupedTurnState(turn)) return `${containerKey}::assistant`;
      const body = turnRole === 'assistant' ? Array.from(turn.querySelectorAll?.('[data-response-body]') || [])
        .filter(candidate => !excluded(candidate)).at(-1) : null;
      const units = Array.from(turn.querySelectorAll?.(SEARCH_UNIT_SELECTOR) || []).filter(unit => searchRole(unit) === turnRole);
      const unitId = units.length === 1 ? searchMessageId(units[0]) : '';
      return turn.getAttribute?.('data-turn-id')
        || turn.getAttribute?.('data-turn-id-container')
        || turn.getAttribute?.('data-message-id')
        || message?.getAttribute?.('data-message-id') || searchMessageId(turn) || unitId || body?.getAttribute?.('data-response-body')
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
      const state = groupedTurnState(root);
      if (state) {
        const scope = root.closest?.('[data-talvt-turn-state]') || root;
        const units = [...(scope.matches?.(SEARCH_UNIT_SELECTOR) ? [scope] : []),
          ...Array.from(scope.querySelectorAll?.(SEARCH_UNIT_SELECTOR) || [])]
          .filter(unit => searchRole(unit) === 'assistant' && !excluded(unit));
        // Real grouped markup places interim commentary outside the
        // assistant search unit. While working, that unit can contain a
        // synthetic fallback-turn-0 instead of a final message.
        if (units.length || state === 'in_progress') {
          const bodies = units.flatMap(unit => {
            const ids = searchMessageIds(unit);
            return Array.from(unit.querySelectorAll?.('[data-response-body]') || [])
              .filter(body => ids.includes(body.getAttribute('data-response-body'))
                && finalAnswerCandidate(body, null));
          });
          return bodies.at(-1) || null;
        }
      }
      const firstStatus = firstStatusBoundary(root);
      if (credibleMessage(root) && finalAnswerCandidate(root, firstStatus)) return root;
      const canonical = Array.from(root.querySelectorAll?.('[data-message-author-role="assistant"]') || [])
        .find((node) => credibleMessage(node) && finalAnswerCandidate(node, firstStatus));
      if (canonical) return canonical;
      if (role(root) === 'assistant') {
        const body = Array.from(root.querySelectorAll?.('[data-response-body]') || [])
          .filter(node => finalAnswerCandidate(node, firstStatus)).at(-1);
        return body || finalAnswerNode(root, firstStatus);
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
      groupedTurnState,
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
