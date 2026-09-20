# Browser extension

The Chrome/Chromium extension is the browser-side runtime for Bridge. Its background service worker owns the authenticated localhost WebSocket and browser operations that cannot be performed by the Node process alone.

## Install

Publish the bundled extension:

```bash
npm run extension:install
```

Load this stable directory through `chrome://extensions` -> **Developer mode** -> **Load unpacked**:

```text
~/.local/share/chatgpt-bridge/extension
```

Bridge updates files inside that stable directory so Chrome can keep the same unpacked-extension registration.

## Connect

Start Bridge and open:

```text
http://127.0.0.1:8080/setup
```

Open or reload `https://chatgpt.com/`, paste the displayed `BRIDGE_TOKEN` into the extension Bridge panel, and choose **Save & connect**.

The extension WebSocket endpoint is:

```text
ws://127.0.0.1:8080/extension/ws
```

The extension token is intentionally separate from `API_TOKEN`.

## Browser responsibilities

The extension handles:

- ChatGPT composer interaction and prompt submission;
- session/tab observation and navigation;
- visible model/effort selection;
- input file attachment;
- visible reasoning/progress and final-answer observation;
- generated artifact discovery;
- browser-side downloads and `chrome.downloads` capture.

The Node Bridge remains the authority for request lifecycle, public API state, persistence, and client-facing events.

## Automatic ChatGPT tab opening

Automatic tab creation is opt-in:

```bash
bridge --auto-open-tab
bridge --server --auto-open-tab
```

Persistent equivalent:

```env
AUTO_OPEN_TAB=1
```

When enabled, Bridge first reuses an unambiguous idle tab that is already on the requested session. If no safe target exists, it opens a dedicated ChatGPT tab. Explicit `sourceClientId` requests remain strict and are never silently redirected.

## Multiple tabs

Bridge treats connected ChatGPT tabs as separate browser clients.

For a request with a known session, it prefers an idle tab already on that session. Busy tabs are not reused. If several unrelated idle tabs are available, interactive mode may require an explicit selection instead of guessing.

List connected clients:

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  http://127.0.0.1:8080/browser/clients | jq
```

Usually `ACTIVE_CLIENT_ID` should remain empty so Bridge can choose the correct session-bound tab.

## Extension updates

Interactive mode can verify and reload the unpacked extension before starting. The main policies are:

```env
BRIDGE_STARTUP_EXTENSION_RELOAD=ask|if-needed|always|never
E2E_EXTENSION_RELOAD=ask|if-needed|always|never
```

Useful one-shot options:

```bash
npm run interact -- --reload-extension
npm run interact -- --no-reload-extension
```

If Chrome still points at an old checkout directory, automatic reload cannot change the registered filesystem path. Load `~/.local/share/chatgpt-bridge/extension` once through **Load unpacked**.

Bridge and the extension exchange explicit protocol/version metadata. An incompatible extension remains visible in diagnostics but is excluded from normal prompt routing until updated.

For implementation details, ownership rules, and recovery semantics, see [Canonical Browser Bridge Architecture](../../ARCHITECTURE.md).
