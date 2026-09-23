import { abortError } from '../requestState.js';

/**
 * Waits until the canonical request proves that the original prompt was
 * submitted and generation is active. The content runtime owns DOM-level
 * steering readiness and waits for the actual send control after it receives
 * the steer command, so duplicating that wait here only shrinks the steer
 * window for short responses.
 */
export async function waitForSteerReadiness({
  requestId,
  state,
  lifecycle,
  signal = null,
  timeoutMs = 30_000,
  steerReadyTimeoutMs = 90_000,
  pollMs = 50,
} = {}) {
  const limit = Math.max(1_000, Math.min(Number(steerReadyTimeoutMs) || 90_000, Number(timeoutMs) || 120_000));
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError(signal.reason || 'Steer cancelled');
    if (state?.done) {
      const error = new Error(`Request ${requestId} completed before steering became possible`);
      error.code = 'REQUEST_COMPLETED_BEFORE_STEER';
      throw error;
    }

    const canonical = lifecycle.getState(requestId);
    const progress = state?.progress && typeof state.progress === 'object' ? state.progress : {};
    const semanticProgress = String(state?.thinking || '').length > 0
      || String(state?.answer || '').length > 0
      || String(state?.progressText || '').length > 0
      || Number(progress.thinkingLength || 0) > 0
      || Number(progress.answerLength || 0) > 0
      || Number(progress.progressLength || 0) > 0;
    const explicitControl = progress.sendButtonVisible === true || progress.steerControlVisible === true;

    if (canonical?.submission === 'submitted' && canonical?.generation === 'active') {
      return {
        ...canonical,
        steerReadiness: {
          canonicalGeneration: true,
          semanticProgress,
          explicitControl,
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const error = new Error(`Request ${requestId} did not enter active generation before the steer deadline`);
  error.code = 'STEER_UI_NOT_READY';
  throw error;
}
