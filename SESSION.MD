# Session Handoff: `/recover` and `/apply` Process Flow

This file documents the process contract for recovery/apply work. It is intentionally about runtime flow and state transitions, not product/business intent.

## Core rule

`/recover list` returns a volatile list of visible assistant-response candidates from the active ChatGPT tab. The displayed `[n]` is a recovery candidate index. It is not a local metadata turn id and it is not the ChatGPT visual `turnIndex`.

Therefore this flow must always work:

```text
/recover list
  [1] turn 29 · ...
/recover 1
```

`/recover 1` must select candidate index `1` from the visible browser list. It must not try to interpret `1` as local turn id `turn_1`, database row id, ChatGPT turn number `29`, or any other identifier.

## `/recover list` flow

1. CLI asks the active extension companion for recent visible assistant responses by sending `response.recover.list`.
2. Extension/content script scans the current ChatGPT page and returns ordered candidates.
3. CLI prints each candidate as `[candidateIndex] turn <visibleTurnIndex> · <chars> · <artifactCount> · <preview>`.
4. This command is read-only for apply state. It may update diagnostics/caches, but it must not select an old artifact or change `lastTurnId`/`lastTurn`.
5. The next valid user step is `/recover <candidateIndex>` or `/recover <candidateIndex> --apply`.

## `/recover <n>` flow

1. Parse `<n>` as the candidate index from the latest visible recovery list convention. Default is `1` only when no number is supplied.
2. Ask the active extension companion for that exact visible candidate by sending `response.recover.latest` with `{ index: n, limit: max(n, defaultLimit) }`.
3. Resolve the local metadata turn in this order:
   - `state.lastTurnId` from the current project/session scope, if it exists;
   - a turn from the current `projectThreadId`, preferring running/failed/interrupted/cancelled turns;
   - an adopted recovery turn created under the current project/session scope when no local turn is available.
4. The adopted recovery turn exists only to attach the recovered browser response to local state. It should be created with status `recovering`, a placeholder user-message item, current `cwd`/`sessionId`, and output expectations derived from the current mode: `zip` when a project is open, otherwise `text`.
5. Store recovered thinking, final answer, and artifacts as turn items.
6. If ZIP output is expected, run the normal `ResultResolver` pipeline against the recovered response. This must select/download/reconstruct the current candidate artifact rather than silently reusing stale state.
7. Update only the current project/session scope: `lastTurnId`, `lastTurn`, response history, and selected artifact/result metadata.
8. Print enough terminal output to identify what was recovered, which candidate was used, which artifact/result was selected, and what command should be run next.

A missing local turn is not a valid reason to print `No turn is available for recovery` after the browser has returned a visible candidate. That situation must use the adopted-turn path. The error is valid only when there is neither a local turn nor permission/context to adopt one, or when the browser companion cannot return the selected candidate.

## `/recover <n> --apply` flow

1. Run the full `/recover <n>` flow first.
2. If the recovered output is a ZIP result, call the same `/apply` path used for normal task results.
3. If the recovered output is not a ZIP, print a clear message that there is nothing to apply and keep the recovered answer in response history.
4. Do not apply a previously selected ZIP merely because the current recovery did not produce a ZIP.

## `/apply` flow

1. `/apply` without a path applies the currently selected ZIP result from the current project/session scope.
2. `/apply /path/to/result.zip` applies the supplied local ZIP, but it must still use the same safe planning/apply implementation.
3. Every invocation builds a fresh apply plan against the current project tree and current reference manifest.
4. `lastAppliedTurnId` and `lastAppliedFileId` are only hints for logging/cleanup. They must not skip planning. A result can be skipped only when the fresh plan is actually empty/unchanged or the user cancels.
5. The safety path must remain unchanged: validate ZIP paths, block traversal/absolute/symlink entries, respect ignored/internal files, detect local changes after snapshot, and ask for confirmation unless forced or safely auto-applied.
6. Apply state is scoped by active project and ChatGPT session. Switching project or session must not reuse another scope's selected artifact or applied flags.

## Regression tests to keep

Minimum test coverage for this flow:

```text
/recover list shows [1] for a visible response
/recover 1 treats 1 as candidateIndex, not as local turn id
/recover 1 works when no local turn exists by creating an adopted recovery turn
/recover 1 --apply uses the recovered ZIP, not an older selected ZIP
/apply always replans even if lastAppliedTurnId/lastAppliedFileId match
/apply /path/to/result.zip uses the same safety planner as normal selected results
```

## Recent bug fixed in this session

Observed failure:

```text
/recover list
  [1] turn 29 · 267 chars · 1 artifact(s) · ...
/recover 1
No turn is available for recovery
```

Root process bug: the list step succeeded through the browser-visible candidate path, but the selection step required an existing local metadata turn. After local state loss or scope mismatch, the selected visible candidate could not be attached to anything.

