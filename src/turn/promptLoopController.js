import { randomBytes } from 'node:crypto';
import { AsyncMutex } from '../mutex.js';

const TERMINAL = new Set(['completed', 'completed_without_artifact', 'failed', 'cancelled', 'interrupted']);
const TERMINAL_EVENTS = new Set([...TERMINAL].map(status => 'turn/' + status));

export function loopPrompt(prompt, marker) {
  return `${prompt}\n\n[Completion protocol]\nContinue the original task from its current state. Do not restart completed work. Complete as much remaining work as possible in this turn. Only when the ENTIRE original task is complete, append this exact marker as the final standalone line, in plain text without Markdown formatting: ${marker}\nIf any work remains, do not output the marker (including in quotations or examples).`;
}

export function hasCompletionMarker(answer, marker) {
  const lines = String(answer || '').trimEnd().split(/\r?\n/);
  return lines.at(-1)?.trim() === marker;
}

export class PromptLoopController {
  #loops = new Map();
  #mutex = new AsyncMutex();

  constructor({ turnManager, notify = () => {} }) {
    this.turnManager = turnManager;
    this.notify = notify;
    turnManager.on('notification', ({ method, params }) => {
      if (!TERMINAL_EVENTS.has(method)) return;
      void this.#mutex.runExclusive(async () => {
        const loop = [...this.#loops.values()].find(value => value.status === 'running' && value.turnId === params.turnId);
        if (loop) await this.#advance(loop);
      }).catch(() => {});
    });
  }

  get(threadId) {
    const loop = this.#loops.get(threadId);
    if (!loop) return null;
    const { params, marker, ...status } = loop;
    return { ...status };
  }

  #publish(loop) { this.notify(this.get(loop.threadId)); }

  #finish(loop, status, reason = '') {
    loop.status = status;
    loop.reason = reason;
    this.#publish(loop);
  }

  async start(params = {}) {
    return await this.#mutex.runExclusive(async () => {
      const thread = await this.turnManager.getThread(params.threadId);
      if (!thread?.sessionId || !/^[a-zA-Z0-9_-]+$/.test(thread.sessionId) || thread.sessionId === 'new') {
        throw new Error('Choose an existing ChatGPT conversation before starting a loop');
      }
      if (params.newSession || (params.sessionPolicy && params.sessionPolicy !== 'reuse')
        || (params.sessionId && params.sessionId !== thread.sessionId)) throw new Error('Loop must reuse the selected conversation');
      if ([...this.#loops.values()].some(loop => loop.status === 'running' && loop.sessionId === thread.sessionId)) {
        throw new Error('A loop is already running in this ChatGPT conversation');
      }
      const turns = await this.turnManager.listTurns({ threadId: thread.id, limit: 1000 });
      if (turns.some(turn => !TERMINAL.has(turn.status))) throw new Error('Wait for the current turn to finish before starting a loop');
      const prompt = String(params.message || '').trim();
      if (!prompt) throw new Error('Loop prompt is empty');
      const maxIterations = Number(params.maxIterations ?? 50);
      if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 500) throw new Error('Loop limit must be between 1 and 500');
      const loop = { id: randomBytes(16).toString('hex'), marker: `BRIDGEDONE-${randomBytes(24).toString('hex')}`,
        threadId: thread.id, sessionId: thread.sessionId, status: 'running', iteration: 0, maxIterations, turnId: '',
        params: { ...params, threadId: thread.id, sessionId: thread.sessionId, newSession: false, sessionPolicy: 'reuse', message: prompt } };
      this.#loops.set(thread.id, loop);
      const turn = await this.#submit(loop);
      return { loop: this.get(thread.id), turn };
    });
  }

  async #submit(loop) {
    try {
      const thread = await this.turnManager.getThread(loop.threadId);
      if (thread?.sessionId !== loop.sessionId || thread.archived) throw new Error('Loop conversation changed or was archived');
      loop.iteration++;
      const { turn } = await this.turnManager.startTurn({
        ...loop.params, message: loopPrompt(loop.params.message, loop.marker),
        // The first turn establishes attachment context. Later turns continue
        // in the exact same conversation without uploading identical files.
        attachments: loop.iteration === 1 ? loop.params.attachments : [],
        metadata: { ...loop.params.metadata, promptLoopId: loop.id, promptLoopIteration: loop.iteration },
      }, { idempotencyKey: `loop:${loop.id}:${loop.iteration}` });
      loop.turnId = turn.id;
      this.#publish(loop);
      return turn;
    } catch (error) {
      this.#finish(loop, 'failed', error.message || String(error));
      throw error;
    }
  }

  async #advance(loop) {
    try {
      const turn = await this.turnManager.getTurn(loop.turnId);
      if (!turn || !TERMINAL.has(turn.status)) return;
      if (turn.status !== 'completed') {
        return this.#finish(loop, ['cancelled', 'interrupted'].includes(turn.status) ? 'stopped' : 'failed', turn.error?.message || turn.status);
      }
      const items = await this.turnManager.getItems({ turnId: turn.id });
      const answers = items.filter(item => item.type === 'agent_message' && item.status === 'completed');
      const final = answers.at(-1)?.content?.text || '';
      if (hasCompletionMarker(final, loop.marker)) return this.#finish(loop, 'completed', 'Completion marker received');
      if (loop.iteration >= loop.maxIterations) return this.#finish(loop, 'limit', 'Iteration limit reached');
      await this.#submit(loop);
    } catch (error) {
      if (loop.status === 'running') this.#finish(loop, 'failed', error.message || String(error));
    }
  }

  async stop(threadId) {
    return await this.#mutex.runExclusive(async () => {
      const loop = this.#loops.get(threadId);
      if (!loop || loop.status !== 'running') return { loop: this.get(threadId) };
      this.#finish(loop, 'stopped', 'Stopped by user');
      if (loop.turnId) await this.turnManager.cancelTurn(loop.turnId, 'Loop cancelled by user');
      return { loop: this.get(threadId) };
    });
  }
}
