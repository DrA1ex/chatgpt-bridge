import { randomBytes } from 'node:crypto';
import { AsyncMutex } from '../mutex.js';
import { log } from '../logger.js';

const TERMINAL = new Set(['completed', 'completed_without_artifact', 'failed', 'cancelled', 'interrupted']);
const TERMINAL_EVENTS = new Set([...TERMINAL].map(status => 'turn/' + status));
const concreteSession = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) && value !== 'new';

export function loopPrompt(prompt, marker, iteration = 1) {
  const task = iteration === 1 ? prompt : 'Continue the original task using the plan and results already recorded in this conversation.';
  return `${task}\n\n[Completion protocol]\nWork through the task in order and build on completed work. If work remains after this turn, report what you finished and what comes next. Only when the entire original task is complete, append this exact marker as the final standalone line, in plain text without Markdown formatting: ${marker}\nIf any work remains, omit the marker.`;
}

export function hasCompletionMarker(answer, marker) {
  const lines = String(answer || '').trimEnd().split(/\r?\n/);
  if (!marker || lines.pop() !== marker) return false;
  let fence = '';
  for (const line of lines) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;
    const [, delimiter, rest] = match;
    if (!fence) fence = delimiter;
    else if (delimiter[0] === fence[0] && delimiter.length >= fence.length && !rest.trim()) fence = '';
  }
  return !fence;
}

export class PromptLoopController {
  #loops = new Map();
  #mutex = new AsyncMutex();