Fix direction: `/recover <n>` now allows `TurnManager` to create an adopted recovery turn in the active project/session scope when no local turn is available, then continues through the same recovered-answer/artifact/result pipeline.

## Real-browser E2E handoff (v61)

A separate live test now exercises the extension against a real logged-in ChatGPT tab:

```bash
npm run test:e2e:real
```

It is intentionally excluded from `npm test`. The test creates an isolated tab, performs a basic exact-answer turn, follows up in the same conversation, verifies `/sessions`, asks ChatGPT directly for a real downloadable text artifact, and verifies the downloaded bytes.

Default cleanup is identity-bound. The runner remembers the concrete session URL produced by the first turn, checks that the same source client remains on that URL, and deletes only that conversation. The content script rechecks `sessionId + canonical URL` around every destructive click. A mismatch is a hard refusal and leaves the tab open. Use `--keep-session` to skip deletion and preserve the test conversation intentionally. Diagnostics default to the current project's `.bridge-data/e2e/last-real-e2e/` plus the uploadable bundle `.bridge-data/e2e/last-real-e2e.zip`; incremental files are created before the first prompt.

## 2026-07-12 — real E2E matrix

Added bridge 4.7.0 / extension 0.3.6 / content 2.10.0. The real E2E runner now covers visible reasoning, completion, source-bound steer, multiple files, ZIP output, project AGENT/skills, missing context, multi-turn edits, and snapshot reuse. Diagnostics are emitted as report.json, SUMMARY.md, timeline.ndjson, and a single uploadable ZIP bundle. Normal test suite: 177/177 passing.

## 2026-07-12 — automatic tab routing (v62)

Added bridge 4.8.0 / extension 0.3.8 / content 2.10.2. The E2E startup race is fixed by removing the assumption that exactly one new ChatGPT client appears after launch. The runner now calls the bridge's centralized browser-open endpoint, and the bridge waits for the client carrying its exact launch token.

The same mechanism is available to ordinary server and interactive prompts with `--auto-open-tab`, `AUTO_OPEN_TAB=1`, or request field `autoOpenTab: true`. Existing safe session matches are still reused. Ambiguous/unavailable targets create a dedicated tab; explicit source ids remain strict; an already-busy requested conversation is not duplicated. Normal auto-opened tabs are retained for ongoing work rather than cleaned up like E2E-owned tabs. Regression suite: 185/185 passing, including a late unrelated tab reconnect arriving before the token-matched system-opened tab.


## 2026-07-12 — isolated E2E port and launch-token compatibility

Added bridge 4.9.0 / extension 0.4.0 / content 2.11.0. The real E2E runner now starts on a free loopback port with a separate temporary data directory by default, preventing collisions with an ordinary bridge on 8080. Launch metadata carries both the exact one-time token and the per-tab E2E server URL. The content/background pair validates and persists the loopback override without changing normal extension settings.

The bridge now accepts the exact launch token from either the handshake or the bridge-created URL, fixing the observed case where the client connected at `#chatgpt-bridge-launch=...` but reported an empty `launchToken`. Timeout diagnostics include observed client metadata and explain that a launch fragment left in the address bar indicates stale content-script code. Regression suite: 187/187 passing.

## 2026-07-12 — E2E page readiness, real steer window, and durable diagnostics

Added bridge 4.10.0 / extension 0.4.1 / content 2.12.0. The real runner now waits for a stable ChatGPT composer before sending, and the content script confirms every real DOM submission with up to three bounded retries. `/health` now exposes active request diagnostics, fixing the steer timeout caused by waiting for a field that the route never returned.

The steer scenario now begins with an exact RED fallback rule during a deliberately long multi-step task, waits until the request is accepted and actively generating, then sends a separate source-bound steer that overrides the result to exact BLUE. Context-continuity prompts explicitly prohibit updating account-wide ChatGPT memory.

Repeated `--model`/`--effort` flags or comma-separated `--models`/`--efforts` values run an opt-in real selection matrix. Reports now start in the current project's `.bridge-data/e2e/last-real-e2e/` before any prompt and include incremental console/partial files plus a verified final ZIP bundle. Normal regression suite: 188/188 passing.

## 2026-07-12 — steer re-anchoring and locale-independent cleanup

Added bridge 4.10.2 / extension 0.4.3 / content 2.12.2. Diagnostic bundle analysis showed that a real steer was successfully submitted, but ChatGPT represented it as a new user/assistant pair while the tracker kept reading the original assistant placeholder. Active requests now move their submitted-user and assistant anchors after steer and reset stale terminal state.

Conversation cleanup now treats visible labels as diagnostics only. It selects the exact `delete-chat-menu-item` from the trigger-owned/newly opened Radix menu and confirms through stable destructive metadata in the newly appeared dialog. Russian, English, French, Japanese, or any other interface language no longer changes the selector path. Regression suite: 192/192 passing.


## 2026-07-12 — fullscreen preview artifact fix

