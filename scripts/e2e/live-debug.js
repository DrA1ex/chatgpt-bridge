// Live browser diagnostic stream formatting for the real E2E runner.
// Kept independent from scenario orchestration so diagnostic vocabulary can evolve separately.

function parseSseBlocks(buffer, onEvent) {
  let rest = buffer;
  let index = -1;
  while ((index = rest.indexOf('\n\n')) !== -1) {
    const block = rest.slice(0, index);
    rest = rest.slice(index + 2);
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data) continue;
    try { onEvent(JSON.parse(data)); } catch {}
  }
  return rest;
}

function modelPickerDebugMessage(event = {}) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const name = String(data.name || event.type || '');
  const fields = { request: event.requestId || data.requestId || '' };
  const scope = 'model-picker';
  switch (name) {
    case 'intelligence.state.read.started':
      return ['search', scope, 'Reading current model and effort from ChatGPT UI', { ...fields, includeModels: data.includeModels }];
    case 'intelligence.picker.candidates':
      return ['search', scope, 'Located possible Intelligence menu triggers', { count: data.count }];
    case 'intelligence.picker.candidate.selected':
      return ['state', scope, 'Selected the highest-confidence Intelligence trigger', { candidate: data.index, score: data.score, signal: data.signal }];
    case 'intelligence.picker.activation':
      return ['action', scope, 'Activating Intelligence menu trigger once', { attempt: data.attempt, method: data.method, waitMs: data.waitMs }];
    case 'intelligence.picker.waiting':
      return ['wait', scope, 'Waiting for Intelligence menu to become visible and stable', { timeoutMs: data.timeoutMs, stableMs: data.stableMs }];
    case 'intelligence.picker.activation_timeout':
      return ['retry', scope, 'Intelligence menu did not open after the activation window', { attempt: data.attempt, method: data.method, elapsedMs: data.elapsedMs }];
    case 'intelligence.picker.opened':
      return ['ok', scope, 'Intelligence menu is open and stable', { method: data.method, elapsedMs: data.elapsedMs }];
    case 'intelligence.picker.not_found':
      return ['fail', scope, 'Could not open the Intelligence menu', { candidates: data.candidateCount }];
    case 'model.submenu.search.started':
      return ['search', scope, 'Looking for the transient model submenu', { trigger: data.trigger }];
    case 'model.submenu.hover.started':
      return ['action', scope, 'Hovering the current-model row to reveal the submenu', { trigger: data.trigger }];
    case 'model.submenu.waiting':
      return ['wait', scope, 'Waiting for the model submenu and option list to stabilize', { timeoutMs: data.timeoutMs, stableMs: data.stableMs }];
    case 'model.submenu.keyboard_retry':
      return ['retry', scope, 'Hover did not reveal the submenu; trying ArrowRight once', { elapsedMs: data.elapsedMs }];
    case 'model.submenu.opened':
      return ['ok', scope, 'Model submenu is visible and stable', { method: data.method, models: data.count }];
    case 'model.submenu.hover_timeout':
      return ['warn', scope, 'Model submenu did not appear during the hover window', { trigger: data.trigger }];
    case 'intelligence.options.wait.started':
      return ['wait', scope, `Waiting for ${data.kind || 'picker'} options to stabilize`, { timeoutMs: data.timeoutMs }];
    case 'intelligence.options.stable':
      return ['ok', scope, `${data.kind || 'Picker'} options are stable`, { count: data.count, elapsedMs: data.elapsedMs }];
    case 'intelligence.options.timeout':
      return ['warn', scope, `${data.kind || 'Picker'} options did not fully stabilize before timeout`, { count: data.count, elapsedMs: data.elapsedMs }];
    case 'model.selection.started':
    case 'effort.selection.started':
      return ['search', scope, `Finding requested ${data.kind || name.split('.')[0]} option`, { requested: data.label }];
    case 'model.selection.click':
    case 'effort.selection.click':
      return ['action', scope, `Clicking ${data.kind || name.split('.')[0]} option once`, { requested: data.label, matched: data.matchedLabel }];
    case 'model.selection.already_selected':
    case 'effort.selection.already_selected':
      return ['ok', scope, `Requested ${data.kind || name.split('.')[0]} was already selected`, { requested: data.label }];
    case 'model.selection.clicked':
    case 'effort.selection.clicked':
      return ['ok', scope, `${data.kind || name.split('.')[0]} option click completed`, { requested: data.label }];
    case 'model.apply.started':
      return ['step', scope, 'Applying requested model/effort settings', { model: data.model, effort: data.effort, request: data.requestId }];
    case 'model.apply.verification.started':
      return ['wait', scope, 'Reopening the picker once to verify the final combined state', { model: data.model, effort: data.effort }];
    case 'model.apply.verification.retry':
      return ['retry', scope, 'State verification failed; waiting before one read-only retry', { attempt: data.attempt, message: data.message }];
    case 'model.apply.done':
      return [(data.warnings || []).length ? 'warn' : 'ok', scope, 'Model/effort application finished', { modelApplied: data.modelApplied, effortApplied: data.effortApplied, warnings: (data.warnings || []).join(' | ') }];
    case 'intelligence.state.read':
      return ['state', scope, 'Current picker state read', { model: data.selectedModel, effort: data.selectedEffort, models: data.models?.length, efforts: data.efforts?.length }];
    default:
      return null;
  }
}

