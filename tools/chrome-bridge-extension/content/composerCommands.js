// Composer editing and generation-control DOM commands.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createComposerCommands(deps = {}) {
    const {
      CONFIG,
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

function promptSubmissionEvidence(request, baselineTurnKeys, message, composerBefore) {
  const turns = getTurnNodes();
  const newUserTurn = turns
    .map((turn, index) => ({ turn, index, key: turnKey(turn, index), role: turnRole(turn) }))
    .find((item) => item.role === 'user' && item.key && !baselineTurnKeys.has(item.key));
  if (newUserTurn) return { confirmed: true, reason: 'new_user_turn', turnKey: newUserTurn.key, turnIndex: newUserTurn.index };

  const currentComposer = findComposer();
  if (message.trim() && composerBefore && (!currentComposer || !composerContainsText(currentComposer, message))) {
    return { confirmed: true, reason: 'composer_cleared' };
  }

  if (!baselineTurnKeys.size && (findStopButton() || isGenerating())) {
    return { confirmed: true, reason: 'generation_started' };
  }
  return { confirmed: false, reason: 'no_submission_evidence' };
}

async function waitForPromptSubmissionEvidence(request, baselineTurnKeys, message, composerBefore, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const evidence = promptSubmissionEvidence(request, baselineTurnKeys, message, composerBefore);
    if (evidence.confirmed) return { ...evidence, waitedMs: Date.now() - started };
    await delay(120);
  }
  return { confirmed: false, reason: 'submission_ack_timeout', waitedMs: Date.now() - started };
}

async function enterPrompt(message, request, options = {}) {
  const kind = String(options.kind || 'prompt');
  const ackTimeoutMs = Math.max(1_000, Number(request?.options?.promptSubmitAckTimeoutMs || CONFIG.promptSubmitAckTimeoutMs) || CONFIG.promptSubmitAckTimeoutMs);
  const baselineTurnKeys = new Set(getTurnNodes().map((turn, index) => turnKey(turn, index)).filter(Boolean));

  const existingEvidence = promptSubmissionEvidence(request, baselineTurnKeys, message, null);
  if (existingEvidence.confirmed) {
    diagnostic('prompt.submit.already_confirmed', { requestId: request.requestId, kind, ...existingEvidence });
    return existingEvidence;
  }

  await waitForChatPageReady(request, { stage: `${kind}.submit`, settleMs: 350 });
  const composer = await waitForComposer(request);
  if (!findChatMain()) {
    throw new Error('DOM_SCHEMA_CHANGED: Chat conversation root is missing. Refusing to submit without a scoped DOM observation root.');
  }
  if (message.trim()) {
    await focusAndSetComposerText(composer, message, request);
    diagnostic('composer.filled', { requestId: request.requestId, kind, length: message.length });
  } else {
    composer.focus();
  }

  await delay(160);
  const method = submitComposer(composer, request, { kind, attempt: 1 });
  const evidence = await waitForPromptSubmissionEvidence(request, baselineTurnKeys, message, composer, ackTimeoutMs);
  diagnostic('prompt.submit.attempt', { requestId: request.requestId, kind, attempt: 1, method, ...evidence });
  emitChatEvent(request, evidence.confirmed ? 'prompt.submit.confirmed' : 'prompt.submit.uncertain', {
    kind, attempt: 1, method, ...evidence,
  });
  if (evidence.confirmed) return evidence;

  const error = new Error(`PROMPT_SUBMIT_UNCERTAIN: ChatGPT did not expose proof for the ${kind} submission; automatic retry is forbidden`);
  error.code = 'PROMPT_SUBMIT_UNCERTAIN';
  error.retryable = false;
  throw error;
}

function submitComposer(composer, request, options = {}) {
  const kind = String(options.kind || 'prompt');
  const attempt = Number(options.attempt || 1);
  const composerRoot = findComposerRootStrict();
  const button = findSendButton([composerRoot].filter(Boolean));
  if (button) {
    diagnostic('send_button.found', { requestId: request.requestId, kind, attempt, label: button.getAttribute('aria-label') || button.getAttribute('title') || button.getAttribute('data-testid') || '' });
    button.click();
    return 'button';
  }

  const form = composer.closest?.('form') || (composerRoot?.tagName === 'FORM' ? composerRoot : composerRoot?.closest?.('form')) || null;
  if (form && typeof form.requestSubmit === 'function') {
    diagnostic('send_button.not_found_form_submit_fallback', { requestId: request.requestId, kind, attempt });
    form.requestSubmit();
    return 'form_request_submit';
  }

  diagnostic('send_button.not_found_keyboard_fallback', { requestId: request.requestId, kind, attempt });
  composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true, cancelable: true }));
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

function usableComposerCandidates(selector, root = document) {
  return Array.from(root.querySelectorAll(selector))
    .filter((element) => isPrimaryChatSurfaceElement(element) && isVisible(element) && !element.disabled && !element.readOnly);
}

function findComposer() {
  const primary = usableComposerCandidates('#prompt-textarea[contenteditable="true"]');
  if (primary.length === 1) return primary[0];
  if (primary.length > 1) {
    diagnostic('dom_schema.composer_ambiguous', { selector: '#prompt-textarea[contenteditable="true"]', count: primary.length });
    return null;
  }

  const roots = Array.from(document.querySelectorAll('form, [data-testid*="composer" i]'))
    .filter((root) => isVisible(root) && root.querySelector('[contenteditable="true"], textarea'));
  const candidates = [];
  const seen = new Set();
  const add = (element) => {
    if (!element || seen.has(element)) return;
    seen.add(element);
    candidates.push(element);
  };
  for (const root of roots) {
    for (const element of usableComposerCandidates('[role="textbox"][aria-label][contenteditable="true"]', root)) add(element);
    for (const element of usableComposerCandidates('textarea[name="prompt-textarea"], textarea[aria-label]', root)) add(element);
    for (const element of usableComposerCandidates('.ProseMirror[contenteditable="true"]', root)) add(element);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) diagnostic('dom_schema.composer_ambiguous', { selector: 'composer scoped fallback', count: candidates.length });
  return null;
}

async function focusAndSetComposerText(element, text, request) {
  element.focus();
  await delay(20);

  const attempts = [
    () => setComposerTextByPaste(element, text),
    () => setComposerTextByNativeValue(element, text),
    () => setComposerTextByExecCommand(element, text),
    () => setComposerTextByTextContent(element, text),
  ];

  for (let i = 0; i < attempts.length; i += 1) {
    attempts[i]();
    await delay(80);
    if (composerContainsText(element, text)) {
      diagnostic('composer.text_verified', { requestId: request.requestId, method: i + 1, length: text.length });
      return;
    }
  }

  diagnostic('composer.text_verify_failed', { requestId: request.requestId, expectedLength: text.length, actualLength: visibleText(element).length });
  throw new Error('COMPOSER_TEXT_VERIFY_FAILED');
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
  if (document.execCommand) document.execCommand('insertText', false, text);
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
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

function findChatMain() {
  return document.querySelector('main') || document.querySelector('[role="main"]') || null;
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
  return findButtonBySignal(roots, /send[-_ ]?(button|message|prompt)?|submit|arrow-up|paper-airplane|отправ|послать|发送|送信/i, [
    '[data-testid="send-button"]',
    '[data-testid*="send" i]',
    'button[aria-label*="Send" i]',
    '[role="button"][aria-label*="Send" i]',
  ]);
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
