import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestRecoveryCoordinator } from '../src/bridge/coordinator/requestRecoveryCoordinator.js';

function setup() {
  const state = { requestId: 'request', clientId: 'tab', answer: 'Current answer' };
  let canonical = { response: { userTurnKey: 'user', epoch: 0 } };
  const identity = { requestId: 'request', leaseId: 'lease', ownerServerInstanceId: 'server', responseEpoch: 0 };
  const events = [];
  let resolve;
  const owner = {
    getState: () => canonical,
    requestIdentity: () => ({ ...identity, responseEpoch: canonical.response.epoch }),
    emitRequestEvent: (_state, event) => events.push(event),
    sendCommand: () => new Promise(done => { resolve = done; }),
  };
  const recovery = new RequestRecoveryCoordinator(owner);
  return { state, recovery, events, update: patch => { canonical = { ...canonical, ...patch }; }, respond: value => resolve(value) };
}

test('a late forced snapshot cannot overwrite a newer semantic observation', async () => {
  const h = setup();
  const ingested = [];
  h.recovery.ingestForcedSnapshot = (_state, response) => ingested.push(response);
  const pending = h.recovery.requestForcedSnapshotForState(h.state);
  assert.equal(await h.recovery.requestForcedSnapshotForState(h.state), null);
  h.update({ lastObservation: { data: { scopedToRequest: true, observation: { semanticChange: true } } } });
  h.respond({ answer: 'Old answer' });
  assert.equal(await pending, null);
  assert.deepEqual(ingested, []);
  assert.ok(h.events.some(event => event.type === 'forced_snapshot.discarded'));
});

test('a snapshot from a previous response epoch is discarded', async () => {
  const h = setup();
  h.recovery.ingestForcedSnapshot = () => assert.fail('Old epoch must not be ingested');
  const pending = h.recovery.requestForcedSnapshotForState(h.state);
  h.update({ response: { epoch: 1, userTurnKey: 'new-user' } });
  h.respond({ answer: 'Old answer' });
  assert.equal(await pending, null);
});

test('an unchanged heartbeat does not suppress a useful forced snapshot', async () => {
  const h = setup();
  const ingested = [];
  h.recovery.ingestForcedSnapshot = (_state, response) => ingested.push(response);
  const pending = h.recovery.requestForcedSnapshotForState(h.state);
  h.update({ lastObservation: { data: { scopedToRequest: true, observation: { semanticChange: false } } } });
  h.respond({ answer: 'Final answer' });
  assert.equal((await pending).answer, 'Final answer');
  assert.equal(ingested.length, 1);
});