Added bridge 4.10.3 / extension 0.4.4 / content 2.12.3. The uploaded real E2E bundle failed because clicking `eeb90261d0ea-one.txt` opened a fullscreen file preview; no Blob, URL, or browser download was produced by that first click. The content runtime now detects the exact newly opened filename-bound preview, clicks its structural download control with captures already armed, uses a bounded CodeMirror UTF-8 fallback, and closes the preview before downloading the next file. A sanitized fixture preserves the observed DOM contract. Regression suite: 195/195 passing.


## 2026-07-12 — v4.10.4 delayed preview readiness

Live diagnostics showed the file card click opening a fullscreen shell immediately while its actual header controls and CodeMirror content appeared later behind a loader. The old preview branch stopped matching after eight seconds and left the 120-second browser capture as the only pending path. The preview resolver now continuously re-describes the new dialog, records `artifact.preview.waiting`, waits for a usable filename-bound control plus mounted text content, and emits `artifact.preview.ready` before clicking. Real E2E prompts are written in English.

## 2026-07-12 — v4.10.5 dual preview layouts and localized action fallback

The uploaded E2E report showed the first text artifact materializing through `page-url` while its preview appeared roughly one minute after the original click, during the second artifact download. The old code therefore waited on the wrong filename preview and eventually timed out. Two real DOM fixtures were added: a fullscreen `role=dialog` preview and a `[slot=content]` library panel.

The content runtime now identifies the exact filename first, waits through loader states, resolves download/close actions from stable metadata or a container-scoped multilingual `aria-label`, closes delayed foreign previews, and retries the current text-file click once. ZIP, binary, and large direct downloads keep the existing fast path and do not incur preview cleanup waits unless a text-like URL capture indicates that a delayed preview may still appear.

Regression suite: 199/199 passing.


## 2026-07-12 — v4.10.6 sequential artifact retry fix

The uploaded E2E bundle proved that the first file downloaded and its preview closed correctly. The second file card was clicked, but a late preview for the first file appeared, was closed, and the retry crashed with `retryAction.click is not a function`. The retry parameter was a callable, not a DOM element.

The content runtime now invokes the retry callable, re-finds a live filename/source-turn-scoped action before every click, waits briefly through React replacement, and re-resolves the source turn during DOM URL polling. This allows the artifact loop to continue immediately to the second and third files instead of waiting for the global 120-second capture timeout.


## 2026-07-12 — v4.10.7 exact artifact identity and shorter waits

The latest real E2E diagnostics proved that artifact sequencing was not primarily a delayed-preview retry problem. Every generated-file action had the same generic CSS selector hint, and `document.querySelector()` always returned the first button. Requesting the second JSON therefore reopened the first TXT file.

The content runtime now resolves all live actions inside the exact source turn and requires exact filename identity or a stable block/action locator. Selector hints are weak discovery metadata only. The runtime clicks once, waits for concrete completion signals with exponential observation backoff, and fails immediately if another filename preview opens. Browser materialization is capped at 45 seconds and the server command envelope at 60 seconds.

## 2026-07-12 — v4.10.8 extensionless CSV/table preview identity

The latest E2E bundle reached the third CSV artifact with the correct source-turn action, but the preview was not recognized. ChatGPT rendered a spreadsheet-style `[slot="content"]` panel with `[data-testid="popcorn-toolbar"]`; its visible title was `test_data` and its adjacent type label was `CSV`, while the bridge expected a generated filename ending in `.csv`.

The content runtime now recognizes this panel, binds `test_data` + `CSV` to the expected CSV artifact, scopes localized download/close controls to the proven toolbar, and adds `test_data.csv` as a temporary capture alias. Arbitrary artifact titles such as a friendly ZIP label are accepted only when the exact clicked artifact's format is unique in the source turn. Same-format ambiguity remains fail-closed. Direct binary/ZIP downloads keep the existing fast path. Regression suite: 209/209 passing.


## 2026-07-13 — v4.10.9 ZIP completion guard

Diagnosed `last-real-e2e(6).zip`: the actual ZIP button was exact and READY, but `[data-state]` scanning misclassified a code-block Copy control and extracted `alpha.txt` from nearby Python as a GENERATING artifact. This prevented `request.done`; consequently a manual ZIP click could not be attached to a bridge artifact capture because no fetch command/capture ID existed yet.

Fixed lifecycle filtering, ZIP-specific required-output matching, bounded post-generation snapshot backoff, and E2E time budgets (90s request, 45s materialization, 30s required-artifact settle). Full suite: 212/212.


## 2026-07-13 — v4.10.10 semantic ZIP title and long-turn waiting

The project E2E reached a READY ZIP action whose visible title was `Download the updated project ZIP`, but the server guard did not treat that extensionless title as ZIP identity and consumed the full 30-second settle window. The E2E runner then hit its own fixed 90-second turn deadline shortly after the bridge began artifact resolution.

