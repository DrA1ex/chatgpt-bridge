# ChatGPT Bridge CSP Dev Bypass

Development-only Chrome extension for testing the Tampermonkey WebSocket transport.
It removes `Content-Security-Policy` and `Content-Security-Policy-Report-Only` response headers from `chatgpt.com` / `chat.openai.com` pages, allowing `ws://127.0.0.1:8080/tm/ws` to be opened by the userscript.

Use only for local debugging:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click “Load unpacked”.
4. Select this `tools/chrome-csp-dev-bypass` folder.
5. Reload ChatGPT and switch the Bridge panel transport to WebSocket.
6. Disable or remove this extension after the test.
