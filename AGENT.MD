# Agent Instructions

This repository is a Node.js bridge for controlling a logged-in ChatGPT tab through a Chrome/Chromium extension. The only browser transport is the extension background WebSocket using protocol 4. Do not add alternate browser transports, protocol downgrade paths, compatibility bypasses, hidden fallbacks, or duplicate request lifecycle logic.

Before non-trivial changes, read `CONTEXT.MD` and `ARCHITECTURE.md`. Before changing ChatGPT selectors, turn parsing, lifecycle detection, model/effort selection, file discovery, generated artifacts, or code-block parsing, also read `docs/CHATGPT_DOM_PARSER.md` and `docs/CHATGPT_FILES_CODE_DOM.md`.

## Operating rules

- The canonical request reducer is the only source of truth for request lifecycle, completion, failure, cancellation, artifact settling, release, and liveness deadlines.
- The extension reports observations and effect results. It must not independently finalize requests.
- Timer callbacks emit named deadline events; they must not directly finish requests.
- Request-scoped browser actions must run as typed effects with `started`, `succeeded`, and `failed` outcomes.
- Register command correlation before sending a command. A diagnostic, status, snapshot, progress, or effect message carrying the same `commandId` is telemetry and must never settle the command; only an explicit response or `command.error` may do so.
- Give every correlated command a request or command-scoped lease. Persist registration and dispatch before browser execution; command-scoped leases are released only after a durable terminal result.
- Never retry an unconfirmed browser write. Prompt submission, steering, attachment, model/session changes, artifact actions, and downloads may repeat only after effect-specific proof that the previous action did not start.
- Startup extension reload may bypass compatibility only for the exact `extension.reload` control command. In `ask` mode, compare both manifest and content-runtime versions and do not prompt when both already match. Forced reload may still run. Buffer asynchronous E2E logs until any startup confirmation is resolved.
- Public reasoning/progress delivery is a first-class API contract. Subscribe to `/turns/:id/events?stream=1&recent=0&wait=1` before creating the turn, and preserve ordered snapshot plus completion events with stable logical IDs.
- Exactly one primary bridge may own a browser tab. Additional workflow processes must consume authenticated sequenced observed turns from the primary bridge and fetch artifacts through its HTTP API; never connect a second browser lifecycle to the same tab.
- Keep one stable identity from project turn to bridge request. Follow-ups remain bound to the source browser tab.
- New requests with a known session prefer an idle tab already showing that session. A different idle tab requires explicit interactive confirmation.
- Automatic tab opening is opt-in and identifies the created tab by an exact one-time launch token.
- Required ZIP results cannot complete from stale text, unrelated files, or text-only snapshots. Artifact materialization has its own bounded deadline.
- Generic Copy controls are not artifacts. Artifact records require explicit file identity or lifecycle evidence.
- Current ChatGPT conversation/navigation URLs are never direct artifact sources. Action artifacts must be materialized through their scoped UI action. Typed artifact selection must fail closed rather than falling back to an unrelated first candidate.
- `/apply` may use only the current selected ZIP for the current project and session scope. Never silently reuse an older result.
- `/recover <n>` uses the browser-visible candidate index printed by `/recover list`.
- Keep `HOST=127.0.0.1` as the security default.
- Do not commit or return `.env`, secrets, `.bridge-data`, generated databases, logs, `node_modules`, build output, caches, or nested archives.
- Do not create `CHANGELOG.md` or `docs/FUNCTION_INVENTORY.MD` unless explicitly requested.
- All project Markdown documentation must be written in English.

## Source organization and file size