The server guard now considers action label/block text semantic ZIP identity while still rejecting unrelated READY files. E2E turn waiting is based on observable inactivity, not total elapsed time; active half-hour turns are supported by default. Delete confirmation uses internal bounded backoff, and outer cleanup retries are exact-URL/source-bound with exponential delays.


## 2026-07-13 — explicit result vs pipeline timeout domains

The v4.10.10 work was tightened after review: short HTTP control calls, long-running ChatGPT result generation, post-generation pipeline work, and artifact materialization no longer share one timeout. Active generation has no default absolute deadline; result inactivity defaults to five minutes; post-generation inactivity defaults to 60 seconds; and artifact fetching remains 45 seconds. The E2E child bridge now receives the long result timeout instead of the 30-second HTTP timeout. Delete confirmation keeps bounded backoff and adds a final short URL-removal grace for navigation races.


## 2026-07-13 — v4.10.11 exact turn boundary, generic ZIP completion, and safe download cleanup

Diagnosed `last-real-e2e(8).zip`. The second project turn was attached to the previous visible user/assistant pair before the new prompt was actually submitted. The old answer and old ZIP were therefore copied into the new request state; the downloaded 732-byte archive was valid, but it was the first-turn archive and still contained `revision=1`.

Content runtime 2.12.11 now records the complete turn-key baseline immediately before submission and keeps all DOM output capture disarmed until that boundary is established. Foreground resyncs, `pageshow`, polling, and MutationObserver callbacks can no longer adopt the previous turn during model/session/file setup. The E2E runner now requires extension 0.4.12 / content 2.12.11 so the stale runtime cannot silently reproduce this failure.

The required-ZIP completion guard now shares the resolver's materialization policy. One scoped READY action with an extensionless label such as `Download the complete updated project` can proceed directly to download and byte-level ZIP validation. Clearly named non-ZIP files and ambiguous groups still wait. This removes the observed 30-second forced-snapshot loop. Post-stop terminal stability is configurable through `POST_STOP_TERMINAL_SETTLE_MS` and defaults to 900 ms instead of a hidden 2.5-second floor.

Chrome download cleanup is now fail-closed. After the artifact has been copied into the bridge store, the source file is removed only when the exact absolute path, Chrome download id, captured filename, size, creation-time window, device/inode, and timestamps still match the file registered during the current capture. Missing metadata, stale files, multiple conflict-name candidates, or any change after import leaves the source untouched and emits `artifact.download.source_cleanup_skipped`. The real E2E runner audits every fetched artifact: in-memory/page captures need no filesystem cleanup, while a `chrome-downloads` source must emit exact-source removal; a safety skip fails the test and explicitly leaves the file untouched rather than broadening deletion criteria. A DOM observer race that captured the correct new user turn before click confirmation also returns immediately instead of consuming the full five-second anchor wait. Additional review added prompt-text turn matching, explicit non-ZIP rejection in the actual result resolver, E2E cleanup auditing, and symbolic-link rejection. Full regression suite: 226/226 passing.


## 2026-07-13 — v4.10.12 response parser E2E, reasoning history, and bound-download cleanup

The previous cleanup implementation still left files in Downloads when a page Blob/URL result won the artifact materialization race after the same click had already started a Chrome download. The content script now performs an atomic capture release: an unbound capture is cancelled, while a capture with a concrete `chrome.downloads` id is retained, awaited, imported, and deleted through the existing fail-closed path. The real E2E audit verifies both the removal event and actual path absence.

Final answer parsing now exports ordered semantic response blocks and exact code blocks. Inline code remains Markdown inline code; fenced block language is preserved; code uses `textContent`; and Markdown whitespace normalization does not modify fenced code. These structures reach completed `agent_message` items and recovery responses.

Reasoning/status persistence now uses one stored item per logical visible phase with stable ids, revisions, lifecycle state, structural hints, timestamps, and source metadata. Empty DOM clearing snapshots cannot erase a non-empty phase. Completed history is merged across live progress, forced snapshots, final done payloads, resume, and recovery.

Added a real-browser `response parsing and reasoning lifecycle` scenario with raw DOM snapshots as the oracle. It verifies exact paragraphs, inline code, JavaScript/Python blocks, streaming convergence, reasoning phase completeness/order, and the transition into a clean final answer. Dedicated parser diagnostics are included in the final report ZIP.

## 2026-07-13 — v4.10.13 independently runnable real E2E scenarios

The real-browser runner no longer relies on one monolithic ordered scenario chain. Stable scenario ids are registered in `scripts/e2e-scenarios.js` and selected with repeatable `--scenario` / `--scenarios` options. The default remains the complete suite, while focused npm commands run `conversation`, `response-parser`, `model-effort`, `reasoning-steer`, `multiple-files`, `zip-artifact`, `project-context`, or `project-no-context`. Group aliases include `smoke`, `artifacts`, and `project`.

