import { EventEmitter } from 'node:events';
import { makeRequestId } from './protocol.js';

function nowIso() { return new Date().toISOString(); }
function cleanString(value) { return typeof value === 'string' ? value.trim() : ''; }
function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item : item?.id || item?.fileId || '')).filter(Boolean);
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    idempotencyKey: job.idempotencyKey || '',
    request: job.request,
    response: job.response,
    result: job.result,
    error: job.error,
  };
}

export class JobManager extends EventEmitter {
  constructor({ bridge, fileStore, metadataStore, resultResolver, eventBus }) {
    super();
    this.bridge = bridge;
    this.fileStore = fileStore;
    this.metadataStore = metadataStore;
    this.resultResolver = resultResolver;
    this.eventBus = eventBus;
    this.queue = [];
    this.running = null;
    this.controllers = new Map();
    this.ready = metadataStore.ready;
  }

  async createJob(input = {}, { idempotencyKey = '' } = {}) {
    await this.ready;
    if (idempotencyKey) {
      const existing = await this.metadataStore.getJobByIdempotencyKey(idempotencyKey);
      if (existing) return { job: publicJob(existing), reused: true };
    }

    const job = await this.metadataStore.createJob({
      id: `job_${makeRequestId().replace(/[^a-zA-Z0-9_-]/g, '')}`,
      idempotencyKey,
      type: input.type || 'chat',
      status: 'queued',
      request: this.#normalizeJobRequest(input),
    });
    await this.#record(job.id, 'job.created', { type: job.type, idempotencyKey });
    this.queue.push(job.id);
    this.#pump();
    return { job: publicJob(job), reused: false };
  }

  async createProjectJob(input = {}, { idempotencyKey = '' } = {}) {
    const projectName = cleanString(input.projectName) || cleanString(input.name) || 'project';
    const inputFileId = cleanString(input.inputFileId) || cleanString(input.fileId) || cleanString(input.projectFileId);
    const extraAttachments = normalizeAttachments(input.attachments);
    const attachments = [...new Set([inputFileId, ...extraAttachments].filter(Boolean))];
    const userMessage = cleanString(input.message) || cleanString(input.instructions) || 'Review and update the attached project.';
    const prompt = makeProjectPrompt({ projectName, userMessage, output: input.result || input.output || {} });
    return await this.createJob({
      type: 'project_zip',
      message: prompt,
      attachments,
      model: input.model,
      effort: input.effort || input.reasoning_effort,
      sessionId: input.sessionId || input.conversationId,
      sessionPolicy: input.sessionPolicy || 'new_per_job',
      output: {
        expected: 'zip',
        required: true,
        ...(input.result || input.output || {}),
      },
      metadata: {
        projectName,
        userMessage,
        inputFileId,
      },
    }, { idempotencyKey });
  }

  async listJobs(filter = {}) {
    const jobs = await this.metadataStore.listJobs(filter);
    return jobs.map(publicJob);
  }

  async getJob(id) {
    return publicJob(await this.metadataStore.getJob(id));
  }

  async getJobEvents(id, options = {}) {
    return await this.metadataStore.listJobEvents(id, options);
  }

  async cancelJob(id, reason = 'Cancelled by API client') {
    const job = await this.metadataStore.getJob(id);
    if (!job) return null;
    if (['done', 'failed', 'cancelled'].includes(job.status)) return publicJob(job);

    const controller = this.controllers.get(id);
    if (controller && !controller.signal.aborted) controller.abort(reason);
    if (this.running === id) this.bridge.cancelActive(reason);
    this.queue = this.queue.filter((queuedId) => queuedId !== id);
    const updated = await this.metadataStore.updateJob(id, { status: 'cancelled', finishedAt: nowIso(), error: { code: 'JOB_CANCELLED', message: reason } });
    await this.#record(id, 'job.cancelled', { reason });
    this.#pump();
    return publicJob(updated);
  }

  async getResult(id) {
    const job = await this.metadataStore.getJob(id);
    return job?.result || null;
  }

  async getResultDownload(id) {
    const job = await this.metadataStore.getJob(id);
    const downloadId = job?.result?.downloadId;
    if (!downloadId) return null;
    return await this.metadataStore.getDownload(downloadId);
  }

