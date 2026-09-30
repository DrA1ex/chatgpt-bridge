# Stale Planner Wake Lease Recovery — Bridge Source Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one exact, safety-gated Bridge path for releasing a stale browser lease, while preserving the background as the sole physical release owner.

**Architecture:** A Bridge coordinator validates the exact request/client/lease/server/epoch identity and a fresh idle tab observation before issuing the existing canonical `request.release` command. The extension background accepts one bounded recovery from `claimed`, `reconciling`, `executing`, or `quarantined` lease status only after checking persisted identity and the absence of active physical children; a `releasing` lease continues only through its exact persisted registered command. Recovery never resubmits a prompt. A loopback-only, API-token-protected route exposes this path to the Planner host.

**Tech Stack:** Node.js 20+, JavaScript ES modules, Chrome extension Manifest V3, Protocol 5, `node:test`.

---

## Scope boundary

This plan implements the Bridge source half only. The Planner-host change is a separate deliverable in `RickyQiYu/project-governance`; Issue #466 currently owns that repository as a live `[RUNNING]` task, so do not modify that repository or its runtime while #466 is active. After it releases the repo, finish the host integration: recover only an exact stale bound client, re-read the same canonical session after release, and advance the wake schedule only after `prompt.sent` (or the existing typed retry-accepted event). Missing `prompt.sent` remains ambiguous unless there is effect-specific proof that the write never began; never replay an ambiguous wake.

## Files and ownership

- Create `src/bridge/coordinator/staleRequestReleaseCoordinator.js` for exact identity validation, release preconditions, and confirmed/ambiguous/rejected outcomes.
- Modify `src/browserBridge.js` only to construct that coordinator and expose `releaseStaleRequestLease()`; keep all physical release in the existing extension-owned `request.release` flow.
- Create `src/http/localReleaseRoutes.js` for the exact loopback/API-token guard and `POST /__local/release-stale-request`.
- Modify `src/routes.js` to register the route behind the normal API router.
- Modify `tools/chrome-bridge-extension/background/stateV6LeaseReducer.js` and `serverEnvelopeRouter.js` to admit one exact quarantined-lease recovery through the existing request-release command.
- Extend `test/commandReleaseAndReloadRegression.test.js`, `test/backgroundFaultInjectionMatrix.test.js`, and `test/extensionCompatibility.test.js`; create `test/staleRequestReleaseCoordinator.test.js` and `test/localReleaseRoutes.test.js`.
- Update `package.json`, `tools/chrome-bridge-extension/manifest.json`, `tools/chrome-bridge-extension/content.js`, and `src/extensionCompatibility.js` together for the compatible Bridge/extension release.
- Update `CONTEXT.MD` and `ARCHITECTURE.md` with the new recovery owner and boundary.

### Task 1: Persist a one-shot exact release recovery in the extension

**Files:**
- Modify: `tools/chrome-bridge-extension/background/stateV6LeaseReducer.js`
- Modify: `tools/chrome-bridge-extension/background/serverEnvelopeRouter.js`
- Modify: `tools/chrome-bridge-extension/shared/commandManifest.js`
- Test: `test/commandReleaseAndReloadRegression.test.js`
- Test: `test/backgroundFaultInjectionMatrix.test.js`

- [x] **Step 1: Add the failing regression for an exact quarantined lease**

In `test/commandReleaseAndReloadRegression.test.js`, use `backgroundHarness()` to claim and quarantine one lease, then send one `request.release` envelope whose immutable request fields exactly match it. Assert the accepted command moves that same lease to `releasing`, sets persisted `releaseRecoveryUsed: true`, and does not create any prompt command or effect.

