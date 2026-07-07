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

  async startTurn(input = {}, { idempotencyKey = '' } = {}) {
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
    this.queue.push(turn.id);
    this.#pump();
    return { turn: publicTurn(turn), reused: false };
  }

  async cancelTurn(id, reason = 'Interrupted by client') {
    const turn = await this.metadataStore.getTurn(id);
    if (!turn) return null;
    if (['completed', 'failed', 'interrupted', 'cancelled'].includes(turn.status)) return publicTurn(turn);
    const controller = this.controllers.get(id);
    if (controller && !controller.signal.aborted) controller.abort(reason);
    if (this.running === id) this.bridge.cancelActive(reason);
    this.queue = this.queue.filter((turnId) => turnId !== id);
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
      const candidates = await this.metadataStore.listTurns({ limit: 20 });
      turn = candidates.find((item) => ['running', 'failed', 'interrupted', 'cancelled'].includes(item.status)) || candidates[0] || null;
    }
    if (!turn) throw new Error('No turn is available for recovery');
    if (turn.status === 'completed' && !options.force) return publicTurn(turn);

    const thread = await this.metadataStore.getThread(turn.threadId);
    await this.#record(turn.id, 'turn/recovery.started', { turnId: turn.id, status: turn.status, source: 'assistant-turn', index: options.index || 1 });

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

    let result = { type: 'text', answer: response.answer || '', artifacts: response.artifacts || [], response };
    const output = turn.input?.output || {};
    const expected = clean(output.expected || output.format);
    if (expected === 'zip' || output.required) {
      await this.#record(turn.id, 'result/resolving', { expected: expected || 'zip', recovered: true });
      result = await this.resultResolver.resolve({ id: turn.id, request: { output: { ...output, downloadUrl: `/turns/${turn.id}/result/download` } } }, response);
    }

    const updated = await this.metadataStore.updateTurn(turn.id, { status: 'completed', completedAt: nowIso(), output: result, error: null });
    await this.#record(turn.id, 'turn/recovered', { turn: updated, output: result, source: response.source || 'latest-assistant-turn' });
    await this.#record(turn.id, 'turn/completed', { turn: updated, output: result, recovered: true });
    return publicTurn(updated);
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
    this.controllers.set(turnId, controller);
    const startedAt = nowIso();
    turn = await this.metadataStore.updateTurn(turnId, { status: 'running', startedAt });
    await this.#record(turnId, 'turn/started', { threadId: turn.threadId, turnId });

    let reasoningItemId = '';
    let messageItemId = '';
    const artifactItemIds = new Map();

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
      }, {
        onEvent: (event) => this.#record(turnId, event.type || 'chat/event', event),
        onThinkingUpdate: async (text) => {
          reasoningItemId = await ensureItem('reasoning', reasoningItemId, { text: '' });
          await this.metadataStore.updateItem(reasoningItemId, { status: 'in_progress', content: { text } });
          await this.#record(turnId, 'item/reasoning/delta', { itemId: reasoningItemId, text, chars: text.length });
        },
        onAnswerUpdate: async (text) => {
          messageItemId = await ensureItem('agent_message', messageItemId, { text: '' });
          await this.metadataStore.updateItem(messageItemId, { status: 'in_progress', content: { text } });
          await this.#record(turnId, 'item/agentMessage/delta', { itemId: messageItemId, text, chars: text.length });
        },
        onArtifactUpdate: async (artifacts) => {
          for (const artifact of artifacts || []) {
            if (!artifact?.id || artifactItemIds.has(artifact.id)) continue;
            const item = await this.metadataStore.createItem({ id: compactId('item'), threadId: turn.threadId, turnId, type: 'artifact', status: 'completed', artifactId: artifact.id, content: { artifact } });
            artifactItemIds.set(artifact.id, item.id);
            await this.#record(turnId, 'item/artifact/created', { item, artifact });
          }
        },
      }, { signal: controller.signal, fullResponse: true });

      if (reasoningItemId) {
        await this.metadataStore.updateItem(reasoningItemId, { status: 'completed', content: { text: response.thinking || '' } });
        await this.#record(turnId, 'item/reasoning/completed', { itemId: reasoningItemId });
      }
      if (messageItemId) {
        await this.metadataStore.updateItem(messageItemId, { status: 'completed', content: { text: response.answer || '' } });
        await this.#record(turnId, 'item/agentMessage/completed', { itemId: messageItemId });
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

      let result = { type: 'text', answer: response.answer || '', artifacts: response.artifacts || [], response };
      const output = turn.input?.output || {};
      const expected = clean(output.expected || output.format);
      if (expected === 'zip' || output.required) {
        await this.#record(turnId, 'result/resolving', { expected: expected || 'zip' });
        result = await this.resultResolver.resolve({ id: turnId, request: { output: { ...output, downloadUrl: `/turns/${turnId}/result/download` } } }, response);
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
      }
      const updated = await this.metadataStore.updateTurn(turnId, { status: 'completed', completedAt: nowIso(), output: result, error: null });
      await this.#record(turnId, 'turn/completed', { turn: updated, output: result });
    } catch (err) {
      const code = err.name === 'AbortError' ? 'TURN_INTERRUPTED' : err.code || 'TURN_FAILED';
      const status = code === 'TURN_INTERRUPTED' || code === 'JOB_CANCELLED' ? 'interrupted' : 'failed';
      const error = { code, message: err.message || String(err), recoverable: status !== 'interrupted', ...(err.extra ? { extra: err.extra } : {}) };
      const updated = await this.metadataStore.updateTurn(turnId, { status, completedAt: nowIso(), error });
      await this.#record(turnId, status === 'interrupted' ? 'turn/interrupted' : 'turn/failed', { turn: updated, error });
    } finally {
      this.controllers.delete(turnId);
    }
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
