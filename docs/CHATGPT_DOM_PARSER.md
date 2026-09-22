# ChatGPT DOM Parser Specification

Status: implementation-oriented specification for the Chrome bridge extension.

## 1. Scope

This document defines how the bridge reads a live ChatGPT conversation without relying on localized visible labels or unstable CSS class names. It covers:

- composer readiness and submission;
- user-turn and assistant-turn anchoring;
- visible reasoning and tool/status phases;
- final Markdown extraction;
- semantic response blocks and fenced code blocks;
- completion detection;
- schema-drift diagnostics;
- safe conversation deletion.

File uploads, generated artifacts, previews, and browser-download cleanup are documented in `CHATGPT_FILES_CODE_DOM.md`.

## 2. Core invariants

1. A request is bound to one browser tab and one exact ChatGPT conversation.
2. The parser records a pre-submit DOM baseline before clicking Send.
3. A request may anchor only to a user turn that was not present in that baseline and whose visible text matches the submitted prompt.
4. The assistant turn is the latest assistant turn after the anchored user turn and before the next user turn.
5. Reasoning/tool/status content and the final answer are separate channels.
6. React node identity is not a durable logical identifier.
7. Completion is a compound state, not a quiet-period heuristic.
8. Unknown DOM structures fail closed and are included in diagnostics.

## 3. Stable signals and fallbacks

Prefer semantic attributes in this order:

- `data-testid`;
- `data-turn`, `data-turn-id`, and message identifiers;
- `data-message-author-role`;
- ARIA roles, states, and ownership relationships;
- document order relative to an already anchored turn;
- bounded structural fallbacks.

Visible localized text is suitable only as a secondary signal. It must never be the sole selector for model menus, deletion actions, completion controls, or artifact identity.

## 4. Composer readiness and submission

Before submission, require:

- a connected extension client;
- `pageReady`;
- `chatMainReady`;
- `composerReady`;
- one usable editable composer;
- no conflicting active request in the target tab.

The content script records:

- all current turn keys;
- current user-turn keys;
- current assistant-turn keys;
- the active conversation URL and ID;
- the submitted normalized prompt text.

The DOM observer may be installed before submission, but turn capture remains disarmed until the baseline has been recorded. After Send, the parser accepts only a new matching user turn. A mutation observed during click confirmation must be consumed immediately rather than waiting for a second mutation.

## 5. Turn anchoring

The request anchor advances in this order:

1. pre-submit baseline;
2. new matching user turn;
3. latest assistant turn within that user turn's response interval;
4. optional steer continuation evidence for a later response epoch.

A newly inserted unrelated user turn must not be accepted merely because it is newer. Matching uses normalized prompt text with a conservative similarity threshold and exact marker support for E2E requests.

Response selection stops at the next user turn, including when the anchored prompt has no assistant response yet. Prompt context is resolved from the exact assistant key; a missing or virtualized anchor returns no context instead of borrowing the latest visible turn. DOM indices are sample-local diagnostics, so reindexing history cannot invalidate an otherwise exact user/assistant key match.

After a steer, ChatGPT can expose a new continuation user key in the active request while the final assistant turn remains attached to the original prompt user key. The parser therefore preserves both pieces of evidence. The original key is accepted for the steered epoch only when it is the exact key stored in the immediately previous response history and the active lease still carries the proved continuation key.

Turn discovery, snapshot lookup, recovery and artifact ownership use the same
`content/turnDom.js` adapter. It merges semantic turn containers and unwrapped
message roots in document order, resolving each message to exactly one owner.
Sidebar, composer and extension-panel nodes never enter that list. Recovery does
not scan unrelated Markdown for files or repeat discovery with another selector.

Durable keys come only from `data-turn-id`, `data-turn-id-container` or
`data-message-id`. Presentation-only message shapes remain readable, but have no
request anchor without a native identifier. DOM indices, positional test IDs,
content hashes and React node references cannot establish identity. Anonymous
observations do not share persisted reasoning history. Semantic author attributes
take precedence over presentation classes and screen-reader headings.

Turn-owned errors and approval controls affect only their owning turn; page-level
signals outside turns remain available. Response signatures retain exact parsed
text, including case, line breaks and code indentation.

## 6. Assistant phases

The normalized phases are:

