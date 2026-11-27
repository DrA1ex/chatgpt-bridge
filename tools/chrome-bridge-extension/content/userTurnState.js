// User-turn prompt extraction and explicit ChatGPT submission errors.
// Loaded before requestPromptCommands.js and turnSnapshots.js.
(() => {
  'use strict';

  const TRANSIENT_ERROR_PATTERNS = Object.freeze([
    /^что-то пошло не так[.!]?\s*попробуйте (?:еще|ещё) раз[.!]?$/i,
    /^something went wrong[.!]?\s*(?:please )?try again[.!]?$/i,
  ]);
  const USER_MESSAGE_SELECTOR = '[data-message-author-role="user"], [data-chatgpt-search-unit-key], [data-chatgpt-search-message-ids][class~="group/user-message"]';

  function createUserTurnState(deps = {}) {
    const { getTurnNodes, isVisible, normalizeText, turnKey, turnRole, visibleText } = deps;
    const BUBBLE_SELECTOR = '[data-user-message-bubble], .bg-user-message, .user-message-bubble-color, [data-testid="user-message"], [data-testid="user-message-content"]';
    const RICH_SELECTOR = '[data-markdown-text-tone="user-message"].rich-text-user-turn';

    function userMessageRoot(turn) {
      if (!turn?.querySelector) return null;
      return turn.matches?.(USER_MESSAGE_SELECTOR) || turn.matches?.(BUBBLE_SELECTOR)
        ? turn
        : turn.querySelector(USER_MESSAGE_SELECTOR) || turn.querySelector(BUBBLE_SELECTOR);
    }

    function userPromptRoot(turn) {
      const root = userMessageRoot(turn);
      if (!root?.querySelector) return null;
      if (root.matches?.(BUBBLE_SELECTOR)) return root;
      return root.querySelector(BUBBLE_SELECTOR)
        || Array.from(root.children || []).find((child) => {
          if (!isVisible(child)) return false;
          if (child.matches?.('[role="group"], button, [data-testid*="turn-action" i], [data-testid*="message-action" i]')) return false;
          if (child.querySelector?.('[role="group"], [data-testid*="turn-action" i], [data-testid*="message-action" i]')) return false;
          return Boolean(visibleText(child));
        })
        || null;
    }

    // ChatGPT's rich user renderer can remove Markdown fences from the
    // displayed text. Restore only recognized source-bearing structures;
    // unknown markup retains the existing plain-text observation path.
    function readRichPrompt(root) {
      if (!root?.querySelectorAll) return null;
      const rich = root.matches?.(RICH_SELECTOR) ? [root] : Array.from(root.querySelectorAll(RICH_SELECTOR));
      if (rich.length !== 1) return null;
      function read(node) {
        if (node.nodeType === 3) return node.textContent || '';
        if (node.tagName === 'BR') return '\n';
        if (node.matches?.('pre[data-markdown-copy="code-block"]')) {
          const code = node.querySelector('code[data-markdown-copy-content="true"][data-language]');
          if (!code || node.children.length !== 1) return null;
          const language = code.getAttribute('data-language') || '';
          if (/[^a-zA-Z0-9_+#. -]/.test(language)) return null;
          return '```' + language + '\n' + code.textContent + '\n```';
        }
        if (node.tagName === 'A') {
          try {
            const label = node.textContent || '';
            const url = new URL(label);
            if (!['http:', 'https:'].includes(url.protocol) || url.href !== new URL(node.getAttribute('href')).href) return null;
          } catch { return null; }
        } else if (!['DIV', 'SPAN', 'P'].includes(node.tagName)) return null;
        const parts = Array.from(node.childNodes || [], read);
        return parts.some(part => part === null) ? null : parts.join('');
      }
      const blocks = Array.from(rich[0].childNodes || []).filter(node => node.nodeType !== 3 || String(node.textContent || '').trim());
      const parts = [];
      for (const block of blocks) {
        if (block.tagName !== 'P' && !block.matches?.('[data-markdown-copy="blank-lines"], pre[data-markdown-copy="code-block"]')) return null;
        const text = read(block);
        if (text === null) return null;
        parts.push(text + (block.tagName === 'P' || block.tagName === 'PRE' ? '\n' : ''));
      }
      return parts.join('');
    }

    function readUserTurnPromptText(turn) {
      if (!turn || turnRole(turn) !== 'user') return '';
      const promptRoot = userPromptRoot(turn);
      const rich = readRichPrompt(promptRoot);
      return normalizeText(rich ?? (promptRoot ? visibleText(promptRoot) : visibleText(userMessageRoot(turn) || turn)));
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
