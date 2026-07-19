import { GenerationState, OutputState, RequestBlocker } from '../state/requestEvents.js';

function text(value = '') { return String(value || ''); }

export function turnObservationSemanticSignature(observation = {}) {
  const turn = observation.turn || {};
  const output = observation.output || {};
  const artifacts = Array.isArray(observation.artifacts) ? observation.artifacts : [];
  return JSON.stringify([
    text(turn.key),
    text(turn.userKey),
    text(turn.userPrompt),
    text(output.thinking),
    text(output.progress),
    text(output.answer),
    text(output.state),
    text(observation.generation?.state),
    text(observation.blocker?.state),
    artifacts.map((artifact) => [
      text(artifact.candidateId || artifact.id),
      text(artifact.name),
      text(artifact.phase),
    ]),
  ]);
}

/**
 * Shared browser-evidence policy for active requests and passive turns.
 * Request/session ownership is intentionally applied by selectors outside this
 * function; DOM completion semantics live here and have exactly one owner.
 */
export function classifyTurnObservation(observation = {}, { minimumStableMs = 1_500 } = {}) {
  const output = observation.output || {};
  const artifacts = Array.isArray(observation.artifacts) ? observation.artifacts : [];
  const stableForMs = Math.max(0, Number(observation.stableForMs) || 0);
  const generationStopped = observation.generation?.state === GenerationState.STOPPED;
  const outputFinal = output.state === OutputState.FINAL;
  const blockerAbsent = observation.blocker?.state === RequestBlocker.NONE;
  const assistantTurnKey = text(observation.turn?.key);
  const userTurnKey = text(observation.turn?.userKey);
  const outputPresent = Boolean(text(output.answer) || artifacts.length || output.finalMessage);
  const stable = stableForMs >= minimumStableMs;
  const terminalCandidate = Boolean(
    generationStopped
    && outputFinal
    && blockerAbsent
    && stable
    && assistantTurnKey
    && outputPresent
  );
  return {
    terminalCandidate,
    generationStopped,
    outputFinal,
    blockerAbsent,
    stable,
    stableForMs,
    minimumStableMs,
    outputPresent,
    assistantTurnKey,
    userTurnKey,
    semanticSignature: turnObservationSemanticSignature(observation),
  };
}
