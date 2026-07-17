# Current Engineering Goals

## Primary goal

Keep browser automation deterministic under changes in the live ChatGPT UI while making automated project workflows understandable without exposing internal pipeline concepts.

The browser request architecture and the `/workflow` redesign are implemented. Current work is release verification against authenticated browsers, maintaining deterministic offline evidence, and resolving the explicitly documented product-policy questions.

## Workflow UX goals

- Keep `/workflow` as the single interactive entry point and preserve ordinary interactive behavior until a workflow is explicitly started.
- Maintain exactly three user-facing presets over one shared runner.
- Keep normal setup within five decisions and expose advanced settings only when requested.
- Make every required decision a persistent, deduplicated attention state with immediate actions and portable notifications.
- Reuse unchanged ChatGPT project context and refresh it whenever effective included project contents change.
- Require exact, safe, machine-applicable result manifests and repair recoverable response errors automatically within a bounded limit.
- Commit only workflow-owned file states, preserve unrelated work, and support checkpoint/final-only plus squash/keep policies.
- Stop iterative repair automatically on success and ask after repeated no progress, maximum attempts, conflicts, or exhausted recovery policy.
- Keep text-only Guided Task responses valid and return cleanly to ordinary interactive mode when the task is finished.

## Reliability goals

- Keep passive workflow completion semantics identical to active request completion.
- Bound every workflow E2E wait with both an absolute stage deadline and, once started, a no-progress deadline.
- Fail immediately on explicit request-owned terminal errors.
- Preserve final answer, reasoning, ordered response blocks, artifacts, and source identity without reconstructing lifecycle from logs.
- Bind follow-ups, recovery, artifact actions, and release to the correct source tab.
- Treat required ZIP output separately from text completion.
- Catch content-runtime initialization and dependency-order failures before live browser testing.
- Reject self-navigation links, unsafe archives, undeclared result files, and unrelated fallback candidates.
- Keep one primary browser owner per tab and support independent workflow workers only through authenticated sequenced observed-turn and artifact APIs.

## Architecture goals

- Maintain protocol 3 as the only extension contract.
- Keep the extension as observer/effect executor and the server as decision owner.
- Keep all production source files at or below 1,000 lines and target 500 lines.
- Keep `content.js` and `e2e-real.js` as thin composition/orchestration facades.
- Keep content-module dependencies explicit and manifest-order bootstrap-tested.
- Convert recurring live DOM and lifecycle failures into sanitized offline fixtures and reducer traces.
- Keep watcher and pipeline state independent while presenting only plain-language workflow stages and actions.
- Keep workflow presets on one runner with shared configuration, notification, session, context, result, apply, check, and commit services.
- Keep headless workflow commands as advanced compatibility surfaces rather than prerequisites for interactive use.

## Verified in the current archive

- Package, extension, and content-runtime versions are `5.10.0`, `1.0.15`, and `3.0.15`.
- The only interactive runtime is exact `terlio.js@1.1.0`; Ink/React and their compatibility path are absent.
- `package-lock.json` contains public npm registry URLs only.
- `npm run check` passes for 300 JavaScript files; every production file remains below the 1,000-line ceiling and 28 files remain above the 500-line target.
- `npm test` passes 624 tests with one optional skip.
- `npm run test:workflow:multi-bridge` passes.
- Workflow UX regression coverage includes the three presets, first-run/global/profile configuration, attention actions, notification deduplication and overrides, context fingerprints, result repair and exact manifest allow-lists, project control-file exclusion, session turn recovery, no-progress handling, Git ownership races, checkpoint/final commit behavior, squash, pause/resume/stop, and Guided Task artifact routing.

## Open questions and external verification

The remaining workflow UX questions are maintained in `docs/WORKFLOW_UX_OPEN_QUESTIONS.md`:

1. Product policy for ambiguous custom legacy workflow migration.
2. Evidence and safeguards for classifying repeated failures as stale conversational context.
3. Execution policy and retained diagnostics for the authenticated real-browser release matrix.

The repository also retains broader browser-release work: capture a replayable ZIP-artifact DOM fixture and a self-contained canonical request trace, run the optional Chromium parser fixture when `CHROMIUM_BIN` is available, and continue splitting files above the 500-line target before adding substantial responsibilities.

## Release-validation sequence

1. Reload extension `1.0.15` in a logged-in target browser profile.
2. Run the complete real-browser matrix for all three workflow presets and retain diagnostics outside the repository.
3. Run the live reasoning lifecycle and inspect `public-progress-events.json`.
4. Run the live multi-bridge workflow scenario.
5. Capture and review sanitized ZIP/result-protocol fixtures and any self-contained request traces.
6. Rerun `npm run check`, `npm test`, `npm run test:e2e:local`, and `npm run test:workflow:multi-bridge`.

## Non-goals

- alternate browser transports;
- protocol downgrade support;
- multiple request state machines;
- page-context localhost transport;
- hidden interactive fallback runtimes;
- unbounded waits;
- automatic application of ambiguous or stale artifacts;
- commits outside explicitly started workflows;
- mandatory native notification dependencies;
- arbitrary file splitting that creates circular dependencies;
- committing full ChatGPT pages or unreviewed browser data as fixtures.
