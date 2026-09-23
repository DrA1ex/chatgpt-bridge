// Composer editing and generation-control DOM commands.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createComposerCommands(deps = {}) {
    const {
      CONFIG,
      DOM_PARSER,
      conversationIdFromUrl,
      delay,
      diagnostic,
      emitChatEvent,
      emitRequestProgress,
      getActiveRequest,
      getTurnNodes,
      isGenerating,
      isPrimaryChatSurfaceElement,
      isVisible,
      normalizeComparable,
      setRequestPhase,
      turnKey,
      turnRole,
      visibleText,
      waitForChatPageReady,
    } = deps;

function promptSubmissionEvidence(request, baselineTurnKeys, message, composerBefore, options = {}) {
  const requireUserTurn = options.requireUserTurn === true;
  const turns = getTurnNodes();
  const newUserTurns = turns
    .map((turn, index) => ({
      turn,
      index,
      key: turnKey(turn, index),
      role: turnRole(turn),
      text: visibleText(turn),
    }))
    .filter((item) => item.role === 'user' && item.key && !baselineTurnKeys.has(item.key));
  const newUserTurn = newUserTurns.findLast((item) => DOM_PARSER.userTurnMatchesExpectedText(item.text, message));
  if (newUserTurn) return { confirmed: true, reason: 'new_user_turn', turnKey: newUserTurn.key, turnIndex: newUserTurn.index };
  if (newUserTurns.length) {
    return {
      confirmed: false,
      reason: 'new_user_turn_text_mismatch',
      turnKey: newUserTurns.at(-1)?.key || '',
      turnIndex: newUserTurns.at(-1)?.index ?? -1,
    };
  }

  const currentComposer = findComposer();
  if (!requireUserTurn && message.trim() && composerBefore && (!currentComposer || !composerContainsText(currentComposer, message))) {
    return { confirmed: true, reason: 'composer_cleared' };
  }

  if (!requireUserTurn && !baselineTurnKeys.size && (findStopButton() || isGenerating())) {
    return { confirmed: true, reason: 'generation_started' };
  }
  return { confirmed: false, reason: 'no_submission_evidence' };
}

function createPromptSubmissionEvidenceWaiter(request, baselineTurnKeys, message, composerBefore, timeoutMs, options = {}) {
  const started = Date.now();
  const target = findChatMain() || document.body || document.documentElement;
  let observer = null;
  let timer = null;
  let settled = false;
  let lastEvidence = promptSubmissionEvidence(request, baselineTurnKeys, message, composerBefore, options);
  let resolvePromise = null;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });

  const finish = (evidence) => {
    if (settled) return;
    settled = true;
    observer?.disconnect?.();
    if (timer) clearTimeout(timer);
    resolvePromise({ ...evidence, waitedMs: Date.now() - started });
  };

  const inspect = () => {
    if (settled) return lastEvidence;
    lastEvidence = promptSubmissionEvidence(request, baselineTurnKeys, message, composerBefore, options);
    if (lastEvidence.confirmed) finish(lastEvidence);
    return lastEvidence;
  };

  if (target && typeof MutationObserver === 'function') {
    observer = new MutationObserver(() => inspect());
    observer.observe(target, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-disabled', 'data-testid', 'disabled', 'value'],
    });
  }

  timer = setTimeout(() => finish({
    confirmed: false,
    reason: 'submission_ack_timeout',
    lastReason: lastEvidence?.reason || 'no_submission_evidence',
  }), timeoutMs);

  return Object.freeze({
    async wait() {
      const immediate = inspect();
      if (immediate.confirmed) return { ...immediate, waitedMs: Date.now() - started };
      return await promise;
    },
    cancel() {
      if (settled) return;
      settled = true;
      observer?.disconnect?.();
      if (timer) clearTimeout(timer);
      resolvePromise({ confirmed: false, reason: 'submission_evidence_wait_cancelled', waitedMs: Date.now() - started });
    },
  });
}

async function waitForPromptSubmissionEvidence(request, baselineTurnKeys, message, composerBefore, timeoutMs) {
  return await createPromptSubmissionEvidenceWaiter(request, baselineTurnKeys, message, composerBefore, timeoutMs).wait();
}

function resolveSubmissionAckTimeoutMs(request, kind = 'prompt') {
  const general = Math.max(1_000, Number(request?.options?.promptSubmitAckTimeoutMs || CONFIG.promptSubmitAckTimeoutMs) || CONFIG.promptSubmitAckTimeoutMs);
  if (String(kind) !== 'steer') return general;
  const steer = Math.max(1_000, Number(request?.options?.steerSubmitAckTimeoutMs || CONFIG.steerSubmitAckTimeoutMs) || CONFIG.steerSubmitAckTimeoutMs);
  return Math.max(general, steer);
}