- Organize code by domain and responsibility. Prefer cohesive trees such as `src/bridge/`, `src/workflow/`, `src/interactive/`, `src/project/`, `src/http/`, and `tools/chrome-bridge-extension/`.
- Entry points and coordinators wire dependencies; parsing, policies, state transitions, timers, filesystem operations, and UI effects belong in dedicated modules.
- Target at most 500 lines per source file. A cohesive module may reach 1,000 lines only when splitting it would damage the domain model.
- Do not add a new source file above 1,000 lines.
- When making a substantial change to an existing file above 1,000 lines, extract at least one coherent responsibility when practical.
- Split by stable responsibility and dependency direction, never by arbitrary line ranges.
- Avoid generic `utils` directories. Keep private helpers near their owning domain.
- Prefer pure functions for normalization, parsing, reducer transitions, projections, and policy.
- Keep DOM access, browser commands, timers, transport, and filesystem operations behind explicit adapters.
- Tests should follow the same domain boundaries. Extract reusable fixtures, wait policies, and scenario drivers from large integration suites.
- `scripts/e2e-real.js` is a thin launcher/shared orchestrator and must stay below 1,000 lines. Put scenario groups in `scripts/e2e/scenarios/` and focused helpers in `scripts/e2e/`.
- Assemble scenario-group dependencies through validated context factories under `scripts/e2e/`. Validate static dependencies before starting the isolated bridge/browser and validate session/client identity before registering scenarios; do not hand-build large dependency objects at each scenario call site.
- All production JavaScript files must remain below 1,000 lines. Files near the limit must be split before adding another substantial responsibility.


## Content-runtime dependency safety

- Manifest-loaded content modules may communicate only through explicit factory dependencies or documented globals exported by their own module.
- Never close over a `const` or destructured dependency that is initialized later in `content.js`. When a genuine cyclic assembly dependency is unavoidable, inject a lazy callback such as `(...args) => dependency(...args)` and document why it is lazy.
- Do not reference free identifiers that happen to exist in another manifest script. Every factory dependency must appear in that factory's argument object and destructuring declaration.
- Keep `test/extensionContentBootstrap.test.js` passing. It executes the complete manifest content-script order and is the required regression for TDZ, missing-global, and initialization-order failures.
- When changing manifest script order, module factories, or `content.js` assembly, add or update an executable bootstrap assertion; source-regex checks alone are insufficient.
- A submitted user turn may produce multiple assistant turn containers. Request-scoped parsing must follow the latest meaningful assistant turn after that user turn; never permanently pin lifecycle state to the first reasoning or placeholder turn.
- Treat missing or virtualized assistant DOM as degraded observation, not a terminal browser error. Recover from later visible request-owned turns or committed request output, then let canonical forced-snapshot/deadline policy decide true liveness failure.
- Do not require the response action bar for completion. It is strong evidence only; stable final output or a ready artifact after generation quiescence is sufficient medium-confidence evidence.
- Active request monitoring and passive workflow observation must use the same immutable `TabObservation` facts and server-owned completion semantics. Never require an action bar only in the passive path.
- Before submitting an explicit passive workflow prompt, hard-baseline every pre-existing assistant turn in the conversation; only turns created after the submitted user-turn anchor may enter that workflow pipeline.
- Compare generated source/text artifacts semantically: normalize CRLF/LF and optional terminal newlines. Keep byte-level comparisons for binary formats.

## Live DOM fixture and replay rules

- Parser, selector, artifact-card, assistant-turn, lifecycle-observation, and code-block changes require deterministic sanitized DOM evidence under `test/fixtures/chat-dom/captured/`.
- Use `--capture-dom-fixtures` for ad hoc live capture. `npm run test:e2e:capture-dom` replaces the generated sanitized corpus under `test/fixtures/chat-dom/captured/generated/`, and `npm run test:e2e:local` must replay that corpus without Chrome before handoff. Use `--fixture-output-dir` for another explicit reviewed fixture destination.
- Capture only the scoped assistant turn. Never persist the full ChatGPT page, sidebar, account menu, cookies, authorization data, tokens, or unrelated conversation content.
- Review generated HTML and fixture JSON before committing them. Sanitization is a defense-in-depth step, not permission to commit unreviewed browser data.
- A captured fixture must include semantic parser expectations; request traces should be replayable through the canonical reducer when available.
- Do not update fixture expectations merely to make a failing parser test green. Confirm that the new expected semantics match the visible response.
- A recurring live E2E failure is not fully fixed until its DOM or canonical transition sequence is represented by an offline fixture/replay test.
- E2E scenarios must wait on committed canonical snapshots. DOM buttons, parser text, and logs may be asserted for UI correctness but must not become an alternate lifecycle machine.
- Failed real E2E runs must end with one deduplicated failure summary. Use `FAILED` for failed scenarios or release-blocking cleanup and `ERROR` for underlying browser/runtime diagnostics; do not require readers to reconstruct root causes from the full log.
- Real E2E keeps the complete parsed browser debug stream in `browser-debug.ndjson` and losslessly DEFLATE-compresses the diagnostic ZIP. Default terminal output hides only known high-frequency diagnostics; `--verbose` restores their live display without changing archived evidence.
- Every workflow E2E wait must have a finite absolute deadline. After a pipeline starts, also enforce a shorter no-progress deadline. A manual SIGINT/SIGTERM must mark the active scenario interrupted and print the same final failure summary before writing diagnostics.
- A failed E2E scenario must not leave the shared isolated tab busy for the next scenario. Recover the exact source tab and wait for an idle ready composer, or stop the run if safe recovery cannot be proven.
- A reasoning retry succeeds when any isolated completed attempt satisfies the full required checkpoint contract. Preserve partial attempts for diagnostics, but do not fail a later complete retry because an earlier attempt was partial.
- A reasoning/progress change is not verified by DOM capture alone. The live E2E must open the public turn SSE before turn creation, prove ordered `0%` through `100%` delivery over multiple receive times, verify `100%` precedes final/terminal events, and save `public-progress-events.json`.
- Do not weaken public progress assertions into an after-the-fact event-history check. A terminal replay batch must fail the live-stream contract.
- Compare generated JSON semantically and normalize optional final newlines/line-ending variants for text and CSV. Keep byte-exact or signature validation for binary formats and archives.

