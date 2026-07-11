import { EventEmitter } from 'node:events';
import { makeRequestId } from './protocol.js';

function nowIso() { return new Date().toISOString(); }
function clean(value) { return typeof value === 'string' ? value.trim() : ''; }
function compactId(prefix) { return `${prefix}_${makeRequestId().replace(/[^a-zA-Z0-9_-]/g, '')}`; }
function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item : item?.id || item?.fileId || '')).filter(Boolean);
}
function normalizeInputParts(input) {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object') return [input];
  return [];
}
function textFromInput(input) {
  const parts = normalizeInputParts(input);
  return parts.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text') return part.text || '';
    if (typeof part?.text === 'string') return part.text;
    if (typeof part?.content === 'string') return part.content;
    return '';
  }).filter(Boolean).join('\n').trim();
}
function publicThread(thread) { return thread ? { ...thread } : null; }
function publicTurn(turn) { return turn ? { ...turn } : null; }
function trackAsync(list, task) {
  if (!task || typeof task.then !== 'function') return task;
  const tracked = Promise.resolve(task);
  list.push(tracked);
  return tracked;
}
async function drainTrackedAsync(list) {
  while (list.length) {
    const batch = list.splice(0, list.length);
    await Promise.all(batch);
  }
}

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
    await this.ready;
    let turn = id ? await this.metadataStore.getTurn(id) : null;
    if (!turn) {
      const listFilter = options.threadId ? { threadId: clean(options.threadId), limit: 20 } : { limit: 20 };
      const candidates = await this.metadataStore.listTurns(listFilter);
      turn = candidates.find((item) => ['running', 'failed', 'interrupted', 'cancelled'].includes(item.status)) || candidates[0] || null;
    }
    if (!turn && options.allowAdoptedTurn) {
      turn = await this.#createAdoptedRecoveryTurn(options);
    }
    if (!turn) throw new Error('No turn is available for recovery');

    const source = turn.input?.metadata?.adoptedRecovery ? 'visible-assistant-response' : 'assistant-turn';
    await this.#record(turn.id, 'turn/recovery.started', { turnId: turn.id, status: turn.status, source, index: options.index || 1 });

    const response = await this.bridge.recoverLatestResponse({ requestId: turn.id, index: options.index || 1, timeoutMs: options.timeoutMs || 30_000 });

    if (response.thinking) {
      const item = await this.metadataStore.createItem({ id: compactId('item'), threadId: turn.threadId, turnId: turn.id, type: 'reasoning', status: 'completed', content: { text: response.thinking, recovered: true } });
      await this.#record(turn.id, 'item/reasoning/recovered', { itemId: item.id, chars: response.thinking.length });
    }
    if (response.answer) {
      const item = await this.metadataStore.createItem({ id: compactId('item'), threadId: turn.threadId, turnId: turn.id, type: 'agent_message', status: 'completed', content: { text: response.answer, recovered: true } });
      await this.#record(turn.id, 'item/agentMessage/recovered', { itemId: item.id, chars: response.answer.length });
    }
    for (const artifact of response.artifacts || []) {
      if (!artifact?.id) continue;
      const item = await this.metadataStore.createItem({ id: compactId('item'), threadId: turn.threadId, turnId: turn.id, type: 'artifact', status: 'completed', artifactId: artifact.id, content: { artifact, recovered: true } });
      await this.#record(turn.id, 'item/artifact/recovered', { itemId: item.id, artifact });
    }

    if (response.session?.id) await this.metadataStore.updateThread(turn.threadId, { sessionId: response.session.id });

    const output = turn.input?.output || {};
    await this.#record(turn.id, 'recovery.pipeline.started', {
      requestId: response.requestId || response.id || turn.id,
      expected: output.expected || output.format || '',
      required: Boolean(output.required),
      artifactCount: Array.isArray(response.artifacts) ? response.artifacts.length : 0,
      sourceClientId: response.sourceClientId || '',
    });
    let result;
    try {
      result = await this.#resolveExpectedOutput(turn.id, { ...output, forceArtifactDownload: Boolean(options.force) }, response, { recovered: true });
    } catch (err) {
      await this.#record(turn.id, 'recovery.pipeline.failed', { message: err.message || String(err), code: err.code || '', recoverable: true });
      throw err;
    }

    const completionStatus = this.#completionStatusForResult(result);
    const updated = await this.metadataStore.updateTurn(turn.id, { status: completionStatus, completedAt: nowIso(), output: result, error: null });
    await this.#record(turn.id, 'turn/recovered', { turn: updated, output: result, source: response.source || 'latest-assistant-turn' });
    await this.#record(turn.id, completionStatus === 'completed_without_artifact' ? 'turn/completed_without_artifact' : 'turn/completed', { turn: updated, output: result, recovered: true });
    return publicTurn(updated);
  }

  async resumeActiveTurn(id = '', options = {}) {
    await this.ready;
    const target = typeof this.bridge.findActiveRequest === 'function'
      ? this.bridge.findActiveRequest({ preferredRequestId: id })
      : null;
    const activeRequest = target?.activeRequest || this.bridge.health().activeClient?.activeRequest || null;
    if (!activeRequest?.requestId) throw new Error('No active ChatGPT prompt is running in any connected tab.');

    let turn = id ? await this.metadataStore.getTurn(id) : null;
    if (!turn || turn.id !== activeRequest.requestId) {
      turn = await this.metadataStore.getTurn(activeRequest.requestId) || turn;
    }
    if (!turn || turn.id !== activeRequest.requestId) {
      const err = new Error(`Active prompt ${activeRequest.requestId} is not a known local project turn.`);
      err.code = 'NO_MATCHING_TURN';
      err.activeRequest = activeRequest;
      throw err;
    }
    if (['completed', 'completed_without_artifact', 'failed', 'interrupted', 'cancelled'].includes(turn.status)) {
      const err = new Error(`Turn ${turn.id} is already ${turn.status}. Use /recover if the browser has newer visible output.`);
      err.code = 'TURN_NOT_RUNNING';
      throw err;
    }
    if (this.controllers.has(turn.id)) throw new Error(`Turn ${turn.id} is already tracked locally.`);
    if (this.running && this.running !== turn.id) throw new Error(`Another turn is already running locally: ${this.running}`);

    const thread = await this.metadataStore.getThread(turn.threadId);
    const controller = new AbortController();
    this.controllers.set(turn.id, controller);
    const previousRunning = this.running;
    this.running = turn.id;
    const startedAt = turn.startedAt || nowIso();
    turn = await this.metadataStore.updateTurn(turn.id, { status: 'running', startedAt });
    await this.#record(turn.id, 'turn/resumed', { turnId: turn.id, activeRequest });

    let reasoningItemId = '';
    let messageItemId = '';
    const artifactItemIds = new Map();
    const callbackTasks = [];
    let normalDoneReceived = false;
    let normalPipelineStarted = false;

    const ensureItem = async (kind, currentId, content = {}) => {
      if (currentId) return currentId;
      const item = await this.metadataStore.createItem({ id: compactId('item'), threadId: turn.threadId, turnId: turn.id, type: kind, status: 'in_progress', content });
      await this.#record(turn.id, 'item/started', { item, resumed: true });
      return item.id;
    };

    try {
      const response = await this.bridge.resumeActiveRequest({
        onEvent: (event) => this.#record(turn.id, event.type || 'chat/event', event),
        onThinkingUpdate: (text) => trackAsync(callbackTasks, (async () => {
          reasoningItemId = await ensureItem('reasoning', reasoningItemId, { text: '' });
          await this.metadataStore.updateItem(reasoningItemId, { status: 'in_progress', content: { text } });
          await this.#record(turn.id, 'item/reasoning/delta', { itemId: reasoningItemId, text, chars: text.length, resumed: true });
        })()),
        onAnswerUpdate: (text) => trackAsync(callbackTasks, (async () => {
          messageItemId = await ensureItem('agent_message', messageItemId, { text: '' });
          await this.metadataStore.updateItem(messageItemId, { status: 'in_progress', content: { text } });
          await this.#record(turn.id, 'item/agentMessage/delta', { itemId: messageItemId, text, chars: text.length, resumed: true });
        })()),
        onArtifactUpdate: (artifacts) => trackAsync(callbackTasks, (async () => {
          for (const artifact of artifacts || []) {
            if (!artifact?.id || artifactItemIds.has(artifact.id)) continue;
            const item = await this.metadataStore.createItem({ id: compactId('item'), threadId: turn.threadId, turnId: turn.id, type: 'artifact', status: 'completed', artifactId: artifact.id, content: { artifact, resumed: true } });
            artifactItemIds.set(artifact.id, item.id);
            await this.#record(turn.id, 'item/artifact/created', { item, artifact, resumed: true });
          }
        })()),
      }, { signal: controller.signal, fullResponse: true, expectedRequestId: turn.id, sourceClientId: target?.clientId || options.sourceClientId || '', timeoutMs: options.timeoutMs || 10_000 });

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

      if (response.thinking || reasoningItemId) {
        reasoningItemId = await ensureItem('reasoning', reasoningItemId, { text: '' });
        await this.metadataStore.updateItem(reasoningItemId, { status: 'completed', content: { text: response.thinking || '' } });
        await this.#record(turn.id, 'item/reasoning/completed', { itemId: reasoningItemId, chars: String(response.thinking || '').length, resumed: true });
      }
      if (response.answer || messageItemId) {
        messageItemId = await ensureItem('agent_message', messageItemId, { text: '' });
        await this.metadataStore.updateItem(messageItemId, { status: 'completed', content: { text: response.answer || '' } });
        await this.#record(turn.id, 'item/agentMessage/completed', { itemId: messageItemId, chars: String(response.answer || '').length, resumed: true });
      }
      if (response.session?.id) await this.metadataStore.updateThread(turn.threadId, { sessionId: response.session.id });

      const output = turn.input?.output || {};
      await this.#record(turn.id, 'normal.pipeline.started', {
        requestId: response.requestId || response.id || turn.id,
        expected: output.expected || output.format || '',
        required: Boolean(output.required),
        artifactCount: Array.isArray(response.artifacts) ? response.artifacts.length : 0,
        sourceClientId: response.sourceClientId || '',
        resumed: true,
      });
      normalPipelineStarted = true;
      const result = await this.#resolveExpectedOutput(turn.id, output, response, { resumed: true });
      const completionStatus = this.#completionStatusForResult(result);
      const updated = await this.metadataStore.updateTurn(turn.id, { status: completionStatus, completedAt: nowIso(), output: result, error: null });
      await this.#record(turn.id, completionStatus === 'completed_without_artifact' ? 'turn/completed_without_artifact' : 'turn/completed', { turn: updated, output: result, resumed: true });
      return publicTurn(updated);
    } catch (err) {
      if (normalDoneReceived && !normalPipelineStarted) {
        await this.#record(turn.id, 'normal.pipeline.missing_after_done', { message: err.message || String(err), resumed: true, recoverable: true });
      } else if (normalPipelineStarted) {
        await this.#record(turn.id, 'normal.pipeline.failed', { message: err.message || String(err), code: err.code || '', resumed: true, recoverable: true });
      }
      const code = err.name === 'AbortError' ? 'TURN_INTERRUPTED' : err.code || 'TURN_FAILED';
      const status = code === 'TURN_INTERRUPTED' || code === 'JOB_CANCELLED' ? 'interrupted' : 'failed';
      const error = { code, message: err.message || String(err), recoverable: status !== 'interrupted', ...(err.extra ? { extra: err.extra } : {}) };
      const updated = await this.metadataStore.updateTurn(turn.id, { status, completedAt: nowIso(), error });
      await this.#record(turn.id, status === 'interrupted' ? 'turn/interrupted' : 'turn/failed', { turn: updated, error, resumed: true });
      throw err;
    } finally {
      this.controllers.delete(turn.id);
      this.running = previousRunning || null;
      this.#pump();
    }
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

    let reasoningItemId = '';
    let messageItemId = '';
    const artifactItemIds = new Map();
    const callbackTasks = [];
    let normalDoneReceived = false;
    let normalPipelineStarted = false;

    const ensureItem = async (kind, currentId, content = {}) => {
      if (currentId) return currentId;
      const item = await this.metadataStore.createItem({ id: compactId('item'), threadId: turn.threadId, turnId, type: kind, status: 'in_progress', content });
      await this.#record(turnId, 'item/started', { item });
      return item.id;
    };

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

      const newSession = req.sessionPolicy === 'new_per_turn' || req.sessionPolicy === 'new_per_job' || req.sessionPolicy === 'new';
      const response = await this.bridge.sendRequest({
        requestId: turnId,
        message: req.message,
        attachments: req.attachments || [],
        model: req.model || '',
        effort: req.effort || '',
        sessionId: newSession ? '' : req.sessionId || thread?.sessionId || '',
        newSession,
        output: req.output || { expected: 'text', required: false },
      }, {
        onEvent: (event) => this.#record(turnId, event.type || 'chat/event', event),
        onThinkingUpdate: (text) => trackAsync(callbackTasks, (async () => {
          reasoningItemId = await ensureItem('reasoning', reasoningItemId, { text: '' });
          await this.metadataStore.updateItem(reasoningItemId, { status: 'in_progress', content: { text } });
          await this.#record(turnId, 'item/reasoning/delta', { itemId: reasoningItemId, text, chars: text.length });
        })()),
        onAnswerUpdate: (text) => trackAsync(callbackTasks, (async () => {
          messageItemId = await ensureItem('agent_message', messageItemId, { text: '' });
          await this.metadataStore.updateItem(messageItemId, { status: 'in_progress', content: { text } });
          await this.#record(turnId, 'item/agentMessage/delta', { itemId: messageItemId, text, chars: text.length });
        })()),
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

      if (response.thinking || reasoningItemId) {
        reasoningItemId = await ensureItem('reasoning', reasoningItemId, { text: '' });
        await this.metadataStore.updateItem(reasoningItemId, { status: 'completed', content: { text: response.thinking || '' } });
        await this.#record(turnId, 'item/reasoning/completed', { itemId: reasoningItemId, chars: String(response.thinking || '').length });
      }
      if (response.answer || messageItemId) {
        messageItemId = await ensureItem('agent_message', messageItemId, { text: '' });
        await this.metadataStore.updateItem(messageItemId, { status: 'completed', content: { text: response.answer || '' } });
        await this.#record(turnId, 'item/agentMessage/completed', { itemId: messageItemId, chars: String(response.answer || '').length });
      }
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
      const status = code === 'TURN_INTERRUPTED' || code === 'JOB_CANCELLED' ? 'interrupted' : 'failed';
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
      }, response);
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