  #pump() {
    if (this.running || this.queue.length === 0) return;
    const jobId = this.queue.shift();
    this.running = jobId;
    this.#runJob(jobId).finally(() => {
      this.running = null;
      this.#pump();
    });
  }

  async #runJob(jobId) {
    let job = await this.metadataStore.getJob(jobId);
    if (!job || job.status !== 'queued') return;

    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    job = await this.metadataStore.updateJob(jobId, { status: 'running', startedAt: nowIso() });
    await this.#record(jobId, 'job.started', { type: job.type });

    try {
      const request = this.#bridgeRequestFromJob(job);
      await this.#record(jobId, 'request.started', { messageLength: request.message.length, attachments: request.attachments, output: job.request.output || {} });
      const response = await this.bridge.sendRequest(request, {
        onEvent: (event) => this.#record(jobId, event.type || 'chat.event', event),
        onThinkingUpdate: (thinking) => this.#record(jobId, 'thinking.snapshot', { chars: thinking.length }),
        onAnswerUpdate: (answer) => this.#record(jobId, 'answer.snapshot', { chars: answer.length }),
        onArtifactUpdate: (artifacts) => this.#record(jobId, 'artifact.snapshot', { count: artifacts.length, artifacts }),
      }, { signal: controller.signal, fullResponse: true });

      await this.#record(jobId, 'result.resolving', { expected: job.request.output?.expected || job.request.output?.format || 'text' });
      const freshJob = await this.metadataStore.getJob(jobId);
      const result = await this.resultResolver.resolve(freshJob || job, response);
      const updated = await this.metadataStore.updateJob(jobId, { status: 'done', finishedAt: nowIso(), response, result, error: null });
      await this.#record(jobId, 'job.done', { result: updated.result });
    } catch (err) {
      const code = err.code || (err.name === 'AbortError' ? 'JOB_CANCELLED' : 'JOB_FAILED');
      const status = code === 'JOB_CANCELLED' ? 'cancelled' : 'failed';
      const error = { code, message: err.message || String(err), recoverable: status !== 'cancelled', ...(err.extra ? { extra: err.extra } : {}) };
      await this.metadataStore.updateJob(jobId, { status, finishedAt: nowIso(), error });
      await this.#record(jobId, status === 'cancelled' ? 'job.cancelled' : 'job.failed', error);
    } finally {
      this.controllers.delete(jobId);
    }
  }

  #normalizeJobRequest(input) {
    const output = input.output || input.result || {};
    return {
      message: cleanString(input.message) || cleanString(input.prompt),
      attachments: normalizeAttachments(input.attachments || input.fileIds),
      model: cleanString(input.model),
      effort: cleanString(input.effort || input.reasoning_effort),
      sessionId: cleanString(input.sessionId || input.conversationId),
      sourceClientId: cleanString(input.sourceClientId || input.clientId),
      autoOpenTab: typeof input.autoOpenTab === 'boolean'
        ? input.autoOpenTab
        : typeof input.auto_open_tab === 'boolean'
          ? input.auto_open_tab
          : undefined,
      sessionPolicy: cleanString(input.sessionPolicy) || (input.newSession ? 'new_per_job' : 'reuse'),
      output: {
        expected: cleanString(output.expected || output.format) || 'text',
        required: output.required !== false,
        ...output,
      },
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    };
  }

  #bridgeRequestFromJob(job) {
    const req = job.request || {};
    const newSession = req.sessionPolicy === 'new_per_job' || req.sessionPolicy === 'new';
    return {
      requestId: job.id,
      message: req.message,
      attachments: req.attachments || [],
      model: req.model || '',
      effort: req.effort || '',
      sessionId: newSession ? '' : req.sessionId || '',
      newSession,
      sourceClientId: req.sourceClientId || '',
      autoOpenTab: typeof req.autoOpenTab === 'boolean' ? req.autoOpenTab : undefined,
    };
  }

  async #record(jobId, type, data = {}) {
    const event = await this.metadataStore.addJobEvent(jobId, { type, data });
    this.emit(`job:${jobId}`, event);
    this.eventBus?.emitUser({ type, requestId: data.requestId || '', sessionId: data.sessionId || '', data: { jobId, ...data } });
    return event;
  }
}

export function makeProjectPrompt({ projectName, userMessage }) {
  return `You are modifying a small software project provided as an attached ZIP archive.

Project: ${projectName}

User request:
${userMessage}

Workflow requirements:
1. Inspect the attached ZIP and modify only the project files that are necessary for the request.
2. Preserve the original project structure. Do not include node_modules, .git, dist, build caches, OS metadata, or unrelated generated files.
3. Return the completed result as a downloadable ZIP artifact.
4. The ZIP should contain the updated project files, not a nested explanation-only document.
5. Include a short summary of what changed in the chat response.
6. If you cannot create a downloadable ZIP artifact, clearly say that no ZIP artifact could be created and explain why.
`;
}