function compactBrowserDebugFields(data = {}, request = '') {
  const keys = [
    'commandId', 'requestId', 'activeRequestId', 'expectedRequestId', 'ownerServerInstanceId',
    'phase', 'previousPhase', 'reason', 'stage', 'status', 'kind', 'source', 'method', 'action',
    'attempt', 'round', 'index', 'count', 'visible', 'total', 'busy', 'removed',
    'timeoutMs', 'waitedMs', 'elapsedMs', 'sentFor', 'maxRequestTimeoutMs', 'maxWaitMs',
    'answerLength', 'thinkingLength', 'progressLength', 'artifactCount', 'artifacts',
    'turnKey', 'turnIndex', 'submittedUserTurnKey', 'assistantTurnKey', 'textLength', 'length',
    'name', 'expectedName', 'actualName', 'artifactId', 'captureId', 'downloadId', 'bytes', 'size',
    'sessionId', 'url', 'message', 'label', 'signal', 'score', 'includeModels',
  ];
  const result = request ? { request } : {};
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    const value = data[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string') result[key] = value.length > 220 ? `${value.slice(0, 217)}...` : value;
    else if (Array.isArray(value)) result[key] = value.length <= 8 ? value : [...value.slice(0, 8), `+${value.length - 8} more`];
    else if (typeof value === 'object') result[key] = '[object]';
    else result[key] = value;
  }
  return result;
}

