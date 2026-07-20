import { abortError } from '../requestState.js';

/**
 * Waits until the canonical request proves that a prompt was submitted and
 * generation is still active. Disposable content projections are not used as
 * authority for steer readiness.
 */
export async function waitForSteerReadiness({
  requestId,
  state,
  lifecycle,
  signal = null,
  timeoutMs = 30_000,
  steerReadyTimeoutMs = 12_000,
  pollMs = 50,
} = {}) {
  const limit = Math.max(1_000, Math.min(Number(steerReadyTimeoutMs) || 12_000, Number(timeoutMs) || 30_000));
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError(signal.reason || 'Steer cancelled');
    if (state?.done) {
      const error = new Error(`Request ${requestId} completed before steering became possible`);
      error.code = 'REQUEST_COMPLETED_BEFORE_STEER';
      throw error;
    }
    const canonical = lifecycle.getState(requestId);
    if (canonical?.submission === 'submitted' && canonical?.generation === 'active') return canonical;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const error = new Error(`Request ${requestId} did not enter active generation before steer deadline`);
  error.code = 'STEER_GENERATION_NOT_ACTIVE';
  throw error;
}
