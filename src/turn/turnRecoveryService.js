import { VisibleProgressTracker } from '../visibleProgressTracker.js';
import {
  clean,
  compactId,
  createAgentMessageWriter,
  drainTrackedAsync,
  nowIso,
  publicTurn,
  trackAsync,
} from './turnManagerSupport.js';

export async function recoverTurnFromLatestResponse(runtime, id = '', options = {}) {
  await runtime.ready;
  let turn = id ? await runtime.metadataStore.getTurn(id) : null;
  if (!turn) {
    const listFilter = options.threadId ? { threadId: clean(options.threadId), limit: 20 } : { limit: 20 };
    const candidates = await runtime.metadataStore.listTurns(listFilter);
    turn = candidates.find((item) => ['running', 'failed', 'interrupted', 'cancelled'].includes(item.status)) || candidates[0] || null;
  }
  if (!turn && options.allowAdoptedTurn) turn = await runtime.createAdoptedRecoveryTurn(options);
  if (!turn) throw new Error('No turn is available for recovery');

  const source = turn.input?.metadata?.adoptedRecovery ? 'visible-assistant-response' : 'assistant-turn';
  await runtime.record(turn.id, 'turn/recovery.started', { turnId: turn.id, status: turn.status, source, index: options.index || 1 });
  const response = await runtime.bridge.recoverLatestResponse({ requestId: turn.id, index: options.index || 1, timeoutMs: options.timeoutMs || 30_000 });

  const recoveredReasoning = new VisibleProgressTracker({
    metadataStore: runtime.metadataStore,
    threadId: turn.threadId,
    turnId: turn.id,
    createId: () => compactId('item'),
    record: (type, data) => runtime.record(turn.id, type, data),
    recovered: true,
  });
  await recoveredReasoning.finalize(response);
  if (response.answer) {
    const item = await runtime.metadataStore.createItem({
      id: compactId('item'), threadId: turn.threadId, turnId: turn.id, type: 'agent_message', status: 'completed',
      content: {
        text: response.answer, blocks: response.responseBlocks || [], codeBlocks: response.codeBlocks || [],
        codeBlockDiagnostics: response.codeBlockDiagnostics || [], parserAudit: response.parserAudit || null,
        format: response.format || '', recovered: true,
      },
    });
    await runtime.record(turn.id, 'item/agentMessage/recovered', { itemId: item.id, chars: response.answer.length });
  }
  for (const artifact of response.artifacts || []) {
    if (!artifact?.id) continue;
    const item = await runtime.metadataStore.createItem({
      id: compactId('item'), threadId: turn.threadId, turnId: turn.id, type: 'artifact', status: 'completed',
      artifactId: artifact.id, content: { artifact, recovered: true },
    });
    await runtime.record(turn.id, 'item/artifact/recovered', { itemId: item.id, artifact });
  }
  if (response.session?.id) await runtime.metadataStore.updateThread(turn.threadId, { sessionId: response.session.id });

  const output = turn.input?.output || {};
  await runtime.record(turn.id, 'recovery.pipeline.started', {
    requestId: response.requestId || response.id || turn.id,
    expected: output.expected || output.format || '',
    required: Boolean(output.required),
    artifactCount: Array.isArray(response.artifacts) ? response.artifacts.length : 0,
    sourceClientId: response.sourceClientId || '',
  });
  let result;
  try {
    result = await runtime.resolveExpectedOutput(turn.id, { ...output, forceArtifactDownload: Boolean(options.force) }, response, { recovered: true });
  } catch (error) {
    await runtime.record(turn.id, 'recovery.pipeline.failed', { message: error.message || String(error), code: error.code || '', recoverable: true });
    throw error;
  }

  const completionStatus = runtime.completionStatusForResult(result);
  const updated = await runtime.metadataStore.updateTurn(turn.id, { status: completionStatus, completedAt: nowIso(), output: result, error: null });
  await runtime.record(turn.id, 'turn/recovered', { turn: updated, output: result, source: response.source || 'latest-assistant-turn' });
  await runtime.record(turn.id, completionStatus === 'completed_without_artifact' ? 'turn/completed_without_artifact' : 'turn/completed', { turn: updated, output: result, recovered: true });
  return publicTurn(updated);
}

