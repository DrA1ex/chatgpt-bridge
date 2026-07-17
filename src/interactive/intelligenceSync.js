import path from 'node:path';

function text(value) {
  return String(value || '').trim();
}

function comparable(value) {
  return text(value)
    .toLowerCase()
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9-]/g, '');
}

function optionValue(option = {}, { effort = false } = {}) {
  const value = option && typeof option === 'object' ? option : {};
  const candidates = effort
    ? [value.value, value.id, value.label, value.name, value.rawText]
    : [value.label, value.value, value.name, value.id, value.rawText];
  return text(candidates.find((value) => text(value)) || '');
}

function effortValue(option = {}) {
  const raw = optionValue(option, { effort: true }).toLowerCase();
  const normalized = raw.replace(/[-‐‑‒–—−_\s]/g, '');
  const aliases = {
    xhigh: 'xhigh',
    extrahigh: 'xhigh',
    medium: 'medium',
    med: 'medium',
    instant: 'instant',
    low: 'low',
    high: 'high',
    auto: 'auto',
  };
  return aliases[normalized] || raw;
}

function sameProject(left = '', right = '') {
  if (!left || !right) return true;
  return path.resolve(left) === path.resolve(right);
}

function workflowRunning(workflow = {}) {
  if (!workflow || typeof workflow !== 'object') return false;
  const watcher = text(workflow.watcher?.status || workflow.status);
  const automation = text(workflow.automation?.status);
  return watcher === 'running' || ['validating', 'waiting_turn', 'applying', 'awaiting_approval'].includes(automation);
}

export function selectIntelligenceWorkflow(workflows = [], { state = {}, health = {} } = {}) {
  const active = health.activeClient || health.clients?.[0] || null;
  const activeClientId = text(active?.id);
  const activeSessionId = text(active?.session?.id || state.sessionId);
  const focusedId = text(state.focusedWorkflowId);
  const candidates = Array.from(workflows || []).filter((workflow) => {
    if (!workflowRunning(workflow)) return false;
    if (!sameProject(workflow.projectRoot, state.projectRoot)) return false;
    const clientId = text(workflow.clientId || workflow.boundSourceClientId || workflow.lastSourceClientId);
    const sessionId = text(workflow.sessionId || workflow.boundSessionId || workflow.lastSessionId || workflow.pinnedSessionId);
    if (clientId && activeClientId && clientId !== activeClientId) return false;
    if (sessionId && activeSessionId && sessionId !== activeSessionId) return false;
    return true;
  });
  return candidates.find((workflow) => workflow.id === focusedId)
    || candidates.find((workflow) => workflow.preset === 'apply-changes')
    || candidates[0]
    || null;
}

export function desiredIntelligence({ state = {}, workflows = [], health = {} } = {}) {
  const workflow = selectIntelligenceWorkflow(workflows, { state, health });
  const configured = workflow?.intelligence || workflow?.ux?.intelligence || {};
  return {
    workflow,
    model: text(configured.model || state.model),
    effort: text(configured.effort || state.effort),
  };
}

export function intelligenceSnapshot(result = {}) {
  const intelligence = result.intelligence || {};
  const models = Array.isArray(result.models) && result.models.length ? result.models : (Array.isArray(intelligence.models) ? intelligence.models : []);
  const efforts = Array.isArray(result.efforts) && result.efforts.length ? result.efforts : (Array.isArray(intelligence.efforts) ? intelligence.efforts : []);
  const selectedModel = result.current || intelligence.selectedModel || models.find((item) => item?.selected) || null;
  const selectedEffort = intelligence.selectedEffort || efforts.find((item) => item?.selected) || null;
  return {
    models,
    efforts,
    model: optionValue(selectedModel),
    effort: effortValue(selectedEffort),
  };
}

export function intelligenceMatches(actual = '', desired = '') {
  const expected = comparable(desired);
  if (!expected) return true;
  const observed = comparable(actual);
  if (observed === expected) return true;
  const aliases = new Map([
    ['x-high', 'xhigh'],
    ['extrahigh', 'xhigh'],
  ]);
  return (aliases.get(observed) || observed) === (aliases.get(expected) || expected);
}

export class InteractiveIntelligenceSync {
  constructor(runtime) {
    this.runtime = runtime;
    this.timer = null;
    this.running = null;
    this.pendingForce = false;
    this.lastKey = '';
    this.lastError = '';
    this.waitingNoticeKey = '';
    this.closed = false;
  }

