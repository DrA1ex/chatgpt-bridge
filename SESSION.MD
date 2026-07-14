# Current Session Handoff

## Completed in the latest migration

- Package version moved to `5.0.0`.
- Extension version moved to `1.0.0` and content runtime to `3.0.0`.
- Protocol 3 is mandatory; protocol 2 and all downgrade adapters were removed.
- Extension WebSocket endpoint changed from `/tm/ws` to `/extension/ws` with no alias.
- Polling/page/userscript transport code and disabled endpoint tombstones were removed.
- The alternate readline interactive runtime and its CLI flags/scripts were removed.
- Status-only workflow persistence/projection was removed.
- Request phase compatibility projection and the former shadow runtime were removed.
- Historical runtime classes were renamed to `BrowserExtensionHub` and `BrowserBridge`.
- The CSP-bypass development extension was deleted.

## Interactive decomposition

Created:

```text
src/interactive/
  apply.js
  commandHandler.js
  format.js
  inkView.js
  progress.js
  runtime.js
  state.js
```

Current sizes:

- `src/interactive/controller.js`: below 1,000 lines;
- `src/interactiveInk.js`: below 1,000 lines;
- extracted modules: 53–674 lines.

Behavioral tests for interactive state, recovery, project task flow, apply safety, Ink input, and workflow command surfaces pass after the split.


## Extension and parser decomposition

Completed:

- `tools/chrome-bridge-extension/content.js`: 987-line assembly/transport facade;
- browser-side domain logic extracted into `tools/chrome-bridge-extension/content/` modules;
- `tools/chrome-bridge-extension/domParserCore.js`: 922 lines;
- artifact parsing extracted into `tools/chrome-bridge-extension/artifactParserCore.js`: 479 lines.

The manifest defines and tests the module load order. Request completion remains server-owned; extracted browser modules only observe facts or execute explicit effects.

## Remaining work

The only oversized production source file is `scripts/e2e-real.js` at 2,353 lines. Reasoning validation, live parser observation, and model/effort selection now live in focused `scripts/e2e/` modules. Split it into environment, browser-session, scenario, assertion, cleanup, and diagnostics modules while keeping the entrypoint thin.

Then run the full real-browser E2E suite with the extension reloaded. Local tests cannot prove current ChatGPT DOM parity.

## Required validation before handoff

```bash
npm run check
npm test
```

Also verify:

- `.bridge/PROJECT_ID.json` is unchanged;
- `package-lock.json` uses only public registry URLs;
- the archive excludes `node_modules`, `.git`, `.env`, logs, databases, caches, build output, nested archives, and generated E2E output.