function browserDebugMessage(event = {}) {
  const modelMessage = modelPickerDebugMessage(event);
  if (modelMessage) return modelMessage;

  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const name = String(data.name || event.type || '');
  const request = event.requestId || data.requestId || '';
  const fields = { request };
  const phaseScope = request ? `browser:${String(request).slice(-8)}` : 'browser';

  switch (name) {
    case 'prompt.accepted':
      return ['ok', phaseScope, 'Browser runtime accepted the prompt request', fields];
    case 'page.ready.wait':
      return ['wait', phaseScope, 'Waiting for the ChatGPT page and composer to become stable', { ...fields, stage: data.stage, timeoutMs: data.timeoutMs, settleMs: data.settleMs }];
    case 'page.ready.state':
      return ['state', phaseScope, 'ChatGPT page readiness snapshot', { ...fields, stage: data.stage, readyState: data.documentReadyState, chatMain: data.chatMainReady, composer: data.composerReady, url: data.url }];
    case 'page.ready':
      return ['ok', phaseScope, 'ChatGPT page and composer are stable', { ...fields, stage: data.stage, waitedMs: data.waitedMs }];
    case 'page.ready.timeout':
      return ['fail', phaseScope, 'Timed out waiting for a stable ChatGPT page', { ...fields, stage: data.stage, timeoutMs: data.timeoutMs, chatMain: data.chatMainReady, composer: data.composerReady }];
    case 'session.new.started':
      return ['action', phaseScope, 'Opening a new ChatGPT conversation', fields];
    case 'session.new.done':
      return ['ok', phaseScope, 'New ChatGPT conversation opened', { ...fields, sessionId: data.session?.id || '' }];
    case 'session.select.started':
      return ['search', phaseScope, 'Locating the requested ChatGPT conversation', { ...fields, sessionId: data.sessionId }];
    case 'session.select.done':
      return ['ok', phaseScope, 'Requested ChatGPT conversation selected', { ...fields, sessionId: data.session?.id || data.sessionId || '' }];
    case 'prompt.turn_boundary.armed':
      return ['state', phaseScope, 'Captured the pre-submit DOM boundary; only newer turns may match', { ...fields, turns: data.turnCount, baseline: data.baselineCount }];
    case 'prompt.user_turn_anchor_wait.started':
    case 'steer.user_turn_anchor_wait.started':
      return ['wait', phaseScope, 'Waiting for the newly submitted user turn to appear after the captured boundary', { ...fields, kind: name.startsWith('steer.') ? 'steer' : 'prompt', timeoutMs: data.timeoutMs, baseline: data.baselineCount, expectedTextHash: data.expectedTextHash }];
    case 'submitted_user_turn.captured':
    case 'steer_user_turn.captured':
      return ['ok', phaseScope, 'Captured the submitted user turn and anchored subsequent assistant parsing to it', { ...fields, kind: name.startsWith('steer_') ? 'steer' : 'prompt', turnKey: data.turnKey, turnIndex: data.turnIndex, textLength: data.textLength }];
    case 'prompt.user_turn_text_mismatch':
    case 'steer.user_turn_text_mismatch':
      return ['warn', phaseScope, 'A new user turn appeared, but its text did not match the submitted prompt', { ...fields, candidates: data.candidates?.length, expectedTextHash: data.expectedTextHash }];
    case 'prompt.user_turn_anchor_pending':
    case 'steer.user_turn_anchor_pending':
      return ['warn', phaseScope, 'Submitted user-turn anchor was not found before the initial wait expired; DOM monitoring continues', { ...fields, timeoutMs: data.timeoutMs, turnCount: data.turnCount }];
    case 'files.attach.started':
      return ['step', phaseScope, 'Preparing prompt attachments', { ...fields, files: data.count }];
    case 'file.prepared':
      return ['ok', phaseScope, 'Attachment prepared', { ...fields, name: data.name, size: data.size }];
    case 'file.prepare_failed':
      return ['fail', phaseScope, 'Attachment preparation failed', { ...fields, name: data.name, message: data.message }];
    case 'file.input.changed':
    case 'files.attach.changed':
      return ['state', phaseScope, 'Composer file input updated', { ...fields, files: data.count, names: data.names }];
    case 'files.attach.progress':
      return ['wait', phaseScope, 'Waiting for attachments to finish uploading', { ...fields, visible: data.visible, total: data.total, busy: data.busy }];
    case 'file.upload.complete':
    case 'files.attach.done':
      return ['ok', phaseScope, 'All prompt attachments are ready', { ...fields, names: data.names, elapsedMs: data.elapsedMs }];
    case 'composer.found':
      return ['ok', phaseScope, 'Composer input located', { ...fields, tag: data.tagName, role: data.role, testId: data.testId }];
    case 'composer.not_found':
      return ['fail', phaseScope, 'Composer input was not found', { ...fields, timeoutMs: data.timeoutMs }];
    case 'composer.filled':
      return ['action', phaseScope, 'Prompt text inserted into the composer', { ...fields, attempt: data.attempt, chars: data.length }];
    case 'composer.text_verified':
      return ['ok', phaseScope, 'Composer text matches the requested prompt', { ...fields, method: data.method, chars: data.length }];
    case 'composer.text_verify_failed':
      return ['fail', phaseScope, 'Composer text verification failed', { ...fields, expectedChars: data.expectedLength, actualChars: data.actualLength }];
    case 'send_button.found':
      return ['search', phaseScope, 'Send button located', { ...fields, attempt: data.attempt, label: data.label }];
    case 'send_button.not_found_keyboard_fallback':
      return ['retry', phaseScope, 'Send button was not found; using the single keyboard fallback', { ...fields, attempt: data.attempt }];
    case 'prompt.submit.attempt':
      return ['action', phaseScope, 'Submitting the prompt once', { ...fields, attempt: data.attempt, method: data.method, evidence: data.evidence || data.kind || '' }];
    case 'prompt.submit.already_confirmed':
      return ['ok', phaseScope, 'Prompt submission was already confirmed; no additional click is needed', { ...fields, attempt: data.attempt, kind: data.kind }];
    case 'prompt.sent':
      return ['ok', phaseScope, 'Prompt submission confirmed by ChatGPT DOM', { ...fields, attachments: data.attachmentCount }];
    case 'dom_monitor.root_attached':
      return ['search', phaseScope, 'Assistant DOM monitor attached to the scoped conversation root', { ...fields, source: data.source, turnBoundary: data.turnBoundary || '' }];
    case 'dom_monitor.started':
      return ['wait', phaseScope, 'Monitoring ChatGPT DOM for generation, reasoning, answer, and artifacts', fields];
    case 'assistant_turn.captured':
      return ['ok', phaseScope, 'Captured the new assistant turn after the submitted prompt', { ...fields, turnKey: data.turnKey, turnIndex: data.turnIndex, reason: data.reason }];
    case 'assistant_turn.not_found_after_generation':
      return ['warn', phaseScope, 'Generation changed state but the scoped assistant turn is not visible yet', { ...fields, waitedMs: data.waitedMs, phase: data.phase }];
    case 'generation.started':
      return ['state', phaseScope, 'ChatGPT generation started', fields];
    case 'generation.stopped':
      return ['ok', phaseScope, 'ChatGPT generation stopped; waiting for terminal DOM stabilization', fields];
    case 'thinking.snapshot':
      return ['state', phaseScope, 'Visible reasoning snapshot changed', { ...fields, chars: data.length, phase: data.phase }];
    case 'assistant.progress.snapshot':
      return ['state', phaseScope, 'Visible progress/status snapshot changed', { ...fields, chars: data.length, phase: data.phase, items: data.items?.length }];
    case 'answer.snapshot':
      return ['state', phaseScope, 'Visible answer snapshot changed', { ...fields, chars: data.length, phase: data.phase, format: data.format, model: data.modelSlug }];
    case 'artifact.snapshot':
      return ['search', phaseScope, 'Scanning the scoped assistant turn for artifacts', { ...fields, found: data.count }];
    case 'artifact.nonblocking_candidates_ignored':
      return ['state', phaseScope, 'Ignoring artifact-like candidates that do not belong to the required output', { ...fields, count: data.count, reason: data.reason }];
    case 'artifact.required_wait_started':
      return ['wait', phaseScope, 'Generation ended, but the required artifact is not ready yet', { ...fields, expected: data.expected, waitedMs: data.waitedMs, limitMs: data.limitMs }];
    case 'artifact.required_wait_expired':
      return ['warn', phaseScope, 'Required-artifact wait window expired', { ...fields, expected: data.expected, waitedMs: data.waitedMs, limitMs: data.limitMs }];
    case 'generation.start_timeout_warning':
      return ['warn', phaseScope, 'Prompt was sent but visible generation has not started yet', { ...fields, sentForMs: data.sentFor }];
    case 'generation.first_output_timeout_warning':
      return ['warn', phaseScope, 'Generation is active but no visible output has appeared yet', { ...fields, sentForMs: data.sentFor }];
    case 'request.phase':
      return ['state', phaseScope, 'Browser request phase changed', { ...fields, from: data.previousPhase, to: data.phase, reason: data.reason || '' }];
    case 'request.done':
      return ['ok', phaseScope, 'Browser runtime finalized the request', { ...fields, answerChars: data.answerLength, reasoningChars: data.thinkingLength, progressChars: data.progressLength, artifacts: data.artifacts, domPhase: data.domPhase }];
    case 'request.error':
      return ['fail', phaseScope, 'Browser runtime request failed', { ...fields, message: data.message }];
    case 'artifact.preview.ready':
      return ['ok', 'artifact', 'Artifact preview is ready', { ...fields, artifactId: data.artifactId, name: data.name, source: data.source }];
    case 'artifact.preview.waiting':
      return ['wait', 'artifact', 'Waiting for the selected artifact preview to become stable', { ...fields, artifactId: data.artifactId, timeoutMs: data.timeoutMs }];
    case 'artifact.preview.readiness_timeout':
      return ['warn', 'artifact', 'Artifact preview did not stabilize before timeout', { ...fields, artifactId: data.artifactId, timeoutMs: data.timeoutMs }];
    case 'artifact.action.resolved':
      return ['search', 'artifact', 'Resolved the scoped artifact action', { ...fields, artifactId: data.artifactId, name: data.name, source: data.source, candidates: data.candidateCount }];
    case 'artifact.action.clicked':
      return ['action', 'artifact', 'Clicking the selected artifact action once', { ...fields, artifactId: data.artifactId, name: data.name, source: data.source }];
    case 'artifact.download_capture.armed':
      return ['wait', 'artifact', 'Armed a Chrome download capture before clicking the artifact', { ...fields, artifactId: data.artifactId, captureId: data.captureId, timeoutMs: data.timeoutMs }];
    case 'artifact.page_capture.armed':
      return ['wait', 'artifact', 'Armed an in-page artifact capture path', { ...fields, artifactId: data.artifactId, captureId: data.captureId, timeoutMs: data.timeoutMs }];
    case 'artifact.materialization_path.failed':
      return ['retry', 'artifact', 'An artifact materialization path failed; another safe path may still succeed', { ...fields, artifactId: data.artifactId, path: data.path, message: data.message }];
    case 'artifact.download_capture.adopted':
    case 'artifact.download_capture.bound_after_materialization':
      return ['state', 'artifact', 'Adopted the concrete Chrome download for cleanup tracking', { ...fields, artifactId: data.artifactId, captureId: data.captureId, downloadId: data.downloadId }];
    case 'artifact.materialized':
      return ['ok', 'artifact', 'Artifact bytes were materialized', { ...fields, artifactId: data.artifactId, name: data.name, source: data.source, bytes: data.bytes || data.size }];
    case 'artifact.fetch.failed':
      return ['fail', 'artifact', 'Artifact fetch failed', { ...fields, artifactId: data.artifactId, name: data.name, message: data.message }];
    case 'session.delete.menu_candidates':
      return ['search', 'cleanup', 'Searching the owned conversation menu for the delete action', { sessionId: data.sessionId, round: data.round, candidates: data.count }];
    case 'session.delete.action_found':
      return ['ok', 'cleanup', 'Delete action found for the owned conversation', { sessionId: data.sessionId, round: data.round, source: data.source }];
    case 'session.delete.menu_open_failed':
      return ['retry', 'cleanup', 'Conversation menu did not open; retrying cleanup', { sessionId: data.sessionId, round: data.round, message: data.message }];
    case 'session.delete.confirmation_waiting':
      return ['wait', 'cleanup', 'Waiting for the destructive confirmation dialog', { sessionId: data.sessionId, timeoutMs: data.timeoutMs }];
    case 'session.delete.confirmation_found':
      return ['action', 'cleanup', 'Destructive confirmation action found; confirming deletion once', { sessionId: data.sessionId, label: data.label }];
    case 'session.delete.completed_during_confirmation_grace':
      return ['ok', 'cleanup', 'Conversation disappeared during confirmation grace period', { sessionId: data.sessionId }];
    case 'session.delete.confirmation_timeout':
      return ['fail', 'cleanup', 'Destructive confirmation dialog did not become available before timeout', { sessionId: data.sessionId, waitedMs: data.waitedMs, timeoutMs: data.timeoutMs }];
    case 'intelligence.state.read.started':
      return ['search', 'model-picker', 'Opening the Intelligence picker to read its normalized state', { includeModels: data.includeModels }];
    case 'intelligence.picker.candidates':
      return ['search', 'model-picker', 'Located possible Intelligence menu triggers', { count: data.count, candidates: data.candidates?.map?.((item) => `${item.score}:${item.signal}`).join(' | ') }];
    case 'intelligence.picker.candidate.selected':
      return ['state', 'model-picker', 'Selected the best-scoring Intelligence trigger candidate', { index: data.index, score: data.score, signal: data.signal }];
    case 'intelligence.picker.activation':
      return ['action', 'model-picker', 'Activating the Intelligence menu trigger once', { attempt: data.attempt, method: data.method, waitMs: data.waitMs, signal: data.signal }];
    case 'model.submenu.empty_retry':
      return ['retry', 'model-picker', 'Model submenu opened without stable options; performing one read-only hover rescan', { trigger: data.trigger, action: data.action }];
    case 'model.picker_not_found':
    case 'effort.picker_not_found':
      return ['fail', 'model-picker', 'Intelligence picker disappeared before the requested option could be selected', { ...fields, kind: name.split('.')[0], label: data.label }];
    case 'model.option_not_found_scoped':
    case 'effort.option_not_found_scoped':
      return ['fail', 'model-picker', 'Requested option was not found in the scoped stable option list', { ...fields, kind: name.split('.')[0], label: data.label, options: data.options }];
    case 'dom_schema.chat_root_missing':
      return ['warn', phaseScope, 'Scoped ChatGPT conversation root is temporarily unavailable', { ...fields, url: data.url }];
    case 'dom_schema.composer_ambiguous':
      return ['warn', phaseScope, 'Composer lookup returned multiple candidates; refusing an ambiguous action', { ...fields, selector: data.selector, count: data.count }];
    case 'dom_schema.unknown_testids':
      return ['warn', phaseScope, 'Unknown ChatGPT test IDs appeared in the scoped assistant turn', { ...fields, turnKey: data.turnKey, testIds: data.testIds }];
    case 'file.attach_button.clicked':
      return ['action', phaseScope, 'Opening the attachment file input once', fields];
    case 'file.attach_button.not_found':
      return ['warn', phaseScope, 'Attachment button was not found; checking for an already available file input', fields];
    case 'file.upload_wait.warning':
      return ['warn', phaseScope, 'Attachment readiness wait reported a warning', { ...fields, message: data.message }];
    case 'file.upload_error':
      return ['fail', phaseScope, 'ChatGPT displayed an attachment upload error', { ...fields, message: data.message }];
    case 'composer.attachments.clear':
      return ['state', phaseScope, 'Cleared visible composer attachments before the next prompt', { ...fields, removed: data.removed }];
    case 'generation.steer_available':
      return ['state', phaseScope, 'Generation exposes a safe steering window', { ...fields, sendButtonVisible: data.sendButtonVisible, steerButtonVisible: data.steerButtonVisible }];
    case 'generation.steer_wait.expired':
      return ['warn', phaseScope, 'Steering window remained available beyond the configured grace period', { ...fields, waitedMs: data.waitForMs, maxWaitMs: data.maxWaitMs }];
    case 'steer.turn.reanchored':
      return ['ok', phaseScope, 'Steered prompt was re-anchored to the new user and assistant turns', { ...fields, submittedUserTurnKey: data.submittedUserTurnKey, assistantTurnKey: data.assistantTurnKey }];
    case 'stop_button.clicked':
      return ['action', phaseScope, 'Clicking the stop-generation control once', fields];
    case 'stop_button.not_found':
      return ['warn', phaseScope, 'Stop-generation control was not found', fields];
    case 'prompt.duplicate_ignored':
      return ['state', phaseScope, 'Duplicate delivery of the same prompt was ignored', { ...fields, phase: data.phase }];
    case 'prompt.rejected_busy':
      return ['fail', phaseScope, 'Prompt was rejected because another request owns this tab', { ...fields, activeRequestId: data.activeRequestId }];
    case 'prompt.cancel_received':
      return ['action', phaseScope, 'Browser runtime received a prompt cancellation request', { ...fields, reason: data.reason }];
    case 'prompt.steered':
      return ['ok', phaseScope, 'Steering prompt was submitted and captured', { ...fields, chars: data.length, reanchored: data.reanchored }];
    case 'request.foreground_resync':
      return ['state', phaseScope, 'Tab returned to the foreground; requesting an immediate scoped DOM resync', { ...fields, reason: data.reason }];
    case 'request.max_timeout_warning':
      return ['warn', phaseScope, 'Request exceeded the configured warning threshold but generation remains active', { ...fields, sentFor: data.sentFor, maxRequestTimeoutMs: data.maxRequestTimeoutMs }];
    case 'request.resume.attached':
      return ['ok', phaseScope, 'Reattached to the active browser request', { ...fields, commandId: data.commandId }];
    case 'request.resume.no_active':
      return ['warn', phaseScope, 'Resume was requested, but this tab has no active prompt', { commandId: data.commandId }];
    case 'request.resume.request_mismatch':
      return ['fail', phaseScope, 'Resume request ID does not match the prompt active in this tab', { commandId: data.commandId, expectedRequestId: data.expectedRequestId, activeRequestId: data.activeRequestId }];
    case 'response.snapshot.active_request':
      return ['state', phaseScope, 'Read a recovery snapshot from the active request', { ...fields, phase: data.phase, answerChars: data.answerLength, artifacts: data.artifacts }];
    case 'response.snapshot.turn_key':
      return ['state', phaseScope, 'Read a recovery snapshot from the requested assistant turn key', { ...fields, turnKey: data.turnKey, answerChars: data.answerLength, artifacts: data.artifacts }];
    case 'response.recovered':
    case 'response.recovered.turnKey':
      return ['ok', phaseScope, 'Recovered a scoped assistant response from the DOM', { ...fields, turnKey: data.turnKey, turnIndex: data.turnIndex, answerChars: data.answerLength, artifacts: data.artifacts }];
    case 'response.recovered.list':
      return ['state', phaseScope, 'Enumerated recoverable assistant responses in the current conversation', { ...fields, count: data.count }];
    case 'network.done':
      return ['state', phaseScope, 'Observed the ChatGPT network request complete', { ...fields, kind: data.kind, url: data.url }];
    case 'network.error':
      return ['warn', phaseScope, 'Observed a ChatGPT network request error', { ...fields, kind: data.kind, message: data.message }];
    case 'artifact.action.target_mismatch':
      return ['fail', 'artifact', 'Resolved artifact action does not match the requested file identity', { ...fields, artifactId: data.artifactId, expectedName: data.expectedName, actualName: data.actualName }];
    case 'artifact.preview.preexisting_detected':
      return ['state', 'artifact', 'A matching artifact preview was already open before the action', { ...fields, artifactId: data.artifactId, name: data.name }];
    case 'artifact.preview.foreign_detected':
      return ['warn', 'artifact', 'A different artifact preview is open; it will not be used', { ...fields, artifactId: data.artifactId, name: data.name, observedNames: data.observedNames }];
    case 'artifact.preview.late_detected':
      return ['state', 'artifact', 'Matching artifact preview appeared after the primary materialization path completed', { ...fields, artifactId: data.artifactId, name: data.name }];
    case 'artifact.preview.late_not_seen':
      return ['state', 'artifact', 'No late artifact preview appeared during the bounded cleanup window', { ...fields, artifactId: data.artifactId, name: data.name }];
    case 'artifact.preview.download_aliases_added':
      return ['state', 'artifact', 'Added exact preview download-name aliases for capture matching', { ...fields, artifactId: data.artifactId, names: data.names }];
    case 'artifact.preview.download_clicked':
      return ['action', 'artifact', 'Clicking the preview download action once', { ...fields, artifactId: data.artifactId, name: data.name }];
    case 'artifact.preview.closed':
      return [data.closed ? 'ok' : 'warn', 'artifact', data.closed ? 'Artifact preview closed' : 'Artifact preview remained open after the close attempt', { ...fields, source: data.source, closeSource: data.closeSource }];
    case 'artifact.page_capture.unavailable':
      return ['warn', 'artifact', 'In-page artifact capture path is unavailable', { ...fields, artifactId: data.artifactId, message: data.message }];
    case 'artifact.download_capture.unavailable':
      return ['warn', 'artifact', 'Chrome download capture path is unavailable', { ...fields, artifactId: data.artifactId, message: data.message }];
    case 'artifact.download_capture.alias_update_failed':
      return ['warn', 'artifact', 'Could not update expected Chrome download aliases', { ...fields, artifactId: data.artifactId, captureId: data.captureId, message: data.message }];
    case 'artifact.download_capture.released_unbound':
      return ['state', 'artifact', 'Released an unbound Chrome capture; no physical download was adopted', { ...fields, artifactId: data.artifactId, captureId: data.captureId }];
    case 'artifact.download_capture.recovered_after_error':
      return ['retry', 'artifact', 'Primary materialization failed, but the already-bound Chrome download can be recovered safely', { ...fields, artifactId: data.artifactId, captureId: data.captureId, downloadId: data.downloadId }];
    default:
      if (!name) return null;
      return ['info', phaseScope, `Browser diagnostic: ${name}`, compactBrowserDebugFields(data, request)];
  }
}