```js
const request = {
  requestId: 'request-stale',
  leaseId: 'lease-stale',
  ownerServerInstanceId: 'prior-server',
  responseEpoch: 2,
};
await h.backgroundState.transition(h.state.tabId, { type: 'lease.claim', ...request });
await h.backgroundState.transition(h.state.tabId, {
  type: 'lease.quarantine', ...request, reason: 'release_unproven',
});
await handleServerEnvelope({
  ...h,
  envelope: serverEnvelope({
    sequence: 1, commandId: 'release-once', type: 'request.release', request,
    payload: { recoveryMode: 'stale_lease' },
  }),
});
const recovered = await h.backgroundState.read(h.state.tabId);
assert.equal(recovered.lease.status, 'releasing');
assert.equal(recovered.lease.releaseRecoveryUsed, true);
assert.equal(recovered.commands['release-once'].commandType, 'request.release');
assert.equal(recovered.commands['release-once'].status, 'dispatched');
```

- [x] **Step 2: Run the focused regression and confirm it fails**

Run: `node --test test/commandReleaseAndReloadRegression.test.js`

Expected: the interruption regression exposes that the current separate recovery transition can persist the lease marker before any release command exists.

- [x] **Step 3: Implement the reducer and exact command gate**

- Make `lease.release_recover` a composite reducer transition. A first recovery requires `matchingLease(..., { requireResponseEpoch: true })`, an existing lease in `claimed`, `reconciling`, `executing`, or `quarantined`, no active commands/effects/downloads from `activeRequestChildren()`, an unused marker, and no prior release command. A continuation may instead promote the exact same-ID persisted release command from `registered` to `dispatched` while the lease is `releasing`. In one store commit, set status to `releasing`, set `releaseRecoveryUsed` and `releaseRecoveryCommandId`, persist the exact request.release command as `dispatched`, and enqueue its `command.accepted` envelope. Persist the normal `lease.released` terminal envelope with that command. Add the typed optional `recoveryMode: 'stale_lease'` discriminator to the request.release definition.
- In `serverEnvelopeRouter.js`, only the typed request-scoped command with exact persisted request identity may invoke this transition; stale mode without an exact lease rejects and never claims one. A registered release can continue only with its same command ID and exact lease identity. Any dispatched, uncertain, or terminal release record blocks another cleanup dispatch. Post the content request.release only after the composite transition commits. After a worker restart, the existing dispatched-release recovery path marks an unproven cleanup uncertain and quarantines the lease; it must never post a second release. Keep canonical request.release behavior unchanged, reject other commands while quarantined, and retain the existing physical cleanup, outbox, and lease.released flow.

- [x] **Step 4: Cover one-shot, identity, children, and persistence failures**

Extend the regression to reject a second recovery, a mismatched epoch/lease, and a lease with an active physical child. Cover the same-ID registered continuation and reject a different command ID or mismatched identity without another post. Simulate an interruption after the composite commit and verify that the accepted envelope and one dispatched release command are durable while a later duplicate does not post again. Add `lease.release_recover` to `test/backgroundFaultInjectionMatrix.test.js`; a storage failure must preserve the previous revision with the marker, command, and accepted outbox entry all absent.

Run: `node --test test/commandReleaseAndReloadRegression.test.js test/backgroundFaultInjectionMatrix.test.js`

Expected: all release and persistence regressions pass, and no branch sends a prompt.

- [x] **Step 5: Commit the atomic extension recovery transition and plan update**

Run:

```bash
git add docs/superpowers/plans/2026-09-30-stale-planner-wake-lease-recovery-bridge.md tools/chrome-bridge-extension/background/stateV6LeaseReducer.js tools/chrome-bridge-extension/background/serverEnvelopeRouter.js tools/chrome-bridge-extension/shared/commandManifest.js test/commandReleaseAndReloadRegression.test.js test/backgroundFaultInjectionMatrix.test.js
git commit -m "fix: atomically dispatch stale lease release recovery"
```

### Task 2: Add the Bridge stale-request release coordinator

**Files:**
- Create: `src/bridge/coordinator/staleRequestReleaseCoordinator.js`
- Modify: `src/browserBridge.js`
- Test: `test/staleRequestReleaseCoordinator.test.js`

- [x] **Step 1: Add failing gate tests**

Create a harness with `activeRequestCandidates()`, a current server instance ID, a pending-request map, `isReleasePending()`, a canonical lifecycle lookup, a fixed clock, and a `sendCommand()` spy. Assert one exact current-owner terminal lease can release; one exact prior-owner lease can release only with a fresh idle/stopped observation; active current-owner state, active generation, stale/future observations, mismatched tab projection, duplicate client candidates, active pending requests, and pending release all reject without calling `sendCommand()`.

