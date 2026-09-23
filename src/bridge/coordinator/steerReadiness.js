import { abortError } from '../requestState.js';

/**
 * Waits until the canonical request proves that a prompt was submitted,
 * generation is active, and the page has exposed either semantic assistant
 * progress or an explicit steering/send control. Generation-start alone is
 * too early on current ChatGPT pages because the composer still contains only
 * the stop button at that point.
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
    if (canonical?.submission === 'submitted' && canonical?.generation === 'active' && (semanticProgress || explicitControl)) {
      return { ...canonical, steerReadiness: { semanticProgress, explicitControl } };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const error = new Error(`Request ${requestId} did not expose assistant progress or a steering send control before the steer deadline`);
  error.code = 'STEER_UI_NOT_READY';
  throw error;
}
