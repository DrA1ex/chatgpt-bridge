// Current ChatGPT turn-key DOM discovery, alongside legacy turn selectors.
// Loaded before content/turnSnapshots.js.
(() => {
  'use strict';

  const LEGACY_TURN_SELECTOR = '[data-testid^="conversation-turn-"][data-turn],section[data-turn][data-turn-id],main section[data-turn],[role="main"] section[data-turn]';
  const USER_TURN_MESSAGE_SELECTOR = '[data-chatgpt-search-message-ids]';
  const ASSISTANT_TURN_START_SELECTOR = '[data-chatgpt-agent-turn-start]';
  const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';
  const TURN_SELECTOR = `${LEGACY_TURN_SELECTOR},[data-turn-key],${USER_TURN_MESSAGE_SELECTOR},${ASSISTANT_TURN_START_SELECTOR},${ASSISTANT_MESSAGE_SELECTOR}`;

  function createCurrentTurnDom({
    normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim(),
    visibleText = (node) => String(node?.innerText || node?.textContent || ''),
  } = {}) {

    function isCurrentUserMessage(node) {
      if (!node?.matches?.(USER_TURN_MESSAGE_SELECTOR)) return false;
      if (node.classList?.contains?.('group/user-message')) return true;
      if (node.closest?.('[data-turn="user"], [data-message-author-role="user"]')) return true;
      return !node.hasAttribute?.('data-content-search-unit-key');
    }

    function compareDocumentOrder(left, right) {
      const position = left?.compareDocumentPosition?.(right) || 0;
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    }

    function currentAssistantNodeFromMarker(marker, turnContainer, userMarkers = []) {
      if (!marker) return null;
      let current = marker;
      let candidate = marker;
      while (current?.parentElement && current.parentElement !== turnContainer) {
        const parent = current.parentElement;
        if (userMarkers.some((userMarker) => parent === userMarker || parent.contains?.(userMarker))) break;
        const markerBranch = Array.from(parent.children || []).find((child) => child === current || child.contains?.(current)) || current;
        const siblings = Array.from(parent.children || []).filter((child) => child !== markerBranch);
        if (siblings.some((sibling) => normalizeText(visibleText(sibling)))) return parent;
        const directText = Array.from(parent.childNodes || []).some((child) => child.nodeType === Node.TEXT_NODE && normalizeText(child.textContent || ''));
        if (directText) return parent;
        current = parent;
        candidate = parent;
      }
      return candidate === marker ? null : candidate;
    }

    function currentAssistantNode(marker) {
      const turnContainer = marker?.closest?.('[data-turn-key]');
      if (!turnContainer) return null;
      const userMarkers = Array.from(turnContainer.querySelectorAll?.(USER_TURN_MESSAGE_SELECTOR) || [])
        .filter((node) => node.closest?.('[data-turn-key]') === turnContainer)
        .filter(isCurrentUserMessage);
      return currentAssistantNodeFromMarker(marker, turnContainer, userMarkers);
    }

    function getFinalAssistantNode(root, isCredibleAssistantNode) {
      if (!root) return null;
      if (isCredibleAssistantNode(root)) return root;
      const legacy = Array.from(root.querySelectorAll?.('[data-message-author-role="assistant"]') || []).find(isCredibleAssistantNode);
      if (legacy) return legacy;
      for (const marker of Array.from(root.querySelectorAll?.(ASSISTANT_TURN_START_SELECTOR) || []).reverse()) {
        const assistant = currentAssistantNode(marker);
        if (assistant && isCredibleAssistantNode(assistant)) return assistant;
      }
      return null;
    }

    function getTurnNodesFromMatches(matchedNodes = []) {
      const nodes = Array.from(matchedNodes || []);
      const legacyTurns = nodes.filter((node) => node.matches?.(LEGACY_TURN_SELECTOR));
      const turnContainers = nodes.filter((node) => node.matches?.('[data-turn-key]'))
        .filter((node) => String(node.getAttribute('data-turn-key') || '').trim());
      const userMarkers = nodes.filter(isCurrentUserMessage);
      const assistantMarkers = nodes.filter((node) => node.matches?.(ASSISTANT_TURN_START_SELECTOR));
      const currentTurns = [];

      for (const turnContainer of turnContainers) {
        const users = userMarkers.filter((node) => node.closest?.('[data-turn-key]') === turnContainer);
        const assistants = assistantMarkers.filter((node) => node.closest?.('[data-turn-key]') === turnContainer);
        currentTurns.push(...users);
        for (const marker of assistants) {
          const assistantNode = currentAssistantNodeFromMarker(marker, turnContainer, users);
          if (assistantNode) currentTurns.push(assistantNode);
        }
      }

      // Preserve the legacy observer fallback for assistant message roots that
      // have no conversation-turn wrapper. Keyed and wrapped messages are
      // already represented by their enclosing turn/assistant branch.
      const standaloneAssistantMessages = nodes.filter((node) => node.matches?.(ASSISTANT_MESSAGE_SELECTOR))
        .filter((node) => !legacyTurns.some((turn) => turn !== node && turn.contains?.(node)))
        .filter((node) => !currentTurns.some((turn) => turn !== node && turn.contains?.(node)));

      return Array.from(new Set([...legacyTurns, ...currentTurns, ...standaloneAssistantMessages])).sort(compareDocumentOrder);
    }

    function getTurnNodes(root) {
      return getTurnNodesFromMatches(Array.from(root.querySelectorAll(TURN_SELECTOR)));
    }

    function turnRole(turn) {
      if (isCurrentUserMessage(turn)) return 'user';
      if (turn?.matches?.(ASSISTANT_TURN_START_SELECTOR)
        || (turn?.querySelector?.(ASSISTANT_TURN_START_SELECTOR)
          && !isCurrentUserMessage(turn)
          && !Array.from(turn.querySelectorAll?.(USER_TURN_MESSAGE_SELECTOR) || []).some(isCurrentUserMessage))) return 'assistant';
      return '';
    }

    function currentTurnKey(turn, role = turnRole(turn)) {
      const key = currentTurnIdentity(turn);
      return key ? `${key}::${role || 'turn'}` : '';
    }

    function currentTurnIdentity(turn) {
      return String(turn?.closest?.('[data-turn-key]')?.getAttribute?.('data-turn-key') || '').trim();
    }

    function currentTurnContainer(turn) {
      return turn?.closest?.('[data-turn-key]') || null;
    }

    function selectAssistantForSubmittedUser(records, userKey, selectLegacyAssistant) {
      const user = records.find((record) => record.key === userKey && record.role === 'user');
      const identity = currentTurnIdentity(user?.turn);
      if (!identity) return selectLegacyAssistant(records, userKey);
      return records.filter((record) => record.role === 'assistant'
        && currentTurnIdentity(record.turn) === identity).at(-1) || null;
    }

    function turnKey(turn, finalNode, role) {
      if (!turn) return '';
      const existingKey = turn.getAttribute?.('data-turn-id')
        || finalNode?.getAttribute?.('data-message-id')
        || turn.getAttribute?.('data-message-id')
        || turn.getAttribute?.('data-turn-id-container');
      if (existingKey) return existingKey;
      return currentTurnKey(turn, role);
    }

    function requestTurnRecords(root, options = {}) {
      const turns = getTurnNodes(root);
      return turns.map((turn, index) => ({
        turn,
        index,
        key: options.turnKey(turn, index),
        role: options.turnRole(turn),
        text: options.includeText
          ? (options.turnRole(turn) === 'user' ? options.readUserTurnPromptText(turn) : options.visibleText(turn))
          : '',
      }));
    }

    function isCurrentAssistantNode(node) {
      return Boolean(node?.matches?.(ASSISTANT_TURN_START_SELECTOR)
        || (node?.querySelector?.(ASSISTANT_TURN_START_SELECTOR)
          && !isCurrentUserMessage(node)
          && !Array.from(node.querySelectorAll?.(USER_TURN_MESSAGE_SELECTOR) || []).some(isCurrentUserMessage)));
    }

    return Object.freeze({ getTurnNodes, getTurnNodesFromMatches, requestTurnRecords, currentAssistantNode, currentTurnContainer, currentTurnIdentity, getFinalAssistantNode, currentTurnKey, selectAssistantForSubmittedUser, turnKey, isCurrentAssistantNode, isCurrentUserMessage, turnRole });
  }

  globalThis.ChatGptCurrentTurnDom = Object.freeze({ createCurrentTurnDom, TURN_SELECTOR });
})();
