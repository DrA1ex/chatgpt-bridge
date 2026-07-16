import { commandSuggestions } from './commands.js';

export function shouldRouteToProjectTask(state = {}, options = {}, message = '') {
  const text = String(message || '').trim();
  return Boolean(
    text &&
    state?.projectRoot &&
    options?.projectService &&
    options?.turnManager
  );
}

export function shouldNavigateCommandSuggestions(input = '', completionActive = false) {
  if (!completionActive) return false;
  const value = String(input || '');
  return value.trimStart().startsWith('/') && commandSuggestions(value).length > 0;
}


export function deriveInteractiveRuntimeStatus(health = {}, busy = false, phase = '') {
  const tracked = Array.isArray(health.activeRequests) ? health.activeRequests.find((item) => item && !item.done) : null;
  const browserActive = health.activeClient?.activeRequest || (Array.isArray(health.clients)
    ? health.clients.find((client) => client?.activeRequest?.requestId)?.activeRequest
    : null);
  const localPhase = String(phase || '').trim() === 'idle' ? '' : String(phase || '').trim();
  const trackedPhase = String(tracked?.phase || browserActive?.phase || localPhase || '').trim();
  const requestId = String(tracked?.requestId || browserActive?.requestId || '');

  if (busy) return { active: true, color: 'yellow', label: localPhase || trackedPhase || 'working', requestId, phase: trackedPhase || localPhase || 'working' };
  if (tracked || Number(health.pendingRequests) > 0) {
    const sourceAlive = tracked?.watchdog?.sourceAlive;
    const reconnecting = !health.ok || sourceAlive === false;
    return {
      active: true,
      color: reconnecting ? 'yellow' : 'cyan',
      label: `${reconnecting ? 'reconnecting' : 'tracking'} · ${trackedPhase || 'waiting for response'}`,
      requestId,
      phase: trackedPhase || 'waiting for response',
    };
  }
  if (browserActive?.requestId) {
    return {
      active: true,
      color: 'yellow',
      label: `resume available · ${trackedPhase || 'active in browser'}`,
      requestId,
      phase: trackedPhase || 'active in browser',
    };
  }
  return { active: false, color: 'gray', label: 'idle', requestId: '', phase: 'idle' };
}

