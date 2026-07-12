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