## Protocol and versioning

Protocol 4 is mandatory. Every WebSocket message uses the v4 envelope, and the handshake includes `extensionVersion`, `clientVersion`, and `extensionProtocolVersion`.

For extension releases:

- increment patch for compatible fixes;
- increment minor when both sides should be updated together but the contract remains broadly compatible;
- increment major for an intentionally incompatible contract;
- update the manifest version, content runtime version, compatibility policy, and tests together;
- incompatible clients remain visible in diagnostics and cannot receive ordinary commands; the only exception is the exact `extension.reload` startup control sent to a client that already speaks protocol 4;
- report an explicit update-required error instead of reconnecting indefinitely.

## Important files

- `src/index.js`: composition root for the HTTP server, `BrowserExtensionHub`, `BrowserBridge`, stores, managers, project service, and RPC server.
- `src/browserExtensionHub.js`: authenticated extension WebSocket clients, compatibility gating, ownership, active selection, and latest revisioned tab observations.
- `src/browserBridge.js`: public bridge facade. It delegates lifecycle, client ownership, event routing, and administrative operations to coordinators.
- `src/extensionCompatibility.js`: protocol and extension/content version policy.
- `src/bridge/state/`: canonical request vocabulary, reducer, transition policy, invariants, failures, and compact views.
- `src/bridge/store/`: revisioned snapshots, bounded transition journals, and race-safe waits.
- `src/bridge/adapters/`: normalized hub and tab observations. Request-specific facts must be bound to the matching request.
- `src/bridge/effects/effectRunner.js`: idempotent typed-effect execution.
- `src/bridge/coordinator/requestLifecycleCoordinator.js`: committed reducer outcomes, deadlines, effects, terminal materialization, cancellation, and explicit request release.
- `src/bridge/coordinator/browserClientCoordinator.js`: source-tab selection, session-safe fallback, auto-open, reconnect, and prompt delivery.
- `src/bridge/adapters/protocolV4Adapter.js`: protocol-4 envelope, sequence, duplicate, epoch, and lease validation before event routing.
- `src/bridge/coordinator/bridgeOperations.js`: bounded administrative browser and artifact commands outside request lifecycle.
- `src/bridge/deadlines/`: meaningful-progress, post-generation, hard-liveness, reconnect, forced-snapshot, and artifact deadlines.
- `src/bridge/replay/`: sanitized canonical traces and deterministic replay.
- `src/http/publicTurnStream.js`: race-safe pre-turn public SSE for committed turn/item events.
- `src/http/observedTurnStream.js`: sequenced authenticated observed-turn SSE for remote workflow workers.
- `src/http/`: remaining diagnostics, event streams, and workflow route groups.
- `src/workflow/state/workflowState.js`: the sole persisted workflow v3 lifecycle, input queue, action, browser-effect, and local-effect state.
- `src/workflow/remoteBrowserBridge.js`: remote workflow adapter for observed-turn SSE, passive prompts, recovery, and artifact import.
- `src/workflow/context/`, `recovery/`, and `support/`: workflow domain services extracted from the manager.
- `src/workflow/automation/service.js`: shared automation runner for workflow presets, check cycles, progress detection, and pause/resume/stop orchestration.
- `src/workflow/ux/workflowWizard.js`: the context-sensitive `/workflow` wizard, preset setup, settings, attention actions, and Guided Task actions.
- `src/workflow/ux/globalConfig.js`: stable global defaults, profile overrides, validation, and config persistence.
- `src/workflow/services/`: shared workflow services for session recovery, project context, result repair, safe application, check-failure decisions, settings, and commits.
- `src/workflow/ux/workflowView.js`: pure user-facing workflow stages, dashboards, actions, approval selection, and run history.
- `src/cli/workflowRuntime.js`: advanced non-interactive `workflow run`/`serve` lifecycle and graceful signal handling.
- `src/cli/workflowConfigCommands.js`: workflow config initialization and validation.
- `src/interactive/controller.js`: project task, plain request, resume, recovery, and artifact command operations.
- `src/interactive/commandHandler.js`: slash-command routing.
- `src/interactive/state.js`: persisted interactive state, scope hydration, and selected-result identity.
- `src/interactive/apply.js`: ZIP planning, safety decisions, and project apply execution.
- `src/interactive/progress.js`: console progress reconciliation and event presentation.
- `src/interactive/view.js`: pure presentation and activity helpers shared by the Terlio runtime.
- `src/interactive/terlioInput.js`: Terlio keyboard/pointer stream normalization, split escape/paste buffering, and macOS terminal compatibility.
- `src/interactive/terlioLayout.js`: pure three-mode responsive geometry for full-width chat, left-sidebar chat, and two-sidebar workspace layouts.
- `src/interactive/terlioScroll.js`: sticky-tail offsets, keyboard/pointer scrolling, counters, ratio seeks, and scrollbar geometry for transcript and details panes.
- `src/interactive/terlioView.js`: declarative Terlio chat, sidebars, full-width header/editor/footer, contextual suggestions, details panel, and overlays.
- `src/interactive/terlioThemes.js`: Terlio preset discovery, descriptions, validation, and persisted theme resolution.
- `src/interactive/terlioRuntime.js`: interactive lifecycle, input routing, rendering, contextual completion, commands, requests, resize, and graceful shutdown; keep it below 1,000 lines.
- `src/interactiveTerlio.js`: the only interactive runtime entry point. Do not reintroduce Ink, React, readline, or a fallback renderer.
- `tools/chrome-bridge-extension/background.js`: extension WebSocket relay, signed localhost fetches, and browser-download capture.
- `tools/chrome-bridge-extension/content.js`: thin manifest-loaded assembly and extension transport facade; do not move DOM policy or request lifecycle decisions back into it.
- `tools/chrome-bridge-extension/content/`: cohesive browser-side DOM adapters, command executors, request telemetry, observations, setup UI, and request monitoring.
- `tools/chrome-bridge-extension/observation/`: always-on tab observation normalization and scheduling; observations never finalize requests.
- `tools/chrome-bridge-extension/artifactParserCore.js`: pure artifact-card, preview identity, materialization, and lifecycle classification.
- `tools/chrome-bridge-extension/domParserCore.js`: DOM-independent turn, lifecycle, ownership, and signature helpers; artifact classification is delegated to `artifactParserCore.js`.
- `scripts/e2e-real.js`: thin real-browser launcher and shared orchestration facade; keep it below 1,000 lines.
- `scripts/e2e/scenarios/`: cohesive real-browser scenario groups.
- `scripts/e2e/public-turn-stream.js`: public SSE capture opened before the reasoning turn is created.
- `scripts/e2e/multi-bridge-workflow.js`: independent workflow-worker process launcher for live E2E.
- `scripts/e2e/dom-fixture-capture.js`: sanitized assistant-turn HTML, parser expectation, and canonical trace capture.
- `scripts/e2e/request-state-wait.js` and `request-state-trace.js`: canonical E2E wait and replay helpers. Do not add lifecycle regexes or local fatal-event lists to E2E scenarios.
- `test/helpers/offlineChatDom.js` and `test/capturedDomFixtures.test.js`: browser-free execution of captured ChatGPT DOM through the real parser modules.
- `test/extensionContentBootstrap.test.js`: executable manifest-order initialization contract for the full content runtime.
- `test/publicReasoningStream.test.js`: public live-progress ordering, timing, and wrapper contract.
- `test/workflowMultiBridge.integration.test.js`: deterministic two-process observed-turn/download/apply integration.
- `src/turnManager.js`: threads, turns, items, and result-pipeline convergence.
- `src/resultResolver.js`: ZIP selection, download, validation, and result events.
- `src/project/apply/`: apply path policy, reference normalization, safety, planning, and execution.
- `src/metadataStore.js`: SQLite persistence with JSON fallback.