Session creation was moved into a minimal common bootstrap that is not reported as a scenario. Every focused run therefore obtains its own concrete ChatGPT session id and canonical URL for exact cleanup without depending on `conversation` running first. A single selected scenario writes diagnostics to `.bridge-data/e2e/<scenario-id>/`; a single group alias uses its alias as the report directory, while the complete suite retains `last-real-e2e`.

`model-effort` is now a first-class short scenario. It reads the real model and effort pickers, defaults to their currently selected values when no flags are supplied, applies each requested pair, requires both `model.apply.started` and successful `model.apply.done`, verifies a deterministic exact answer, then re-reads both pickers sequentially to confirm the requested state persisted. Explicit model/effort lists still form a bounded matrix of at most 12 cases. Regression suite: 236/236 passing.

## 2026-07-13 — v4.10.14 localized transient intelligence picker

The smoke E2E failed at `GET /models` because the previous parser treated the picker as a stable nested menu and searched only the immediate composer root. The supplied DOM showed a different contract: top-level localized radio items are effort modes; the final submenu item contains the current model; the model list is a separate hover-only Radix portal.

The extension now discovers the picker trigger across bounded composer ancestors, identifies the final submenu item structurally, maintains hover/focus while resolving its `aria-controls` / `aria-labelledby` portal, and reads the model list before it disappears. Localized efforts are normalized to stable automation ids while preserving their UI labels. Current model resolution is based on the trigger with the submenu check retained for diagnostics. Added a captured localized picker fixture and regression tests for the three visible effort tiers, transient model annotations, and stale submenu checks.


## 2026-07-13 — v4.10.15 split parser diagnostics and real model/effort transitions

The response parser E2E is now split into `response-markdown` and `reasoning-lifecycle`; the old `response-parser` selector remains as a compatibility alias for both. Each scenario writes its DOM timeline, parsed state, stored items, and events before assertions, so an early Markdown mismatch no longer blocks reasoning coverage or removes the most useful diagnostics.

Code-language fallback is now scoped to the concrete code block. It first uses a minimal wrapper containing exactly one `<pre>` and otherwise associates an exact language label with the next `<pre>` in document order. This fixes the observed failure where the second Python block inherited the first block's JavaScript label. Localized short author labels, including the equivalent of `ChatGPT said:`, are excluded from progress history.

The default `model-effort` scenario now proves actual changes instead of reapplying the selected pair: it switches to another model, switches to another effort, verifies both picker transitions and exact answers, then restores the original model/effort in a guarded final turn. Explicit `--model` and `--effort` values continue to test exactly the supplied fields. Extension 0.4.15 / content runtime 2.12.14 is required.

## 2026-07-13 — v4.10.16 response parser hardening and English-only Markdown

The code-language parser was hardened against current ChatGPT code-block layouts. It now reads explicit metadata from code, pre, and single-pre wrappers; scans bounded preceding and CSS-ordered following toolbars; reads direct text nodes and interactive header descendants; and ranks labels only within the interval associated with the target code block. Markdown and structured code blocks are now built from one language-resolution pass, preventing transient disagreement between the two representations.

Code-block language diagnostics now travel through the content script, bridge state, recovery response, and completed `agent_message`. The real `response-markdown` scenario records the stored diagnostics, accumulates every detectable structural/content/language/streaming mismatch before failing, and includes a sanitised DOM context. Multi-scenario runs continue after a local scenario failure and return one aggregate failure after all selected scenarios.

The reasoning lifecycle diagnostics now include a revision timeline and reject decreasing revisions or text changes that reuse the same revision. The Markdown fixture also covers inline code containing backticks, emphasis, deletion markup, code containing fence-like backticks, and exact per-block language labels.

All project Markdown documentation is written in English. Extension 0.4.16 / content runtime 2.12.15 is required for the updated live parser.

## 2026-07-13 — v4.10.17 lossless response ownership and live parser transcript

The final-answer parser now uses one ordered semantic block stream as the source of both stored `responseBlocks` and reconstructed Markdown. Every visible text leaf is audited as content, artifact, interface, reasoning, unknown, or duplicate ownership. Unknown visible text is retained as an explicit plain-text `unknown` block in ordinary parsing and fails the strict real-browser parser scenario instead of disappearing silently.

Code blocks are parsed as outer response-level widgets. A nested CodeMirror `<pre class="cm-content">` is only the code source and cannot become a second top-level block. Toolbar language metadata, localized Copy/Run controls, editor content, and unknown widget chrome are classified separately. The current nested CodeMirror structure is represented by deterministic DOM fixtures, with an optional real-Chromium fixture enabled through `CHROMIUM_BIN`.

`response-markdown` now creates and prints a live `parser-observation.txt` path. Every meaningful snapshot records raw visible assistant text, parsed blocks, reasoning/progress, artifacts, excluded UI, unknown content, duplicate ownership, and coverage. Terminal diagnostics also include `parser-audit.json`, `response-blocks.json`, `reasoning-blocks.json`, `unknown-nodes.json`, and a sanitised terminal DOM. Streaming validation no longer assumes rendered Markdown is a byte-prefix of the final answer; exact text and 100 percent coverage are terminal invariants.

