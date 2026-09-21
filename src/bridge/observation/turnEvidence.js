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
    Boolean(observation.generation?.streamingVisible),
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
  const streamingVisible = Boolean(observation.generation?.streamingVisible);
  const generationStopped = observation.generation?.state === GenerationState.STOPPED
    && !streamingVisible && !observation.generation?.stopVisible && !observation.generation?.activeTool;
  const outputFinal = output.state === OutputState.FINAL;
  const blockerAbsent = observation.blocker?.state === RequestBlocker.NONE;
  const assistantTurnKey = text(observation.turn?.key);
  const userTurnKey = text(observation.turn?.userKey);
  const artifactsPending = observation.artifact?.state === 'pending'
    || artifacts.some((artifact) => /GENERAT|PEND|LOAD|RUN|QUEU/i.test(text(artifact.phase || artifact.state)));
  const artifactsFailed = observation.artifact?.state === 'failed'
    || artifacts.some((artifact) => /FAIL|ERROR/i.test(text(artifact.phase || artifact.state)));
  const outputPresent = Boolean(text(output.answer).trim() || artifacts.length);
  const stable = stableForMs >= minimumStableMs;
  const terminalCandidate = Boolean(
    generationStopped
    && outputFinal
    && blockerAbsent
    && stable
    && assistantTurnKey
    && outputPresent
    && !artifactsPending
    && !artifactsFailed
    && !observation.degraded
  );
  return {
    terminalCandidate,
    generationStopped,
    streamingVisible,
    outputFinal,
    blockerAbsent,
    stable,
    stableForMs,
    minimumStableMs,
    outputPresent,
    artifactsPending,
    artifactsFailed,
    assistantTurnKey,
    userTurnKey,
    semanticSignature: turnObservationSemanticSignature(observation),
  };
}