  schedule(reason = 'connection', { force = false, delayMs = 120 } = {}) {
    if (this.closed) return;
    this.pendingForce ||= Boolean(force);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync(reason, { force: this.pendingForce }).finally(() => { this.pendingForce = false; });
    }, Math.max(0, Number(delayMs) || 0));
    this.timer.unref?.();
  }

  async sync(reason = 'connection', { force = false } = {}) {
    if (this.running) return await this.running;
    const bridge = this.runtime.options.bridge;
    const health = bridge.health();
    const active = health.activeClient || health.clients?.[0] || null;
    if (!active?.id) return null;
    const workflows = this.runtime.options.workflowManager?.list?.() || [];
    const desired = desiredIntelligence({ state: this.runtime.state, workflows, health });
    const key = JSON.stringify([active.id, active.session?.id || '', desired.workflow?.id || '', desired.model, desired.effort]);
    if (!force && key === this.lastKey) return null;
    this.lastKey = key;

    this.running = (async () => {
      try {
        const listed = await bridge.listModels({ sourceClientId: active.id, timeoutMs: 12_000 });
        let snapshot = intelligenceSnapshot(listed);
        if (!snapshot.efforts.length || !snapshot.effort) {
          const efforts = await bridge.listEfforts({ sourceClientId: active.id, timeoutMs: 12_000 });
          snapshot = intelligenceSnapshot({ ...listed, efforts: efforts.efforts, intelligence: { ...(listed.intelligence || {}), ...(efforts.intelligence || {}) } });
        }
        this.#applySnapshot(snapshot);

        if (desired.effort && !intelligenceMatches(snapshot.effort, desired.effort)) {
          const applied = await bridge.applyIntelligence({ effort: desired.effort }, { sourceClientId: active.id, timeoutMs: 15_000 });
          const appliedSnapshot = intelligenceSnapshot(applied);
          if (appliedSnapshot.models.length || appliedSnapshot.efforts.length || appliedSnapshot.model || appliedSnapshot.effort) {
            snapshot = appliedSnapshot;
            this.#applySnapshot(appliedSnapshot);
          }
          if (!applied.effortApplied) {
            const detail = applied.warnings?.join('; ') || `ChatGPT still reports ${this.runtime.state.currentEffort || snapshot.effort || 'an unknown effort'}`;
            throw new Error(`Could not switch reasoning effort to ${desired.effort}: ${detail}`);
          }
          this.runtime.pushEntry({
            kind: 'system',
            title: 'ChatGPT effort synchronized',
            body: `${snapshot.effort || 'unknown'} → ${desired.effort}${desired.workflow ? `\nWorkflow: ${desired.workflow.label || desired.workflow.id}` : '\nProject setting applied'}`,
          });
        }
        this.lastError = '';
        this.waitingNoticeKey = '';
        this.runtime.state.intelligenceSyncStatus = 'ready';
        this.runtime.state.intelligenceSyncMessage = '';
        await this.runtime.saveState?.();
        this.runtime.invalidate();
        return snapshot;
      } catch (error) {
        const message = String(error?.message || error);
        if (this.#shouldRetryConnectedWorkflowTimeout(error, desired.workflow, active.id)) {
          this.lastKey = '';
          this.runtime.state.intelligenceSyncStatus = 'waiting';
          this.runtime.state.intelligenceSyncMessage = 'Waiting for the connected ChatGPT tab to expose model and effort controls.';
          const noticeKey = `${active.id}:${desired.workflow?.id || ''}`;
          if (noticeKey !== this.waitingNoticeKey) {
            this.waitingNoticeKey = noticeKey;
            this.runtime.pushEntry({
              kind: 'system',
              title: 'Waiting for ChatGPT model/effort',
              body: 'The workflow tab is still connected. Bridge will keep retrying automatically instead of failing the active workflow.',
            });
          }
          this.schedule('connected workflow intelligence retry', { force: true, delayMs: 2_000 });
          this.runtime.invalidate();
          return null;
        }
        this.runtime.state.intelligenceSyncStatus = 'error';
        this.runtime.state.intelligenceSyncMessage = message;
        if (message !== this.lastError) {
          this.lastError = message;
          this.runtime.pushEntry({ kind: 'error', title: 'Could not read ChatGPT model/effort', body: `${message}\nTrigger: ${reason}` });
        }
        this.runtime.invalidate();
        return null;
      } finally {
        this.running = null;
      }
    })();
    return await this.running;
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
  }

  #shouldRetryConnectedWorkflowTimeout(error, workflow, clientId) {
    if (!workflowRunning(workflow)) return false;
    const message = String(error?.message || error || '');
    if (!/Timed out waiting for (?:models\.list|efforts\.list|intelligence\.apply) response/i.test(message)) return false;
    const health = this.runtime.options.bridge.health();
    return Array.from(health.clients || []).some((client) => String(client?.id || '') === String(clientId || ''));
  }

  #applySnapshot(snapshot = {}) {
    this.runtime.state.lastModels = snapshot.models || [];
    this.runtime.state.lastEfforts = snapshot.efforts || [];
    this.runtime.state.currentModel = snapshot.model || '';
    this.runtime.state.currentEffort = snapshot.effort || '';
  }
}
