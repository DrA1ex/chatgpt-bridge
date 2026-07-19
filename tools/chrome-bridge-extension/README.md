# ChatGPT Browser Bridge extension

This is the preferred browser companion runtime. It keeps a WebSocket from the extension background service worker to the local Node bridge, then relays commands/events to the content script running on ChatGPT pages.

Why this exists:

- The page context is intentionally isolated from localhost transport.
- The extension background service worker owns the bridge WebSocket and reconnect lifecycle.
- Extension host permissions allow the background worker to talk to localhost and fetch local signed file URLs without page CSP.

Install during development:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click “Load unpacked”.
4. Select this `tools/chrome-bridge-extension` folder.
5. Open or reload `https://chatgpt.com`.
6. Open an actual ChatGPT chat, hover the tucked-away Bridge tab to reveal it, then click it, paste the Server URL and Bridge token from `/setup`, then press Save & connect. The button is intentionally hidden on non-chat ChatGPT pages.

Only the extension background WebSocket runtime is supported.

Version compatibility:

- The content script reports the extension manifest version, content runtime version, and extension protocol version in its hello handshake.
- The server reports its bridge version and minimum/recommended extension version.
- Incompatible clients remain visible for diagnostics but cannot receive prompts or be selected.
- The panel opens with an explicit update instruction when the extension or bridge must be updated.
- Follow the manifest version policy in the repository `AGENT.MD`; do not increment the version as an arbitrary build number.

The setup panel is onboarding-first. Raw state, local logs, and diagnostic actions are collapsed under `Advanced & diagnostics` rather than shown as the default UI.

File and artifact handling:

- The content script drives the ChatGPT DOM: it attaches `File` objects to the composer and parses generated-file cards across the anchored assistant turn, including button-only files without `href`.
- `artifactCaptureMain.js` runs in the page MAIN world. Around one scoped artifact click it observes page-created Blob/data/URL downloads and can return Blob bytes without leaving a duplicate temporary file in the user's Downloads folder.
- The isolated content script can also fetch a direct/authenticated URL exposed by the file card after the click.
- The background service worker owns privileged browser APIs: localhost fetches, WebSocket transport, and `chrome.downloads`. Exact HTTPS artifact anchors are started there with the already-armed capture ID instead of being clicked in the ChatGPT tab; button-only and preview actions remain scoped DOM clicks. Every download capture is bound to the originating tab and expected filename, and unrelated downloads are ignored.
- The first successful materialization path wins. Page and background captures are explicitly cancelled afterward.
- A file button may omit its filename. The Node resolver may materialize the only scoped file action and confirm its type from ZIP bytes; the extension must preserve source-turn locator metadata even when the visible label is generic.
- For ordinary input attachments, the Node bridge reads local paths itself and exposes signed localhost URLs. The extension fetches those URLs outside page CSP and turns them into page `File` objects.

If artifact download capture does not work, reload the unpacked extension after manifest changes. Also confirm the extension has the `downloads` permission and that Chrome is allowed to complete the download without a blocked-danger prompt.

Tab/session targeting and request ownership:

- For a prompt with a known conversation id, the Node bridge prefers an idle connected tab already on that session.
- Reusing an idle tab on another session requires confirmation in interactive mode; the content script verifies the `/c/<sessionId>` URL before inserting the prompt.
- A full navigation reload creates a new content epoch. Background restores the persisted lease, effect ledger, and critical outbox; dispatched-but-unconfirmed writes become uncertain and are reconciled rather than repeated.
- Tabs reporting an active request are busy and are not reused. Each active request has a background-owned `leaseId` and `ownerServerInstanceId`; another server instance needs an explicit resume handoff and cannot silently steal it.
- Watchdog forced snapshots are bound to the original source tab and assistant turn; they never read a global latest response from another tab.

Real-browser E2E controls:

- A connected extension tab can ask the background worker to create an isolated ChatGPT tab for `npm run test:e2e:real`.
- The worker creates `about:blank`, stores the one-time launch token in `chrome.storage.session`, and only then navigates to ChatGPT. This removes the connection-before-token race.
- The new content script reports its browser tab id, launch token, and requested URL in the bridge handshake so the runner can identify exactly the tab it created.
- Session deletion is fail-closed. The command must contain both the concrete session id and expected canonical conversation URL, and the content script repeats this check around every destructive UI action.
- A generic message/tool “More” button is not a valid cleanup target. Header fallback controls must explicitly identify the conversation/chat, and the accepted Delete action must become visible after opening that exact menu.
- Tab close is routed to one source client. When a launch token is available, the background worker also verifies it before removing the sender tab.
- Extension self-reload arms a delayed reload in the ChatGPT page MAIN world before restarting the extension. The page-owned timer survives service-worker/content-context teardown and causes the updated content runtime to be injected automatically. A short-lived local handoff remains as secondary ownership and connection recovery.
- There is no older-protocol reload adapter or general compatibility bypass. The exact `extension.reload` control may cross only the package/content version gate for a protocol-4 client. Temporary `bridge-reload-*` markers select a transient loopback connection only and are never accepted as ownership tokens.
- `--keep-session` skips both deletion and tab close so the live E2E result can be inspected manually.


## Runtime structure

The manifest loads small browser-side modules in dependency order before `content.js`:

- `artifactParserCore.js` owns pure artifact-card, preview identity, materialization, and lifecycle parsing;
- `domParserCore.js` owns general turn, lifecycle, ownership, and stability classification;
- `responseParserCore.js` owns semantic response-block parsing;
- `observation/` owns the only DOM mutation scheduler, always-on tab facts, and revision ordering; active and passive consumers subscribe to the same observation stream;
- `content/` contains session, model/effort, composer, attachment, response, artifact, snapshot, telemetry, setup-panel, command-router, and request-monitor modules;
- `content.js` is only the composition root; `content/transportRuntime.js` owns transport/reconnect and `content/featureRuntime.js` assembles parser/executor adapters.

Browser modules may report observations or execute explicit server effects. Background persists effect intent before browser writes. They must not decide request completion or introduce a second request state machine.
