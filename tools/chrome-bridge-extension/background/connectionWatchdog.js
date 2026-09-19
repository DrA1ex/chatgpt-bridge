export const CONNECTION_WATCHDOG_ALARM = 'bridge.connection.watchdog';

function socketAlive(state = {}) {
  const readyState = state.ws?.readyState;
  return readyState === WebSocket.CONNECTING || readyState === WebSocket.OPEN;
}

export function createConnectionWatchdog({ alarms, connections, openConnection, periodInMinutes = 1 } = {}) {
  if (!connections || typeof openConnection !== 'function') throw new TypeError('Connection watchdog requires connections and openConnection');

  async function run() {
    const retries = [];
    for (const state of connections.values()) {
      if (!state || state.closed || socketAlive(state)) continue;
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
      retries.push(Promise.resolve(openConnection(state)));
    }
    await Promise.allSettled(retries);
    return retries.length;
  }

  async function arm() {
    if (!alarms?.create) return false;
    await alarms.create(CONNECTION_WATCHDOG_ALARM, { periodInMinutes: Math.max(1, Number(periodInMinutes) || 1) });
    return true;
  }

  function handlesAlarm(name = '') {
    return String(name || '') === CONNECTION_WATCHDOG_ALARM;
  }

  return Object.freeze({ arm, handlesAlarm, run });
}
