# Response reconciliation and transfer integrity

The RFC is integrated into Protocol 5's existing command results and transfer messages. Canonical request completion remains owned by the server reducer; no mailbox, server restart recovery, new effect lifecycle, or transfer service is introduced.

## Optional conversation-record evidence

`response.snapshot.request`, `response.recover.latest`, and `response.recover.turnKey` accept an optional `reconcileConversation` object:

```json
{
  "conversationId": "exact-conversation-id",
  "userMessageId": "exact-submitted-user-message-id",
  "assistantMessageId": "exact-assistant-message-id"
}
```

The same option is exposed by `BrowserBridge.recoverLatestResponse`, `recoverResponseByTurnKey`, and `POST /browser/recover-latest`. The assistant ID may be omitted when the DOM snapshot exposes a real `data-message-id`. User IDs must be supplied explicitly: a DOM turn key, text fingerprint, or ordinal is not a backend message ID. List recovery does not fetch conversation records.

The content adapter performs a bounded, same-origin authenticated GET of the internal conversation record. On HTTP 401 it may read the same-origin session endpoint and retry once with its access token. Tokens remain local to that read, are never included in results or diagnostics, and requests refuse redirects. There is no polling or persistent record cache. Reads time out after four seconds and respect command cancellation. Navigation to another conversation invalidates the evidence.

Results contain only compact evidence, with `source: "conversation-record"`, schema `version: 1`, the expected identities, and one of:

| Status | Meaning |
| --- | --- |
| `matched_complete` | Exact assistant ID on the current branch, expected nearest user ancestor, no later user/assistant message, successful backend status and final end-of-turn evidence |
| `matched_incomplete` | Identities match, but backend final-message evidence is absent |
| `mismatch` | A conversation, branch, role, user boundary, or assistant identity differs |
| `unavailable` | Missing IDs, unsupported schema, navigation, authentication, network, cancellation, or timeout prevents verification |

When a plain-text record is available, `textMatches` compares it exactly with the DOM answer. Formatting differences can produce `false`; unsupported content yields `null`. A completed backend message with `textMatches: false` does **not** verify the rendered answer. Successful reads carry `checkedAt`.

This is deliberately optional evidence, not a new canonical completion gate or a source of replacement answer text. Existing DOM output, blockers, deadlines, response epochs and release policy remain authoritative. Schema assumptions are isolated in one adapter and tested with fixtures; compatibility with the current authenticated ChatGPT service still requires live verification. Before using this evidence in completion policy, validate live schemas, freshness and steer/multi-message behavior.

## Transfer contract

Artifacts retain `artifact.data.started`, `artifact.data.chunk`, and `artifact.data.done` inside existing command progress/result envelopes. Layout captures retain `page.layout.chunk` and `page.layout.captured`. Byte payloads carry:

- a unique `transferId` and complete-payload `sha256` (lowercase hexadecimal);
- raw byte `size`, `encodedSize`, `encoding`, and `totalChunks`;
- zero-based `index` and contiguous encoded `offset` on each chunk.

`base64` sizes and offsets count ASCII characters. `utf8` layout sizes count UTF-8 bytes, while encoded sizes and offsets count JavaScript UTF-16 code units; reconstruction precedes hashing, including when a surrogate pair crosses chunks. Single-message artifacts and layouts also require integrity metadata with one chunk.

The command-owned receiver requires unchanged metadata, strictly increasing contiguous indexes, exact counts and lengths, canonical base64, exact raw byte size, and matching SHA-256 before resolving. It rejects duplicate starts, duplicates, gaps, reordering, cross-transfer or cross-artifact mixing, changed transfer modes and malformed indexes with `TRANSFER_INTEGRITY_INVALID`. Transport-level exact-message deduplication remains upstream; duplicate logical chunks are errors. State disappears with command settlement, timeout or close.

Bounds are 128 MiB raw, 178,956,972 encoded characters, and 4,096 chunks. The production artifact sender uses 48 KiB–1 MiB chunks. Integrity-bearing senders and receivers must be deployed together; old metadata-free byte transfers fail explicitly. The compatibility gate requires extension 2.3.20 / content runtime 4.3.18. Protocol version remains 5 and normal command/outbox ownership is unchanged. The extension advertises `transferIntegrity: "sha256-v1"`.

Stored and inline attachments receive an `integrity` descriptor at the server. The content executor validates the complete decoded or downloaded file before obtaining the composer input or emitting file-input events. Stored URL attachments use the FileStore's existing size/SHA-256, so mutation between publication and fetch is detectable. Base64 reads also check the stored size/hash before transport. Arbitrary caller-owned URLs without a supplied SHA-256 have only a declared-size check when provided; supply `size` and `sha256` for end-to-end verification of those URLs.

Chrome download paths continue through the existing exact capture binding, filesystem identity/size validation, verified import, FileStore hashing and safe cleanup. They are not byte streams and cannot switch into or out of a byte transfer. Main-world Blob capture uses structured cloning of an immutable Blob and existing capture correlation; content hashes the bytes when materializing the transfer. HTTP/page fetches start integrity measurement at the browser materialization boundary, not at the upstream file producer. SHA-256 detects corruption and mixing; it does not authenticate a compromised producer.

## Verification

`test/transferIntegrity.test.js` exercises malformed metadata, loss, duplicates, order, offsets, truncation, oversize, corruption, mixed identities, command cleanup and pre-input attachment rejection. `test/conversationReconciliation.test.js` covers identity/branch boundaries, backend completion, schema/network/auth failures, credential containment and opt-in recovery behavior. Existing artifact, layout, image and mock Protocol 5 fixtures use the integrity-bearing payloads.
