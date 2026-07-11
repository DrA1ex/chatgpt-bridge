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

The old Tampermonkey userscript fallback has been removed from supported setup.

File and artifact handling:

- The content script drives the ChatGPT DOM: it attaches `File` objects to the composer and parses generated-file cards across the anchored assistant turn, including button-only files without `href`.
- `artifactCaptureMain.js` runs in the page MAIN world. Around one scoped artifact click it observes page-created Blob/data/URL downloads and can return Blob bytes without leaving a duplicate temporary file in the user's Downloads folder.
- The isolated content script can also fetch a direct/authenticated URL exposed by the file card after the click.
- The background service worker owns privileged browser APIs: localhost fetches, WebSocket transport, and the final `chrome.downloads` fallback. The fallback is bound to the originating tab and expected filename; unrelated downloads are ignored.
- The first successful materialization path wins. Page and background captures are explicitly cancelled afterward.
- For ordinary input attachments, the Node bridge reads local paths itself and exposes signed localhost URLs. The extension fetches those URLs outside page CSP and turns them into page `File` objects.

If artifact download capture does not work, reload the unpacked extension after manifest changes. Also confirm the extension has the `downloads` permission and that Chrome is allowed to complete the download without a blocked-danger prompt.

Tab/session targeting and request ownership:

- For a prompt with a known conversation id, the Node bridge prefers an idle connected tab already on that session.
- Reusing an idle tab on another session requires confirmation in interactive mode; the content script verifies the `/c/<sessionId>` URL before inserting the prompt.
- A full navigation reload reconnects the content script and the server may resend the same request id. Duplicate delivery is idempotent.
- Tabs reporting an active request are busy and are not reused. The active request includes `ownerServerInstanceId` when available so a reconnect does not silently steal another bridge process's work. This is ownership metadata, not a distributed cross-server lease.
- Watchdog forced snapshots are bound to the original source tab and assistant turn; they never read a global latest response from another tab.