- `ASSISTANT_PLACEHOLDER`;
- `ASSISTANT_REASONING`;
- `TOOL_RUNNING`;
- `ASSISTANT_FINAL_STREAMING`;
- `ASSISTANT_FINAL_STREAMING_WITH_HISTORY`;
- `ASSISTANT_FINAL`;
- `NEEDS_CONFIRMATION`;
- `NEEDS_CONTINUE`;
- `ERROR`.

Classification uses the presence of the final author node, Stop control, action bar, active tool blocks, visible reasoning markers, confirmation UI, Continue UI, and errors.

A quiet DOM is not terminal while Stop is visible or an artifact/tool lifecycle is active.

## 7. Visible reasoning and progress history

Visible reasoning summaries and tool/status blocks are read on every meaningful DOM mutation. The parser maintains an append-only logical history with:

- stable logical ID;
- sequence number;
- kind (`thinking`, `tool_status`, `progress`, or `action_status`);
- text;
- revision;
- active/completed state;
- visibility;
- first/last seen timestamps;
- structural hint and source metadata.

Reconciliation priority:

1. same live DOM node;
2. same structural slot with compatible lifecycle and text;
3. same kind and identical text;
4. active item of the same kind with high text similarity.

An active shimmer that becomes a completed reasoning button retains its logical ID. A React replacement with identical completed content does not create a duplicate. Reuse of a completed structural slot for new active text creates a new item.

A completed non-empty item must never be overwritten by a later empty snapshot. When the final answer replaces a transient reasoning node, the event history remains authoritative.

Author labels such as “ChatGPT said:” are structural labels, not progress items.

## 8. Final-answer boundary

The final answer starts at the element carrying `data-message-author-role="assistant"` or the best bounded equivalent inside the anchored assistant turn.

Parse and audit this entire message root in one pass. `.markdown` and `MarkdownRoot` wrappers indicate formatting, not ownership boundaries: sibling prose, code widgets and tables remain part of the answer, and nested wrappers must not duplicate content.

Exclude:

- reasoning/tool/status siblings;
- action bars;
- copy, feedback, run, and other UI controls;
- citations and artifact controls when they are not part of prose;
- composer content;
- satisfaction surveys and page-level UI outside the final Markdown root.

Never use the whole assistant turn's `innerText` as the final answer. It mixes reasoning, tool output, code headers, actions, and final prose.

## 9. Lossless response ownership

The final-answer parser is a lossless DOM classifier rather than a list of selectors that silently drops everything unfamiliar. Every visible response leaf belongs to exactly one owner category:

- `content`;
- `artifact`;
- `interface`;
- `reasoning`;
- `unknown`.

The response root is traversed in document order. Once an outer block owns a subtree, nested implementation elements cannot become additional top-level response blocks. This is essential for editor-backed widgets where a response-level container includes another `<pre>` or `<code>` internally.

Each terminal snapshot includes a parser audit with:

- visible text-leaf count;
- content, artifact, interface, and reasoning counts;
- unknown text and visual elements;
- duplicate ownership;
- total classified leaves and coverage percentage;
- block-level warnings and bounded DOM context.

A visible leaf with no known adapter is represented as an explicit `unknown` block and retained as plain text in the ordinary final answer. Strict parser E2E rejects `unknown` blocks, unknown visible nodes, and duplicate ownership. Unknown content must never disappear silently.

## 10. Semantic response blocks

The final answer is represented both as Markdown and as one ordered semantic block list. Markdown is generated from that same list; it is not reconstructed by a second DOM scan.

Known block types include:

- `paragraph`;
- `heading`;
- `code_block`;
- `list`;
- `table`;
- `blockquote`;
- `separator`;
- `media`;
- `math`;
- `citation`;
- `artifact`;
- `rich_widget`;
- `unknown`.

Block indices follow document order across the complete final-message root. A missing adapter may reduce semantic precision, but it cannot remove visible text because the `unknown` fallback remains part of the ordered block stream.

Inline code uses a backtick delimiter longer than any backtick run inside its content. Fenced code similarly uses a fence longer than any backtick run inside the code body. Whitespace inside code is read from `textContent` and is not normalized through `innerText`.

## 11. Code widgets and language discovery

A code block is treated as a widget, not as an arbitrary `<pre>` tag. The response-level owner may contain:

