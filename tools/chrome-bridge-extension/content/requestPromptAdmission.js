// Prompt-send admission check, loaded before requestPromptCommands.js.
(() => {
  'use strict';

  function requireNewUserTurnAnchor({ anchor, baseline, request, setRequestPhase }) {
    const key = String(anchor?.key || '');
    if (!key || baseline.has(key) || String(request.submittedUserTurnKey || '') !== key) {
      setRequestPhase(request, 'waiting_for_user_turn', { meaningful: false });
      const error = new Error('PROMPT_USER_TURN_ADMISSION_UNCONFIRMED: ChatGPT did not expose a new matching user turn for this prompt submission');
      error.code = 'PROMPT_USER_TURN_ADMISSION_UNCONFIRMED';
      throw error;
    }
    return key;
  }

  globalThis.ChatGptRequestPromptAdmission = Object.freeze({ requireNewUserTurnAnchor });
})();