## Workflow UX contract

- `/workflow` is the only workflow command ordinary interactive users need. It opens setup, the active workflow, or the current attention decision according to context.
- No workflow starts, watches a chat, applies files, or creates commits until the user explicitly starts or resumes it.
- The wizard exposes exactly three primary presets: **Apply changes from ChatGPT**, **Fix the project until checks pass**, and **Work through a task**.
- Normal setup must fit within five short decisions: goal, chat, project, checks, and final summary. Advanced settings remain optional.
- Use plain-language workflow stages and actions. Definition IDs, pipeline IDs, worker topology, restart policies, and other internal state belong only in debug surfaces.
- Every required decision must create a persistent attention state, display its actions immediately, and reopen through `/workflow`. Notification failures must never fail the workflow.
- Global defaults live in `~/.bridge-data/workflows/config.json`. Unknown fields are preserved, invalid known values report their exact JSON path, and per-workflow profiles override global defaults.
- Existing chats default to quiet attachment. New or recovered chats receive a fresh project archive, a separate workflow-instruction attachment, and a concise initialization or handoff prompt.
- Compare the effective project fingerprint before requests. Reuse unchanged remote context and refresh the complete project archive whenever included local contents changed.
- Automatically applicable ZIP results require `bridge-result.json`. Its `files` field is optional and advisory; the transactional apply diff is authoritative, listed unchanged files are ignored, and Bridge control files are validated but never written into the project.
- Automatic result repair is bounded. Retry exhaustion, unsafe paths, identity mismatches, duplicate results, and other unresolved validation failures must become attention states.
- Git commits must include only workflow-owned paths. Capture exact applied file states, detect subsequent user edits before commit/finalization, preserve unrelated work, and support checkpoint/final-only plus squash/keep policies.
- **Apply changes from ChatGPT** must return to watching after success. Failed post-apply checks must offer fix-loop, keep-and-stop, revert, and review actions instead of silently entering remediation.
- **Fix the project until checks pass** must stop on success and ask after maximum attempts or repeated no-progress signatures instead of looping indefinitely.
- **Work through a task** accepts text-only responses and exposes follow-up, apply/review files, checks, attachments, context refresh, and finish actions while focused.
- Headless `bridge workflow run` and `bridge workflow serve` remain advanced compatibility surfaces over the same manager; they must not become additional commands users need for the interactive workflow UX.
- Slash help must appear after the first `/`. After a command is selected, offer contextual parameters, subcommands, flags, and known runtime IDs with short inline descriptions.
- Keep the three layout modes explicit: chat-only below 115 columns, left panel plus expanding chat from 115 through 169, and two panels plus center chat from 170. Header, editor, visible suggestions, and footer span the full terminal width.
- Use Terlio theme presets through persisted interactive state; do not copy or fork theme token tables into the bridge.
- Keep transcript and details scrolling in the explicit Terlio scroll model. Shift+Up/Down, PgUp/PgDn, Ctrl+Home/End, wheel/trackpad events, and scrollbar click/drag navigate the visible pane. Plain Up/Down first moves within multiline input, then navigates active slash suggestions, and accesses persistent input history only from an empty editor or an unchanged recalled entry.
- Use the semantic pointer API from `terlio.js@1.1.0`; do not add a second bridge-local SGR mouse protocol. Delegate decoding and hit-testing to Terlio, then map wheel, click, drag, and pointer-capture toggles into the shared scroll model.
- Use Terlio `SelectableText` for transcript selection. Preserve multiline drag selection and copy a completed selection on a short click inside the highlight; do not add a separate bridge-local selection protocol.
- Persist input history per resolved project root, or per launch directory when no project is open. Esc-cancelled drafts and submitted prompts remain recallable after restart.
- Keep bracketed paste enabled while the TUI is active. Multiline paste must preserve the exact submitted text; pastes above 250 Unicode symbols render as one compact editor token, cursor movement skips the token, and Backspace/Delete expands it instead of deleting its contents.
- The prompt editor grows to five visual rows. Up/Down moves vertically inside multiline or wrapped input before any completion/history navigation.
- npm CLI bins must point to executable files with a Node shebang so `npm link` works on Unix. Do not recommend `npx link`.

