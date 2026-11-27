import test from 'node:test';
import assert from 'node:assert/strict';
import { StaleRequestReleaseCoordinator } from '../src/bridge/coordinator/staleRequestReleaseCoordinator.js';

const NOW = 1_800_000_000_000;
const FRESHNESS_MS = 10_000;

function identity(overrides = {}) {
  return {
    requestId: 'request-1',
    clientId: 'client-1',
    leaseId: 'lease-1',
    ownerServerInstanceId: 'server-current',
    responseEpoch: 2,
    ...overrides,
  };
}

function makeHarness(options = {}) {
  const releaseIdentity = identity(options.identity);
  const projection = {
    requestId: releaseIdentity.requestId,
    leaseId: releaseIdentity.leaseId,
    ownerServerInstanceId: releaseIdentity.ownerServerInstanceId,
    responseEpoch: releaseIdentity.responseEpoch,
  };
  const tabProjection = { ...projection };
  const client = {
    id: releaseIdentity.clientId,
    ready: true,
    compatible: true,
    compatibility: { compatible: true },
    activeRequest: { ...projection },
    tabObservation: {
      observerId: 'observer-1',
      revision: 7,
      observedAt: NOW - 100,
      generation: { state: options.generationState || 'stopped' },
      activeRequest: tabProjection,
    },
    ...options.client,
  };
  const candidate = {
    clientId: client.id,
    client,
    activeRequest: client.activeRequest,
    selected: true,
    ...options.candidate,
  };
  const candidates = options.candidates || [candidate];
  const pending = options.pending || new Map();
  const calls = [];
  const state = options.canonicalState === undefined
    ? {
      requestId: releaseIdentity.requestId,
      source: {
        leaseId: releaseIdentity.leaseId,
        ownerServerInstanceId: releaseIdentity.ownerServerInstanceId,
      },
      response: { epoch: releaseIdentity.responseEpoch },
      lifecycle: 'completed',
      terminal: { code: 'completed' },
    }
    : options.canonicalState;
  const coordinator = new StaleRequestReleaseCoordinator({
    activeRequestCandidates: () => candidates,
    serverInstanceId: options.serverInstanceId || 'server-current',
    pending,
    isReleasePending: () => Boolean(options.releasePending),
    getCanonicalRequestState: (requestId) => requestId === state?.requestId ? state : null,
    sendCommand: async (...args) => {
      calls.push(args);
      if (options.sendCommandError) throw options.sendCommandError;
      return options.sendCommandResult === undefined
        ? { type: 'lease.released', released: true }
        : options.sendCommandResult;
    },
    now: () => NOW,
    observationFreshnessMs: FRESHNESS_MS,
  });
  return { coordinator, candidate, candidates, calls, client, pending, releaseIdentity, state };
}

function makeCanonical(releaseIdentity, overrides = {}) {
  return {
    requestId: releaseIdentity.requestId,
    source: {
      leaseId: releaseIdentity.leaseId,
      ownerServerInstanceId: releaseIdentity.ownerServerInstanceId,
    },
    response: { epoch: releaseIdentity.responseEpoch },
    lifecycle: 'completed',
    terminal: { code: 'completed' },
    ...overrides,
  };
}

test('releases one exact current-owner terminal lease after lease.released', async () => {
  const h = makeHarness();

  const outcome = await h.coordinator.releaseStaleRequestLease(h.releaseIdentity);

  assert.equal(outcome.status, 'confirmed');
  assert.equal(h.calls.length, 1);
  const [type, payload, options] = h.calls[0];
  assert.equal(type, 'request.release');
  assert.deepEqual(payload, {
    requestId: h.releaseIdentity.requestId,
    recoveryMode: 'stale_lease',
    reason: 'stale_lease_release',
    terminalCode: 'stale_lease_release',
  });
  assert.deepEqual(options, {
    sourceClientId: h.releaseIdentity.clientId,
    timeoutMs: 10_000,
    request: {
      requestId: h.releaseIdentity.requestId,
      leaseId: h.releaseIdentity.leaseId,
      ownerServerInstanceId: h.releaseIdentity.ownerServerInstanceId,
      responseEpoch: h.releaseIdentity.responseEpoch,
    },
  });
});