export async function resumeActiveTurn(runtime, id = '', options = {}) {
  await runtime.ready;
  const target = typeof runtime.bridge.findActiveRequest === 'function'
    ? runtime.bridge.findActiveRequest({ preferredRequestId: id })
    : null;
  const activeRequest = target?.activeRequest || runtime.bridge.health().activeClient?.activeRequest || null;
  if (!activeRequest?.requestId) throw new Error('No active ChatGPT prompt is running in any connected tab.');

  let turn = id ? await runtime.metadataStore.getTurn(id) : null;
  if (!turn || turn.id !== activeRequest.requestId) turn = await runtime.metadataStore.getTurn(activeRequest.requestId) || turn;
  if (!turn || turn.id !== activeRequest.requestId) {
    const error = new Error(`Active prompt ${activeRequest.requestId} is not a known local project turn.`);
    error.code = 'NO_MATCHING_TURN';
    error.activeRequest = activeRequest;
    throw error;
  }
  if (['completed', 'completed_without_artifact', 'failed', 'interrupted', 'cancelled'].includes(turn.status)) {
    const error = new Error(`Turn ${turn.id} is already ${turn.status}. Use /recover if the browser has newer visible output.`);
    error.code = 'TURN_NOT_RUNNING';
    throw error;
  }
  if (runtime.controllers.has(turn.id)) throw new Error(`Turn ${turn.id} is already tracked locally.`);
  if (runtime.getRunning() && runtime.getRunning() !== turn.id) throw new Error(`Another turn is already running locally: ${runtime.getRunning()}`);

  const controller = new AbortController();
  runtime.controllers.set(turn.id, controller);
  const previousRunning = runtime.getRunning();
  runtime.setRunning(turn.id);
  turn = await runtime.metadataStore.updateTurn(turn.id, { status: 'running', startedAt: turn.startedAt || nowIso() });
  await runtime.record(turn.id, 'turn/resumed', { turnId: turn.id, activeRequest });

  const artifactItemIds = new Map();
  const callbackTasks = [];
  let normalDoneReceived = false;
  let normalPipelineStarted = false;
  const answerWriter = createAgentMessageWriter({
    metadataStore: runtime.metadataStore,
    threadId: turn.threadId,
    turnId: turn.id,
    record: (type, data) => runtime.record(turn.id, type, data),
    resumed: true,
  });
  const reasoningTracker = new VisibleProgressTracker({
    metadataStore: runtime.metadataStore,
    threadId: turn.threadId,
    turnId: turn.id,
    createId: () => compactId('item'),
    record: (type, data) => runtime.record(turn.id, type, data),
    resumed: true,
  });

  try {
    const response = await runtime.bridge.resumeActiveRequest({
      onEvent: (event) => runtime.record(turn.id, event.type || 'chat/event', event),
      onThinkingUpdate: (text, payload) => trackAsync(callbackTasks, reasoningTracker.updateThinking(text, payload)),
      onProgressUpdate: (_text, payload) => trackAsync(callbackTasks, reasoningTracker.updateItems(payload?.items || payload?.progressItems || [], payload)),
      onAnswerUpdate: (text) => trackAsync(callbackTasks, answerWriter.update(text)),
      onArtifactUpdate: (artifacts) => trackAsync(callbackTasks, (async () => {
        for (const artifact of artifacts || []) {
          if (!artifact?.id || artifactItemIds.has(artifact.id)) continue;
          const item = await runtime.metadataStore.createItem({
            id: compactId('item'), threadId: turn.threadId, turnId: turn.id, type: 'artifact', status: 'completed',
            artifactId: artifact.id, content: { artifact, resumed: true },
          });
          artifactItemIds.set(artifact.id, item.id);
          await runtime.record(turn.id, 'item/artifact/created', { item, artifact, resumed: true });
        }
      })()),
    }, {
      signal: controller.signal,
      fullResponse: true,
      expectedRequestId: turn.id,
      sourceClientId: target?.clientId || options.sourceClientId || '',
      timeoutMs: options.timeoutMs || 10_000,
    });

    await drainTrackedAsync(callbackTasks);
    await runtime.record(turn.id, 'normal.done.received', {
      requestId: response.requestId || response.id || turn.id,
      answerLength: String(response.answer || '').length,
      thinkingLength: String(response.thinking || '').length,
      artifactCount: Array.isArray(response.artifacts) ? response.artifacts.length : 0,
      sourceClientId: response.sourceClientId || '',
      turnKey: response.turnKey || '',
    });
    normalDoneReceived = true;
    await reasoningTracker.finalize(response);
    await answerWriter.finish(response);
    if (response.session?.id) await runtime.metadataStore.updateThread(turn.threadId, { sessionId: response.session.id });

    const output = turn.input?.output || {};
    await runtime.record(turn.id, 'normal.pipeline.started', {
      requestId: response.requestId || response.id || turn.id,
      expected: output.expected || output.format || '',
      required: Boolean(output.required),
      artifactCount: Array.isArray(response.artifacts) ? response.artifacts.length : 0,
      sourceClientId: response.sourceClientId || '',
      resumed: true,
    });
    normalPipelineStarted = true;
    const result = await runtime.resolveExpectedOutput(turn.id, output, response, { resumed: true });
    const completionStatus = runtime.completionStatusForResult(result);
    const updated = await runtime.metadataStore.updateTurn(turn.id, { status: completionStatus, completedAt: nowIso(), output: result, error: null });
    await runtime.record(turn.id, completionStatus === 'completed_without_artifact' ? 'turn/completed_without_artifact' : 'turn/completed', { turn: updated, output: result, resumed: true });
    return publicTurn(updated);
  } catch (error) {
    if (normalDoneReceived && !normalPipelineStarted) {
      await runtime.record(turn.id, 'normal.pipeline.missing_after_done', { message: error.message || String(error), resumed: true, recoverable: true });
    } else if (normalPipelineStarted) {
      await runtime.record(turn.id, 'normal.pipeline.failed', { message: error.message || String(error), code: error.code || '', resumed: true, recoverable: true });
    }
    const code = error.name === 'AbortError' ? 'TURN_INTERRUPTED' : error.code || 'TURN_FAILED';
    const status = code === 'TURN_INTERRUPTED' ? 'interrupted' : 'failed';
    const storedError = { code, message: error.message || String(error), recoverable: status !== 'interrupted', ...(error.extra ? { extra: error.extra } : {}) };
    const updated = await runtime.metadataStore.updateTurn(turn.id, { status, completedAt: nowIso(), error: storedError });
    await runtime.record(turn.id, status === 'interrupted' ? 'turn/interrupted' : 'turn/failed', { turn: updated, error: storedError, resumed: true });
    throw error;
  } finally {
    runtime.controllers.delete(turn.id);
    runtime.setRunning(previousRunning || null);
    runtime.pump();
  }
}
