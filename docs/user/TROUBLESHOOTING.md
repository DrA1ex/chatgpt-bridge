# Troubleshooting

## No browser client is connected

Check these in order:

1. Bridge is running.
2. The unpacked extension is enabled in `chrome://extensions`.
3. Chrome is using the stable extension directory:
   `~/.local/share/chatgpt-bridge/extension`.
4. You are logged in at `https://chatgpt.com/`.
5. The extension Bridge panel uses the `BRIDGE_TOKEN` shown by `/setup`.
6. Reload the ChatGPT tab.

Useful pages:

```text
http://127.0.0.1:8080/setup
http://127.0.0.1:8080/diagnostics
```

## Extension update required

Bridge and the extension exchange explicit protocol/version metadata. An outdated extension can remain visible in diagnostics while being excluded from normal prompt routing.

Run:

```bash
npm run extension:install
```

Then reload/update the unpacked extension. If Chrome still points at an old checkout path, use **Load unpacked** once with:

```text
~/.local/share/chatgpt-bridge/extension
```

## Prompt insertion fails

Check that:

- the ChatGPT composer is visible;
- no modal, CAPTCHA, or interstitial blocks the page;
- the target tab is on a normal ChatGPT chat route;
- the tab is not busy with another Bridge request.

Use `/diagnostics` or `/debug` to inspect typed browser errors rather than guessing from the page.

## Streaming output looks incomplete

For `/chat?stream=1`, intermediate deltas are observational. The authoritative final response arrives in `request.result`.

For `/v1/chat/completions`, the stream is append-only by design. Bridge does not send replacement chunks if ChatGPT rewrites already-rendered DOM text.

## A project result finished after the CLI disconnected

If ChatGPT is still actively generating and you reconnect to the same browser tab, use:

```text
/resume
```

If ChatGPT already finished while Bridge/CLI was disconnected, use:

```text
/recover
/recover --apply
```

Recovery reads the latest visible assistant result from the source tab, re-registers artifacts, and reconnects it to the project turn.

## Artifact download fails

Artifact downloads are tied to the original assistant turn and browser tab. Keep the source tab available until the artifact has been captured.

Check `/artifacts`, the diagnostics page, and recent debug events. Avoid manually switching the source tab while Bridge is resolving a generated file.

## Multiple tabs behave unexpectedly

Leave `ACTIVE_CLIENT_ID` unset unless you need a fixed browser client. Bridge normally routes by requested ChatGPT session and prefers an idle tab already on that session.

Busy tabs are never silently reused for another request.