## Project ZIP contract

Input snapshots contain:

```text
project/...
.bridge/PROJECT_CONTEXT.md
.bridge/AGENT_EFFECTIVE.md
.bridge/SKILLS.md
.bridge/MANIFEST.json
```

Returned ZIP artifacts place project files at archive root. Protected paths such as `.bridge`, `.git`, `node_modules`, build output, caches, environment files, databases, and archives must not be applied.

If `package-lock.json` is returned, every resolved registry URL must point to a public registry. Never return internal OpenAI/cache registry URLs.

## Apply safety

Preserve these invariants:

- reject traversal, absolute paths, and symlink entries;
- write only allowed project files;
- sync-delete only files present in the original snapshot and absent from the result;
- never touch ignored or unsent files;
- detect local changes after the snapshot;
- require confirmation unless a safe auto-apply path or explicit `--force` is used;
- always re-plan against current project state, even if a result was applied before.

## Tests before handoff

Run at least:

```bash
npm ci
npm run check
npm test
```

### Restricted sandbox `sqlite3` installation

In the restricted Linux sandbox, plain `npm ci` may repeatedly fail because `sqlite3` tries to download a prebuilt binary or Node headers. Do not retry the same network-dependent install. Use the locally installed Node headers and system SQLite immediately:

```bash
npm ci --ignore-scripts --no-audit --no-fund
NODE_DIR="$(dirname "$(dirname "$(command -v node)")")"
test -f "$NODE_DIR/include/node/node.h"
test -f /usr/include/sqlite3.h
npm_config_nodedir="$NODE_DIR" \
  npm_config_sqlite=/usr \
  npm_config_build_from_source=true \
  npm rebuild sqlite3 --no-audit --no-fund
node --input-type=module -e "import sqlite3 from 'sqlite3'; const db=new sqlite3.Database(':memory:', e=>{if(e) throw e; db.get('select 1 as ok',(err,row)=>{if(err) throw err; if(row.ok!==1) throw new Error('sqlite3 verification failed'); db.close();});});"
```