```js
const outcome = await coordinator.release(exactIdentity);
assert.equal(outcome.outcome, 'confirmed');
assert.equal(sent[0].type, 'request.release');
assert.equal(sent[0].options.request.responseEpoch, exactIdentity.responseEpoch);
```

- [x] **Step 2: Run the new focused tests and confirm they fail**

Run: `node --test test/staleRequestReleaseCoordinator.test.js`

Expected: module/API resolution fails until the coordinator exists.

- [x] **Step 3: Implement exact identity and pre-release checks**

Require exactly `requestId`, `clientId`, `leaseId`, `ownerServerInstanceId`, and safe non-negative `responseEpoch`. Require one ready compatible candidate and exact equality between the client `activeRequest` and tab-observation `activeRequest`. Require a current observation with non-empty `observerId`, positive `revision`, a non-future `observedAt` within the configured freshness limit, and generation `idle` or `stopped`. Require no Bridge pending request or release barrier. If a canonical request state exists, require its source lease/server/epoch to match exactly and require that state to be terminal, regardless of owner. If the old owner has no surviving canonical state after a Bridge restart, allow only the exact persisted lease identity plus the same fresh idle observation. Pass `clientId` only as `sourceClientId`; the Protocol request identity contains only `requestId`, `leaseId`, `ownerServerInstanceId`, and `responseEpoch`. Send exactly one canonical `request.release`; return `confirmed` only for `lease.released`, `ambiguous` for any unconfirmed outcome, and `rejected` for failed preconditions. Do not retry and do not synthesize a terminal lifecycle transition.

- [x] **Step 4: Wire the coordinator through the Bridge facade and pass the tests**

Construct the coordinator from the existing hub, lifecycle, pending map, command registry, and canonical command sender in `BrowserBridge`. Expose only `releaseStaleRequestLease(input)` for the local route. Keep the new coordinator cohesive and below the 800-line production limit.

Run: `node --test test/staleRequestReleaseCoordinator.test.js test/requestStateCanonicalBridge.test.js`

Expected: the exact safe cases confirm release and every negative gate sends no command.

- [x] **Step 5: Commit the coordinator seam**

Run:

```bash
git add src/bridge/coordinator/staleRequestReleaseCoordinator.js src/browserBridge.js test/staleRequestReleaseCoordinator.test.js
git commit -m "feat: add exact stale request lease recovery"
```

### Task 3: Expose the local release route with strict access control

**Files:**
- Create: `src/http/localReleaseRoutes.js`
- Modify: `src/routes.js`
- Test: `test/localReleaseRoutes.test.js`
- Test: `test/api.blackbox.test.js`

- [x] **Step 1: Add the failing route-access tests**

Test that the route rejects a missing API token configuration, missing/wrong token, and every non-loopback peer address; accepts only `127.0.0.1`, `::1`, and `::ffff:127.0.0.1`; maps coordinator outcomes to `200` confirmed, `202` ambiguous, and `409` rejected; and passes the request body unchanged to `releaseStaleRequestLease()`.

- [x] **Step 2: Run the focused route tests and confirm they fail**

Run: `node --test test/localReleaseRoutes.test.js test/api.blackbox.test.js`

Expected: the route module and endpoint are absent.

- [x] **Step 3: Implement the loopback and token gates**

Register `POST /__local/release-stale-request`. Require a valid IP loopback peer and a configured `API_TOKEN` matched in constant time; fail closed when the token is unset. Return only the bounded coordinator outcome, without browser page content, prompt text, or local paths.

- [x] **Step 4: Register the route and pass the focused tests**

Register the route after the normal API-token middleware in `src/routes.js`; keep the route implementation and access checks in `src/http/localReleaseRoutes.js`.

Run: `node --test test/localReleaseRoutes.test.js test/api.blackbox.test.js`

Expected: valid loopback/token requests reach only the release coordinator, and invalid callers are rejected before it runs.

