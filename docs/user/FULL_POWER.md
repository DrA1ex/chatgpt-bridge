# Full-Power adapter

Full-Power is an optional, separate owner-PC execution plane. It is not required for normal ChatGPT Bridge use.

The integration path is:

```text
Manager chat
  -> authenticated ChatGPT Bridge
  -> Full-Power adapter
  -> owner PC
```

The controller does not need to sit directly in the execution path.

## Enable the Bridge-side integration

Configure the Node Bridge with:

```env
FULL_POWER_BRIDGE_URL=...
FULL_POWER_BRIDGE_TOKEN=...
```

The adapter itself keeps its own bridge/capability credentials and owner-confirmation policy.

The integration is disabled until `FULL_POWER_BRIDGE_TOKEN` is configured.

## Bridge routes

The Node Bridge exposes:

```text
POST /v1/full-power/capabilities
POST /v1/full-power/jobs
GET  /v1/full-power/jobs
GET  /v1/full-power/jobs/:jobId
POST /v1/full-power/owner/jobs/:jobId/challenge
POST /v1/full-power/owner/jobs/:jobId/confirm
POST /v1/full-power/owner/jobs/:jobId/cancel
```

Every route still requires the normal Node `API_TOKEN`.

Protected owner actions additionally require:

```env
FULL_POWER_OWNER_TOKEN=...
```

## Security model

Full-Power is deliberately separate from the normal browser automation path.

Important properties:

- the execution adapter is expected to remain loopback-only;
- Bridge authentication still applies before requests reach the adapter;
- protected owner actions have a separate owner credential;
- capabilities are short-lived and payload-bound;
- uncertain execution is not retried automatically.

The last rule is important for privileged work: if Bridge cannot prove whether an execution started, it does not blindly repeat the operation.

Keep the adapter local unless you have designed an explicit trusted network boundary around it.
