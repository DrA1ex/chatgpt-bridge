# ChatGPT Files, Artifacts, and Code DOM Specification

Status: implementation-oriented companion to `CHATGPT_DOM_PARSER.md`.

## 1. Scope

This document covers:

- opening the attachment menu;
- uploading one or multiple input files;
- pre-submit upload readiness;
- binding attachments to the new user turn;
- generated files and archives;
- preview dialogs and download controls;
- browser-download capture and safe cleanup;
- code blocks that coexist with artifacts;
- delayed artifact completion after answer text has finished.

## 2. General safety rules

1. File identity must be scoped to one request and one assistant turn.
2. A filename mentioned in prose or source code is not an artifact.
3. A generic button state such as `open` or `closed` is not an artifact lifecycle.
4. Multiple ambiguous artifact actions fail closed.
5. Browser download cleanup may remove only the exact file registered by the current capture.
6. ZIP identity is ultimately validated from bytes, not only from a label or MIME hint.

## 3. Input attachment discovery

Prefer a real file input reached through the composer attachment trigger. Do not assign `input.files` with ordinary page JavaScript. Use the extension/browser file chooser path that activates the same React upload flow as a user action.

Attachment readiness requires evidence that each requested file has mounted in the composer and no longer has an active upload/error state. Do not infer the number of files from the number of visible remove buttons because grouped attachments and previews can add unrelated controls.

A pre-submit attachment record should include:

- expected filename;
- visible filename;
- size text when available;
- MIME/extension hint;
- upload state;
- stable structural fingerprint;
- insertion order.

## 4. Binding attachments to a user turn

Record attachment state before Send. After submission, bind only attachments shown in the newly anchored user turn. Existing attachment cards elsewhere in the conversation are not part of the current request.

The request must not continue if an expected attachment disappears before the user turn is created or if an error state appears.

## 5. Generated artifact discovery

A generated artifact may appear as:

- a direct anchor;
- a button that initiates a browser download;
- a button that opens a preview;
- a file card with a later download action;
- an extensionless action label for a complete project/archive;
- a lifecycle card that changes from generating to ready or failed.

Artifact records include:

- scoped artifact ID;
- display name and inferred filename;
- URL or preview identity when available;
- lifecycle phase;
- materialization method;
- MIME/format hints;
- exact assistant-turn key;
- evidence used for identity.

## 6. Avoiding false artifacts

Do not create an artifact from:

- a filename in a paragraph;
- a filename inside inline or fenced code;
- a reasoning/progress control whose surrounding `cot-v5` text mentions a filename or archive;
- a code-block Run/Copy control;
- an unrelated navigation link;
- a button whose only signal is `data-state="closed"`;
- a generic action when several generic actions are present;
- a preview whose title does not match the expected artifact identity.

Artifact and ZIP identity must come from the action itself, stable file/artifact
metadata, a materializable URL, or a verified preview. Ambient block text is
diagnostic context only and must never make an unrelated control ZIP-like.

A defensive artifact record with no lifecycle evidence and no materializable URL/action must not block response completion.

## 7. Required ZIP resolution

A required ZIP may be accepted from:

1. explicit `.zip` filename or ZIP MIME metadata;
2. an artifact action whose own title clearly identifies an archive;
3. one extensionless ready action scoped to the completed assistant turn, followed by byte-level ZIP validation.

The third case supports interfaces that label the action semantically rather than exposing a filename. A clearly named non-ZIP action and multiple generic actions remain insufficient.

Ambient prose mentioning another file does not disqualify an otherwise unique project-download action because artifact identity is taken from the action itself, not the surrounding answer text.

## 8. Preview handling

A preview shell may become visible before its content or download control is ready. Re-read the same identity-bound preview until:

- the title/filename is available;
- loaders are gone;
- a usable download control is enabled;
- text viewers have mounted their content node when required.

For table/CSV viewers, a proven preview identity and usable toolbar download action are sufficient. For CodeMirror-style text viewers, wait for the actual code/content node.

If a preview opens for a different file, close it and return an identity mismatch immediately. Do not perform a second blind click.