  constructor({ turnManager, notify = () => {}, checkIntervalMs = 5_000, continuationDelayMs = 3_000 }) {
    this.turnManager = turnManager;
    this.notify = notify;
    this.checkIntervalMs = checkIntervalMs;
    this.continuationDelayMs = continuationDelayMs;
    turnManager?.on?.('notification', ({ method, params }) => {
      if (!TERMINAL_EVENTS.has(method)) return;
      void this.#mutex.runExclusive(async () => {
        const loop = [...this.#loops.values()].find(value => value.status === 'running' && value.turnId === params.turnId);
        if (loop) await this.#advance(loop);
      }).catch(error => log('Loop completion check failed', { turnId: params.turnId, message: error.message }));
    });
  }

  get(threadId) {
    const loop = this.#loops.get(threadId);
    if (!loop) return null;
    const { params, marker, timer, startKey, sourceClientId, ...status } = loop;
    return { ...status };
  }

  #publish(loop) {
    try { this.notify(this.get(loop.threadId)); }
    catch (error) { log('Loop status notification failed', { loopId: loop.id, message: error.message }); }
  }

  // Notifications are a fast path. Persisted turn status is authoritative
  // even when a notification is lost. The same mutex serializes both paths.
  #scheduleCheck(loop) {
    if (loop.status !== 'running' || loop.timer) return;
    loop.timer = setTimeout(() => {
      loop.timer = null;
      void this.#mutex.runExclusive(async () => {
        if (loop.status === 'running') await this.#advance(loop);
        this.#scheduleCheck(loop);
      }).catch(error => this.#finish(loop, 'failed', error.message || String(error)));
    }, loop.nextIterationAt ? Math.max(0, loop.nextIterationAt - Date.now()) : this.checkIntervalMs);
    loop.timer.unref?.();
  }

  #finish(loop, status, reason = '') {
    clearTimeout(loop.timer);
    loop.timer = null;
    loop.nextIterationAt = 0;
    loop.status = status;
    loop.reason = reason;
    log('Prompt loop stopped', { loopId: loop.id, turnId: loop.turnId, iteration: loop.iteration, status, reason });
    this.#publish(loop);
  }

  async start(params = {}) {
    if (!this.turnManager?.startTurn || !this.turnManager?.on) throw new Error('Prompt loops are unavailable in this server instance');
    return await this.#mutex.runExclusive(async () => {
      const startKey = String(params.idempotencyKey || '');
      if (startKey) {
        const existing = [...this.#loops.values()].find(loop => loop.startKey === startKey);
        if (existing) return { loop: this.get(existing.threadId), turn: await this.turnManager.getTurn(existing.turnId) };
      }
      const prompt = String(params.message || '').trim();
      if (!prompt) throw new Error('Loop prompt is empty');
      const maxIterations = Number(params.maxIterations ?? 50);
      if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 500) throw new Error('Loop limit must be between 1 and 500');

      const requestedThread = params.threadId || params.thread_id;
      const thread = requestedThread
        ? await this.turnManager.getThread(requestedThread)
        : await this.turnManager.createThread({ title: params.title, cwd: params.cwd });
      if (!thread || thread.archived) throw new Error('Choose an active thread before starting a loop');
      const sessionId = concreteSession(thread.sessionId) ? thread.sessionId : '';
      if ((sessionId && params.newSession) || (params.sessionPolicy && params.sessionPolicy !== 'reuse')
        || (params.sessionId && params.sessionId !== sessionId)) throw new Error('Loop must reuse the selected conversation');
      if ([...this.#loops.values()].some(loop => loop.status === 'running'
        && (loop.threadId === thread.id || (sessionId && loop.sessionId === sessionId)))) {
        throw new Error('A loop is already running in this ChatGPT conversation');
      }
      const turns = await this.turnManager.listTurns({ threadId: thread.id, limit: 1000 });
      if (turns.some(turn => !TERMINAL.has(turn.status))) throw new Error('Wait for the current turn to finish before starting a loop');
      const loop = { id: randomBytes(16).toString('hex'), marker: `BRIDGEDONE-${randomBytes(24).toString('hex')}`,
        threadId: thread.id, sessionId, status: 'running', iteration: 0, maxIterations, turnId: '',
        startKey, sourceClientId: params.sourceClientId || params.clientId || '', nextIterationAt: 0,
        params: { ...params, message: prompt } };
      this.#loops.set(thread.id, loop);
      const turn = await this.#submit(loop);
      return { loop: this.get(thread.id), turn };
    });
  }

  async #submit(loop) {
    try {
      const thread = await this.turnManager.getThread(loop.threadId);
      if (!thread || thread.archived || (concreteSession(thread.sessionId) ? thread.sessionId : '') !== loop.sessionId) {
        throw new Error('Loop conversation changed or was archived');
      }
      const iteration = loop.iteration + 1;
      const message = loopPrompt(loop.params.message, loop.marker, iteration);
      const { turn } = await this.turnManager.startTurn({
        ...loop.params, threadId: loop.threadId, sessionId: loop.sessionId, sourceClientId: loop.sourceClientId,
        newSession: !loop.sessionId, sessionPolicy: loop.sessionId ? 'reuse' : 'new_per_turn',
        message, input: message, id: undefined,
        // The first turn establishes attachment context. Later turns continue
        // in the exact same conversation without uploading identical files.
        attachments: iteration === 1 ? (loop.params.attachments || loop.params.fileIds) : [],
        // The RPC also accepts fileIds as an attachment alias. Explicitly
        // clear it so no downstream normalization can reattach old files.
        fileIds: [],
        project: iteration === 1 ? loop.params.project : null,
        metadata: { ...loop.params.metadata, promptLoopId: loop.id, promptLoopIteration: iteration, promptLoopMarker: loop.marker },
      }, { idempotencyKey: `loop:${loop.id}:${iteration}` });
      loop.iteration = iteration;
      loop.turnId = turn.id;
      loop.nextIterationAt = 0;
      log('Prompt loop iteration queued', { loopId: loop.id, turnId: turn.id, iteration: loop.iteration });
      this.#publish(loop);
      this.#scheduleCheck(loop);
      return turn;
    } catch (error) {
      this.#finish(loop, 'failed', error.message || String(error));
      throw error;
    }
  }

  async #advance(loop) {
    try {
      if (loop.nextIterationAt) {
        if (Date.now() >= loop.nextIterationAt) await this.#submit(loop);
        return;
      }
      const turn = await this.turnManager.getTurn(loop.turnId);
      if (!turn) return this.#finish(loop, 'failed', 'Current loop turn was not found');
      if (!TERMINAL.has(turn.status)) return;
      if (turn.status !== 'completed') {
        return this.#finish(loop, ['cancelled', 'interrupted'].includes(turn.status) ? 'stopped' : 'failed', turn.error?.message || turn.status);
      }
      const items = await this.turnManager.getItems({ turnId: turn.id });
      const answers = items.filter(item => item.type === 'agent_message' && item.status === 'completed');
      const final = String(turn.output?.answer ?? turn.output?.response?.answer ?? turn.output?.text ?? answers.at(-1)?.content?.text ?? '');
      if (!final.trim() && !items.some(item => item.type === 'artifact' && item.status === 'completed')
        && !turn.output?.artifacts?.length) {
        return this.#finish(loop, 'failed', 'Turn completed without a saved response; inspect history before retrying');
      }
      log('Prompt loop iteration completed', { loopId: loop.id, turnId: turn.id, iteration: loop.iteration, answerLength: final.length });
      if (hasCompletionMarker(final, loop.marker)) return this.#finish(loop, 'completed', 'Completion marker received');
      if (loop.iteration >= loop.maxIterations) return this.#finish(loop, 'limit', 'Iteration limit reached');
      const thread = await this.turnManager.getThread(loop.threadId);
      const observedSession = turn.output?.response?.session?.id;
      const sessionId = loop.sessionId || observedSession || thread?.sessionId;
      if (!concreteSession(sessionId) || thread?.sessionId !== sessionId || (observedSession && observedSession !== sessionId)) {
        return this.#finish(loop, 'failed', 'Could not verify the ChatGPT conversation for the next iteration');
      }
      loop.sessionId = sessionId;
      loop.sourceClientId = turn.output?.response?.sourceClientId || turn.output?.sourceClientId || loop.sourceClientId;
      loop.nextIterationAt = Date.now() + this.continuationDelayMs;
      clearTimeout(loop.timer);
      loop.timer = null;
      this.#publish(loop);
      this.#scheduleCheck(loop);
    } catch (error) {
      if (loop.status === 'running') this.#finish(loop, 'failed', error.message || String(error));
    }
  }

  async stop(threadId) {
    return await this.#mutex.runExclusive(async () => {
      const loop = this.#loops.get(threadId);
      if (!loop || loop.status !== 'running') return { loop: this.get(threadId) };
      const cancel = loop.turnId && !loop.nextIterationAt;
      this.#finish(loop, 'stopped', 'Stopped by user');
      if (cancel) await this.turnManager.cancelTurn(loop.turnId, 'Loop cancelled by user');
      return { loop: this.get(threadId) };
    });
  }
}
