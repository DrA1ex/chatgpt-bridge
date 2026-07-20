import { classifyTurnObservation } from '../observation/turnEvidence.js';

/**
 * Consumes request-free TabObservation snapshots and publishes durable workflow
 * inputs. It owns passive turn deduplication only; it never owns request state.
 */
export class PassiveObservationRouter {
  constructor({ eventBus = null, publishObservedTurn, registerObservedArtifacts }) {
    this.eventBus = eventBus;
    this.publishObservedTurn = publishObservedTurn;
    this.registerObservedArtifacts = registerObservedArtifacts;
    this.observations = new Map();
  }

  handle(clientId, client = null, payload = {}, envelope = null) {
    const observation = payload?.observation && typeof payload.observation === 'object'
      ? payload.observation
      : payload?.tabObservation && typeof payload.tabObservation === 'object'
        ? payload.tabObservation
        : null;
    if (!observation || observation.activeRequest?.requestId) return;
    const conversationId = String(observation.conversationId || client?.session?.id || payload.session?.id || 'new');
    const turnKey = String(observation.turn?.key || '');
    const userTurnKey = String(observation.turn?.userKey || '');
    const userPrompt = String(observation.turn?.userPrompt || '').trim();
    if (!turnKey || !userTurnKey || !userPrompt) return;
    const key = `${clientId}:${conversationId}`;
    const current = this.observations.get(key) || {
      baselineTurnKey: '',
      snapshots: new Map(),
      terminal: new Map(),
    };
    this.observations.set(key, current);
    while (this.observations.size > 64) this.observations.delete(this.observations.keys().next().value);

    const boundary = observation.turn?.promptBoundary || null;
    const afterExplicitBoundary = Boolean(
      boundary
      && (!boundary.submittedUserTurnKey || boundary.submittedUserTurnKey === userTurnKey),
    );
    if (!current.baselineTurnKey) {
      current.baselineTurnKey = turnKey;
      if (!afterExplicitBoundary) return;
    }
    const isNewTurn = turnKey !== current.baselineTurnKey;
    if (!isNewTurn && !afterExplicitBoundary) return;

    const output = observation.output || {};
    const artifacts = Array.isArray(observation.artifacts) ? observation.artifacts : [];
    const evidence = classifyTurnObservation(observation);
    const signature = evidence.semanticSignature;
    if (current.snapshots.get(turnKey) !== signature) {
      current.snapshots.set(turnKey, signature);
      while (current.snapshots.size > 100) current.snapshots.delete(current.snapshots.keys().next().value);
      const emit = this.eventBus?.emitTransient?.bind(this.eventBus) || this.eventBus?.emitUser?.bind(this.eventBus);
      emit?.({
        type: 'watch.turn.snapshot',
        data: {
          sourceClientId: clientId,
          sessionId: conversationId,
          observedAt: new Date(Number(observation.observedAt) || Date.now()).toISOString(),
          observationRevision: Number(observation.revision) || 0,
          turnKey,
          userTurnKey,
          turnIndex: Number(observation.turn?.index ?? -1),
          messageId: String(observation.turn?.messageId || ''),
          modelSlug: String(observation.turn?.modelSlug || ''),
          userPrompt,
          reasoning: String(output.thinking || ''),
          progress: String(output.progress || ''),
          answer: String(output.answer || ''),
          phase: String(observation.turn?.phase || ''),
          terminal: false,
          title: String(observation.title || ''),
          url: String(observation.url || ''),
        },
      });
    }

    if (!evidence.terminalCandidate || current.terminal.get(turnKey) === signature) return;
    current.terminal.set(turnKey, signature);
    while (current.terminal.size > 100) current.terminal.delete(current.terminal.keys().next().value);
    current.baselineTurnKey = turnKey;
    const normalizedArtifacts = this.registerObservedArtifacts(artifacts, {
      sourceClientId: clientId,
      turnKey,
      sessionId: conversationId,
    });
    const observed = {
      sourceClientId: clientId,
      sessionId: conversationId,
      streamSource: {
        messageId: String(envelope?.messageId || ''),
        contentEpoch: String(envelope?.source?.contentEpoch || ''),
        sequence: Number(envelope?.source?.sequence) || 0,
        observationRevision: Number(observation.revision) || 0,
      },
      observedAt: new Date(Number(observation.observedAt) || Date.now()).toISOString(),
      session: client?.session || payload.session || { id: conversationId },
      url: String(observation.url || ''),
      title: String(observation.title || ''),
      turnKey,
      userTurnKey,
      turnIndex: Number(observation.turn?.index ?? -1),
      messageId: String(observation.turn?.messageId || ''),
      modelSlug: String(observation.turn?.modelSlug || ''),
      userPrompt,
      reasoning: String(output.thinking || ''),
      progress: String(output.progress || ''),
      answer: String(output.answer || ''),
      responseBlocks: Array.isArray(output.responseBlocks) ? output.responseBlocks : [],
      parserAudit: output.parserAudit || null,
      artifacts: normalizedArtifacts,
    };
    this.eventBus?.emitUser({
      type: 'watch.turn.observed',
      data: {
        sourceClientId: clientId,
        sessionId: conversationId,
        turnKey,
        artifactCount: normalizedArtifacts.length,
        answerLength: String(output.answer || '').length,
      },
    });
    this.publishObservedTurn?.(observed);
  }
}
