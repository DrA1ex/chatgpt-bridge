export function createE2eInterruptionController() {
  const controller = new AbortController();
  let signalName = '';
  let requestedAt = '';

  function request(signal = 'SIGINT') {
    if (controller.signal.aborted) return false;
    signalName = String(signal || 'SIGINT');
    requestedAt = new Date().toISOString();
    const error = new Error(`E2E interrupted by ${signalName}`);
    error.code = 'E2E_INTERRUPTED';
    error.signal = signalName;
    controller.abort(error);
    return true;
  }

  function throwIfRequested() {
    if (!controller.signal.aborted) return;
    const reason = controller.signal.reason;
    throw reason instanceof Error ? reason : Object.assign(new Error(`E2E interrupted by ${signalName || 'signal'}`), { code: 'E2E_INTERRUPTED' });
  }

  return Object.freeze({
    signal: controller.signal,
    request,
    throwIfRequested,
    get requested() { return controller.signal.aborted; },
    get signalName() { return signalName; },
    get requestedAt() { return requestedAt; },
  });
}

export function isE2eInterruption(error) {
  return Boolean(error?.code === 'E2E_INTERRUPTED');
}

export async function abortableDelay(ms, signal = null) {
  if (!signal) return await new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) throw signal.reason;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, Number(ms) || 0));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}


export function createE2eSignalCoordinator({
  interruption,
  onGraceful = () => {},
  onDuplicate = () => {},
  onForce = () => {},
  now = () => Date.now(),
  forceAfterMs = 750,
} = {}) {
  if (!interruption || typeof interruption.request !== 'function') throw new TypeError('interruption controller is required');
  let firstSignalAt = 0;
  return function handleSignal(signal = 'SIGINT') {
    const at = Number(now()) || Date.now();
    if (interruption.request(signal)) {
      firstSignalAt = at;
      onGraceful(signal);
      return 'graceful';
    }
    // A terminal signal is commonly delivered to both the E2E parent and its
    // server child process group. Treat an immediate duplicate as the same
    // physical Ctrl+C rather than destroying the graceful-cleanup window.
    if (at - firstSignalAt < Math.max(0, Number(forceAfterMs) || 0)) {
      onDuplicate(signal);
      return 'duplicate';
    }
    onForce(signal);
    return 'forced';
  };
}

export function ownedBridgeSpawnOptions(options = {}, platform = process.platform) {
  return {
    ...options,
    // Isolate the owned bridge from terminal Ctrl+C on POSIX. The E2E parent
    // remains the sole signal owner and shuts the child down deliberately after
    // canonical requests and release barriers settle.
    detached: platform !== 'win32',
  };
}
