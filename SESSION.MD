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