function resolveSteerSubmitReadyTimeoutMs(request) {
  return Math.max(2_000, Number(request?.options?.steerSubmitReadyTimeoutMs || CONFIG.steerSubmitReadyTimeoutMs) || CONFIG.steerSubmitReadyTimeoutMs || 30_000);
}

function composerTextValue(element) {
  if (!element) return '';
  return String(element.value ?? element.innerText ?? element.textContent ?? '');
}

function restoreComposerText(element, value = '') {
  if (!element) return;
  const text = String(value || '');
  if (!text) {
    clearComposerElement(element);
    return;
  }
  setComposerTextByNativeValue(element, text);
}

async function waitForSteerSubmitButton(request, timeoutMs = resolveSteerSubmitReadyTimeoutMs(request)) {
  const started = Date.now();
  const target = findComposerRootStrict() || findChatMain() || document.body || document.documentElement;
  let observer = null;
  let timer = null;
  let settled = false;
  let lastDiagnosticAt = 0;
  let resolvePromise = null;
  let rejectPromise = null;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const cleanup = () => {
    observer?.disconnect?.();
    if (timer) clearTimeout(timer);
  };
  const succeed = (button) => {
    if (settled) return;
    settled = true;
    cleanup();
    const waitedMs = Date.now() - started;
    diagnostic('steer.submit.ready', {
      requestId: request?.requestId || '',
      waitedMs,
      label: button.getAttribute?.('aria-label') || button.getAttribute?.('title') || button.getAttribute?.('data-testid') || '',
    });
    resolvePromise({ button, waitedMs });
  };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPromise(error);
  };
  const inspect = () => {
    if (settled) return;
    const roots = [findComposerRootStrict()].filter(Boolean);
    const button = findSendButton(roots);
    if (button) {
      succeed(button);
      return;
    }

    const stopVisible = Boolean(findStopButton(roots));
    const responseFinalized = Boolean(!stopVisible && findRegenerateButton(finalizationControlRoots(request)));
    if (responseFinalized) {
      const error = new Error('STEER_WINDOW_CLOSED: ChatGPT completed the response before a steering send control became available');
      error.code = 'STEER_WINDOW_CLOSED';
      error.retryable = false;
      error.provenNotExecuted = true;
      error.cancellationEvidence = { source: 'composer', reason: 'response_finalized_before_steer_submit' };
      fail(error);
      return;
    }

    const now = Date.now();
    if (!lastDiagnosticAt || now - lastDiagnosticAt >= 2_000) {
      lastDiagnosticAt = now;
      diagnostic('steer.submit.waiting', {
        requestId: request?.requestId || '',
        waitedMs: now - started,
        timeoutMs,
        stopButtonVisible: stopVisible,
        sendButtonVisible: false,
      });
      emitRequestProgress(request, null, stopVisible, 'steer.submit.waiting', {
        force: true,
        meaningful: false,
        sendButtonVisible: false,
      });
    }
  };

  if (target && typeof MutationObserver === 'function') {
    observer = new MutationObserver(() => inspect());
    observer.observe(target, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-disabled', 'aria-label', 'data-testid', 'disabled'],
    });
  }
  timer = setTimeout(() => {
    const error = new Error(`STEER_SUBMIT_NOT_READY: ChatGPT did not expose an enabled steering send control within ${timeoutMs}ms`);
    error.code = 'STEER_SUBMIT_NOT_READY';
    error.retryable = true;
    error.provenNotExecuted = true;
    error.cancellationEvidence = { source: 'composer', reason: 'steer_send_control_not_available' };
    fail(error);
  }, timeoutMs);
  inspect();
  return await promise;
}

async function waitForPromptSendButton(request, timeoutMs = 2_000) {
  const started = Date.now();
  const limit = Math.max(250, Number(timeoutMs) || 2_000);
  let lastDiagnosticAt = 0;
  while (Date.now() - started < limit) {
    const button = findSendButton([findComposerRootStrict()].filter(Boolean));
    if (button) {
      diagnostic('prompt.submit.ready', {
        requestId: request?.requestId || '',
        waitedMs: Date.now() - started,
        label: button.getAttribute?.('aria-label') || button.getAttribute?.('title') || button.getAttribute?.('data-testid') || '',
      });
      return button;
    }
    const now = Date.now();
    if (!lastDiagnosticAt || now - lastDiagnosticAt >= 1_000) {
      lastDiagnosticAt = now;
      diagnostic('prompt.submit.waiting', {
        requestId: request?.requestId || '',
        waitedMs: now - started,
        timeoutMs: limit,
        sendButtonVisible: false,
      });
    }
    await delay(Math.min(100, Math.max(1, limit - (Date.now() - started))));
  }
  return null;
}

