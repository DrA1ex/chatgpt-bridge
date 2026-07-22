// Request command composition root. Command-family policy lives in focused modules.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createRequestCommands(deps = {}) {
    const { REQUEST_STATE, findStopButton, isGenerating } = deps;
    if (!REQUEST_STATE || typeof REQUEST_STATE.createRequestState !== 'function' || typeof REQUEST_STATE.publicRequestStatus !== 'function') {
      throw new TypeError('Request commands require REQUEST_STATE');
    }
    const supportFactory = globalThis.ChatGptRequestCommandSupport;
    const resumeFactory = globalThis.ChatGptRequestResumeCommands;
    const promptFactory = globalThis.ChatGptRequestPromptCommands;
    const reconciliationFactory = globalThis.ChatGptRequestEffectReconciliation;
    if (!supportFactory || !resumeFactory || !promptFactory || !reconciliationFactory) {
      throw new TypeError('Request command family modules are unavailable');
    }

    function publicRequestStatus(request) {
      const stopButtonVisible = Boolean(findStopButton());
      return REQUEST_STATE.publicRequestStatus(request, {
        generating: stopButtonVisible || isGenerating(),
        stopButtonVisible,
        url: location.href,
        title: document.title,
      });
    }

    const requestCommandSupport = supportFactory.createRequestCommandSupport(deps);
    const promptCommands = promptFactory.createRequestPromptCommands({ ...deps, requestCommandSupport });
    const resumeCommands = resumeFactory.createRequestResumeCommands({ ...deps, publicRequestStatus });
    const reconciliation = reconciliationFactory.createRequestEffectReconciliation(deps);

    return Object.freeze({
      ...promptCommands,
      ...resumeCommands,
      ...reconciliation,
      publicRequestStatus,
    });
  }

  globalThis.ChatGptRequestCommands = Object.freeze({ createRequestCommands });
})();
