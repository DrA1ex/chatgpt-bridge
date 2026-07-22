import { EventEmitter } from 'node:events';
import { VisibleProgressTracker } from './visibleProgressTracker.js';
import { recoverTurnFromLatestResponse, resumeActiveTurn } from './turn/turnRecoveryService.js';
import {
  clean,
  compactId,
  createAgentMessageWriter,
  drainTrackedAsync,
  normalizeAttachments,
  normalizeInputParts,
  nowIso,
  publicThread,
  publicTurn,
  textFromInput,
  trackAsync,
} from './turn/turnManagerSupport.js';

export class TurnManager extends EventEmitter {
  constructor({ bridge, metadataStore, resultResolver, eventBus, projectService = null }) {
    super();
    this.bridge = bridge;
    this.metadataStore = metadataStore;
    this.resultResolver = resultResolver;
    this.eventBus = eventBus;
    this.projectService = projectService;
    this.queue = [];
    this.running = null;
    this.controllers = new Map();
    this.ready = metadataStore.ready;
    this.runtimeOptions = new Map();
  }

  async createThread(input = {}) {
    await this.ready;
    const cwd = clean(input.cwd || input.projectRoot);
    const title = clean(input.title || input.name) || (cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : 'New thread') || 'New thread';
    const thread = await this.metadataStore.createThread({
      id: input.id || compactId('thread'),
      title,
      cwd,
      sessionId: clean(input.sessionId || input.conversationId),
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    });
    this.#notify('thread/created', { thread });
    return publicThread(thread);
  }

  async listThreads(filter = {}) {
    return (await this.metadataStore.listThreads(filter)).map(publicThread);
  }

  async getThread(id) {
    const thread = await this.metadataStore.getThread(id);
    return publicThread(thread);
  }

  async getTurn(id) {
    const turn = await this.metadataStore.getTurn(id);
    return publicTurn(turn);
  }

  async listTurns(filter = {}) {
    return (await this.metadataStore.listTurns(filter)).map(publicTurn);
  }

  async getItems(filter = {}) {
    return await this.metadataStore.listItems(filter);
  }

  async getTurnEvents(turnId, options = {}) {
    return await this.metadataStore.listTurnEvents(turnId, options);
  }

  isTurnTracked(id = '') {
    const turnId = clean(id);
    return Boolean(turnId && (this.controllers.has(turnId) || this.running === turnId || this.queue.includes(turnId)));
  }

  async recordTurnEvent(turnId, type, data = {}) {
    await this.ready;
    if (!turnId) throw new Error('No turn id provided for event recording');
    return await this.#record(turnId, type, data);
  }

  async startTurn(input = {}, { idempotencyKey = '', confirmClientSelection = null } = {}) {
    await this.ready;
    if (idempotencyKey) {
      const existing = await this.metadataStore.getTurnByIdempotencyKey(idempotencyKey);
      if (existing) return { turn: publicTurn(existing), reused: true };
    }

    let threadId = clean(input.threadId || input.thread_id);
    if (!threadId) {
      const thread = await this.createThread({ title: input.title || input.projectName || 'ChatGPT bridge thread', cwd: input.cwd, sessionId: input.sessionId });
      threadId = thread.id;
    }
    const thread = await this.metadataStore.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);

    const message = clean(input.message || input.prompt || textFromInput(input.input));
    const turnInput = {
      input: normalizeInputParts(input.input || message),
      message,
      cwd: clean(input.cwd || thread.cwd),
      model: clean(input.model),
      effort: clean(input.effort || input.reasoning_effort),
      attachments: normalizeAttachments(input.attachments || input.fileIds),
      sessionId: clean(input.sessionId || input.conversationId || thread.sessionId),
      sessionPolicy: clean(input.sessionPolicy) || (input.newSession ? 'new_per_turn' : 'reuse'),
      sourceClientId: clean(input.sourceClientId || input.clientId),
      project: input.project && typeof input.project === 'object' ? input.project : null,
      output: input.output && typeof input.output === 'object' ? input.output : { expected: clean(input.outputFormat) || 'text', required: false },
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    };
    if (!turnInput.message) throw new Error('No turn input message provided');

