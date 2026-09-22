// Turn-scoped action, confirmation, and generic error signals.
// Loaded before turnSnapshots.js.
(() => {
  'use strict';

  function createTurnUiSignals(deps = {}) {
    const { buttonSignalText, findChatMain, isVisible, visibleText } = deps;

    const turnDom = globalThis.ChatGptTurnDom.createTurnDom();

    function ownsSignal(turn, element) {
      if (turnDom.excluded(element)) return false;
      const owner = turnDom.owner(element);
      return !owner || owner === (turnDom.owner(turn) || turn);
    }

    function responseActionBarVisible(turn) {
      if (!turn?.querySelectorAll) return false;
      const copy = Array.from(turn.querySelectorAll('[data-testid="copy-turn-action-button"]')).find(isVisible);
      if (copy) return true;
      return Array.from(turn.querySelectorAll('[role="group"][aria-label], [data-testid*="turn-action" i], [data-testid*="message-action" i]'))
        .some((group) => isVisible(group) && /action|response|message|действ|ответ/i.test(`${group.getAttribute('aria-label') || ''} ${group.getAttribute('data-testid') || ''}`));
    }

    function readConfirmationState(turn) {
      const root = turn?.closest?.('main') || turn?.closest?.('[role="main"]') || turn || findChatMain();
      if (!root?.querySelectorAll) return false;
      return Array.from(root.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-testid*="confirm" i], [data-testid*="approval" i]'))
        .some((element) => {
          if (!isVisible(element) || !ownsSignal(turn, element)) return false;
          const buttons = Array.from(element.querySelectorAll('button, [role="button"]')).filter(isVisible);
          const text = `${visibleText(element)} ${buttons.map(buttonSignalText).join(' ')}`;
          return buttons.length > 0 && /confirm|allow|approve|continue|разреш|подтверд|одобр/i.test(text);
        });
    }

    function readErrorState(turn) {
      const root = turn?.closest?.('main') || turn?.closest?.('[role="main"]') || findChatMain() || turn;
      if (!root?.querySelectorAll) return { hasError: false, text: '' };
      const candidate = Array.from(root.querySelectorAll('[role="alert"], [data-testid*="error" i], [data-testid*="rate-limit" i]'))
        .find((element) => {
          if (!isVisible(element) || !ownsSignal(turn, element)) return false;
          const text = visibleText(element);
          return /error|failed|something went wrong|rate limit|try again|ошиб|не удалось|лимит/i.test(text);
        });
      return { hasError: Boolean(candidate), text: candidate ? visibleText(candidate) : '' };
    }

    return Object.freeze({ readConfirmationState, readErrorState, responseActionBarVisible });
  }

  globalThis.ChatGptTurnUiSignals = Object.freeze({ createTurnUiSignals });
})();
