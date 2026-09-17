# Passive prompt contract — Astra code handover

Base: `b6b914699502bf191041ec288d15e2df2c455f99`
Branch: `astra/passive-contract-20260915`
Tests/runtime acceptance: deliberately not run.

`POST /browser/passive-prompt` now returns `contract=passive-prompt-v1`:

- HTTP 200: `submissionStatus=SUBMITTED`, `ok=true`, with a validated `passive.prompt.submitted` result identifying the submitted user turn and requested conversation/client.
- HTTP 422: `submissionStatus=REJECTED_BEFORE_SUBMIT`, only when the request was positively rejected before the physical submission boundary.
- HTTP 503: `submissionStatus=UNCERTAIN_AFTER_SUBMIT`; transport/timeouts/unknown failures must never trigger blind resend.

The Edge extension reports the boundary immediately before click, form submission or Enter dispatch. The background command ledger and Node command registry preserve the classification. Observation bookkeeping after a submitted result cannot send a conflicting failure. Remote Bridge forwarding preserves the contract and gives the upstream request a timeout margin.

Deploy the Node source and matching extension together. Node-only rollout conservatively treats errors from an older extension as uncertain. Do not update/control Chrome. This source pass does not claim the historical B failure was reproduced or accepted fixed at runtime; Luna must use a fresh dispatch after installing both components. The old uncertain B dispatch must remain frozen.
