import { makeEvent } from '../requestState.js';

// Diagnostic only: the canonical reducer still owns all response meaning.
const MAX_INTERMEDIATE_CAPTURE_EVENTS = 63;

export function publishDomCaptureSnapshot(state, observation, emit) {
  if (!state?.promptPayload?.options?.captureDomTimeline) return false;
  const output = observation?.output || {};
  const sourceHtml = output.parserAudit?.sourceHtml;
  if (!sourceHtml || !observation?.turn?.key) return false;

  const phase = String(observation.turn.phase || '');
  const signature = `${observation.turn.key}\n${phase}\n${sourceHtml}`;
  const capture = state.domCapture || { count: 0, signature: '', finalCaptured: false };
  const final = phase === 'ASSISTANT_FINAL';
  if (capture.signature === signature
    || (final ? capture.finalCaptured : capture.count >= MAX_INTERMEDIATE_CAPTURE_EVENTS)) return false;
  state.domCapture = {
    count: capture.count + (final ? 0 : 1),
    signature,
    finalCaptured: capture.finalCaptured || final,
  };
  emit(state, makeEvent('assistant.dom.snapshot', {
    requestId: state.requestId,
    phase,
    domPhase: phase,
    turnKey: String(observation.turn.key),
    turnIndex: Number(observation.turn.index ?? -1),
    observationRevision: Number(observation.revision) || 0,
    answer: String(output.answer || ''),
    thinking: String(output.thinking || ''),
    progress: String(output.progress || ''),
    progressItems: output.progressItems || [],
    reasoningHistory: output.reasoningHistory || [],
    raw: String(output.raw || ''),
    responseBlocks: output.responseBlocks || [],
    codeBlocks: output.codeBlocks || [],
    codeBlockDiagnostics: output.codeBlockDiagnostics || [],
    parserAudit: output.parserAudit,
    artifacts: observation.artifacts || [],
    format: String(output.format || ''),
    signature: String(observation.signature || ''),
  }));
  return true;
}