## 9. Materialization race

Page URL/blob extraction and `chrome.downloads` capture may race. An exact HTTPS download anchor must be started by the background service worker through `chrome.downloads.download` and bound to the existing capture ID; clicking that anchor in the content page is forbidden because it can navigate the ChatGPT tab to a signed attachment URL and destroy the command lifecycle. Button-only and preview actions remain scoped DOM clicks.

- If no Chrome download has bound to the capture, a successful page result may finish materialization.
- Once Chrome has assigned a concrete download ID, that download becomes authoritative.
- A bound Chrome download must be allowed to finish, imported, and safely removed even if a page URL/blob path completed first.
- If the page path fails after the Chrome download has started, use the Chrome download as the recovery path.

Unused unbound captures are cancelled. Bound captures are never abandoned merely because another source returned bytes first.

## 10. Safe browser-download cleanup

Deletion is allowed only for a file proven to belong to the current capture. Verify:

- capture ID;
- Chrome download ID;
- absolute path inside the configured download directory;
- expected effective filename, including a browser-added collision suffix;
- start and completion timestamps;
- creation time, with a conservative fallback only when necessary;
- size;
- inode and device;
- absence of a symbolic link;
- unchanged metadata between import and deletion.

After deletion, perform `lstat` on the exact path. At the end of the E2E run, verify every removed source path again. Never search broadly by wildcard and never delete old files from a previous run.

If any safety check is ambiguous, leave the file untouched, record `source_cleanup_skipped`, and fail the scenario explicitly.

## 11. Artifact timing and completion

Final answer text may stabilize before a generated file is ready. Text completion and artifact completion use separate budgets.

The response remains active while a genuine artifact lifecycle is generating. Ready and failed artifacts are terminal. A candidate with no lifecycle evidence and no materialization path cannot keep the turn alive indefinitely.

Artifact action discovery uses bounded backoff and a hard post-generation limit. Materialization uses its own bounded timeout. The general turn watcher remains progress-based and does not impose a short fixed total duration on legitimate long-running ChatGPT work.

## 12. Code blocks near artifacts

Inline code is a `<code>` element outside `<pre>`. A fenced block is normally `<pre><code>` or an equivalent code viewer. Tool output and file-preview code are separate categories and must not be merged into the final Markdown answer.

Code-block controls may resemble artifact actions. Their structural scope, neighbouring `<pre>`, and known code-toolbar semantics must exclude them from artifact discovery.

Language detection and Markdown reconstruction are specified in `CHATGPT_DOM_PARSER.md`.

## 13. Multiple artifacts

When several artifacts are present:

- preserve their assistant-turn order;
- assign independent identities;
- materialize each one separately;
- do not replace separate downloadable files with one synthetic combined file;
- do not use one preview title as an alias for another artifact;
- record one cleanup audit per browser download.

An archive plus its source files are distinct artifacts unless the prompt explicitly requests only the archive.

## 14. Recovery

Recovery scans recent assistant turns and artifact-bearing final-message nodes. It may recover direct links, preview actions, and browser-download buttons, but it must retain the same identity and cleanup guarantees as live materialization.

A recovered artifact is associated with its original turn and imported into the bridge artifact store before project apply or user download.

## 15. Diagnostics

For artifact scenarios, retain:

- normalized artifact snapshots;
- lifecycle transitions;
- action candidate scores;
- preview identity/readiness observations;
- materialization source and timing;
- browser download ID/path metadata;
- cleanup audit and final absence verification;
- byte-level ZIP validation errors.

Diagnostics must not contain unrestricted scans of the user's Downloads directory.

## 16. E2E coverage

Independent real-browser scenarios cover:

- multiple generated files;
- one ZIP artifact;
- grouped artifact aliases;
- project package creation and second-turn modification;
- extensionless archive actions;
- preview materialization;
- browser-download cleanup;
- project context reuse;
- project flow without optional context files.

The artifact scenarios are the authoritative test for Downloads cleanup. Text-only parser and model-picker scenarios do not create download cleanup audits.
