import { bytes } from './format.js';

function appendIncremental(previous, next, stream = process.stdout) {
  if (!previous) {
    stream.write(next);
    return next;
  }
  if (next.startsWith(previous)) {
    stream.write(next.slice(previous.length));
    return next;
  }
  stream.write(`\n${next}`);
  return next;
}

export function createConsoleStream(spinner, stream = process.stdout) {
  let activeSection = null;
  let printedThinking = '';
  let printedProgress = '';
  let printedAnswer = '';
  let printedAnything = false;
  let spinnerCleared = false;

  function clearSpinnerOnce() {
    if (spinnerCleared) return;
    spinner.stop();
    spinnerCleared = true;
  }

  function switchSection(sectionName) {
    clearSpinnerOnce();
    if (activeSection === sectionName) return;
    if (printedAnything) stream.write('\n\n');
    stream.write(`${sectionName}:\n`);
    activeSection = sectionName;
    printedAnything = true;
  }

  return {
    status(line) {
      if (!line) return;
      clearSpinnerOnce();
      if (printedAnything && activeSection) stream.write('\n');
      stream.write(`${line}\n`);
      printedAnything = true;
    },

    onThinkingUpdate(text) {
      if (!text || text === printedThinking) return;
      switchSection('Thinking');
      printedThinking = appendIncremental(printedThinking, text, stream);
    },

    onProgressUpdate(text) {
      if (!text || text === printedProgress) return;
      switchSection('Progress');
      printedProgress = appendIncremental(printedProgress, text, stream);
    },

    onAnswerUpdate(text) {
      if (!text || text === printedAnswer) return;
      switchSection('Answer');
      printedAnswer = appendIncremental(printedAnswer, text, stream);
    },

    onArtifactUpdate(artifacts) {
      clearSpinnerOnce();
      for (const [index, artifact] of artifacts.entries()) {
        stream.write(`\n[artifact] #${index + 1} ${artifact.kind || 'artifact'} ${artifact.name || artifact.id || ''}\n`);
      }
      printedAnything = true;
    },

    finish(answer) {
      const finalAnswer = String(answer || '').trim();
      clearSpinnerOnce();
      if (!finalAnswer) {
        if (printedAnything) stream.write('\n');
        return;
      }
      if (!printedAnything) {
        stream.write(`Answer:\n${finalAnswer}\n`);
        return;
      }
      if (printedAnswer.trim() !== finalAnswer) {
        stream.write(`\n\nFinal answer:\n${finalAnswer}\n`);
        return;
      }
      stream.write('\n');
    },

    fail() {
      clearSpinnerOnce();
      if (printedAnything) stream.write('\n');
    },
  };
}

export function visibleProgressLines(data = {}) {
  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length) {
    return items.map((item) => {
      const kind = String(item?.kind || data.kind || 'progress').replace(/_/g, ' ');
      const text = String(item?.text || '').trim();
      return text ? `[${kind}] ${text}` : '';
    }).filter(Boolean);
  }
  const text = String(data.text || data.progress || data.delta || '').trim();
  return text ? [`[progress] ${text}`] : [];
}

function progressItemId(item = {}, index = 0) {
  const explicit = String(item.id || item.key || '').trim();
  if (explicit) return explicit;
  return `${String(item.kind || 'progress')}:${index}:${String(item.text || '').trim()}`;
}

export function reconcileVisibleProgressSnapshot(data = {}, previousState = {}) {
  const previous = previousState && typeof previousState === 'object' ? previousState : {};
  const records = { ...(previous.records || {}) };
  const items = Array.isArray(data.items) ? data.items : [];
  const completedLines = [];
  const activeLines = [];

  if (!items.length) {
    const text = String(data.text || data.progress || '').trim();
    return { state: { records }, liveText: text, completedLines };
  }

  items.forEach((item, index) => {
    const id = progressItemId(item, index);
    const kind = String(item.kind || data.kind || 'progress').replace(/_/g, ' ');
    const text = String(item.text || '').trim();
    if (!text) return;
    const state = String(item.state || (item.active ? 'active' : 'completed')).toLowerCase();
    const revision = Number(item.revision || 0);
    const previousRecord = records[id] || {};
    const record = {
      ...previousRecord,
      id,
      kind,
      text,
      state,
      revision,
      visible: item.visible !== false,
    };

    if (state === 'completed' && !previousRecord.committed) {
      completedLines.push(`[${kind}] ${text}`);
      record.committed = true;
    }
    if (state === 'active' && item.visible !== false && kind !== 'thinking') {
      activeLines.push(`[${kind}] ${text}`);
    }
    records[id] = record;
  });

  return {
    state: { records },
    liveText: activeLines.join('\n'),
    completedLines,
  };
}