Extension 0.4.17 and content runtime 2.12.16 are required for the lossless parser audit.

## 2026-07-13 — v4.10.18 parser ownership and paced intelligence picker

The response parser now traverses zero-box and `display: contents` wrappers through the shared parser visibility rules. A response-level `<pre>` remains the atomic owner of a nested CodeMirror editor, and code-widget owners are collected independently before semantic block traversal. Parser coverage uses the complete visible-text leaf walk as its denominator, so a skipped subtree can no longer report false 100 percent coverage.

The intelligence picker interaction is deliberately paced. Each activation method receives a full mount-and-stability window before any fallback is attempted. Model submenu hover is pulsed at a human-scale interval, option lists settle before selection, each option is clicked at most once per selection attempt, verification retries only reread state, and model-to-effort changes have a separate settling delay.


Extension 0.4.19 and content runtime 2.12.18 are required for these changes.


## 2026-07-13 — v4.10.19 observable model-picker E2E flow

The model/effort report showed six Intelligence-menu openings represented by twelve activation events because every opening first used `element.click()` and then fell back to pointer events. The E2E runner also opened the same picker repeatedly through separate `/models` and `/efforts` reads before and after each transition.

Content runtime 2.12.18 now treats one menu opening as one logical pointer-click sequence. Keyboard Enter is the only fallback and is attempted only after the full open-and-stability timeout. The hover-only model submenu receives one entry sequence followed by low-frequency pointer movement; it is never clicked as a fallback. Each model or effort option is clicked at most once. A single combined state read verifies all requested changes after selection and is included in `model.apply.done`, so the E2E runner does not reopen the picker to duplicate that verification.

The real E2E runner now has a structured ANSI console logger. It reports `STEP`, `SEARCH`, `WAIT`, `ACTION`, `RETRY`, `STATE`, `OK`, `WARN`, and `FAIL` records with elapsed time, scenario scope, retry counts, timeouts, requested values, and completion criteria. Live extension diagnostics are streamed into this readable trace. `console.log` keeps the same structure without ANSI escape sequences. `--color` forces color and `--no-color` disables it.

## 2026-07-13 — v4.10.20 end-to-end internal trace and deterministic reasoning prompt

The real-browser runner now exposes the internal decision path instead of showing only scenario-level steps. Browser diagnostics are translated into structured `SEARCH`, `WAIT`, `ACTION`, `RETRY`, `STATE`, `OK`, `WARN`, and `FAIL` records for page readiness, exact turn-boundary capture, composer discovery, prompt insertion and submission evidence, assistant-turn capture, generation state, terminal stabilization, artifact discovery, preview/materialization paths, Chrome-download adoption, safe source cleanup, recovery, steering, and URL-bound conversation deletion. Unrecognized browser diagnostics are no longer silently discarded; they are emitted with a bounded set of safe summary fields. The interactive trace uses ANSI color and emphasizes actions, retries, completions, warnings, and failures, while the saved `console.log` remains plain text.

Non-reasoning scenarios request the normalized `instant` effort and avoid reopening the picker once that effort is already expected to be active. Scenarios that require visible reasoning switch to a reasoning-capable effort only for those turns.

`reasoning-lifecycle` now uses the verified percentage-progress prompt. Every attempt receives its own generated test id and requires matching `TEST_<id>_BEGIN` and `TEST_<id>_FINISH` boundaries, the sum `25502500`, and a JavaScript code block that prints the same result without delays. The DOM timeline is checked for the visible `0%` through `100%` checkpoints. The exact prompt and final answer for every attempt are saved as text diagnostics.

No automated Cyrillic scan is part of the project test suite. Project Markdown is maintained in English as an authoring rule.

Extension 0.4.20 and content runtime 2.12.19 are required.

## 2026-07-14 — v4.11.0 passive artifact workflows

Added a persistent workflow engine for externally initiated ChatGPT turns. The extension baselines existing assistant turns and emits new terminal turns even when the prompt originated from another device. A JSON workflow can verify, approve, or automatically apply a scoped project ZIP; execute staging and post-apply commands; roll back failed changes; send bounded validation output back to the original conversation; process replacement artifacts; optionally create a local Git commit; and deploy/reload the unpacked extension.

Workflow state, approvals, artifact SHA-256 values, and events survive daemon restarts. Artifact operations are serialized per project workflow. Duplicate archives are skipped by content hash. Automatic mode degrades to persistent approval for protected paths, unsafe plans, ambiguous ZIPs, or policy limits.

Added `bridge.workflow.example.json`, `docs/WORKFLOWS.md`, workflow HTTP endpoints, interactive `/workflow` and `/watch` commands, `workflow:init`, and `extension:install`. The extension manifest now has a stable public key. A stable unpacked directory only needs to be loaded once; later updates use `chrome.runtime.reload()` and reload the affected ChatGPT tabs.