async function enterPrompt(message, request, options = {}) {
  const kind = String(options.kind || 'prompt');
  const ackTimeoutMs = resolveSubmissionAckTimeoutMs(request, kind);
  const baselineTurnKeys = new Set(getTurnNodes().map((turn, index) => turnKey(turn, index)).filter(Boolean));

  // Passive wakes must be proved by a new user turn. A cleared composer alone
  // is not enough: the modern ChatGPT form can clear itself after a no-op
  // submit while no message was actually posted.
  const evidenceOptions = kind === 'passive' ? { requireUserTurn: true } : {};
  const existingEvidence = promptSubmissionEvidence(request, baselineTurnKeys, message, null, evidenceOptions);
  if (existingEvidence.confirmed) {
    diagnostic('prompt.submit.already_confirmed', { requestId: request.requestId, kind, ...existingEvidence });
    return existingEvidence;
  }

  await waitForChatPageReady(request, { stage: `${kind}.submit`, settleMs: 350 });
  const composer = await waitForComposer(request);
  const composerBeforeText = composerTextValue(composer);
  if (!findChatMain()) {
    throw new Error('DOM_SCHEMA_CHANGED: Chat conversation root is missing. Refusing to submit without a scoped DOM observation root.');
  }
  let preparedSubmitButton = null;
  if (message.trim()) {
    preparedSubmitButton = (await focusAndSetComposerText(composer, message, request))?.button || null;
    diagnostic('composer.filled', { requestId: request.requestId, kind, length: message.length });
  } else {
    composer.focus();
  }

  await delay(160);
  let method = '';
  let evidenceWaiter = null;
  try {
    if (kind === 'steer') {
      const ready = await waitForSteerSubmitButton(request);
      evidenceWaiter = createPromptSubmissionEvidenceWaiter(request, baselineTurnKeys, message, composer, ackTimeoutMs, evidenceOptions);
      method = submitComposer(composer, request, { kind, attempt: 1, button: ready.button });
    } else {
      evidenceWaiter = createPromptSubmissionEvidenceWaiter(request, baselineTurnKeys, message, composer, ackTimeoutMs, evidenceOptions);
      // ChatGPT's current ProseMirror composer updates its submit control
      // asynchronously after the input event. Give React a short bounded
      // window to expose the real button before falling back to form/keyboard
      // submission; submitting the form while its state is still empty is a
      // silent no-op on that surface.
      // React may replace the button during the final composer render. Prefer
      // a fresh control immediately before the click and only use the earlier
      // reference as a bounded fallback.
      const readyButton = await waitForPromptSendButton(request, 1_000) || preparedSubmitButton;
      method = submitComposer(composer, request, {
        kind,
        attempt: 1,
        button: readyButton || undefined,
        onSubmissionBoundary: options.onSubmissionBoundary,
      });
    }
  } catch (error) {
    evidenceWaiter?.cancel?.();
    if (kind === 'steer' && error?.provenNotExecuted === true) {
      try { restoreComposerText(composer, composerBeforeText); } catch {}
      diagnostic('steer.submit.rolled_back', {
        requestId: request?.requestId || '',
        code: String(error?.code || ''),
        restoredLength: composerBeforeText.length,
      });
    }
    throw error;
  }
  const evidence = await evidenceWaiter.wait();
  diagnostic('prompt.submit.attempt', { requestId: request.requestId, kind, attempt: 1, method, ...evidence });
  emitChatEvent(request, evidence.confirmed ? 'prompt.submit.confirmed' : 'prompt.submit.uncertain', {
    kind, attempt: 1, method, ...evidence,
  });
  if (evidence.confirmed) return evidence;

  const currentComposer = findComposer();
  const textStillPresent = Boolean(message.trim() && currentComposer && composerContainsText(currentComposer, message));
  const generationActive = Boolean(findStopButton() || isGenerating());
  if (textStillPresent && !generationActive) {
    try { restoreComposerText(currentComposer, composerBeforeText); } catch {}
    diagnostic('prompt.submit.rolled_back', {
      requestId: request?.requestId || '',
      kind,
      code: 'PROMPT_SUBMIT_NOT_EXECUTED',
      restoredLength: composerBeforeText.length,
    });
    const error = new Error(`PROMPT_SUBMIT_NOT_EXECUTED: ChatGPT kept the ${kind} text in the composer and did not start generation`);
    error.code = 'PROMPT_SUBMIT_NOT_EXECUTED';
    error.retryable = true;
    error.provenNotExecuted = true;
    error.cancellationEvidence = { source: 'composer', reason: 'submitted_text_remained_without_generation' };
    throw error;
  }

  const error = new Error(`PROMPT_SUBMIT_UNCERTAIN: ChatGPT did not expose proof for the ${kind} submission; automatic retry is forbidden`);
  error.code = 'PROMPT_SUBMIT_UNCERTAIN';
  error.retryable = false;
  throw error;
}