- a language/header toolbar;
- Copy, Run, preview, or other interface actions;
- an editor implementation;
- a nested CodeMirror `<pre class="cm-content">` and `<code>` source.

The outer response-level container owns the whole block. Nested editor `<pre>` elements are content sources and can never become separate top-level blocks.

Parsing proceeds in this order:

1. choose the best code-content source, preferring editor-backed and nested `<code>` nodes;
2. classify every visible text leaf inside the widget as code content, language metadata, known interface, or unknown chrome;
3. read explicit language metadata from the content source, editor container, and widget attributes/classes;
4. read structurally scoped language text from the remaining widget chrome;
5. canonicalize common aliases while preserving safe structurally scoped uncommon labels;
6. record every interface control and every unknown child in diagnostics.

The language label may be localized only in surrounding actions; the language itself is normalized to a stable value. Composite toolbars such as `Python` plus a localized Run control are separated structurally. Copy/Run dictionaries are fallback signals, not the primary ownership rule.

Unknown toolbar text is not discarded. It produces `unclassified_code_widget_chrome`, appears in the transcript, and fails strict E2E.

## 12. Streaming and terminal validation

React and Markdown rendering may rewrite an incomplete block while streaming. Therefore a partial rendered Markdown string is not required to be a byte prefix of the final answer.

Streaming validation checks only invariants that must remain true during generation:

- the snapshot can be parsed;
- one visible leaf never has multiple owners;
- response and reasoning identities remain coherent;
- revisions do not decrease;
- changed reasoning text advances its revision;
- diagnostics are appended for every meaningful snapshot.

Strict content checks are applied to the terminal snapshot:

- exact expected Markdown;
- exact semantic block order;
- exact inline-code values;
- exact code content and language per block;
- no unknown text or visual content;
- no duplicate ownership;
- 100 percent leaf coverage;
- final DOM snapshot equals the stored completed `agent_message`.

## 13. Completion

A response is complete only when all of the following hold:

1. the anchored assistant turn has final output containing text or a ready artifact;
2. Stop is absent;
3. the normalized output state is final (the action bar is corroborating UI evidence);
4. no active tool remains;
5. no confirmation or Continue prompt is active;
6. no terminal error is present;
7. no visible artifact is pending or failed, and required artifacts satisfy the server materialization policy;
8. the normalized snapshot is stable for the configured settle period;
9. the page still represents the expected conversation.

The settle period exists only to absorb final React updates. It must not become a second long result timeout.

The shared server evidence classifier requires actual non-whitespace answer text or an artifact; an empty final author container is not output. Pending/failed artifacts, a degraded page, visible streaming/Stop signals and active tools prevent completion, even if another field says the response is final.

The observer uses separate publication and response-stability signatures. Focus, visibility, DOM paths and diagnostic markup can publish updated tab facts without restarting the response settle period. Response identity, text, generation, blockers, artifacts and request boundaries reset it. Stability uses monotonic elapsed time and fresh DOM reads at bounded milestones; missing reads, parser exceptions and degraded DOM intervals invalidate it.

Mutation batches coalesce into the earliest scheduled read, so continuous streaming cannot postpone observation and peripheral changes cannot delay urgent reads. Class/style/visibility mutations are observed alongside text and semantic attributes. A stopped observer clears cached snapshots and invalidates in-flight reads; a subsequent activation begins a fresh stability interval.

## 14. E2E audit and human verification

The parser is covered by independent real-browser scenarios:

- `response-markdown`: exact terminal Markdown, semantic blocks, inline code, code-widget parsing, languages, ownership, and coverage;
- `reasoning-lifecycle`: visible reasoning phases, revisions, completion, ordering, and transition to final output;
- `parser`: scenario group that runs both parser scenarios.

One scenario failure is recorded locally and does not prevent later selected scenarios from running. The runner returns one aggregate failure after all selected scenarios and cleanup have finished.

`response-markdown` creates a live human-readable file as soon as the scenario starts:

```text
.bridge-data/e2e/<run>/response-markdown/parser-observation.txt
```

Each meaningful snapshot records:

- raw visible assistant-turn text;
- ordered parsed response blocks;
- language source and confidence for code widgets;
- reasoning/progress phases;
- artifact content;
- excluded interface leaves and controls;
- unknown visible content;
- duplicate ownership;
- coverage totals and warnings.

