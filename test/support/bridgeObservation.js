let revision = 0;

export function emitPromptSubmitted(hub, {
  requestId,
  clientId = 'client-1',
  effectId = `${requestId}:prompt.submit`,
  accepted = true,
} = {}) {
  if (accepted) hub.emit('client.message', {
    clientId,
    payload: { type: 'prompt.accepted', requestId },
  });
  hub.emit('client.message', {
    clientId,
    payload: { type: 'request.effect.started', requestId, effectId, effectType: 'prompt.submit' },
  });
  hub.emit('client.message', {
    clientId,
    payload: { type: 'request.effect.succeeded', requestId, effectId, effectType: 'prompt.submit', result: { submitted: true } },
  });
}

export function emitTabObservation(hub, {
  requestId,
  clientId = 'client-1',
  responseEpoch = 0,
  conversationId = 'conversation-1',
  userTurnKey = 'user-1',
  assistantTurnKey = 'assistant-1',
  userPrompt = 'test prompt',
  answer = '',
  thinking = '',
  progress = '',
  progressItems = [],
  reasoningHistory = [],
  responseBlocks = [],
  codeBlocks = [],
  codeBlockDiagnostics = [],
  parserAudit = null,
  artifacts = [],
  generation = 'stopped',
  outputState = generation === 'active' ? 'streaming' : 'final',
  blocker = 'none',
  stableForMs = generation === 'stopped' ? 2_000 : 0,
  finalMessage = generation === 'stopped',
  activeRequest = true,
  session = null,
} = {}) {
  revision += 1;
  const observation = {
    schemaVersion: 4,
    revision,
    observedAt: Date.now(),
    stableForMs,
    conversationId,
    activeRequest: activeRequest ? {
      requestId,
      responseEpoch,
      submittedUserTurnKey: userTurnKey,
      submittedUserTurnIndex: 0,
      assistantTurnKey,
      assistantTurnIndex: 1,
    } : null,
    turn: {
      key: assistantTurnKey,
      index: 1,
      userKey: userTurnKey,
      userIndex: 0,
      userPrompt,
      promptBoundary: {
        submittedUserTurnKey: userTurnKey,
        submittedUserTurnIndex: 0,
      },
    },
    generation: { state: generation, stopVisible: generation === 'active', activeTool: false },
    blocker: { state: blocker },
    output: {
      state: outputState,
      answer,
      thinking,
      progress,
      progressItems,
      finalMessage,
      responseBlocks,
      reasoningHistory,
      codeBlocks,
      codeBlockDiagnostics,
      parserAudit,
    },
    artifact: { state: artifacts.length ? 'ready' : 'not_expected', count: artifacts.length },
    artifacts,
  };
  hub.emit('client.activity', {
    clientId,
    client: { id: clientId, session: session || { id: conversationId } },
    payload: { type: 'tab.observation', observation, session: session || { id: conversationId } },
  });
  return observation;
}

export function commandProgress(commandId, progressType, data = {}) {
  return { ...data, type: 'command.progress', commandId, progressType };
}

export function commandResult(commandId, resultType, data = {}) {
  return { ...data, type: 'command.result', commandId, resultType };
}
