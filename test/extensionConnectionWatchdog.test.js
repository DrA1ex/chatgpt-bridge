import assert from 'node:assert/strict';
import test from 'node:test';
import { CONNECTION_WATCHDOG_ALARM, createConnectionWatchdog } from '../tools/chrome-bridge-extension/background/connectionWatchdog.js';

const previousWebSocket = globalThis.WebSocket;
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1 };

test.after(() => { globalThis.WebSocket = previousWebSocket; });

test('connection watchdog rearms alarms and retries only dead connection states', async () => {
  const alarms = [];
  const retried = [];
  const alive = { closed: false, ws: { readyState: 1 }, reconnectTimer: null };
  const dead = { closed: false, ws: null, reconnectTimer: setTimeout(() => {}, 60_000) };
  dead.reconnectTimer.unref?.();
  const closed = { closed: true, ws: null, reconnectTimer: null };
  const watchdog = createConnectionWatchdog({
    alarms: { async create(name, options) { alarms.push({ name, options }); } },
    connections: new Map([['alive', alive], ['dead', dead], ['closed', closed]]),
    async openConnection(state) { retried.push(state); },
  });

  assert.equal(await watchdog.arm(), true);
  assert.deepEqual(alarms, [{ name: CONNECTION_WATCHDOG_ALARM, options: { periodInMinutes: 1 } }]);
  assert.equal(watchdog.handlesAlarm(CONNECTION_WATCHDOG_ALARM), true);
  assert.equal(await watchdog.run(), 1);
  assert.deepEqual(retried, [dead]);
  assert.equal(dead.reconnectTimer, null);
});
