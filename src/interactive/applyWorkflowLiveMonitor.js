function text(value) {
  return String(value || '').trimEnd();
}

function sourceMatches(workflow = {}, event = {}) {
  const data = event.data || {};
  const workflowClient = String(workflow.clientId || workflow.boundSourceClientId || workflow.lastSourceClientId || '');
  const workflowSession = String(workflow.sessionId || workflow.boundSessionId || workflow.lastSessionId || '');
  const eventClient = String(data.sourceClientId || event.clientId || '');
  const eventSession = String(data.sessionId || event.sessionId || '');
  if (workflowClient && eventClient && workflowClient !== eventClient) return false;
  if (workflowSession && eventSession && workflowSession !== eventSession) return false;
  return true;
}

function monitorableWorkflow(workflow = {}) {
  if (workflow.preset !== 'apply-changes') return false;
  const status = String(workflow.watcher?.status || workflow.status || '');
  return !['stopped', 'failed', 'paused'].includes(status);
}

function mergeObservedText(previous, next) {
  const before = text(previous);
  const after = text(next);
  if (!before) return after;
  if (!after || before === after || before.includes(after)) return before;
  if (after.includes(before)) return after;
  return `${before}\n${after}`;
}

export class ApplyWorkflowLiveMonitor {
  constructor(runtime) {
    this.runtime = runtime;
    this.entries = new Map();
    this.activity = new Map();
    this.currentTurns = new Map();
  }

  handle(event = {}) {
    if (event.type !== 'watch.turn.snapshot') return false;
    const workflows = this.runtime.options.workflowManager?.list?.() || [];
    const workflow = workflows.find((item) => monitorableWorkflow(item) && sourceMatches(item, event));
    if (!workflow) return false;
    const data = event.data || {};
    const turnKey = String(data.userTurnKey || data.turnKey || data.messageId || `turn-${data.turnIndex ?? 'unknown'}`);
    const baseKey = `${workflow.id}:${data.sessionId || workflow.sessionId || 'new'}:${turnKey}`;
    this.#selectCurrentTurn(workflow.id, baseKey);
    this.activity.set(workflow.id, {
      workflowId: workflow.id,
      turnKey,
      userTurnKey: String(data.userTurnKey || turnKey),
      active: !data.terminal,
      terminal: Boolean(data.terminal),
      phase: String(data.phase || (data.answer ? 'writing-answer' : data.reasoning || data.progress ? 'reasoning' : 'waiting-for-assistant')),
      userPrompt: text(data.userPrompt),
      updatedAt: String(data.observedAt || event.time || new Date().toISOString()),
    });
    this.#upsert(`${baseKey}:user`, {
      kind: 'user',
      title: 'ChatGPT tab · User',
      subtitle: workflow.label || workflow.id,
      body: text(data.userPrompt),
      fullText: true,
    });
    this.#upsert(`${baseKey}:reasoning`, {
      kind: 'system',
      title: data.terminal ? 'ChatGPT · Reasoning' : 'ChatGPT · Reasoning · streaming',
      subtitle: workflow.label || workflow.id,
      body: text([data.reasoning, data.progress].filter(Boolean).join('\n')),
      streaming: !data.terminal,
      fullText: true,
    }, { merge: true });
    this.#upsert(`${baseKey}:answer`, {
      kind: 'assistant',
      title: data.terminal ? 'ChatGPT · Answer' : 'ChatGPT · Answer · streaming',
      subtitle: workflow.label || workflow.id,
      body: text(data.answer),
      streaming: !data.terminal,
      fullText: true,
    });
    this.runtime.invalidate();
    return true;
  }

  activityFor(workflow = {}) {
    return this.activity.get(String(workflow.id || '')) || null;
  }

  clear() {
    this.entries.clear();
    this.activity.clear();
    this.currentTurns.clear();
  }

  #selectCurrentTurn(workflowId, baseKey) {
    const id = String(workflowId || '');
    const previous = this.currentTurns.get(id);
    if (!previous || previous === baseKey) {
      this.currentTurns.set(id, baseKey);
      return;
    }
    const removedIds = new Set();
    for (const [key, entryId] of this.entries.entries()) {
      if (!key.startsWith(`${previous}:`)) continue;
      removedIds.add(entryId);
      this.entries.delete(key);
    }
    if (removedIds.size) {
      this.runtime.entries = this.runtime.entries.filter((entry) => !removedIds.has(entry.id));
    }
    this.currentTurns.set(id, baseKey);
  }

  #upsert(key, entry, { merge = false } = {}) {
    if (!entry.body) return;
    const existingId = this.entries.get(key);
    if (!existingId) {
      const created = this.runtime.pushEntry(entry);
      this.entries.set(key, created.id);
      return;
    }
    let changed = false;
    this.runtime.entries = this.runtime.entries.map((item) => {
      if (item.id !== existingId) return item;
      const body = merge ? mergeObservedText(item.body, entry.body) : entry.body;
      if (item.body === body && item.title === entry.title && item.streaming === entry.streaming) return item;
      changed = true;
      return { ...item, ...entry, body };
    });
    if (changed) this.runtime.invalidate();
  }
}