Bridge 4.11.0 requires extension 0.5.0 and content runtime 2.13.0.

## 2026-07-14 — v4.12.0 project identity, restart handoff, atomic extension deployment, and passive workflow E2E

Project workflows now create a stable UUID in `.bridge/PROJECT_ID.json` and a bounded fingerprint in `.bridge/PROJECT_FINGERPRINT.json`. Bridge-generated complete project archives and lightweight project-context attachments preserve these files. Verification requires an exact project-ID match when the artifact contains identity metadata and otherwise uses the synchronized fingerprint context as a fail-closed fallback.

A successful self-hosted update can persist a daemon restart intent after terminal workflow state, then either exit with a supervisor-friendly code or invoke a configured restart command. The next process acknowledges the persisted intent after restoring workflow state. Added a real-browser `passive-workflow` E2E that submits through the browser-only passive path and verifies unsolicited turn observation, identity matching, artifact download, application, and post-apply validation.

External unpacked-extension deployment now uses a sibling staging directory, a validated backup archive, atomic directory replacement, reconnect verification, and rollback to the previous extension when the new service worker does not reconnect. A future approval notification/UI remains a roadmap item; approvals are currently exposed through CLI and HTTP only.

## 2026-07-14 — v4.12.1 incremental passive parsing and response-parser performance

The passive observer no longer reparses up to 80 historical assistant turns every two seconds. It maintains a bounded dirty-turn set from MutationObserver records, parses only changed unfinished turns, baselines and permanently skips completed historical turns, and uses a five-second lightweight poll only to recover missed recent changes. Session and emitted-turn caches are bounded.

A response-parser pass now owns short-lived WeakMap caches for visibility, computed styles, text leaves, code-content sources, and code-widget ownership. Ancestor visibility and computed styles are evaluated once per element per pass. The parser no longer calls `getBoundingClientRect()` for visibility and no longer enumerates every descendant as a possible code-widget owner. Parser audit diagnostics include performance counters and elapsed time.

This removes the continuous style/layout work visible in Chrome profiling on long conversations and prevents temporary parser DOM collections from being retained between passes. Regression coverage verifies cached visibility/style reads, dirty-only passive parsing, and the absence of the former full-history scan.

## 2026-07-14 — v4.12.2 real workflow E2E matrix

- Expanded the single passive workflow happy-path check into three independent real-browser scenarios: automatic apply, explicit approval, and rollback/remediation.
- The initial artifact prompt is submitted through the browser-only passive command so the workflow must detect an unsolicited terminal turn rather than relying on a pending bridge request.
- Added structured workflow-event logging that distinguishes actions, waits, state transitions, retries, approvals, verification, rollback, remediation, and completion.
- Added per-scenario workflow diagnostics containing the generated configuration, full event history, approval state, and terminal project files.
- Added `npm run test:e2e:workflows`, `test:e2e:workflow-approval`, and `test:e2e:workflow-remediation` while preserving `test:e2e:passive-workflow` as the focused automatic-apply scenario.

## 2026-07-14 — v4.12.3 workflow E2E failure handling and shared context

- Fixed the passive workflow helper so effort is passed explicitly instead of referencing a closure that is unavailable at module scope.
- The real workflow suite now synchronizes one stable project identity into the owned conversation and reuses it across auto, approval, and remediation scenarios. Individual scenario projects carry the same `.bridge/PROJECT_ID.json` and package identity, avoiding contradictory project contexts in one chat.
- Project-context acknowledgements accept the exact marker surrounded by harmless punctuation or Markdown while still rejecting a different or extended project id.
- Workflow waits name the exact target event, show the current stage, and fail immediately when a newly observed fatal event makes the target impossible. Approval waits also report the number of pending approvals.
- Workflow diagnostics now include `workflow-progress.json`, which records whether the passive prompt, artifact observation, download, verification, approval, apply, remediation, and terminal completion stages actually occurred.
- SIGINT and SIGTERM produce a terminal interrupted report instead of leaving only `RUNNING.json` and partial diagnostics.


## 2026-07-14 — canonical request-state foundation

Implemented the first request-state architecture slice described in `ARCHITECTURE.md`:

- Phase 1: canonical event/state vocabulary and complete mapping for current legacy request phases;
- Phase 2: pure reducer with typed terminal outcomes, stale source-sequence rejection, artifact-contract settling, effects, deadlines, and invariant checks;
- Phase 3: revisioned entity store, bounded transition journal, and subscribe-first `waitForState()`;
- Phase 5 foundation: legacy progress and hub heartbeat adapters connected to an isolated shadow runtime in `TampermonkeyBridge`;
- Phase 6 foundation: idempotent effect runner with cancellation and typed result events.

The production request completion/watchdog path was not switched. Shadow state is diagnostic only and is available through active request diagnostics, `requestStateDiagnostics()`, `/diagnostics/request-state`, the diagnostics page, and compact/full debug bundles. The full regression suite passed with 320 tests passing and one expected skip; JavaScript syntax checks passed for 136 files.

