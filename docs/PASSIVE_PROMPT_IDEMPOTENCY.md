# Passive prompt request-id compatibility

The `passive-prompt-v1` HTTP boundary uses the caller-provided
`X-Yazhan-Request-Id` (and matching `requestId` body field) as the durable
operation identity. The Bridge reserves that identity before issuing the
browser command. A duplicate `INFLIGHT` request is explicitly uncertain and
is never resent; `SUBMITTED` and `REJECTED_BEFORE_SUBMIT` are monotonic cached
terminal results.

An `INFLIGHT` row is never cleared just because its command timed out. The
status endpoint also exposes a cross-service read contract:

```json
{
  "storage_status": "INFLIGHT",
  "operator_status": "NEEDS_OWNER_REVIEW",
  "can_retry": false,
  "reconciliation_required": true
}
```

Before the bounded review window expires, `operator_status` is `INFLIGHT`.
After it expires, it becomes `NEEDS_OWNER_REVIEW`; neither state authorizes a
new browser command. An owner may submit exact negative conversation evidence
through the reconciliation endpoint. That appends an audited
`OWNER_RECONCILED_NOT_SENT` event while preserving the original `INFLIGHT`
write-safety row. A later positive observation may still settle that row to
`SUBMITTED`; the owner event never enables resend.

## Rollout order

1. Install and verify the Bridge build that exposes the durable reservation
   and `GET /browser/passive-prompt/status/:requestId` endpoint.
2. Start the Controller router build that sends both the request header and
   body field, and that reconciles uncertain POST results through the status
   endpoint.
3. Observe the Controller/Bridge health and request ledgers before enabling
   unattended delivery. Do not replay historical `SUBMITTING` or
   `UNCERTAIN_AFTER_SUBMIT` rows during the rollout.

The Bridge command registry receives the same request ID as
`options.commandId`; it does not create a second physical command identity.
If the command times out, the durable request remains `INFLIGHT` because a
late browser response is no longer owned by the registry.

## Compatibility behavior

The Controller accepts a successful response only when it contains the
`passive-prompt-v1` contract, `SUBMITTED`, and an exact proof for the expected
source client, conversation, and non-empty submitted user-turn key. A
contract response of `REJECTED_BEFORE_SUBMIT` is the only safe retry signal.
`UNKNOWN`, `INFLIGHT`, missing status endpoints, old Bridge responses, and
proof mismatches remain uncertain and must not be resent automatically.
`NEEDS_OWNER_REVIEW` and `OWNER_RECONCILED_NOT_SENT` are also fail-closed and
are surfaced for owner review, never as retry permission.

This change is source-compatible only when the Bridge is upgraded first. The
old Bridge can continue serving other endpoints, but its passive-prompt
responses are deliberately treated as fail-closed by the new Controller until
the new contract and status endpoint are available. No live Bridge or
Controller restart is part of this source change.