function submitComposer(composer, request, options = {}) {
  const kind = String(options.kind || 'prompt');
  const attempt = Number(options.attempt || 1);
  const composerRoot = findComposerRootStrict();
  const button = options.button || findSendButton([composerRoot].filter(Boolean));
  if (button) {
    diagnostic('send_button.found', { requestId: request.requestId, kind, attempt, label: button.getAttribute('aria-label') || button.getAttribute('title') || button.getAttribute('data-testid') || '' });
    options.onSubmissionBoundary?.();
    button.click();
    return 'button';
  }

  if (kind === 'steer') {
    const error = new Error('STEER_SUBMIT_NOT_READY: ChatGPT steering send control is not available');
    error.code = 'STEER_SUBMIT_NOT_READY';
    error.retryable = true;
    error.provenNotExecuted = true;
    error.cancellationEvidence = { source: 'composer', reason: 'steer_send_control_missing' };
    diagnostic('send_button.not_found_steer_blocked', { requestId: request.requestId, kind, attempt });
    throw error;
  }

  const form = composer.closest?.('form') || (composerRoot?.tagName === 'FORM' ? composerRoot : composerRoot?.closest?.('form')) || null;
  if (form && typeof form.requestSubmit === 'function') {
    diagnostic('send_button.not_found_form_submit_fallback', { requestId: request.requestId, kind, attempt });
    options.onSubmissionBoundary?.();
    form.requestSubmit();
    return 'form_request_submit';
  }

  diagnostic('send_button.not_found_keyboard_fallback', { requestId: request.requestId, kind, attempt });
  options.onSubmissionBoundary?.();
  composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true, cancelable: true }));
  composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true, cancelable: true }));
  return 'keyboard';
}