- [x] **Step 5: Commit the route**

Run:

```bash
git add src/http/localReleaseRoutes.js src/routes.js test/localReleaseRoutes.test.js test/api.blackbox.test.js
git commit -m "feat: expose loopback stale lease recovery route"
```

### Task 4: Version the Bridge/extension pair and document the lifecycle

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tools/chrome-bridge-extension/manifest.json`
- Modify: `tools/chrome-bridge-extension/content.js`
- Modify: `src/bridge/coordinator/browserTabCoordinator.js`
- Modify: `src/extensionCompatibility.js`
- Modify: `test/extensionCompatibility.test.js`
- Test: `test/browserTabCoordinator.test.js`
- Modify: `CONTEXT.MD`
- Modify: `ARCHITECTURE.md`
- Modify: `GOAL.MD`
- Modify: `SESSION.MD`

- [x] **Step 1: Add compatibility assertions for the next patch pair**

Assert that package version, both package-lock root version fields, recommended/minimum extension versions, manifest version/version_name, content-script version, and minimum content version agree for the new compatible patch release. Exercise the system-browser launch failure and assert that its guidance uses the current recommended extension and minimum content versions.

- [x] **Step 2: Run the focused compatibility tests and confirm they fail**

Run: `node --test test/extensionCompatibility.test.js test/browserTabCoordinator.test.js`

Before Step 3, the tests failed against source versions `6.4.0`, `2.4.5`, and `4.4.5`; the system-browser timeout advice also contained old fixed extension/content versions.

- [x] **Step 3: Update versions and lifecycle documentation together**

Use the next compatible patch versions (`6.4.1`, `2.4.6`, and `4.4.6`) and update the minimum/recommended compatibility constants. Keep `package-lock.json` root version fields in sync. Read the system-browser failure guidance from the recommended extension and minimum content compatibility constants. Document candidate source versions in `CONTEXT.MD`, `ARCHITECTURE.md`, `GOAL.MD`, and `SESSION.MD`; state that they are not deployed. Document that the Bridge validates/requests release while the extension background alone proves cleanup and publishes `lease.released`; an ambiguous outcome stays quarantined and is never converted into prompt replay.

- [x] **Step 4: Run version and source checks**

Run: `node --test test/extensionCompatibility.test.js test/browserTabCoordinator.test.js && npm run check:quality`

Result: the compatibility and system-browser guidance tests passed (9/9), and `npm run check:quality` exited successfully with 11 existing source-size warnings below the hard limit.

- [x] **Step 5: Commit the version and docs update**

Run:

```bash
git add package.json package-lock.json tools/chrome-bridge-extension/manifest.json tools/chrome-bridge-extension/content.js src/bridge/coordinator/browserTabCoordinator.js src/extensionCompatibility.js test/extensionCompatibility.test.js test/browserTabCoordinator.test.js CONTEXT.MD ARCHITECTURE.md GOAL.MD SESSION.MD
git commit -m "docs: record stale lease recovery lifecycle"
```

### Task 5: Verify the complete Bridge source change

**Files:**
- Verify: all files listed above.

- [ ] **Step 1: Run the focused recovery contract**

Run: `node --test test/commandReleaseAndReloadRegression.test.js test/backgroundFaultInjectionMatrix.test.js test/staleRequestReleaseCoordinator.test.js test/localReleaseRoutes.test.js test/extensionCompatibility.test.js`

Expected: all targeted release, persistence, authorization, and version tests pass.

- [ ] **Step 2: Run repository checks and the full unit suite**

Run: `npm ci && npm run check && npm run check:quality && npm test`

Expected: exit code 0. Do not run a live browser wake or alter the installed Bridge/extension as part of this source-only step.

- [ ] **Step 3: Review the final diff and record the blocked host seam**

Run: `git diff --check && git status --short --branch`

Expected: no whitespace errors, only the planned Bridge/source/doc files changed, and a clean committed branch. Record that Planner-host integration and live deployment remain pending until Issue #466 releases `RickyQiYu/project-governance` and the existing rollout authority is read back.