The final section is labelled `FINAL TERMINAL SNAPSHOT`. This file is intended for direct manual comparison with the ChatGPT UI.

Machine-readable diagnostics include:

- `parser-audit.json`;
- `response-blocks.json`;
- `reasoning-blocks.json`;
- `unknown-nodes.json`;
- `terminal-dom.html`;
- `raw-dom-timeline.json`;
- `parsed-timeline.json`;
- `stored-items.json`;
- `turn-events.json`;
- expected/final Markdown and their structured diff.

Diagnostics are written in `finally` blocks, so early validation failure still produces the transcript and terminal evidence. The captured current CodeMirror widget structure is also covered by a deterministic DOM fixture test. An optional real-Chromium fixture can be run by setting `CHROMIUM_BIN`.

## 15. Locale independence

Model and effort pickers, completion, deletion, and artifact actions must be discovered from structural semantics. Localized labels may be retained as display metadata but are normalized to stable internal IDs where automation needs stable values.

## 16. Safe conversation deletion

Deletion is destructive and therefore requires all of the following:

- exact expected session ID;
- exact canonical expected conversation URL;
- the current tab still showing that conversation;
- a structurally identified conversation-menu trigger;
- a structurally identified destructive menu item;
- a structurally identified confirmation dialog and destructive action.

Visible words such as “Delete” are not sufficient. If identity or confirmation is ambiguous, deletion fails closed.

## 17. Primary chat control scope

General browser actions operate only on the primary chat surface. Composer, send/stop/continue, model, effort, generation, and artifact control discovery must reject:

- the ChatGPT history sidebar and its portals when structurally identifiable;
- message-level model actions inside existing user or assistant turns;
- the extension-owned Bridge panel.

Session discovery, selection, and deletion are the only commands allowed to inspect conversation-history controls in the sidebar. A selector change that widens primary-chat discovery must include a sanitized captured fixture with sidebar and extension-panel decoys.

## 18. Always-on tab observation

The content script runs one tab observer for the lifetime of the content-script instance, whether or not a bridge request is active. It reports normalized facts rather than request-completion decisions:

- URL, conversation identity, visibility, and focus;
- document and composer readiness;
- latest assistant-turn identity and parser phase;
- current generation, blocker, output, explicit-error, and artifact facts;
- the content script's active request identity when one exists.

Each emitted observation contains an `observerId` and a monotonically increasing `revision`. Duplicate or stale revisions from the same observer epoch must not replace newer hub state. A page/content-script reload creates a new observer epoch and may restart revisions from one.

Temporary document/composer loss during React replacement is reported only after a short degraded-state stabilization window. It is not itself a terminal request failure.

The request adapter must not project historical tab content onto a newly created request. Request-specific generation, blocker, output, artifact, and error facts are accepted only after prompt binding is established or when the observation explicitly names that request. Conversation/request mismatch becomes fatal only after binding. The observer itself never finalizes a request, evaluates the required-output contract, runs workflow actions, or clicks UI controls.
## Submitted user-turn transient errors

A ChatGPT-owned error banner may appear inside the user-turn container but outside the prompt bubble. The parser must read the prompt only from the user-message bubble and report the banner separately as `CHATGPT_TRANSIENT_REQUEST_ERROR`. Localized Russian and English forms are recognized only from the exact submitted turn.

This evidence permits a bounded response retry because the initial write is already proved by the user-turn key. It does not authorize replay after an uncertain click. Every retry stays in the same lease/conversation, increments `responseEpoch`, and must re-prove the failed turn and error before content executes the new prompt step.

### Recovery chronology

Recovery snapshots carry the preceding native `userTurnKey` from the same ordered DOM sample. A request accepts recovered output only behind its exact submitted user key; indices captured before history hydration or virtualization cannot prove ownership. Hidden/inert historical copies are not transcript turns.

Codex UI recovery uses source candidate order and exact artifact content identities to place missing images relative to known images. It does not assign the current local turn or the time of recovery to historical output. A verified capture of the same content may repair a failed preview without moving its existing item.

Generated image materialization uses `artifact.image.read`, a standalone read allowed during an active request lease. Its executor rejects sources requiring UI actions. `artifact.fetch` remains a standalone write for action/download capture and retains the lease barrier.