export function renderEvent(event, level = 'normal') {
  if (level === 'quiet') return '';
  const type = String(event?.type || '');
  const data = event || {};

  if (type === 'request.started') {
    const bits = [];
    if (data.sessionId) bits.push(`session=${data.sessionId}`);
    if (data.model) bits.push(`model=${data.model}`);
    if (data.effort) bits.push(`effort=${data.effort}`);
    if (Array.isArray(data.attachments) && data.attachments.length) bits.push(`files=${data.attachments.length}`);
    return `[request] started${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
  }
  if (type === 'request.resumed') return `[resume] attached to ${data.requestId || 'active request'}`;
  if (type === 'client.auto_open.requested') return `[open-tab] opening an isolated ChatGPT tab · ${data.reason || 'no safe tab available'}`;
  if (type === 'client.auto_open.completed') return `[open-tab] connected ${data.clientId || 'new tab'} · ${data.openedBy || 'browser'}`;
  if (type === 'client.auto_open.failed') return `[open-tab] failed: ${data.message || 'unknown error'}`;
  if (type === 'client.selection.confirmation_required') return `[select-tab] ${data.message || 'choose an available ChatGPT tab'}`;
  if (type === 'client.target.resolved') return `[select-tab] using ${data.clientId || 'selected tab'}${data.reason ? ` · ${data.reason}` : ''}${data.sessionSwitch ? ' · will switch session' : ''}`;
  if (type === 'session.switch.requested') return `[session] switching ${data.clientId || 'tab'} to ${data.sessionId || 'requested session'}`;
  if (type === 'prompt.resent_after_navigation') return `[session] tab reloaded; prompt resent${data.sessionId ? ` to ${data.sessionId}` : ''}${data.resendCount ? ` · attempt ${data.resendCount}` : ''}`;
  if (type === 'prompt.resend.blocked_busy') return `[error] prompt resend blocked: tab is running ${data.activeRequestId || 'another request'}`;
  if (type === 'prompt.resend.delivery_failed') return `[warn] prompt resend delivery failed: ${data.message || 'unknown error'}`;
  if (type === 'resume.attached') return `[resume] receiving events from active tab`;
  if (type === 'prompt.delivered') return `[chat] prompt delivered to ${data.clientId || 'selected tab'}`;
  if (type === 'prompt.accepted') return data.implicit ? `[chat] prompt accepted implicitly via ${data.via || 'client event'}` : '[chat] prompt accepted';
  if (type === 'prompt.sent' || type === 'chat.prompt.sent') return '[chat] prompt sent';
  if (type === 'generation.started' || type === 'chat.generation.started') return '[chat] generation started';
  if (type === 'generation.stopped' || type === 'chat.generation.stopped') return '[chat] generation stopped';
  if (type === 'request.phase') return data.phase ? `[chat] phase: ${data.phase}` : '';
  if (type === 'user_turn.captured' || type === 'chat.user_turn.captured') return `[chat] user turn captured${data.turnIndex >= 0 ? ` #${data.turnIndex}` : ''}`;
  if (type === 'assistant_turn.captured' || type === 'chat.assistant_turn.captured') return `[chat] assistant turn captured${data.turnIndex >= 0 ? ` #${data.turnIndex}` : ''}`;
  if (type === 'assistant.progress.snapshot') return visibleProgressLines(data).join('\n');
  if (type === 'generation.start_timeout_warning' || type === 'chat.generation.start_timeout_warning') return `[warn] generation has not visibly started${data.sentFor ? ` · ${Math.round(data.sentFor / 1000)}s` : ''}`;
  if (type === 'generation.first_output_timeout_warning' || type === 'chat.generation.first_output_timeout_warning') return `[warn] generation is active, but no visible output yet${data.sentFor ? ` · ${Math.round(data.sentFor / 1000)}s` : ''}`;
  if (type === 'request.max_timeout_warning' || type === 'chat.request.max_timeout_warning') return `[warn] request is still running after ${data.sentFor ? `${Math.round(data.sentFor / 1000)}s` : 'the configured warning window'}`;
  if (type === 'watchdog.generation_active_no_visible_change') return `[watchdog] generation active, no visible changes${data.meaningfulIdleMs ? ` · ${Math.round(data.meaningfulIdleMs / 1000)}s` : ''}`;
  if (type === 'watchdog.meaningful_progress_stalled') return `[watchdog] no meaningful progress${data.meaningfulIdleMs ? ` · ${Math.round(data.meaningfulIdleMs / 1000)}s` : ''}; requesting snapshot`;
  if (type === 'watchdog.source_disconnected') return `[watchdog] source tab disconnected${data.phase ? ` · ${data.phase}` : ''}`;
  if (type === 'forced_snapshot.requested') return `[watchdog] requesting source snapshot${data.assistantTurnKey ? ` · ${data.assistantTurnKey}` : ''}`;
  if (type === 'forced_snapshot.received') return `[watchdog] snapshot received${data.answerLength ? ` · answer ${data.answerLength}` : ''}${data.artifactCount ? ` · artifacts ${data.artifactCount}` : ''}`;
  if (type === 'forced_snapshot.failed') return `[watchdog] snapshot failed: ${data.message || 'unknown error'}`;
  if (type === 'request.recoverable_failed') return `[recoverable] ${data.message || 'request needs recovery'}`;
  if (type === 'normal.pipeline.started') return `[result] processing final response${data.expected ? ` · expected ${data.expected}` : ''}`;
  if (type === 'normal.pipeline.missing_after_done') return `[recoverable] final response arrived, but result processing did not start: ${data.message || 'unknown error'}`;
  if (type === 'normal.pipeline.failed' || type === 'recovery.pipeline.failed') return `[error] result processing failed: ${data.message || 'unknown error'}`;
  if (type === 'request.progress') {
    const phase = data.phase || 'progress';
    if (level !== 'verbose' && data.meaningful === false && data.reason === 'dom.poll') return '';
    const metrics = [];
    if (Number.isFinite(Number(data.thinkingLength)) && Number(data.thinkingLength) > 0) metrics.push(`thinking ${data.thinkingLength}`);
    if (Number.isFinite(Number(data.progressLength)) && Number(data.progressLength) > 0) metrics.push(`progress ${data.progressLength}`);
    if (Number.isFinite(Number(data.answerLength)) && Number(data.answerLength) > 0) metrics.push(`answer ${data.answerLength}`);
    if (Number.isFinite(Number(data.artifactCount)) && Number(data.artifactCount) > 0) metrics.push(`artifacts ${data.artifactCount}`);
    if (data.visibilityState && data.visibilityState !== 'visible') metrics.push(`tab ${data.visibilityState}`);
    if (data.anchorConfidence && !['high', 'medium'].includes(data.anchorConfidence)) metrics.push(`anchor ${data.anchorConfidence}`);
    return `[chat] ${phase}${metrics.length ? ` · ${metrics.join(' · ')}` : ''}`;
  }
  if (type === 'files.attach.started') return `[file] attaching ${data.count ?? ''} file(s)`.trim();
  if (type === 'files.attach.done') return `[file] attached ${(data.names || []).join(', ') || `${data.count ?? ''} file(s)`}`;
  if (type === 'files.attach.failed' || type === 'files.attach.warning') return `[file] ${data.message || 'attachment warning'}`;
  if (type === 'model.apply.started') return `[model] applying ${[data.model, data.effort].filter(Boolean).join(' / ')}`;
  if (type === 'model.apply.done') {
    const warnings = Array.isArray(data.warnings) && data.warnings.length ? ` · ${data.warnings.join('; ')}` : '';
    return `[model] applied${warnings}`;
  }
  if (type === 'session.snapshot') return data.session?.id ? `[session] ${data.session.title || data.session.id}` : '';
  if (type === 'artifact.snapshot') return Array.isArray(data.artifacts) && data.artifacts.length ? `[artifact] discovered ${data.artifacts.length}` : '';
  if (type === 'request.done') return `[done] ${data.answerLength ?? 0} chars · ${Array.isArray(data.artifacts) ? data.artifacts.length : 0} artifact(s)`;
  if (type === 'request.error') return `[error] ${data.message || 'request failed'}`;
  if (type === 'artifact.downloading') return `[artifact] downloading ${data.name || data.artifactId || 'artifact'}${data.sourceClientId ? ` · source ${data.sourceClientId}` : ''}`;
  if (type === 'artifact.downloaded') return `[artifact] downloaded ${data.name || data.fileId || data.artifactId || 'artifact'}${data.size ? ` · ${bytes(data.size)}` : ''}`;
  if (type === 'result.validating') return `[result] selecting ZIP artifact${data.artifactId ? ` · ${data.artifactId}` : ''}${data.artifactCount != null ? ` · ${data.artifactCount} candidate(s)` : ''}`;
  if (type === 'result.artifact.metadata_fallback_selected') return `[result] ZIP filename missing in DOM; validating scoped file action${data.selected?.name ? ` · ${data.selected.name}` : ''}`;
  if (type === 'result.artifact.metadata_fallback_ambiguous') return `[result] multiple file actions are visible, but none is an unambiguous ZIP`;
  if (type === 'result.validation.started') return `[result] validating ZIP ${data.name || data.fileId || data.artifactId || ''}${data.size ? ` · ${bytes(data.size)}` : ''}`;
  if (type === 'result.validated') return `[result] ZIP validation passed · ${data.entries ?? 0} entries${data.totalUncompressedSize ? ` · ${bytes(data.totalUncompressedSize)} unpacked` : ''}`;
  if (type === 'result.validation_failed') return `[result] ZIP validation failed: ${data.message || data.code || 'unknown error'}`;
  if (type === 'result.ready') return `[result] ready ${data.name || ''} · ${bytes(data.size)}${data.zip?.entries ? ` · ${data.zip.entries} entries` : ''}`;
  if (type === 'apply/skipped') return `[apply] auto-apply skipped: ${data.reason || 'requires confirmation'}${data.filesToUpdate || data.filesToCreate || data.filesToDelete ? ` · +${data.filesToCreate || 0} ~${data.filesToUpdate || 0} -${data.filesToDelete || 0}` : ''}`;
  if (type === 'apply/done') return `[apply] applied · +${data.created || 0} ~${data.updated || 0} -${data.deleted || 0}${data.skipped ? ` · !${data.skipped} skipped` : ''}`;

  if (level === 'verbose' && !/^(thinking|answer)\./.test(type)) {
    return `[event] ${type}${data.message ? ` · ${data.message}` : ''}`;
  }

  return '';
}