`npm_config_sqlite=/usr` is important in this sandbox: it links the addon against the installed system SQLite instead of compiling the bundled amalgamation, which is slow enough to exceed command limits. This is a sandbox-only fallback; use ordinary `npm ci` in a normal networked development environment.

Add a regression test for every fixed bug. Prefer black-box/API tests for public behavior and focused unit tests for pure logic. DOM changes require reviewed sanitized fixtures under `test/fixtures/chat-dom/captured/` and must preserve semantic invariants rather than merely matching current markup. Run the manifest-order content bootstrap test for every content assembly or module-order change. Changes to public progress streaming must run the public-stream contract tests and a live `reasoning-lifecycle` scenario. Changes to observed-turn or remote workflow behavior must run `npm run test:workflow:multi-bridge` and the live `workflow-multi-bridge` scenario when an authorized browser is available.

## Passive workflow rules

- Treat unsolicited observed turns as untrusted until artifacts are materialized and verified.
- Never apply an archive only because its label resembles a project ZIP.
- Keep workflows project-scoped, persistent, and serialized.
- A browser tab has one primary bridge owner. Remote workflow workers subscribe to the primary bridge's authenticated sequence journal and must resume from `Last-Event-ID`/`after`; they must not connect another extension transport to that tab.
- Import remote artifacts into the worker's own `FileStore` before verification or apply.
- Preserve rollback before sending remediation output to ChatGPT.
- Do not push Git commits from a workflow.
- Auto-commit only when the configured commit mode yields an exact marked message.