function waitForComposer(request, timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const composer = findComposer();
      if (composer) {
        diagnostic('composer.found', { requestId: request.requestId, tagName: composer.tagName, role: composer.getAttribute('role') || '', testId: composer.getAttribute('data-testid') || '' });
        resolve(composer);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        diagnostic('composer.not_found', { requestId: request.requestId, timeoutMs });
        reject(new Error('DOM_SCHEMA_CHANGED: ChatGPT composer is missing or ambiguous. Verify login state and current ChatGPT markup.'));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

const EDITABLE_CONTENT_SELECTOR = '[contenteditable]:not([contenteditable="false"])';
const COMPOSER_PRIMARY_SELECTOR = '#prompt-textarea[contenteditable]:not([contenteditable="false"]), textarea#prompt-textarea';

function isEditableComposerElement(element) {
  if (!element) return false;
  if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') return !element.disabled && !element.readOnly;
  const editable = String(element.getAttribute?.('contenteditable') || '').trim().toLowerCase();
  return editable === 'true' || editable === 'plaintext-only' || (editable !== 'false' && element.isContentEditable === true);
}

function usableComposerCandidates(selector, root = document) {
  return Array.from(root.querySelectorAll(selector))
    .filter((element) => isEditableComposerElement(element)
      && isPrimaryChatSurfaceElement(element)
      && isVisible(element)
      && !element.disabled
      && !element.readOnly);
}

function findComposer() {
  const primary = usableComposerCandidates(COMPOSER_PRIMARY_SELECTOR);
  if (primary.length === 1) return primary[0];
  if (primary.length > 1) {
    diagnostic('dom_schema.composer_ambiguous', { selector: COMPOSER_PRIMARY_SELECTOR, count: primary.length });
    return null;
  }

  const roots = Array.from(document.querySelectorAll('form, [data-testid*="composer" i], [data-type="unified-composer"]'))
    .filter((root) => isVisible(root) && root.querySelector(`${EDITABLE_CONTENT_SELECTOR}, textarea`));
  const candidates = [];
  const seen = new Set();
  const add = (element) => {
    if (!element || seen.has(element)) return;
    seen.add(element);
    candidates.push(element);
  };
  for (const root of roots) {
    for (const element of usableComposerCandidates(`[role="textbox"]${EDITABLE_CONTENT_SELECTOR}`, root)) add(element);
    for (const element of usableComposerCandidates('textarea[name="prompt-textarea"], textarea[aria-label], textarea[data-testid*="prompt" i]', root)) add(element);
    for (const element of usableComposerCandidates(`.ProseMirror${EDITABLE_CONTENT_SELECTOR}`, root)) add(element);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) diagnostic('dom_schema.composer_ambiguous', { selector: 'composer scoped fallback', count: candidates.length });
  return null;
}

async function focusAndSetComposerText(element, text, request) {
  element.focus();
  await delay(20);

  const attempts = [
    { name: 'page_main', apply: () => setComposerTextByPageMain(element, text, request) },
    { name: 'paste', apply: () => setComposerTextByPaste(element, text) },
    { name: 'exec_command', apply: () => setComposerTextByExecCommand(element, text) },
    { name: 'text_content', apply: () => setComposerTextByTextContent(element, text) },
    { name: 'native_value', apply: () => setComposerTextByNativeValue(element, text) },
  ];

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    let result;
    try { result = await attempt.apply(); } catch (error) {
      diagnostic('composer.text_method_failed', {
        requestId: request.requestId,
        method: attempt.name,
        message: String(error?.message || error).slice(0, 160),
      });
      continue;
    }
    if (result && result.ok === false) {
      diagnostic('composer.text_method_failed', {
        requestId: request.requestId,
        method: attempt.name,
        message: String(result.error || 'page main world did not verify composer text').slice(0, 160),
      });
      continue;
    }
    await delay(80);
    if (composerContainsText(element, text)) {
      // The DOM can contain text while the React/ProseMirror state is still
      // empty. Accept a setter only after ChatGPT exposes its real send
      // control; otherwise the form fallback is a silent no-op on the modern
      // composer.
      const button = await waitForPromptSendButton(request, 900);
      if (button) {
        diagnostic('composer.text_verified', {
          requestId: request.requestId,
          method: attempt.name,
          length: text.length,
          sendReady: true,
        });
        return { button, method: attempt.name };
      }
      diagnostic('composer.text_not_submit_ready', {
        requestId: request.requestId,
        method: attempt.name,
        length: text.length,
        sendReady: false,
      });
      clearComposerElement(element);
    }
  }

  diagnostic('composer.text_verify_failed', {
    requestId: request.requestId,
    expectedLength: text.length,
    actualLength: visibleText(element).length,
    reason: 'send_control_not_ready_after_bounded_setter_attempts',
  });
  throw new Error('COMPOSER_TEXT_VERIFY_FAILED: ChatGPT did not expose an enabled send control after bounded composer input attempts');
}

function setComposerTextByPaste(element, text) {
  clearComposerElement(element);
  const data = new DataTransfer();
  data.setData('text/plain', text);
  const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
  element.dispatchEvent(event);
}

function setComposerTextByNativeValue(element, text) {
  if (!(element.tagName === 'TEXTAREA' || element.tagName === 'INPUT')) return;
  const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  descriptor?.set?.call(element, '');
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
  descriptor?.set?.call(element, text);
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function setComposerTextByExecCommand(element, text) {
  clearComposerElement(element);
  // ProseMirror's current ChatGPT composer derives its transaction from the
  // browser editing boundary.  A synthetic `input` after a DOM write can
  // leave the visible text present while React still owns an empty editor
  // state, which makes the send control stay in its voice state.  Re-arm a
  // collapsed selection and emit the same beforeinput -> edit -> input
  // sequence used by a normal text insertion before trying the browser's
  // editing command path.
  try {
    element.focus?.();
    const selection = window.getSelection?.();
    const range = document.createRange?.();
    if (selection && range) {
      range.selectNodeContents(element);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  } catch {}
  element.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: text,
  }));
  if (document.execCommand) document.execCommand('insertText', false, text);
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
}