test('recovers one exact prior-owner lease without canonical state only with a fresh idle observation', async () => {
  const priorIdentity = identity({ ownerServerInstanceId: 'server-prior' });
  const h = makeHarness({
    identity: priorIdentity,
    serverInstanceId: 'server-current',
    canonicalState: null,
    generationState: 'idle',
  });

  const outcome = await h.coordinator.releaseStaleRequestLease(priorIdentity);

  assert.equal(outcome.status, 'confirmed');
  assert.equal(h.calls.length, 1);
});

test('rejects an active canonical request without sending a command', async () => {
  const h = makeHarness({ canonicalState: makeCanonical(identity(), { lifecycle: 'generating', terminal: null }) });

  const outcome = await h.coordinator.releaseStaleRequestLease(h.releaseIdentity);

  assert.equal(outcome.status, 'rejected');
  assert.equal(h.calls.length, 0);
});

test('rejects a current-owner lease when canonical state has not survived', async () => {
  const h = makeHarness({ canonicalState: null });

  const outcome = await h.coordinator.releaseStaleRequestLease(h.releaseIdentity);

  assert.equal(outcome.status, 'rejected');
  assert.equal(h.calls.length, 0);
});

test('rejects canonical state whose lease identity does not match', async (t) => {
  const mismatches = [
    { source: { leaseId: 'different-lease', ownerServerInstanceId: 'server-current' } },
    { source: { leaseId: 'lease-1', ownerServerInstanceId: 'server-prior' } },
    { response: { epoch: 3 } },
  ];
  for (const overrides of mismatches) {
    await t.test(JSON.stringify(overrides), async () => {
      const h = makeHarness({ canonicalState: makeCanonical(identity(), overrides) });
      const outcome = await h.coordinator.releaseStaleRequestLease(h.releaseIdentity);
      assert.equal(outcome.status, 'rejected');
      assert.equal(h.calls.length, 0);
    });
  }
});

test('rejects malformed release identities and unsafe response epochs', async (t) => {
  for (const input of [
    { ...identity(), extra: 'not allowed' },
    identity({ responseEpoch: Number.MAX_SAFE_INTEGER + 1 }),
    identity({ responseEpoch: -1 }),
    identity({ responseEpoch: 1.5 }),
    identity({ clientId: '' }),
  ]) {
    await t.test(JSON.stringify(input), async () => {
      const h = makeHarness();
      const outcome = await h.coordinator.releaseStaleRequestLease(input);
      assert.equal(outcome.status, 'rejected');
      assert.equal(h.calls.length, 0);
    });
  }
});

test('rejects when active generation is reported', async () => {
  const h = makeHarness({ client: { tabObservation: {
    observerId: 'observer-1', revision: 7, observedAt: NOW - 100,
    generation: { state: 'active' }, activeRequest: {
      requestId: 'request-1', leaseId: 'lease-1', ownerServerInstanceId: 'server-current', responseEpoch: 2,
    },
  } } });

  const outcome = await h.coordinator.releaseStaleRequestLease(h.releaseIdentity);

  assert.equal(outcome.status, 'rejected');
  assert.equal(h.calls.length, 0);
});

test('rejects stale, future-dated, and malformed observations', async (t) => {
  const invalidObservations = [
    { observerId: 'observer-1', revision: 7, observedAt: NOW - FRESHNESS_MS - 1, generation: { state: 'idle' } },
    { observerId: 'observer-1', revision: 7, observedAt: NOW + 1, generation: { state: 'idle' } },
    { observerId: '', revision: 7, observedAt: NOW - 1, generation: { state: 'idle' } },
    { observerId: 'observer-1', revision: 0, observedAt: NOW - 1, generation: { state: 'idle' } },
    { observerId: 'observer-1', revision: 7.2, observedAt: NOW - 1, generation: { state: 'idle' } },
    { observerId: 'observer-1', revision: 7, observedAt: 'bad-time', generation: { state: 'idle' } },
    { observerId: 'observer-1', revision: 7, observedAt: NOW - 1, generation: { state: 'unknown' } },
  ];

  for (const observation of invalidObservations) {
    await t.test(JSON.stringify(observation), async () => {
      const h = makeHarness({
        identity: identity({ ownerServerInstanceId: 'server-prior' }),
        serverInstanceId: 'server-current',
        canonicalState: null,
        client: { tabObservation: {
          ...observation,
          activeRequest: {
            requestId: 'request-1', leaseId: 'lease-1', ownerServerInstanceId: 'server-prior', responseEpoch: 2,
          },
        } },
      });
      const outcome = await h.coordinator.releaseStaleRequestLease(h.releaseIdentity);
      assert.equal(outcome.status, 'rejected');
      assert.equal(h.calls.length, 0);
    });
  }
});

