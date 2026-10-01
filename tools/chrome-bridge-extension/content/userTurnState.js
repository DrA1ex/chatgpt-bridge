// User-turn prompt extraction and explicit ChatGPT submission errors.
// Loaded before requestPromptCommands.js and turnSnapshots.js.
(() => {
  'use strict';

  const TRANSIENT_ERROR_PATTERNS = Object.freeze([
    /^что-то пошло не так[.!]?\s*попробуйте (?:еще|ещё) раз[.!]?$/i,
    /^something went wrong[.!]?\s*(?:please )?try again[.!]?$/i,
  ]);
  const USER_MESSAGE_SELECTOR = '[data-message-author-role="user"], [data-chatgpt-search-message-ids]:not([data-content-search-unit-key]), [data-chatgpt-search-message-ids][class~="group/user-message"]';

  function createUserTurnState(deps = {}) {
    const { getTurnNodes, isVisible, normalizeText, turnKey, turnRole, visibleText } = deps;

    function userMessageRoot(turn) {
      if (!turn?.querySelector) return null;
      return turn.matches?.(USER_MESSAGE_SELECTOR)
        ? turn
        : turn.querySelector(USER_MESSAGE_SELECTOR);
    }

    function userPromptRoot(turn) {
      const root = userMessageRoot(turn);
      if (!root?.querySelector) return null;
      return root.querySelector('.user-message-bubble-color, [data-testid="user-message"], [data-testid="user-message-content"]')
        || Array.from(root.children || []).find((child) => {
          if (!isVisible(child)) return false;
          if (child.matches?.('[role="group"], button, [data-testid*="turn-action" i], [data-testid*="message-action" i]')) return false;
          if (child.querySelector?.('[role="group"], [data-testid*="turn-action" i], [data-testid*="message-action" i]')) return false;
          return Boolean(visibleText(child));
        })
        || null;
    }

    function readUserTurnPromptText(turn) {
      if (!turn || turnRole(turn) !== 'user') return '';
      const promptRoot = userPromptRoot(turn);
      return normalizeText(promptRoot ? visibleText(promptRoot) : visibleText(userMessageRoot(turn) || turn));
    }

    function emptyError() {
      return { hasError: false, text: '', code: '', kind: '', retryable: false, userTurnKey: '' };
    }

    function classifyUserTurnError(turn) {
      if (!turn || turnRole(turn) !== 'user') return emptyError();
      const root = userMessageRoot(turn) || turn;
      const promptRoot = userPromptRoot(turn);
      const candidate = Array.from(root.querySelectorAll?.('div, p, span') || [])
        .filter((element) => {
          if (!isVisible(element)) return false;
          if (promptRoot && (element === promptRoot || promptRoot.contains?.(element) || element.contains?.(promptRoot))) return false;
          if (element.closest?.('button, [role="button"], [role="group"], [data-testid*="turn-action" i], [data-testid*="message-action" i]')) return false;
          const text = normalizeText(visibleText(element));
          return text && TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
        })
        .sort((left, right) => (left.children?.length || 0) - (right.children?.length || 0))[0] || null;
      if (!candidate) return emptyError();
      return {
        hasError: true,
        text: normalizeText(visibleText(candidate)),
        code: 'CHATGPT_TRANSIENT_REQUEST_ERROR',
        kind: 'transient_request_error',
        retryable: true,
        userTurnKey: turnKey(turn, getTurnNodes().indexOf(turn)),
      };
    }

    function readSubmittedUserTurnError(request) {
      const expectedKey = String(request?.submittedUserTurnKey || '');
      if (!expectedKey) return emptyError();
      const turns = getTurnNodes();
      for (let index = 0; index < turns.length; index += 1) {
        const turn = turns[index];
        if (turnRole(turn) !== 'user' || turnKey(turn, index) !== expectedKey) continue;
        return classifyUserTurnError(turn);
      }
      return emptyError();
    }

    return Object.freeze({ classifyUserTurnError, readSubmittedUserTurnError, readUserTurnPromptText });
  }

  globalThis.ChatGptUserTurnState = Object.freeze({ createUserTurnState });
})();