export async function startLiveDebugTrace(options, testLog) {
  testLog('search', 'diagnostics', 'Connecting to the live browser-debug stream');
  const controller = new AbortController();
  const headers = options.apiToken ? { Authorization: `Bearer ${options.apiToken}` } : {};
  const seen = new Map();
  const done = (async () => {
    try {
      const response = await fetch(`${options.baseUrl}/debug/stream`, { headers, signal: controller.signal, cache: 'no-store' });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      testLog('ok', 'diagnostics', 'Live browser-debug stream connected');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = parseSseBlocks(buffer, (event) => {
          const mapped = browserDebugMessage(event);
          if (!mapped) return;
          const [level, scope, message, fields] = mapped;
          const eventName = String(event?.data?.name || event.type || '');
          const requestId = String(event.requestId || event?.data?.requestId || '');
          const fingerprint = JSON.stringify([eventName, requestId, fields]);
          const throttleKey = `${eventName}:${requestId}`;
          const now = Date.now();
          const highFrequency = new Set(['page.ready.state', 'answer.snapshot', 'thinking.snapshot', 'assistant.progress.snapshot', 'artifact.snapshot']);
          const throttleMs = highFrequency.has(eventName) ? 900 : 250;
          if (seen.has(fingerprint) && now - seen.get(fingerprint) < throttleMs) return;
          if (highFrequency.has(eventName) && seen.has(throttleKey) && now - seen.get(throttleKey) < throttleMs) return;
          seen.set(fingerprint, now);
          seen.set(throttleKey, now);
          testLog(level, scope, message, fields);
        });
      }
    } catch (err) {
      if (!controller.signal.aborted) testLog('warn', 'diagnostics', 'Live debug stream stopped', { message: err.message });
    }
  })();
  return {
    stop: async () => {
      controller.abort();
      await done.catch(() => {});
    },
  };
}

