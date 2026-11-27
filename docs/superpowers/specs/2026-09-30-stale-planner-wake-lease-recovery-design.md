# Stale Planner Wake Lease Recovery

Status: Proposed design, approved for documentation and review on 2026-09-30

## Problem and observed evidence

A scheduled governance wake reached the Bridge extension and was accepted, but
the Bridge turn ended with `CANONICAL_DEADLINE_EXCEEDED` before `prompt.sent`.
Afterward, the Bridge had no active or pending server request, while the bound
extension client still reported that old request as `activeRequest`. Its
current conversation was different from the conversation recorded on the
failed turn, and generation was stopped. The wake host therefore skipped due
passes as `client_not_ready`.

Replacing only the governance tab created a clean client for the same
conversation. The next natural host poll sent wake sequence 38, and Bridge
recorded `prompt.sent`. This confirms that stale tab-scoped request state was
blocking admission. The exact release acknowledgement for the earlier failed
turn was not retained, so the design treats the failure to clear the physical
lease as a state-reconciliation gap rather than assuming which individual
release substep failed. Missing `prompt.sent` is not proof that the browser
write did not happen; without effect-specific `proved_not_started` evidence,
the send outcome is ambiguous and must not be replayed automatically.

There are two related delivery gaps:

1. A failed turn can leave a physical extension lease or content projection
   after the canonical server request is terminal.
2. The deployed Planner host source predates the merged 0.25.0 source. The
   deployed path treated a Bridge turn ID as a sent wake; accepted 0.25.0
   source waits for `prompt.sent`, but still rejects any client whose
   `activeRequest` is non-null. Deploying that source alone would prevent false
   cadence advancement but would not clear this stale lease.

The Bridge checkout already contains uncommitted work for a loopback
stale-release coordinator and Protocol 5 release recovery. That path is not
called by the Planner host. A separate request-liveness worktree also contains
overlapping recovery edits. Implementation must review those changes and
preserve both existing worktrees before selectively porting anything.

## Goals

- Recover a terminal stale lease through the existing canonical
  `request.release` command and require a confirmed `lease.released` result.
- Let the Planner host resume only after a fresh client readback proves the
  canonical session binding is unique and the client is ready.
- Advance wake sequence/cadence only after `prompt.sent` or the existing
  equivalent retry-accepted event is observed.
- Keep ambiguous browser writes fail-closed. Never replay a prompt whose
  submission outcome is unknown.

## Non-goals

- Clearing a lease because a timeout elapsed or because a client looks stale.
- Bypassing a quarantined lease, changing the conversation, opening a new
  conversation, or selecting a global client as a fallback.
- Adding another transport, another request lifecycle, or direct content-side
  terminalization.
- Creating a replacement dispatch or changing the active worker task.

## Considered approaches

### Host-only readiness relaxation

Ignore `activeRequest` when Bridge reports no active server request. This is
rejected: the background may still hold a physical lease or dispatched browser
effects, so a second wake could overlap an unresolved write.

### Manual stale-release endpoint only

Keep a loopback recovery route for an operator to invoke after every stale
lease. This is useful as a bounded repair surface, but it does not prevent the
scheduled host from repeatedly skipping while nobody invokes it.

### Exact Bridge release plus Planner-host admission recovery (recommended)

Use one Bridge-owned stale-release coordinator, called by the due Planner host
only when the unique bound client is otherwise not ready because it reports an
old request. The coordinator verifies exact request/client/lease/server/epoch
identity, absence of a current pending request or release command, a fresh
tab observation with generation `idle` or `stopped`, and no unsettled physical
commands, effects, or downloads. For the current Bridge owner it additionally
requires a canonical terminal state; after a Bridge restart it may handle an
old owner only through the exact persisted lease identity and the same fresh
idle evidence. The background permits one bounded release recovery and emits
the normal `lease.released` envelope. Any mismatch or ambiguity leaves the
client quarantined and the wake skipped.

After confirmed release, the host re-reads `/browser/clients` and verifies the
same canonical session fingerprint still has exactly one ready compatible
client. It sends only when no prior wake has an unresolved ambiguous outcome.
The host advances sequence/cadence only after `prompt.sent` or the existing
retry-accepted event. A bounded terminal failure or wait timeout without that
event is ambiguous unless a typed pre-dispatch rejection or effect-specific
`proved_not_started` evidence proves that the prompt write never began. Lease
release clears the client admission block; it does not by itself authorize
replaying an ambiguous wake.

## Verification plan

- Bridge coordinator tests cover exact identity, same-owner terminal recovery,
  previous-owner recovery, fresh-observation expiry, active generation,
  pending requests, pending release commands, active physical children,
  one-shot recovery, and invalid/missing acknowledgements.
- Protocol/background tests prove release recovery uses the existing
  `request.release` path and atomically clears or quarantines the exact lease;
  it never resubmits the prompt.
- Planner-host tests reproduce a terminal Bridge turn with no `prompt.sent`,
  a stale `activeRequest`, confirmed lease release, client readback, and a
  subsequent `prompt.sent`. They prove an unproved submission becomes
  `ambiguous_send` without replay, while an exact pre-dispatch rejection or
  `proved_not_started` effect can be retried only after confirmed lease
  release. Failed or ambiguous release does not advance cadence or send a
  second prompt.
- Existing manifest-order, command/effect/release fault-matrix, Bridge API,
  and local multi-bridge tests remain required. The authenticated live check
  verifies one natural wake after release; it does not manually seed a wake.

## Rollout boundary

Bridge and Planner-host source changes are separate deliverables. The
currently accepted Planner source still needs deployment to the installed
60-second host, and the Bridge/extension recovery change needs its compatible
bundle rollout. No LaunchAgent, Bridge process, or extension will be changed
until source review and the existing rollout authority are verified. If a
release or recovery check cannot prove `lease.released`, stop and report the
exact blocker rather than clearing storage or forcing a send.
