# Current Session Handoff

## Current release

- Bridge package: `5.10.0`.
- Extension manifest: `1.0.15`.
- Content runtime: `3.0.15`.
- Extension protocol: `3` only.
- Interactive dependency: exact `terlio.js@1.1.0`.
- `package-lock.json` references public npm registry URLs only.

## Workflow UX implementation

- `/workflow` is the single required interactive workflow command and no workflow starts from ordinary interactive mode.
- The wizard exposes exactly **Apply changes from ChatGPT**, **Fix the project until checks pass**, and **Work through a task** over one shared runner.
- Normal startup fits within goal, chat, project, checks, and summary decisions. Existing chats default to quiet attachment; new chats use a separate project archive and workflow instruction file.
- Global defaults and profiles are stored in `~/.bridge-data/workflows/config.json`, validate known values with exact JSON paths, preserve unknown fields, and support live per-workflow overrides.
- Persistent attention states reopen directly through `/workflow`; terminal bell and best-effort native desktop notifications are deduplicated and may be overridden per workflow.
- Effective project fingerprints prevent unnecessary uploads and trigger a complete context refresh when included local contents change.
- Automatic result packages require `bridge-result.json`; its file list is an exact allow-list for actual changes. Bridge control files are never written into the project.
- Invalid results use bounded automatic repair. Retry exhaustion and unresolved safety problems become explicit attention decisions.
- Workflow-owned Git files are tracked by exact path state. Manual edits made after application, during commit-message generation, before approval, or before finalization prevent the workflow commit. Unrelated work is not staged.
- Apply Changes exposes fix-loop, keep-and-stop, revert, and review actions after failed checks.
- Fix Until Checks Pass tracks attempts and no-progress signatures, supports checkpoints or final-only commits, and can squash workflow-owned checkpoints on success.
- Guided Task accepts text-only responses, routes returned ZIP files through the shared validator/apply path, offers follow-up/check/attachment/context actions, and completes the workflow when finished.
- Explicit session-exhaustion signals and a configurable per-chat workflow-turn limit follow automatic, ask, or stop recovery policy. Automatic recovery creates a fresh chat and sends a project/instruction/handoff package.
- Deterministic legacy definitions are mapped to presets for display and management. Ambiguous custom definitions remain an explicit open product-policy question.

## Verification completed

```text
npm run check
npm test
npm run test:workflow:multi-bridge
```

Observed results:

- `npm run check`: 300 JavaScript files passed; all production files remain under 1,000 lines and 28 remain above the 500-line target.
- `npm test`: 625 tests total, 624 passed, 0 failed, 1 optional test skipped.
- `npm run test:workflow:multi-bridge`: 1 integration test passed.
- New workflow UX regression tests cover exact manifest allow-lists, workflow control-file exclusion, live settings/profile persistence, per-workflow notifications, session turn recovery, Apply Changes failure decisions, fix-loop conversion, rollback ownership restoration, legacy preset mapping, and Git ownership races before both manual and automatic commits.

## External verification and open questions

An authenticated real-browser workflow release run was not executed in this environment because no logged-in browser profile is available. This is an external release-verification step, not a locally simulated success. The required product-policy and release-environment questions are documented in `docs/WORKFLOW_UX_OPEN_QUESTIONS.md`.

## Handoff constraints

- Keep `.bridge/PROJECT_ID.json` unchanged when present.
- Do not return `node_modules`, logs, databases, `.env`, secrets, generated E2E reports, nested archives, caches, build output, or `CHANGELOG.md`.
- Keep `package-lock.json` only while registry URLs remain public.
- Keep all project Markdown in English.
