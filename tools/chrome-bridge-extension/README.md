# ChatGPT Browser Bridge extension

This is the preferred browser companion runtime. It keeps a WebSocket from the extension background service worker to the local Node bridge, then relays commands/events to the content script running on ChatGPT pages.

Why this exists:

- ChatGPT page CSP can block `new WebSocket('ws://127.0.0.1:8080')` from a userscript/page context.
- Tampermonkey networking can introduce polling/event batching delays.
- Extension host permissions allow the background worker to talk to localhost and fetch local signed file URLs without page CSP.

Install during development:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click “Load unpacked”.
4. Select this `tools/chrome-bridge-extension` folder.
5. Open or reload `https://chatgpt.com`.
6. In the floating Bridge panel select `Extension WebSocket`, paste Server URL and Bridge token from `/setup`, then Save & Connect.

The Tampermonkey userscript remains available as fallback.


File and artifact handling:

- The content script still drives the ChatGPT DOM: it attaches `File` objects to the composer and extracts visible artifact links/buttons.
- The background service worker owns privileged browser APIs: localhost fetches, WebSocket transport, and `chrome.downloads` capture.
- When a ChatGPT artifact button starts a browser download without exposing a direct URL, the content script arms a download capture before clicking. The background worker waits for the completed download and returns its local filename to the Node bridge. Node then imports that path into `DATA_DIR/artifacts`.
- For ordinary input attachments, the Node bridge reads local paths itself and exposes signed localhost URLs. The extension fetches those URLs outside page CSP and turns them into page `File` objects.

If artifact download capture does not work, confirm the extension has the `downloads` permission and that Chrome is allowed to complete the download without a blocked-danger prompt.