## 2026-07-14 — always-on tab observations and narrow canonical cutover

Continued the canonical request-state migration from `ARCHITECTURE.md`:

- completed the code-level Phase 4 implementation with `observation/tabObservationCore.js` and `observation/tabObserver.js` loaded before the compatibility content script;
- one observer now runs for the content-script lifetime, including tabs with no active bridge request, and emits deduplicated facts with `observerId`, revision, URL/conversation, document/composer readiness, assistant state, generation, blockers, output, errors, and artifacts;
- degraded document/composer state is stabilized before publication so a brief React replacement is not treated as a durable state change;
- the hub retains the latest observation per client and ignores duplicate/stale revisions inside one observer epoch while allowing a new epoch to restart at revision one;
- the request adapter scopes assistant/generation/error facts only after prompt binding or when the observation explicitly names the request, preventing old page content from advancing a new request;
- canonical explicit UI errors, bound-conversation changes, and request replacement began terminating compatibility requests immediately; this checkpoint used a temporary rollback flag that was removed in the later single-lifecycle cutover;
- prompt delivery is the first production effect routed through `EffectRunner`; typed non-retryable delivery failure becomes canonical `effect_failed` without waiting for the watchdog;
- production completion, general progress, resume/recovery, and watchdog ownership remain on the legacy path.

At this historical checkpoint the extension version was 0.6.2 and content runtime was 2.15.0. The later cutover entry below supersedes these versions and rollout mechanics.


## 2026-07-14 — canonical lifecycle, deadline, workflow state, and replay

Continued the migration defined in `ARCHITECTURE.md`:

- Phase 8 is implemented: one revision-aware coordinator owns request deadlines, and timer callbacks only publish `deadline.reached`; normal completion, cancellation, required-artifact settling, liveness failure, forced snapshots, and artifact probes flow through canonical state.
- this historical checkpoint still carried temporary full and narrow lifecycle rollback flags; both were removed by the later single-canonical-lifecycle cutover.
- Phase 9 is implemented for passive workflows: watcher and pipeline state are independent and persisted, state is committed before events, remediation retains one pipeline id, and `workflowManager.js` is below the 1,000-line exception ceiling after domain extraction.
- Phase 10 is substantially implemented: real E2E request waits use canonical snapshots, failed waits persist redacted replay traces, workflow waits consume committed pipeline state, and deterministic replay fixtures cover the current recurring lifecycle bugs.
- Phase 11 started structurally: workflow routes and reusable SSE streaming were extracted, bringing `routes.js` below 1,000 lines. The later cutover removed lifecycle inference and rollback code; decomposition of the largest coordinators remains.


## 2026-07-14 — single canonical request lifecycle cutover

Completed the behavioral transition to one authoritative request machine:

- extension protocol 3 publishes `request.terminal_snapshot` and `request.terminal_failure` observations, but does not declare request completion or release active ownership;
- the server reducer determines terminal outcome and sends an explicit `request.release` effect back to protocol 3 clients;
- protocol 2 `done`/`error` messages remain accepted only as compatibility observations and pass through the same reducer;
- legacy watchdog/finalization rollback flags, regex phase inference, duplicate artifact-settle timers, and content-side required-artifact completion policy were removed;
- request preparation, session/model application, attachment upload, prompt submission, steering, resume, forced snapshot, and artifact probe paths emit typed effect lifecycle events;
- the canonical runtime was renamed from the former shadow terminology, reducer transitions and bridge operations were extracted into domain modules, and compatibility re-exports remain only where existing imports require them;
- extension version is 0.7.0 and content runtime is 2.16.0.

The full regression suite passes with 361 tests passing and one expected skip; JavaScript syntax checks pass for 171 files. Real ChatGPT browser E2E was not available in this environment, so live parity remains a release-validation requirement rather than a reason to keep a second runtime state machine.

## 2026-07-14 — bridge coordinator decomposition

Completed the server-side structural boundary for the canonical lifecycle:

- extracted `RequestLifecycleCoordinator` for reducer/store ownership, typed effects, named deadlines, terminal materialization, cancellation, and request release;
- extracted `BrowserClientCoordinator` for session-aware tab selection, browser launch/reconnect, and prompt delivery;
- extracted `BridgeClientEventRouter` for protocol 2/3 extension messages, tab observations, and compatibility normalization;
- retained bounded administrative commands in `BridgeOperations`;
- reduced `src/tampermonkeyBridge.js` to an 856-line compatibility facade and removed stale imports;
- verified that no content-script `done`/`error` sender or alternate server finalization call remains.

After this decomposition the full suite still passes with 361 tests and one expected skip; syntax checks cover 171 JavaScript files. Remaining migration work is structural decomposition of the extension content script, interactive command/UI files, DOM parser coordinator, and real-browser E2E runner, plus live ChatGPT parity evidence.