test('rejects a client activeRequest that differs from the tab observation projection', async () => {
  const h = makeHarness({ client: {
    activeRequest: { requestId: 'request-1', leaseId: 'client-lease', ownerServerInstanceId: 'server-current', responseEpoch: 2 },
  } });

  const outcome = await h.coordinator.releaseStaleRequestLease(h.releaseIdentity);

  assert.equal(outcome.status, 'rejected');
  assert.equal(h.calls.length, 0);
});

test('rejects a candidate whose activeRequest differs from the client tab observation', async () => {
  const h = makeHarness({ candidate: {
    activeRequest: { requestId: 'request-1', leaseId: 'candidate-lease', ownerServerInstanceId: 'server-current', responseEpoch: 2 },
  } });

  const outcome = await h.coordinator.releaseStaleRequestLease(h.releaseIdentity);

  assert.equal(outcome.status, 'rejected');
  assert.equal(h.calls.length, 0);
});

test('rejects a candidate that is not ready or compatible', async (t) => {
  for (const client of [{ ready: false }, { compatible: false }, { compatibility: { compatible: false } }]) {
    await t.test(JSON.stringify(client), async () => {
      const h = makeHarness({ client });
      const outcome = await h.coordinator.releaseStaleRequestLease(h.releaseIdentity);
      assert.equal(outcome.status, 'rejected');
      assert.equal(h.calls.length, 0);
    });
  }
});

test('rejects duplicate active request candidates', async () => {
  const h = makeHarness();
  h.candidates.push({ ...h.candidate, client: { ...h.client } });

  const outcome = await h.coordinator.releaseStaleRequestLease(h.releaseIdentity);

  assert.equal(outcome.status, 'rejected');
  assert.equal(h.calls.length, 0);
});

test('rejects an active pending bridge request using the client', async () => {
  const pending = new Map([['request-pending', { requestId: 'request-pending', clientId: 'client-1', runtime: { finished: false } }]]);
  const h = makeHarness({ pending });

  const outcome = await h.coordinator.releaseStaleRequestLease(h.releaseIdentity);

  assert.equal(outcome.status, 'rejected');
  assert.equal(h.calls.length, 0);
});

test('rejects a release while the client release barrier is pending', async () => {
  const h = makeHarness({ releasePending: true });

  const outcome = await h.coordinator.releaseStaleRequestLease(h.releaseIdentity);

  assert.equal(outcome.status, 'rejected');
  assert.equal(h.calls.length, 0);
});

test('returns ambiguous when release is unconfirmed and never retries', async () => {
  const h = makeHarness({ sendCommandResult: { type: 'command.result', released: true } });

  const outcome = await h.coordinator.releaseStaleRequestLease(h.releaseIdentity);

  assert.equal(outcome.status, 'ambiguous');
  assert.equal(h.calls.length, 1);
});

test('returns ambiguous when the release command rejects and never retries', async () => {
  const h = makeHarness({ sendCommandResult: Promise.reject(new Error('timed out')) });

  const outcome = await h.coordinator.releaseStaleRequestLease(h.releaseIdentity);

  assert.equal(outcome.status, 'ambiguous');
  assert.equal(h.calls.length, 1);
});

test('returns rejected when the browser rejects a release before dispatch', async () => {
  const error = Object.assign(new Error('quarantined before release dispatch'), {
    code: 'BROWSER_TAB_QUARANTINED',
    preDispatchRejected: true,
  });
  const h = makeHarness({ sendCommandError: error });

  const outcome = await h.coordinator.releaseStaleRequestLease(h.releaseIdentity);

  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.reason, 'release_rejected_before_dispatch');
  assert.equal(h.calls.length, 1);
});
