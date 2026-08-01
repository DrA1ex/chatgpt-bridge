import path from 'node:path';
import { normalizeConversationId, sessionIdFromClient } from '../bridge/clientSelection.js';
import { captureConsoleLines } from './consoleCapture.js';
import { recoverLatestResponse } from './recovery.js';

const TURN_KEY_EVENTS = new Set([
  'result.artifact.retry_found',
  'result.artifact.retry',
  'normal.done.received',
  'request.done',
]);

function text(value) {
  return String(value || '').trim();
}

function expectedRequiredZip(turn = {}) {
  const output = turn.input?.output || {};
  return output.required === true && text(output.expected || output.format).toLowerCase() === 'zip';
}

function hasReadyZip(turn = {}) {
  return turn.output?.type === 'zip' && Boolean(turn.output?.fileId);
}

function sameProject(turn = {}, state = {}) {
  const turnRoot = text(turn.input?.cwd || turn.input?.project?.root);
  const projectRoot = text(state.projectRoot);
  if (!turnRoot || !projectRoot) return true;
  return path.resolve(turnRoot) === path.resolve(projectRoot);
}

function eligibleTurn(turn = {}, state = {}) {
  if (!turn?.id || !expectedRequiredZip(turn) || hasReadyZip(turn) || !sameProject(turn, state)) return false;
  if (!['running', 'interrupted', 'failed', 'completed_without_artifact'].includes(text(turn.status))) return false;
  return turn.status !== 'failed' || turn.error?.recoverable !== false;
}

function connectedClients(health = {}) {
  const clients = Array.from(health.clients || []);
  const active = health.activeClient;
  if (active?.id && !clients.some((client) => text(client?.id) === text(active.id))) clients.push(active);
  return clients.filter((client) => text(client?.id));
}

export function selectStartupTurnRecovery({ turn, events = [], state = {}, health = {} } = {}) {
  if (!eligibleTurn(turn, state)) return null;
  const ordered = Array.from(events || []);
  const correlated = ordered.slice().reverse().find((event) => (
    TURN_KEY_EVENTS.has(text(event?.type)) && text(event?.data?.turnKey)
  ));
  const turnKey = text(correlated?.data?.turnKey);
  if (!turnKey) return null;

  const clients = connectedClients(health);
  const correlatedClientId = text(correlated?.data?.sourceClientId);
  const exact = correlatedClientId
    ? clients.find((client) => text(client.id) === correlatedClientId)
    : null;
  if (exact) return { turnId: turn.id, turnKey, sourceClientId: exact.id };

  const targetEvent = ordered.slice().reverse().find((event) => (
    text(event?.type) === 'client.target.resolved'
    && text(event?.data?.sourceUrl || event?.data?.url || event?.data?.sessionId)
  ));
  const sessionId = normalizeConversationId(
    targetEvent?.data?.sourceUrl
    || targetEvent?.data?.url
    || targetEvent?.data?.sessionId
    || state.sessionId,
  );
  if (!sessionId) return null;
  const matching = clients.filter((client) => sessionIdFromClient(client) === sessionId);
  if (matching.length !== 1) return null;
  return { turnId: turn.id, turnKey, sourceClientId: matching[0].id };
}

export class InteractiveStartupTurnRecovery {
  constructor(runtime) {
    this.runtime = runtime;
    this.timer = null;
    this.running = null;
    this.closed = false;
    this.completed = new Set();
    this.lastErrorKey = '';
  }

  schedule(reason = 'startup', { delayMs = 350 } = {}) {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.recover(reason);
    }, Math.max(0, Number(delayMs) || 0));
    this.timer.unref?.();
  }

  async recover(reason = 'startup') {
    if (this.closed || this.running) return await this.running;
    this.running = this.#recoverOnce(reason).finally(() => { this.running = null; });
    return await this.running;
  }

  async #recoverOnce(reason) {
    const turnId = text(this.runtime.state.lastTurnId);
    const turnManager = this.runtime.options.turnManager;
    if (!turnId || !turnManager || this.completed.has(turnId)) return null;
    const turn = await turnManager.getTurn(turnId);
    if (!turn) return null;
    const events = await turnManager.getTurnEvents(turnId, { limit: 1000 });
    const candidate = selectStartupTurnRecovery({
      turn,
      events,
      state: this.runtime.state,
      health: this.runtime.options.bridge.health(),
    });
    if (!candidate) return null;

    const key = `${candidate.turnId}:${candidate.turnKey}:${candidate.sourceClientId}`;
    try {
      let recovered = null;
      await captureConsoleLines(async () => {
        recovered = await recoverLatestResponse(this.runtime.context, {
          apply: true,
          sourceClientId: candidate.sourceClientId,
          turnKey: candidate.turnKey,
        });
      }, (line) => this.runtime.pushEventLine?.(line));
      this.completed.add(turnId);
      this.lastErrorKey = '';
      await this.runtime.saveState?.();
      this.runtime.pushEntry({
        kind: 'system',
        title: 'Interrupted result recovered',
        body: `Recovered ${turnId} from its original ChatGPT conversation and continued the workflow.`,
      });
      this.runtime.invalidate();
      return recovered;
    } catch (error) {
      if (key !== this.lastErrorKey) {
        this.lastErrorKey = key;
        this.runtime.pushEntry({
          kind: 'error',
          title: 'Could not recover the interrupted result',
          body: `${error.message || String(error)}\nTrigger: ${reason}`,
        });
      }
      this.runtime.invalidate();
      return null;
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