function setComposerTextByPageMain(element, text, request) {
  if (!element || !(element.isContentEditable || element.getAttribute?.('contenteditable'))) return { ok: false, error: 'not_contenteditable' };
  const requestId = `composer-main-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(result && typeof result === 'object' ? result : { ok: false, error: 'invalid_main_world_result' });
    };
    const onMessage = (event) => {
      if (event.source !== window || event.data?.source !== 'chatgpt-bridge-composer-main-v1' || event.data?.type !== 'composer.set.result' || String(event.data.requestId || '') !== requestId) return;
      finish(event.data.result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'main_world_composer_timeout' }), 1_200);
    window.addEventListener('message', onMessage);
    window.postMessage({ source: 'chatgpt-bridge-composer-content-v1', type: 'composer.set', requestId, text: String(text || ''), diagnosticRequestId: request?.requestId || '' }, '*');
  });
}

function setComposerTextByTextContent(element, text) {
  clearComposerElement(element);
  if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') element.value = text;
  else element.textContent = text;
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function clearComposerElement(element) {
  element.focus();
  if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
    element.value = '';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
    return;
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
  if (document.execCommand) document.execCommand('delete', false);
  if (visibleText(element)) element.textContent = '';
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
}

function composerContainsText(element, text) {
  const expected = normalizeComparable(text).slice(0, 2000);
  const actual = normalizeComparable(element.value || element.innerText || element.textContent || '');
  return expected ? actual.includes(expected.slice(0, Math.min(expected.length, 200))) : true;
}


function buttonSignalText(element) {
  const text = [
    element?.getAttribute?.('data-testid'),
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('title'),
    element?.getAttribute?.('data-state'),
    element?.getAttribute?.('placeholder'),
    element?.textContent || '',
  ].filter(Boolean).join(' ');
  return text.length > 500 ? text.slice(0, 500) : text;
}

function scopedQueryAll(roots, selector) {
  const result = [];
  const seen = new Set();
  for (const root of roots || []) {
    if (!root || seen.has(root)) continue;
    seen.add(root);
    try {
      if (root.matches?.(selector)) result.push(root);
      result.push(...Array.from(root.querySelectorAll?.(selector) || []));
    } catch {
      // Ignore selector/root combinations that become invalid during DOM churn.
    }
  }
  return result;
}

function isUsableChatSurface(element) {
  return Boolean(element)
    && element.isConnected !== false
    && isPrimaryChatSurfaceElement(element)
    && isVisible(element);
}

function findChatMain() {
  const composer = findComposer();
  const composerMain = composer?.closest?.('main, [role="main"]') || null;
  if (isUsableChatSurface(composerMain)) return composerMain;

  const candidates = Array.from(document.querySelectorAll('main, [role="main"]'))
    .filter(isUsableChatSurface);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const scored = candidates.map((element, index) => ({
      element,
      index,
      score: (composer && element.contains?.(composer) ? 1000 : 0)
        + Math.min(100, Number(element.querySelectorAll?.('[data-testid^="conversation-turn-"], section[data-turn], [data-message-author-role]').length || 0) * 10),
    })).sort((a, b) => b.score - a.score || a.index - b.index);
    if (scored[0].score > scored[1].score) return scored[0].element;
    diagnostic('dom_schema.chat_main_ambiguous', { count: candidates.length, topScore: scored[0].score });
    return null;
  }

  // Some ChatGPT layouts expose the composer inside a page surface without a
  // semantic <main>. Keep readiness scoped to that verified composer surface
  // instead of blocking the entire request before model or prompt handling.
  const composerRoot = composer?.closest?.('form, [data-testid*="composer" i], [data-type="unified-composer"]') || null;
  const derived = composerRoot?.closest?.('[data-testid="conversation-page"], [data-testid="chat-page"], [data-chat-root], [role="presentation"]')
    || composerRoot?.parentElement
    || null;
  if (isUsableChatSurface(derived)) {
    diagnostic('dom_schema.chat_main_derived_from_composer', {
      tagName: derived.tagName || '',
      testId: derived.getAttribute?.('data-testid') || '',
    });
    return derived;
  }
  return null;
}

function findTurnByKey(key, preferredIndex = -1) {
  if (!key) return null;
  const turns = getTurnNodes();
  const index = Number(preferredIndex);
  if (Number.isInteger(index) && index >= 0 && index < turns.length && turnKey(turns[index], index) === key) return turns[index];
  for (let cursor = turns.length - 1; cursor >= 0; cursor -= 1) {
    if (turnKey(turns[cursor], cursor) === key) return turns[cursor];
  }
  return null;
}

function findComposerRootStrict() {
  const composer = findComposer();
  if (!composer) return null;
  return composer.closest('form')
    || composer.closest('[data-testid*="composer" i]')
    || composer.closest('[role="presentation"]')
    || composer.parentElement?.parentElement?.parentElement
    || composer.parentElement
    || null;
}

function finalizationControlRoots(request, snapshot = {}) {
  const roots = [];
  const add = (node) => { if (node && !roots.includes(node)) roots.push(node); };
  add(findComposerRootStrict());
  add(findTurnByKey(snapshot.turnKey || request?.assistantTurnKey || ''));
  if (!roots.length) {
    const main = findChatMain();
    if (main) add(main);
  }
  return roots;
}

function findButtonBySignal(roots, pattern, selectors = []) {
  for (const selector of selectors) {
    const found = scopedQueryAll(roots, selector).find(isUsableButton);
    if (found) return found;
  }
  return scopedQueryAll(roots, 'button, [role="button"]').find((element) => {
    if (!isPrimaryChatSurfaceElement(element) || !isUsableButton(element)) return false;
    return pattern.test(buttonSignalText(element));
  }) || null;
}

function findStopButton(roots = [document]) {
  return findButtonBySignal(roots, /stop[-_ ]?(button|generating|streaming)|\bstop\b|остановить|停止/i, [
    '[data-testid*="stop" i]',
    'button[aria-label*="Stop" i]',
    '[role="button"][aria-label*="Stop" i]',
  ]);
}

function findSendButton(roots = [document]) {
  const sendPattern = /send[-_ ]?(button|message|prompt)?|submit|arrow-up|paper-airplane|отправ|послать|发送|送信/i;
  const stopPattern = /stop[-_ ]?(button|generating|streaming)|\bstop\b|остановить|停止/i;
  const selectors = [
    '[data-testid="send-button"]',
    '[data-testid*="send" i]',
    'button[aria-label*="Send" i]',
    '[role="button"][aria-label*="Send" i]',
    'button[type="submit"]',
    '[role="button"][type="submit"]',
  ];

  for (const selector of selectors) {
    const found = scopedQueryAll(roots, selector).find((element) => {
      if (!isUsableButton(element)) return false;
      return !stopPattern.test(buttonSignalText(element));
    });
    if (found) return found;
  }

  return scopedQueryAll(roots, 'button, [role="button"]').find((element) => {
    if (!isPrimaryChatSurfaceElement(element) || !isUsableButton(element)) return false;
    const signal = buttonSignalText(element);
    return sendPattern.test(signal) && !stopPattern.test(signal);
  }) || null;
}

function findRegenerateButton(roots = [document]) {
  return findButtonBySignal(roots, /regenerate|retry|try again|rerun|repeat|повтор|сгенерировать снова|заново|もう一度/i, [
    '[data-testid*="regenerate" i]',
    '[data-testid*="retry" i]',
    'button[aria-label*="Regenerate" i]',
    'button[aria-label*="Retry" i]',
  ]);
}

function findContinueButton(roots = [document]) {
  return findButtonBySignal(roots, /continue|keep going|resume|продолж|возобнов|続け/i, [
    '[data-testid*="continue" i]',
    'button[aria-label*="Continue" i]',
    '[role="button"][aria-label*="Continue" i]',
  ]);
}

function findSteerControl(roots = finalizationControlRoots(getActiveRequest())) {
  const selector = [
    '[data-testid*="steer" i]',
    '[data-testid*="guidance" i]',
    '[aria-label*="steer" i]',
    '[aria-label*="guide" i]',
    '[aria-label*="guidance" i]',
    '[aria-label*="direct" i]',
    '[aria-label*="interrupt" i]',
    '[placeholder*="steer" i]',
    '[placeholder*="guide" i]',
    '[placeholder*="guidance" i]',
    '[placeholder*="уточ" i]',
    '[placeholder*="направ" i]',
    '[aria-label*="уточ" i]',
    '[aria-label*="направ" i]',
    '[aria-label*="скоррект" i]',
  ].join(',');
  return scopedQueryAll(roots, selector).find((element) => {
    if (!isVisible(element)) return false;
    const text = [
      element.getAttribute?.('data-testid'),
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
      element.getAttribute?.('placeholder'),
      element.tagName === 'TEXTAREA' || element.tagName === 'INPUT' ? element.value : '',
    ].filter(Boolean).join(' ');
    return /steer|guide|guidance|direct|interrupt|nudge|уточн|направ|скоррект|подправ|вмешат|рули|настрой ход/i.test(text);
  }) || null;
}

function readFinalizationSignals(request, snapshot = {}, generating = false) {
  const roots = finalizationControlRoots(request, snapshot);
  const stopButtonVisible = Boolean(snapshot.stopVisible || generating || findStopButton(roots));
  const sendButtonVisible = Boolean(snapshot.sendVisible || findSendButton(roots));
  const regenerateButtonVisible = Boolean(findRegenerateButton(roots));
  const continueButtonVisible = Boolean(snapshot.needsContinue || findContinueButton(roots));
  const steerControlVisible = Boolean(findSteerControl(roots));
  const actionBarVisible = Boolean(snapshot.actionBarVisible);
  const hasFinalMessage = Boolean(snapshot.hasFinalMessage);
  const hasActiveTool = Boolean(snapshot.hasActiveTool);
  const needsConfirmation = Boolean(snapshot.needsConfirmation);
  const hasError = Boolean(snapshot.hasError);
  const expectedConversationId = conversationIdFromUrl(request?.options?.sessionId || '') || String(request?.options?.sessionId || '');
  const conversationMatches = !expectedConversationId || !snapshot.conversationId || snapshot.conversationId === expectedConversationId;
  const artifactReady = Array.isArray(snapshot.artifacts) && snapshot.artifacts.length > 0;
  const terminalMarkerVisible = Boolean((hasFinalMessage || artifactReady) && !stopButtonVisible && !hasActiveTool && !continueButtonVisible && !needsConfirmation && !hasError && conversationMatches);
  // Continue/Steer are interactive continuation controls. Confirmation is a
  // separate lifecycle state and must never age out into a completed answer.
  const interactiveContinuation = Boolean(continueButtonVisible || steerControlVisible);
  return {
    stopButtonVisible,
    sendButtonVisible,
    regenerateButtonVisible,
    continueButtonVisible,
    steerControlVisible,
    actionBarVisible,
    hasFinalMessage,
    hasActiveTool,
    needsConfirmation,
    hasError,
    conversationMatches,
    terminalMarkerVisible,
    interactiveContinuation,
    artifactReady,
    finalizationConfidence: terminalMarkerVisible
      ? (actionBarVisible || regenerateButtonVisible ? 'high' : 'medium')
      : (interactiveContinuation || hasError || !conversationMatches ? 'low' : 'medium'),
  };
}

function shouldDeferFinalizationForSteer(request, snapshot, signals, now) {
  if (!request || !signals?.interactiveContinuation) {
    if (request) {
      request.update('request.executor_updated', {
        steerWaitStartedAt: 0,
        steerWaitExpiredAt: 0,
      });
    }
    return false;
  }

  if (!request.steerWaitStartedAt) {
    request.update('request.executor_updated', { steerWaitStartedAt: now });
    diagnostic('generation.steer_available', {
      requestId: request.requestId,
      sendButtonVisible: signals.sendButtonVisible,
      continueButtonVisible: signals.continueButtonVisible,
      steerControlVisible: signals.steerControlVisible,
      regenerateButtonVisible: signals.regenerateButtonVisible,
      artifactCount: Array.isArray(snapshot.artifacts) ? snapshot.artifacts.length : 0,
    });
    emitChatEvent(request, 'generation.steer_available', {
      sendButtonVisible: signals.sendButtonVisible,
      continueButtonVisible: signals.continueButtonVisible,
      steerControlVisible: signals.steerControlVisible,
      regenerateButtonVisible: signals.regenerateButtonVisible,
    });
  }

  const waitForMs = now - request.steerWaitStartedAt;
  const maxWaitMs = Number(request.options?.steerContinuationSettleMs) || CONFIG.steerContinuationSettleMs;
  if (waitForMs <= maxWaitMs) {
    setRequestPhase(request, signals.steerControlVisible || signals.continueButtonVisible ? 'steer_available' : 'continuation_wait', {
      waitForMs,
      maxWaitMs,
      sendButtonVisible: signals.sendButtonVisible,
      continueButtonVisible: signals.continueButtonVisible,
      steerControlVisible: signals.steerControlVisible,
      regenerateButtonVisible: signals.regenerateButtonVisible,
      finalizationConfidence: signals.finalizationConfidence,
    });
    emitRequestProgress(request, snapshot, false, 'generation.steer_wait', {
      force: true,
      meaningful: false,
      sendButtonVisible: signals.sendButtonVisible,
      continueButtonVisible: signals.continueButtonVisible,
      steerControlVisible: signals.steerControlVisible,
      regenerateButtonVisible: signals.regenerateButtonVisible,
      finalizationConfidence: signals.finalizationConfidence,
    });
    return true;
  }

  if (!request.steerWaitExpiredAt) request.update('request.executor_updated', { steerWaitExpiredAt: now });
  diagnostic('generation.steer_wait.expired', { requestId: request.requestId, waitForMs, maxWaitMs });
  emitChatEvent(request, 'generation.steer_wait.expired', { waitForMs, maxWaitMs });
  return false;
}


function clickStopButton() {
  const button = findStopButton();
  if (!button) {
    diagnostic('stop_button.not_found', { requestId: getActiveRequest()?.requestId });
    return false;
  }
  button.click();
  diagnostic('stop_button.clicked', { requestId: getActiveRequest()?.requestId });
  return true;
}

function isUsableButton(element) {
  return Boolean(element) && isVisible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
}


    return Object.freeze({
      enterPrompt,
      promptSubmissionEvidence,
      createPromptSubmissionEvidenceWaiter,
      waitForPromptSubmissionEvidence,
      resolveSubmissionAckTimeoutMs,
      resolveSteerSubmitReadyTimeoutMs,
      waitForSteerSubmitButton,
      waitForPromptSendButton,
      submitComposer,
      findComposer,
      buttonSignalText,
      findChatMain,
      findTurnByKey,
      findComposerRootStrict,
      finalizationControlRoots,
      findStopButton,
      findSendButton,
      findContinueButton,
      readFinalizationSignals,
      shouldDeferFinalizationForSteer,
      clickStopButton,
      isUsableButton,
    });
  }

  globalThis.ChatGptComposerCommands = Object.freeze({ createComposerCommands });
})();
