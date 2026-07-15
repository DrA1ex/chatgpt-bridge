# Agent Instructions

This repository is a Node.js bridge for controlling a logged-in ChatGPT tab through a Chrome/Chromium extension. The only browser transport is the extension background WebSocket using protocol 3. Do not add alternate browser transports, protocol downgrade paths, hidden fallbacks, or duplicate request lifecycle logic.

Before non-trivial changes, read `CONTEXT.MD` and `ARCHITECTURE.md`. Before changing ChatGPT selectors, turn parsing, lifecycle detection, model/effort selection, file discovery, generated artifacts, or code-block parsing, also read `docs/CHATGPT_DOM_PARSER.md` and `docs/CHATGPT_FILES_CODE_DOM.md`.

## Operating rules

- The canonical request reducer is the only source of truth for request lifecycle, completion, failure, cancellation, artifact settling, release, and liveness deadlines.
- The extension reports observations and effect results. It must not independently finalize requests.
- Timer callbacks emit named deadline events; they must not directly finish requests.
- Request-scoped browser actions must run as typed effects with `started`, `succeeded`, and `failed` outcomes.
- Keep one stable identity from project turn to bridge request. Follow-ups remain bound to the source browser tab.
- New requests with a known session prefer an idle tab already showing that session. A different idle tab requires explicit interactive confirmation.
- Automatic tab opening is opt-in and identifies the created tab by an exact one-time launch token.
- Required ZIP results cannot complete from stale text, unrelated files, or text-only snapshots. Artifact materialization has its own bounded deadline.
- Generic Copy controls are not artifacts. Artifact records require explicit file identity or lifecycle evidence.
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
- All production JavaScript files must remain below 1,000 lines. Files near the limit must be split before adding another substantial responsibility.


## Content-runtime dependency safety

- Manifest-loaded content modules may communicate only through explicit factory dependencies or documented globals exported by their own module.
- Never close over a `const` or destructured dependency that is initialized later in `content.js`. When a genuine cyclic assembly dependency is unavoidable, inject a lazy callback such as `(...args) => dependency(...args)` and document why it is lazy.
- Do not reference free identifiers that happen to exist in another manifest script. Every factory dependency must appear in that factory's argument object and destructuring declaration.
- Keep `test/extensionContentBootstrap.test.js` passing. It executes the complete manifest content-script order and is the required regression for TDZ, missing-global, and initialization-order failures.
- When changing manifest script order, module factories, or `content.js` assembly, add or update an executable bootstrap assertion; source-regex checks alone are insufficient.

## Live DOM fixture and replay rules

- Parser, selector, artifact-card, assistant-turn, lifecycle-observation, and code-block changes require deterministic sanitized DOM evidence under `test/fixtures/chat-dom/captured/`.
- Use `--capture-dom-fixtures` or `npm run test:e2e:capture-dom` during live E2E. Use `--fixture-output-dir` when intentionally promoting captures into the fixture tree.
- Capture only the scoped assistant turn. Never persist the full ChatGPT page, sidebar, account menu, cookies, authorization data, tokens, or unrelated conversation content.
- Review generated HTML and fixture JSON before committing them. Sanitization is a defense-in-depth step, not permission to commit unreviewed browser data.
- A captured fixture must include semantic parser expectations; request traces should be replayable through the canonical reducer when available.
- Do not update fixture expectations merely to make a failing parser test green. Confirm that the new expected semantics match the visible response.
- A recurring live E2E failure is not fully fixed until its DOM or canonical transition sequence is represented by an offline fixture/replay test.
- E2E scenarios must wait on committed canonical snapshots. DOM buttons, parser text, and logs may be asserted for UI correctness but must not become an alternate lifecycle machine.
- Failed real E2E runs must end with one deduplicated failure summary. Use `FAILED` for failed scenarios or release-blocking cleanup and `ERROR` for underlying browser/runtime diagnostics; do not require readers to reconstruct root causes from the full log.

## Protocol and versioning

Protocol 3 is mandatory. The extension handshake must include `extensionVersion`, `clientVersion`, and `extensionProtocolVersion`.

For extension releases:

- increment patch for compatible fixes;
- increment minor when both sides should be updated together but the contract remains broadly compatible;
- increment major for an intentionally incompatible contract;
- update the manifest version, content runtime version, compatibility policy, and tests together;
- incompatible clients remain visible in diagnostics but cannot be selected or receive commands;
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
- `src/bridge/coordinator/bridgeClientEventRouter.js`: protocol-3 event and observation normalization.
- `src/bridge/coordinator/bridgeOperations.js`: bounded administrative browser and artifact commands outside request lifecycle.
- `src/bridge/deadlines/`: meaningful-progress, post-generation, hard-liveness, reconnect, forced-snapshot, and artifact deadlines.
- `src/bridge/replay/`: sanitized canonical traces and deterministic replay.
- `src/http/`: diagnostics, event streams, and workflow route groups.
- `src/workflow/state/workflowState.js`: independent persisted watcher and pipeline state.
- `src/workflow/context/`, `recovery/`, and `support/`: workflow domain services extracted from the manager.
- `src/interactive/controller.js`: project task, plain request, resume, recovery, and artifact command operations.
- `src/interactive/commandHandler.js`: slash-command routing.
- `src/interactive/state.js`: persisted interactive state, scope hydration, and selected-result identity.
- `src/interactive/apply.js`: ZIP planning, safety decisions, and project apply execution.
- `src/interactive/progress.js`: console progress reconciliation and event presentation.
- `src/interactive/inkView.js`: pure Ink presentation helpers.
- `src/interactiveInk.js`: Ink runtime coordinator; keep it below 1,000 lines.
- `tools/chrome-bridge-extension/background.js`: extension WebSocket relay, signed localhost fetches, and browser-download capture.
- `tools/chrome-bridge-extension/content.js`: thin manifest-loaded assembly and extension transport facade; do not move DOM policy or request lifecycle decisions back into it.
- `tools/chrome-bridge-extension/content/`: cohesive browser-side DOM adapters, command executors, request telemetry, observations, setup UI, and request monitoring.
- `tools/chrome-bridge-extension/observation/`: always-on tab observation normalization and scheduling; observations never finalize requests.
- `tools/chrome-bridge-extension/artifactParserCore.js`: pure artifact-card, preview identity, materialization, and lifecycle classification.
- `tools/chrome-bridge-extension/domParserCore.js`: DOM-independent turn, lifecycle, ownership, and signature helpers; artifact classification is delegated to `artifactParserCore.js`.
- `scripts/e2e-real.js`: thin real-browser launcher and shared orchestration facade; keep it below 1,000 lines.
- `scripts/e2e/scenarios/`: cohesive real-browser scenario groups.
- `scripts/e2e/dom-fixture-capture.js`: sanitized assistant-turn HTML, parser expectation, and canonical trace capture.
- `scripts/e2e/request-state-wait.js` and `request-state-trace.js`: canonical E2E wait and replay helpers. Do not add lifecycle regexes or local fatal-event lists to E2E scenarios.
- `test/helpers/offlineChatDom.js` and `test/capturedDomFixtures.test.js`: browser-free execution of captured ChatGPT DOM through the real parser modules.
- `test/extensionContentBootstrap.test.js`: executable manifest-order initialization contract for the full content runtime.
- `src/turnManager.js`: threads, turns, items, and result-pipeline convergence.
- `src/resultResolver.js`: ZIP selection, download, validation, and result events.
- `src/project/apply/`: apply path policy, reference normalization, safety, planning, and execution.
- `src/metadataStore.js`: SQLite persistence with JSON fallback.

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

Add a regression test for every fixed bug. Prefer black-box/API tests for public behavior and focused unit tests for pure logic. DOM changes require reviewed sanitized fixtures under `test/fixtures/chat-dom/captured/` and must preserve semantic invariants rather than merely matching current markup. Run the manifest-order content bootstrap test for every content assembly or module-order change.

## Passive workflow rules

- Treat unsolicited observed turns as untrusted until artifacts are materialized and verified.
- Never apply an archive only because its label resembles a project ZIP.
- Keep workflows project-scoped, persistent, and serialized.
- Preserve rollback before sending remediation output to ChatGPT.
- Do not push Git commits from a workflow.
- Auto-commit only when the configured commit mode yields an exact marked message.
