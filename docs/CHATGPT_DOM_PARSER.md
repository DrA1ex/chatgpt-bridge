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
4. The assistant turn is the first assistant turn after the anchored user turn.
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
3. first assistant turn after that user turn;
4. optional later re-anchor after a confirmed steer submission.

A newly inserted unrelated user turn must not be accepted merely because it is newer. Matching uses normalized prompt text with a conservative similarity threshold and exact marker support for E2E requests.

A steer creates a new visible user turn and a new assistant turn while retaining the same bridge request ID. The old assistant placeholder must not remain authoritative after the steer is confirmed.

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

Exclude:

- reasoning/tool/status siblings;
- action bars;
- copy, feedback, run, and other UI controls;
- citations and artifact controls when they are not part of prose;
- composer content;
- satisfaction surveys and page-level UI outside the final Markdown root.

Never use the whole assistant turn's `innerText` as the final answer. It mixes reasoning, tool output, code headers, actions, and final prose.

## 9. Semantic response blocks

The final answer is represented both as Markdown text and as ordered semantic blocks:

- `paragraph`;
- `heading`;
- `code_block`;
- `list`;
- `table`;
- `blockquote`;
- `separator`.

Block indices are global across all Markdown roots in the final message.

Inline code is preserved with a backtick delimiter longer than any backtick run inside the code. Whitespace inside inline code is preserved; normalization applies only to surrounding prose.

Fenced code uses a backtick fence longer than any backtick run inside the code body. Markdown normalization tracks the exact opening fence character and length, so a shorter fence-like sequence inside code cannot terminate the block.

## 10. Code-block language discovery

Language discovery is scoped to one concrete `<pre>` and follows this order:

1. `data-language`, `data-lang`, `data-syntax`, `aria-label`, `title`, or `language-*` / `lang-*` classes on `<code>` or `<pre>`;
2. the same explicit metadata on the smallest wrapper that owns exactly one `<pre>`;
3. bounded preceding and following header/toolbar siblings while walking from the `<pre>` toward the Markdown root;
4. descendants and direct text nodes of those headers, including buttons and ARIA-labelled controls;
5. structurally marked labels in the document-order interval after the previous `<pre>` and before the target `<pre>`.

Composite header text is tokenized. UI actions such as Copy, Run, Execute, and their localized equivalents are removed before language normalization. Thus a header containing a language plus a Run button still resolves to the language.

Common aliases are canonicalized (`js` to `javascript`, `py` to `python`, and similar). Safe structurally scoped uncommon labels such as `mermaid`, `graphql`, or `objective-c` are preserved. UI prose is rejected.

A candidate explicitly associated with another `<pre>` receives a strong negative score and cannot be reused for the target block.

Each captured DOM timeline includes a bounded sanitised HTML context and ranked language candidates for every code block. The same diagnostics are transported through the bridge and stored on the completed `agent_message`, so they survive final DOM replacement and early assertion failures. This diagnostic data is not used as final response content.

## 11. Streaming convergence

During streaming:

- block order may only grow by appending or completing the current block;
- already emitted code text must remain a prefix of the completed code text;
- already emitted prose must remain a prefix of the completed prose for the same logical block;
- a final completed snapshot must equal the stored final answer;
- reasoning text must not leak into the final answer;
- final answer text must not be stored as reasoning.

Language may be unresolved while a code header has not mounted yet. The completed snapshot must resolve it when the visible header is present.

## 12. Completion

A response is complete only when all of the following hold:

1. the anchored assistant turn has a final author node;
2. Stop is absent;
3. the response action bar is visible;
4. no active tool remains;
5. no confirmation or Continue prompt is active;
6. no terminal error is present;
7. required artifacts are terminal or materializable;
8. the normalized snapshot is stable for the configured settle period;
9. the page still represents the expected conversation.

The settle period exists only to absorb final React updates. It must not become a second long result timeout.

## 13. Schema drift and diagnostics

For requests with DOM timeline capture enabled, record:

- phase and turn identity;
- final answer snapshot;
- semantic blocks;
- code blocks and language diagnostics;
- visible progress items;
- completed reasoning history;
- visible top-level blocks;
- Stop/Send/action-bar state;
- unknown `data-testid` values;
- bounded raw visible text.

If an expected semantic signal disappears, return a schema error instead of a false completion. Unknown test IDs inside the active turn are telemetry and must not be silently discarded.

## 14. E2E scenarios

The parser is covered by independent real-browser scenarios:

- `response-markdown`: exact final Markdown, inline code, fenced code, language labels, block order, and streaming convergence;
- `reasoning-lifecycle`: visible reasoning phases, revisions, completion, ordering, and transition to final output;
- `response-parser`: compatibility alias that runs both scenarios.

When multiple scenarios are selected, one scenario failure is recorded locally and does not prevent later selected scenarios from running. The runner emits one aggregate failure after all selected scenarios have finished and cleanup has been attempted.

Diagnostics are written in `finally` blocks, so an early assertion failure still produces the DOM timeline, stored items, turn events, answer diff, and code-block DOM context. Markdown validation accumulates all detectable mismatches in one run instead of stopping after the first language or block error. Reasoning validation also checks that revisions never decrease and that text cannot change without a revision increment.

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