    const turn = await this.metadataStore.createTurn({
      id: input.id || compactId('turn'),
      threadId,
      idempotencyKey,
      status: 'queued',
      input: turnInput,
    });
    await this.metadataStore.createItem({
      id: compactId('item'),
      threadId,
      turnId: turn.id,
      type: 'user_message',
      status: 'completed',
      content: { text: turnInput.message, input: turnInput.input, attachments: turnInput.attachments },
    });
    await this.#record(turn.id, 'turn/queued', { threadId, turnId: turn.id });
    if (typeof confirmClientSelection === 'function') this.runtimeOptions.set(turn.id, { confirmClientSelection });
    this.queue.push(turn.id);
    this.#pump();
    return { turn: publicTurn(turn), reused: false };
  }

  async cancelTurn(id, reason = 'Interrupted by client') {
    const turn = await this.metadataStore.getTurn(id);
    if (!turn) return null;
    if (['completed', 'completed_without_artifact', 'failed', 'interrupted', 'cancelled'].includes(turn.status)) return publicTurn(turn);
    const controller = this.controllers.get(id);
    if (controller && !controller.signal.aborted) controller.abort(reason);
    if (this.running === id) this.bridge.cancelActive(reason);
    this.queue = this.queue.filter((turnId) => turnId !== id);
    this.runtimeOptions.delete(id);
    const status = reason.toLowerCase().includes('cancel') ? 'cancelled' : 'interrupted';
    const updated = await this.metadataStore.updateTurn(id, { status, completedAt: nowIso(), error: { code: status === 'cancelled' ? 'TURN_CANCELLED' : 'TURN_INTERRUPTED', message: reason } });
    await this.#record(id, status === 'cancelled' ? 'turn/cancelled' : 'turn/interrupted', { reason });
    this.#pump();
    return publicTurn(updated);
  }

  async recoverTurnFromLatestResponse(id = '', options = {}) {
    return await recoverTurnFromLatestResponse(this.#recoveryRuntime(), id, options);
  }

  async resumeActiveTurn(id = '', options = {}) {
    return await resumeActiveTurn(this.#recoveryRuntime(), id, options);
  }

  #recoveryRuntime() {
    return {
      ready: this.ready,
      bridge: this.bridge,
      metadataStore: this.metadataStore,
      controllers: this.controllers,
      getRunning: () => this.running,
      setRunning: (value) => { this.running = value; },
      pump: () => this.#pump(),
      record: (turnId, type, data) => this.#record(turnId, type, data),
      createAdoptedRecoveryTurn: (options) => this.#createAdoptedRecoveryTurn(options),
      resolveExpectedOutput: (turnId, output, response, extra) => this.#resolveExpectedOutput(turnId, output, response, extra),
      completionStatusForResult: (result) => this.#completionStatusForResult(result),
    };
  }

  #pump() {
    if (this.running || this.queue.length === 0) return;
    const turnId = this.queue.shift();
    this.running = turnId;
    this.#runTurn(turnId).finally(() => {
      this.running = null;
      this.#pump();
    });
  }

  async #runTurn(turnId) {
    let turn = await this.metadataStore.getTurn(turnId);
    if (!turn || turn.status !== 'queued') return;
    const thread = await this.metadataStore.getThread(turn.threadId);
    const controller = new AbortController();
    const runtimeOptions = this.runtimeOptions.get(turnId) || {};
    this.controllers.set(turnId, controller);
    const startedAt = nowIso();
    turn = await this.metadataStore.updateTurn(turnId, { status: 'running', startedAt });
    await this.#record(turnId, 'turn/started', { threadId: turn.threadId, turnId });

    const artifactItemIds = new Map();
    const callbackTasks = [];
    let normalDoneReceived = false;
    let normalPipelineStarted = false;
    const answerWriter = createAgentMessageWriter({
      metadataStore: this.metadataStore,
      threadId: turn.threadId,
      turnId,
      record: (type, data) => this.#record(turnId, type, data),
    });
    const reasoningTracker = new VisibleProgressTracker({
      metadataStore: this.metadataStore,
      threadId: turn.threadId,
      turnId,
      createId: () => compactId('item'),
      record: (type, data) => this.#record(turnId, type, data),
    });

    try {
      const req = { ...(turn.input || {}) };
      let projectPack = null;
      if (req.project?.mode === 'package' || req.project?.package === true) {
        if (!this.projectService) throw new Error('Project packaging is not available in this server instance');
        const cwd = req.cwd || thread?.cwd || req.project.cwd || '';
        await this.#record(turnId, 'project/scanStarted', { cwd });
        projectPack = await this.projectService.pack(cwd, {
          threadId: turn.threadId,
          skills: req.project.skills || [],
          useGitignore: req.project.useGitignore !== false,
          snapshotPolicy: req.project.snapshotPolicy || 'reuse-if-unchanged',
          force: Boolean(req.project.force),
        });
        await this.#record(turnId, 'project/scanCompleted', {
          cwd,
          snapshotId: projectPack.snapshotId,
          files: projectPack.scan.files.length,
          ignored: projectPack.scan.ignored.length,
          totalBytes: projectPack.scan.totalBytes,
        });
        await this.#record(turnId, 'project/packageCreated', {
          snapshotId: projectPack.snapshotId,
          fileId: projectPack.file?.id || '',
          name: projectPack.file?.name || '',
          size: projectPack.file?.size || 0,
          attached: projectPack.shouldAttach,
          reused: projectPack.alreadyUploaded,
        });
        req.message = this.projectService.buildTaskMessage({ message: req.message, pack: projectPack });
        req.attachments = [...(req.attachments || []), ...(projectPack.attachmentIds || [])];
        req.output = req.output || { expected: 'zip', required: true };
      }

      const newSession = req.sessionPolicy === 'new_per_turn' || req.sessionPolicy === 'new';
      const response = await this.bridge.sendRequest({
        requestId: turnId,
        message: req.message,
        attachments: req.attachments || [],
        model: req.model || '',
        effort: req.effort || '',
        sessionId: newSession ? '' : req.sessionId || thread?.sessionId || '',
        newSession,
        output: req.output || { expected: 'text', required: false },
        sourceClientId: req.sourceClientId || '',
        autoOpenTab: typeof req.autoOpenTab === 'boolean' ? req.autoOpenTab : undefined,
        captureDomTimeline: Boolean(req.captureDomTimeline || req.metadata?.captureDomTimeline),
      }, {
        onEvent: (event) => this.#record(turnId, event.type || 'chat/event', event),
        onThinkingUpdate: (text, payload) => trackAsync(callbackTasks, reasoningTracker.updateThinking(text, payload)),
        onProgressUpdate: (_text, payload) => trackAsync(callbackTasks, reasoningTracker.updateItems(payload?.items || payload?.progressItems || [], payload)),
        onAnswerUpdate: (text) => trackAsync(callbackTasks, answerWriter.update(text)),
        onArtifactUpdate: (artifacts) => trackAsync(callbackTasks, (async () => {
          for (const artifact of artifacts || []) {
            if (!artifact?.id || artifactItemIds.has(artifact.id)) continue;
            const item = await this.metadataStore.createItem({ id: compactId('item'), threadId: turn.threadId, turnId, type: 'artifact', status: 'completed', artifactId: artifact.id, content: { artifact } });
            artifactItemIds.set(artifact.id, item.id);
            await this.#record(turnId, 'item/artifact/created', { item, artifact });
          }
        })()),
      }, { signal: controller.signal, fullResponse: true, confirmClientSelection: runtimeOptions.confirmClientSelection });

      await drainTrackedAsync(callbackTasks);
      await this.#record(turn.id, 'normal.done.received', {
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
      if (response.session?.id) await this.metadataStore.updateThread(turn.threadId, { sessionId: response.session.id });
      if (projectPack?.shouldAttach && projectPack.file?.id) {
        await this.projectService.markSnapshotUploaded({
          cwd: projectPack.scan.root,
          projectId: projectPack.project.id,
          threadId: turn.threadId,
          snapshotId: projectPack.snapshotId,
          fileId: projectPack.file.id,
          sha256: projectPack.sha256 || projectPack.zip?.sha256 || '',
          source: 'attached',
        }).catch(() => null);
      }

      const output = turn.input?.output || {};
      await this.#record(turnId, 'normal.pipeline.started', {
        requestId: response.requestId || response.id || turnId,
        expected: output.expected || output.format || '',
        required: Boolean(output.required),
        artifactCount: Array.isArray(response.artifacts) ? response.artifacts.length : 0,
        sourceClientId: response.sourceClientId || '',
      });
      normalPipelineStarted = true;
      const result = await this.#resolveExpectedOutput(turnId, output, response);
      if (projectPack?.threadId && result?.type === 'zip' && result.sha256 && projectPack.sha256 && result.sha256 === projectPack.sha256) {
        await this.projectService.markSnapshotUploaded({
          cwd: projectPack.scan.root,
          projectId: projectPack.project.id,
          threadId: turn.threadId,
          snapshotId: projectPack.snapshotId,
          fileId: projectPack.file?.id || '',
          sha256: projectPack.sha256,
          source: 'assistant-artifact-same-as-snapshot',
        }).catch(() => null);
        await this.#record(turnId, 'project/packageReusedFromAssistantArtifact', { snapshotId: projectPack.snapshotId, sha256: projectPack.sha256 });
      }
      const completionStatus = this.#completionStatusForResult(result);
      const updated = await this.metadataStore.updateTurn(turnId, { status: completionStatus, completedAt: nowIso(), output: result, error: null });
      await this.#record(turnId, completionStatus === 'completed_without_artifact' ? 'turn/completed_without_artifact' : 'turn/completed', { turn: updated, output: result });
    } catch (err) {
      if (normalDoneReceived && !normalPipelineStarted) {
        await this.#record(turnId, 'normal.pipeline.missing_after_done', { message: err.message || String(err), recoverable: true });
      } else if (normalPipelineStarted) {
        await this.#record(turnId, 'normal.pipeline.failed', { message: err.message || String(err), code: err.code || '', recoverable: true });
      }
      const code = err.name === 'AbortError' ? 'TURN_INTERRUPTED' : err.code || 'TURN_FAILED';
      const status = code === 'TURN_INTERRUPTED' ? 'interrupted' : 'failed';
      const error = { code, message: err.message || String(err), recoverable: status !== 'interrupted', ...(err.extra ? { extra: err.extra } : {}) };
      const updated = await this.metadataStore.updateTurn(turnId, { status, completedAt: nowIso(), error });
      await this.#record(turnId, status === 'interrupted' ? 'turn/interrupted' : 'turn/failed', { turn: updated, error });
    } finally {
      this.controllers.delete(turnId);
      this.runtimeOptions.delete(turnId);
    }
  }

  async #createAdoptedRecoveryTurn(options = {}) {
    const cwd = clean(options.cwd || options.projectRoot);
    const sessionId = clean(options.sessionId || options.conversationId);
    let threadId = clean(options.threadId);
    let thread = threadId ? await this.metadataStore.getThread(threadId) : null;
    if (!thread) {
      thread = await this.metadataStore.createThread({
        id: compactId('thread'),
        title: cwd ? `Recovered ${cwd.split(/[\/]/).filter(Boolean).pop() || 'project'} response` : 'Recovered ChatGPT response',
        cwd,
        sessionId,
        metadata: { recovered: true, adoptedRecovery: true },
      });
      threadId = thread.id;
    }

    const index = Math.max(1, Number(options.index) || 1);
    const output = options.output && typeof options.output === 'object'
      ? options.output
      : (options.expectedOutput && typeof options.expectedOutput === 'object' ? options.expectedOutput : { expected: 'text', required: false });
    const message = clean(options.message) || `Recovered visible assistant response #${index}`;
    const turn = await this.metadataStore.createTurn({
      id: compactId('turn'),
      threadId,
      status: 'recovering',
      startedAt: nowIso(),
      input: {
        input: [{ type: 'text', text: message }],
        message,
        cwd,
        sessionId,
        sessionPolicy: 'reuse',
        project: options.project && typeof options.project === 'object' ? options.project : null,
        output,
        metadata: { recovered: true, adoptedRecovery: true, candidateIndex: index },
      },
    });
    await this.metadataStore.createItem({
      id: compactId('item'),
      threadId,
      turnId: turn.id,
      type: 'user_message',
      status: 'completed',
      content: { text: message, recovered: true, adoptedRecovery: true },
    });
    await this.#record(turn.id, 'turn/recovery.adopted', { turnId: turn.id, threadId, cwd, sessionId, index, output });
    return turn;
  }

  async #resolveExpectedOutput(turnId, output = {}, response = {}, extra = {}) {
    const expected = clean(output.expected || output.format);
    if (!(expected === 'zip' || output.required)) {
      return { type: 'text', answer: response.answer || '', artifacts: response.artifacts || [], response };
    }

    await this.#record(turnId, 'result/resolving', { expected: expected || 'zip', ...extra });
    try {
      return await this.resultResolver.resolve({
        id: turnId,
        request: { output: { ...output, downloadUrl: `/turns/${turnId}/result/download` } },
      }, response, {
        onEvent: (type, data) => this.#record(turnId, type, data),
      });
    } catch (err) {
      if (err.code !== 'EXPECTED_ZIP_ARTIFACT_NOT_FOUND') throw err;
      const result = {
        type: 'text',
        status: 'missing_required_artifact',
        expected: expected || 'zip',
        answer: response.answer || response.response || '',
        text: response.answer || response.response || '',
        artifacts: Array.isArray(response.artifacts) ? response.artifacts : [],
        response,
        error: { code: err.code, message: err.message || String(err), recoverable: true, ...(err.extra ? { extra: err.extra } : {}) },
      };
      await this.#record(turnId, 'result/missing_required_artifact', {
        expected: result.expected,
        answerLength: String(result.answer || '').length,
        artifactCount: result.artifacts.length,
        message: err.message || String(err),
        ...extra,
      });
      return result;
    }
  }

  #completionStatusForResult(result = {}) {
    return result.status === 'missing_required_artifact' ? 'completed_without_artifact' : 'completed';
  }

  async #record(turnId, type, data = {}) {
    const event = await this.metadataStore.addTurnEvent(turnId, { type, data });
    this.emit(`turn:${turnId}`, event);
    this.emit('turn:event', { turnId, event });
    this.eventBus?.emitUser({ type, requestId: turnId, data: { turnId, ...data } });
    this.#notify(type, { turnId, ...data, event });
    return event;
  }

  #notify(method, params = {}) {
    this.emit('notification', { method, params });
  }
}
