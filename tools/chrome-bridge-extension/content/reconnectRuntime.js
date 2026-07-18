// Content-runtime reconnect handshake policy.
// Recovery must never prevent a protocol hello from reaching the bridge.
(() => {
  'use strict';

  function recoverForHandshake(executionStore, recovery = {}) {
    const requestId = String(recovery?.lease?.requestId || '');
    if (!recovery?.lease) return { accepted: true, requestId, error: '' };
    try {
      const outcome = executionStore.recover(recovery);
      if (outcome.accepted) return { accepted: true, requestId, error: '' };
      return {
        accepted: false,
        requestId,
        error: String(outcome.error?.message || outcome.reason || 'request recovery failed'),
      };
    } catch (error) {
      return {
        accepted: false,
        requestId,
        error: String(error?.message || error || 'request recovery failed'),
      };
    }
  }

  globalThis.ChatGptReconnectRuntime = Object.freeze({ recoverForHandshake });
})();
