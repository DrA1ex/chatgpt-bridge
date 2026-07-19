// Pure normalization helpers for always-on ChatGPT tab observations.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  const SCHEMA_VERSION = 1;

  const DocumentState = Object.freeze({
    LOADING: 'loading',
    READY: 'ready',
    DEGRADED: 'degraded',
  });

  const ComposerState = Object.freeze({
    READY: 'ready',
    MISSING: 'missing',
    UNKNOWN: 'unknown',
  });

  const TurnState = Object.freeze({
    NONE: 'none',
    PLACEHOLDER: 'placeholder',
    REASONING: 'reasoning',
    TOOL_RUNNING: 'tool_running',
    STREAMING: 'streaming',
    FINAL: 'final',
    UNKNOWN: 'unknown',
  });

  const GenerationState = Object.freeze({
    IDLE: 'idle',
    ACTIVE: 'active',
    STOPPED: 'stopped',
  });

  const BlockerState = Object.freeze({
    NONE: 'none',
    CONFIRMATION: 'confirmation',
    CONTINUE: 'continue',
    EXPLICIT_ERROR: 'explicit_error',
    UNKNOWN: 'unknown',
  });

  const OutputState = Object.freeze({
    NONE: 'none',
    REASONING: 'reasoning',
    STREAMING: 'streaming',
    FINAL: 'final',
  });

  const ArtifactState = Object.freeze({
    NONE: 'none',
    PENDING: 'pending',
    READY: 'ready',
    FAILED: 'failed',
  });

  function string(value = '') {
    return String(value || '');
  }

  function integer(value, fallback = 0) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : fallback;
  }

  function array(value, limit = 200) {
    return Array.isArray(value) ? value.slice(0, limit).map((item) => item && typeof item === 'object' ? { ...item } : item) : [];
  }

  function normalizedArtifacts(value) {
    return array(value, 100).map((artifact) => ({
      id: string(artifact?.id),
      candidateId: string(artifact?.candidateId || artifact?.id),
      kind: string(artifact?.kind),
      name: string(artifact?.name),
      mime: string(artifact?.mime),
      phase: string(artifact?.phase || artifact?.state || 'READY'),
      url: string(artifact?.url || artifact?.downloadUrl || artifact?.src),
      turnKey: string(artifact?.turnKey),
      downloadable: Boolean(artifact?.downloadable),
      downloadActionPresent: Boolean(artifact?.downloadActionPresent),
      actionLabel: string(artifact?.actionLabel),
    }));
  }

  function phaseFacts(phase = '') {
    switch (string(phase).toUpperCase()) {
      case 'ASSISTANT_PLACEHOLDER':
        return { turn: TurnState.PLACEHOLDER, output: OutputState.NONE };
      case 'ASSISTANT_REASONING':
        return { turn: TurnState.REASONING, output: OutputState.REASONING };
      case 'TOOL_RUNNING':
        return { turn: TurnState.TOOL_RUNNING, output: OutputState.REASONING };
      case 'ASSISTANT_FINAL_STREAMING':
      case 'ASSISTANT_FINAL_STREAMING_WITH_HISTORY':
        return { turn: TurnState.STREAMING, output: OutputState.STREAMING };
      case 'ASSISTANT_FINAL':
        return { turn: TurnState.FINAL, output: OutputState.FINAL };
      case 'NEEDS_CONFIRMATION':
        return { turn: TurnState.UNKNOWN, blocker: BlockerState.CONFIRMATION };
      case 'NEEDS_CONTINUE':
        return { turn: TurnState.UNKNOWN, blocker: BlockerState.CONTINUE };
      case 'ERROR':
        return { turn: TurnState.UNKNOWN, blocker: BlockerState.EXPLICIT_ERROR };
      default:
        return { turn: phase ? TurnState.UNKNOWN : TurnState.NONE, output: OutputState.NONE };
    }
  }

  function artifactFacts(artifacts = []) {
    const source = Array.isArray(artifacts) ? artifacts : [];
    if (!source.length) return { state: ArtifactState.NONE, count: 0 };
    let pending = false;
    let failed = false;
    let ready = false;
    for (const artifact of source) {
      const phase = string(artifact?.phase || artifact?.state || 'READY').toUpperCase();
      if (/FAIL|ERROR/.test(phase)) failed = true;
      else if (/GENERAT|PEND|LOAD|RUN|QUEU/.test(phase)) pending = true;
      else ready = true;
    }
    return {
      state: failed ? ArtifactState.FAILED : pending ? ArtifactState.PENDING : ready ? ArtifactState.READY : ArtifactState.NONE,
      count: source.length,
    };
  }

  function normalizeTabObservation(input = {}) {
    const presence = input.presence || {};
    const session = input.session || {};
    const snapshot = input.snapshot || {};
    const activeRequest = input.activeRequest || null;
    const turnContext = input.turnContext && typeof input.turnContext === 'object' ? input.turnContext : {};
    const phase = phaseFacts(snapshot.phase);
    const artifacts = artifactFacts(snapshot.artifacts);
    const generating = Boolean(input.generating || snapshot.stopVisible || snapshot.hasActiveTool);
    const hasAssistant = Boolean(snapshot.turnKey || snapshot.messageId || snapshot.answer || snapshot.thinking || snapshot.progress || snapshot.phase);
    const documentReadyState = string(presence.documentReadyState);
    const documentState = presence.chatMainReady
      ? DocumentState.READY
      : documentReadyState === 'loading' ? DocumentState.LOADING : DocumentState.DEGRADED;
    const composerState = presence.composerReady === true
      ? ComposerState.READY
      : presence.composerReady === false ? ComposerState.MISSING : ComposerState.UNKNOWN;
    const blocker = snapshot.hasError || snapshot.phase === 'ERROR'
      ? BlockerState.EXPLICIT_ERROR
      : snapshot.needsConfirmation ? BlockerState.CONFIRMATION
        : snapshot.needsContinue ? BlockerState.CONTINUE
          : phase.blocker || BlockerState.NONE;
    const output = snapshot.hasFinalMessage && !generating
      ? OutputState.FINAL
      : phase.output || (snapshot.answer ? (generating ? OutputState.STREAMING : OutputState.FINAL) : snapshot.thinking ? OutputState.REASONING : OutputState.NONE);
    const turn = output === OutputState.FINAL
      ? TurnState.FINAL
      : output === OutputState.STREAMING ? TurnState.STREAMING
        : phase.turn;

    return {
      schemaVersion: SCHEMA_VERSION,
      url: string(input.url),
      title: string(input.title),
      conversationId: string(session.id || input.conversationId),
      visibility: string(presence.visibilityState),
      focused: Boolean(presence.focused),
      document: {
        state: documentState,
        readyState: documentReadyState,
        chatMainReady: Boolean(presence.chatMainReady),
        pageReady: Boolean(presence.pageReady),
      },
      composer: {
        state: composerState,
        ready: Boolean(presence.composerReady),
      },
      turn: {
        state: turn,
        phase: string(snapshot.phase),
        key: string(snapshot.turnKey),
        index: Number.isInteger(snapshot.turnIndex) ? snapshot.turnIndex : -1,
        messageId: string(snapshot.messageId),
        modelSlug: string(snapshot.modelSlug),
        count: integer(snapshot.turnCount),
        userKey: string(turnContext.userTurnKey),
        userIndex: Number.isInteger(turnContext.userTurnIndex) ? turnContext.userTurnIndex : -1,
        userPrompt: string(turnContext.userPrompt),
        promptBoundary: turnContext.promptBoundary && typeof turnContext.promptBoundary === 'object'
          ? { ...turnContext.promptBoundary }
          : null,
      },
      generation: {
        state: generating ? GenerationState.ACTIVE : hasAssistant ? GenerationState.STOPPED : GenerationState.IDLE,
        stopVisible: Boolean(snapshot.stopVisible),
        activeTool: Boolean(snapshot.hasActiveTool),
      },
      blocker: {
        state: blocker,
        confirmation: blocker === BlockerState.CONFIRMATION,
        continue: blocker === BlockerState.CONTINUE,
      },
      output: {
        state: output,
        answer: string(snapshot.answer),
        thinking: string(snapshot.thinking),
        progress: string(snapshot.progress),
        progressItems: array(snapshot.progressItems),
        reasoningHistory: array(snapshot.reasoningHistory),
        responseBlocks: array(snapshot.responseBlocks),
        codeBlocks: array(snapshot.codeBlocks),
        codeBlockDiagnostics: array(snapshot.codeBlockDiagnostics),
        parserAudit: snapshot.parserAudit && typeof snapshot.parserAudit === 'object' ? { ...snapshot.parserAudit } : null,
        format: string(snapshot.format),
        raw: string(snapshot.raw),
        answerLength: string(snapshot.answer).length,
        thinkingLength: string(snapshot.thinking).length,
        progressLength: string(snapshot.progress).length,
        finalMessage: Boolean(snapshot.hasFinalMessage),
        actionBarVisible: Boolean(snapshot.actionBarVisible),
      },
      artifacts: normalizedArtifacts(snapshot.artifacts),
      artifact: artifacts,
      error: {
        explicit: blocker === BlockerState.EXPLICIT_ERROR,
        message: string(snapshot.errorText),
      },
      boundLeaseProjection: activeRequest ? {
        requestId: string(activeRequest.requestId),
        leaseId: string(activeRequest.leaseId),
        ownerServerInstanceId: string(activeRequest.ownerServerInstanceId),
        responseEpoch: integer(activeRequest.responseEpoch),
        submittedUserTurnKey: string(activeRequest.submittedUserTurnKey),
        assistantTurnKey: string(activeRequest.assistantTurnKey),
      } : null,
      activeRequest: activeRequest ? {
        requestId: string(activeRequest.requestId),
        leaseId: string(activeRequest.leaseId),
        ownerServerInstanceId: string(activeRequest.ownerServerInstanceId),
        responseEpoch: integer(activeRequest.responseEpoch),
        submittedUserTurnKey: string(activeRequest.submittedUserTurnKey),
        assistantTurnKey: string(activeRequest.assistantTurnKey),
      } : null,
      degraded: documentState === DocumentState.DEGRADED || composerState === ComposerState.MISSING,
      evidence: {
        snapshotReason: string(snapshot.reason),
        unknownTestIds: Array.isArray(snapshot.unknownTestIds) ? snapshot.unknownTestIds.slice(0, 30) : [],
        assistantNodeCount: integer(snapshot.count),
      },
    };
  }

  function signatureForObservation(observation = {}) {
    return JSON.stringify([
      observation.url || '',
      observation.conversationId || '',
      observation.visibility || '',
      Boolean(observation.focused),
      observation.document?.state || '',
      observation.document?.readyState || '',
      Boolean(observation.document?.chatMainReady),
      Boolean(observation.document?.pageReady),
      observation.composer?.state || '',
      observation.turn?.state || '',
      observation.turn?.phase || '',
      observation.turn?.key || '',
      observation.turn?.userKey || '',
      observation.turn?.userPrompt || '',
      observation.turn?.messageId || '',
      observation.turn?.modelSlug || '',
      observation.generation?.state || '',
      Boolean(observation.generation?.stopVisible),
      Boolean(observation.generation?.activeTool),
      observation.blocker?.state || '',
      observation.output?.state || '',
      observation.output?.answer || '',
      observation.output?.thinking || '',
      observation.output?.progress || '',
      observation.output?.progressItems || [],
      Boolean(observation.output?.finalMessage),
      Boolean(observation.output?.actionBarVisible),
      observation.artifact?.state || '',
      observation.artifacts || [],
      Boolean(observation.error?.explicit),
      observation.error?.message || '',
      observation.activeRequest?.requestId || '',
      observation.activeRequest?.leaseId || '',
      Number(observation.activeRequest?.responseEpoch) || 0,
      Boolean(observation.degraded),
      observation.evidence?.unknownTestIds || [],
    ]);
  }

  function isMateriallyEqual(left, right) {
    return signatureForObservation(left) === signatureForObservation(right);
  }

  Object.assign(globalThis, {
    ChatGptTabObservationCore: Object.freeze({
      SCHEMA_VERSION,
      DocumentState,
      ComposerState,
      TurnState,
      GenerationState,
      BlockerState,
      OutputState,
      ArtifactState,
      normalizeTabObservation,
      signatureForObservation,
      isMateriallyEqual,
    }),
  });
})();
