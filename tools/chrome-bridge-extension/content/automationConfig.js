(() => {
  'use strict';

  // The controller replaces this file in its private, machine-local launch
  // copy with the Bridge connection details.  Keeping the source values empty
  // means no credential is ever committed to the extension bundle.
  if (globalThis.ChatGptBridgeAutomationConfig) return;
  globalThis.ChatGptBridgeAutomationConfig = Object.freeze({
    serverUrl: '',
    token: '',
  });
})();