export function truncate(text, limit = 100) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export function preserveText(text, limit = 4000) {
  const value = String(text || '').trimEnd();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… ${value.length - limit} more chars`;
}

export function transcriptBodyText(entry = {}) {
  const body = String(entry.body || '').trimEnd();
  return entry.kind === 'user' ? body : preserveText(body, 12_000);
}

export function fitLiveText(text, options = {}) {
  const value = String(text || '').replace(/\r/g, '').trimEnd();
  if (!value) return '';
  const maxLines = Math.max(1, Number(options.maxLines) || 6);
  const maxColumns = Math.max(12, Number(options.maxColumns) || 96);
  const wrapped = [];
  for (const rawLine of value.split('\n')) {
    const line = rawLine || ' ';
    for (let offset = 0; offset < line.length; offset += maxColumns) wrapped.push(line.slice(offset, offset + maxColumns));
  }
  if (wrapped.length <= maxLines) return wrapped.join('\n');
  if (maxLines === 1) return wrapped.at(-1) || '';
  const hidden = wrapped.length - maxLines + 1;
  return [`… ${hidden} earlier line${hidden === 1 ? '' : 's'}`, ...wrapped.slice(-(maxLines - 1))].join('\n');
}

export function wrapLiveSection(label, text, maxColumns) {
  const value = String(text || '').replace(/\r/g, '').trimEnd();
  if (!value) return [];
  const prefix = `${label}: `;
  const continuation = ' '.repeat(prefix.length);
  const contentWidth = Math.max(8, maxColumns - prefix.length);
  const contentLines = [];
  for (const rawLine of value.split('\n')) {
    const line = rawLine || ' ';
    for (let offset = 0; offset < line.length; offset += contentWidth) contentLines.push(line.slice(offset, offset + contentWidth));
  }
  return contentLines.map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
}

export function buildLiveLines(options = {}) {
  const maxLines = Math.max(1, Number(options.maxLines) || 10);
  const maxColumns = Math.max(24, Number(options.maxColumns) || 96);
  const activity = (Array.isArray(options.activityLines) ? options.activityLines : [])
    .map((line) => `• ${String(line || '').replace(/\s+/g, ' ').trim()}`)
    .filter((line) => line !== '• ')
    .map((line) => line.length > maxColumns ? `${line.slice(0, Math.max(1, maxColumns - 1))}…` : line);
  const sections = {
    activity,
    thinking: wrapLiveSection('Thinking', options.thinking, maxColumns),
    progress: wrapLiveSection('Progress', options.progress, maxColumns),
    answer: wrapLiveSection('Assistant', options.answer, maxColumns),
  };
  const caps = {
    activity: Math.min(3, sections.activity.length),
    thinking: Math.min(3, sections.thinking.length),
    progress: Math.min(3, sections.progress.length),
    answer: sections.answer.length,
  };
  const allocation = { activity: 0, thinking: 0, progress: 0, answer: 0 };
  let remaining = maxLines;

  for (const name of ['answer', 'progress', 'activity', 'thinking']) {
    if (remaining > 0 && caps[name] > 0) {
      allocation[name] += 1;
      remaining -= 1;
    }
  }
  const extraOrder = ['answer', 'answer', 'activity', 'progress', 'thinking'];
  while (remaining > 0) {
    let added = false;
    for (const name of extraOrder) {
      if (remaining <= 0) break;
      if (allocation[name] >= caps[name]) continue;
      allocation[name] += 1;
      remaining -= 1;
      added = true;
    }
    if (!added) break;
  }

  const result = [];
  for (const name of ['activity', 'thinking', 'progress', 'answer']) {
    const count = allocation[name];
    if (!count) continue;
    const source = sections[name];
    const selected = source.slice(-count);
    if (source.length > count && selected.length) {
      const labels = { thinking: 'Thinking', progress: 'Progress', answer: 'Assistant' };
      selected[0] = name === 'activity'
        ? `… ${selected[0].replace(/^•\s*/, '')}`
        : `${labels[name]}: … ${selected[0].trimStart().replace(/^[^:]+:\s*/, '')}`;
    }
    result.push(...selected);
  }
  return result.slice(0, maxLines);
}

export function compactTabLabel(client) {
  if (!client) return '(no tab)';
  const title = client.title || client.session?.title || client.url || client.id;
  const state = [client.visibilityState === 'visible' ? 'visible' : '', client.focused ? 'focused' : ''].filter(Boolean).join('/');
  return `${truncate(title, 58)}${state ? ` · ${state}` : ''}`;
}

export function eventTone(line) {
  if (/\[error\]|ERROR|failed/i.test(line)) return 'red';
  if (/\[done\]|applied|attached/i.test(line)) return 'green';
  if (/warning|warn|select-tab|not-connected/i.test(line)) return 'yellow';
  if (/generation|prompt|request/i.test(line)) return 'cyan';
  return 'gray';
}

export function shouldShowDebugEvents(state = {}) {
  return state.eventLevel === 'verbose';
}

export function isUserFacingActivity(line = '') {
  const text = String(line || '');
  if (!text.trim()) return false;
  if (/^\[(request|project|file|result|artifact|apply|task|resume|turn|done|warn|error|watchdog|recoverable|select-tab|open-tab|session|model)\]/i.test(text)) return true;
  if (/^\[chat\] (prompt delivered|prompt accepted|prompt sent|generation started|generation stopped|assistant turn captured|user turn captured|phase:)/i.test(text)) return true;
  if (/^\[(thinking|progress|action status|tool status)\]/i.test(text)) return true;
  return false;
}

export function splitActivityMessages(value = '') {
  return String(value || '')
    .split(/\n(?=\[[^\]]+\]\s)/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function compactActivityLine(line = '') {
  const raw = String(line || '').replace(/\r/g, '').trim();
  if (/^\[(thinking|progress|action status|tool status)\]/i.test(raw)) {
    return preserveText(raw, 12_000);
  }
  return truncate(raw.replace(/\s+/g, ' '), 240);
}

export function activityEntryForLine(line = '') {
  const body = compactActivityLine(line);
  if (!isUserFacingActivity(body)) return null;
  const tag = body.match(/^\[([^\]]+)\]/)?.[1] || 'activity';
  const title = tag
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return { kind: 'system', title: title || 'Activity', body };
}

export function nextPhaseFromEvent(event, fallback) {
  const type = String(event?.type || '');
  if (type === 'request.started') return 'starting';
  if (type === 'client.auto_open.requested') return 'opening tab';
  if (type === 'client.auto_open.completed') return 'tab connected';
  if (type === 'client.auto_open.failed') return 'error';
  if (type === 'prompt.delivered' || type === 'prompt.accepted') return 'delivered';
  if (type === 'prompt.sent' || type === 'chat.prompt.sent') return 'sent';
  if (type === 'generation.started' || type === 'chat.generation.started') return 'generating';
  if (type === 'thinking.delta' || type === 'thinking.snapshot') return 'thinking';
  if (type === 'assistant.progress.snapshot') return 'progress';
  if (type === 'answer.delta' || type === 'answer.snapshot') return 'writing answer';
  if (type === 'generation.stopped' || type === 'chat.generation.stopped') return 'reading answer';
  if (type === 'request.done') return 'done';
  if (type.startsWith('watchdog.') || type.startsWith('forced_snapshot.')) return 'watchdog';
  if (type === 'request.error' || type === 'request.recoverable_failed') return 'error';
  if (type.startsWith('files.attach')) return 'attaching files';
  if (type.startsWith('model.apply')) return 'applying settings';
  return fallback;
}
