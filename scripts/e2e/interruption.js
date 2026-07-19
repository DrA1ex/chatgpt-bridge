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


export function createE2eSignalCoordinator({ interruption, onGraceful = () => {}, onForce = () => {} } = {}) {
  if (!interruption || typeof interruption.request !== 'function') throw new TypeError('interruption controller is required');
  return function handleSignal(signal = 'SIGINT') {
    if (interruption.request(signal)) {
      onGraceful(signal);
      return 'graceful';
    }
    onForce(signal);
    return 'forced';
  };
}
