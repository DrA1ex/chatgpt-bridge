const PIPELINE_LIFECYCLES = new Set(['finalizing', 'artifact_settling', 'completed', 'failed', 'cancelled']);
const SUCCESS_TERMINAL_CODES = new Set(['completed']);


export function canonicalRequestDiagnostics(payload = null) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.state || payload.history) return payload;
  if (payload.requests?.state || payload.requests?.history) return payload.requests;
  return null;
}

export function turnWaitState({ canonical = null } = {}) {
  const diagnostics = canonicalRequestDiagnostics(canonical);
  const state = diagnostics?.state || null;
  if (!state) {
    return {
      source: 'unavailable',
      stage: 'state_unavailable',
      phase: 'unknown',
      lifecycle: '',
      generationActive: false,
      revision: 0,
      terminal: null,
      history: [],
    };
  }

  const lifecycle = String(state.lifecycle || '');
  const generationActive = state.generation === 'active';
  return {
    source: 'canonical',
    stage: generationActive ? 'result_active' : PIPELINE_LIFECYCLES.has(lifecycle) ? 'pipeline' : 'result_waiting',
    phase: String(state.displayPhase || lifecycle || 'unknown'),
    lifecycle,
    generationActive,
    revision: Number(state.revision || 0),
    terminal: state.terminal || null,
    history: Array.isArray(diagnostics.history) ? diagnostics.history : [],
  };
}

export function turnProgressSignature(snapshot = {}, events = [], active = null, waitState = {}) {
  const turn = snapshot.turn || {};
  const latest = events.at?.(-1) || events[events.length - 1] || {};
  return JSON.stringify({
    status: turn.status || '',
    updatedAt: turn.updatedAt || '',
    completedAt: turn.completedAt || '',
    latestEventType: latest.type || '',
    latestEventTime: latest.time || latest.createdAt || latest.at || '',
    latestEventId: latest.id || latest.sequence || '',
    stateSource: waitState.source || '',
    canonicalRevision: Number(waitState.revision || 0),
    canonicalLifecycle: waitState.lifecycle || '',
    canonicalTerminal: waitState.terminal?.code || '',
    activePhase: active?.phase || '',
    activeAnswerLength: Number(active?.answerLength || 0),
    activeThinkingLength: Number(active?.thinkingLength || 0),
    activeArtifactCount: Number(active?.artifactCount || 0),
    activeLastMeaningfulProgressAt: Number(active?.lastMeaningfulProgressAt || 0),
    activeGeneration: Boolean(active?.currentGenerationActive),
  });
}

export function canonicalTransitionPath(waitState = {}, limit = 12) {
  const history = Array.isArray(waitState.history) ? waitState.history.slice(-Math.max(1, limit)) : [];
  return history.map((entry) => {
    const revision = Number(entry.revision || 0);
    const type = String(entry.event?.type || 'unknown');
    const lifecycle = String(entry.lifecycle || 'unknown');
    const terminal = String(entry.terminal?.code || '');
    return `r${revision}:${type}->${lifecycle}${terminal ? `(${terminal})` : ''}`;
  }).join(' | ');
}

export function canonicalTerminalFailure(waitState = {}) {
  const terminal = waitState.terminal;
  if (!terminal || SUCCESS_TERMINAL_CODES.has(String(terminal.code || ''))) return null;
  const path = canonicalTransitionPath(waitState);
  return {
    code: String(terminal.code || 'failed'),
    message: String(terminal.message || terminal.code || 'Canonical request failed'),
    revision: Number(waitState.revision || 0),
    path,
  };
}
