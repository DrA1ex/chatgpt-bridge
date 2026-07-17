// Chat page readiness and session/model request preparation.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createRequestPreparation(deps = {}) {
    const {
      CONFIG,
      DOM_PARSER,
      INTELLIGENCE_UI_TIMING,
      delay,
      diagnostic,
      emitChatEvent,
      findChatMain,
      findComposer,
      isVisible,
      openNewSession,
      readIntelligenceState,
      schedulePageStatus,
      selectSessionById,
      send,
      trySelectIntelligenceOption,
    } = deps;

    function waitForDocumentReady() {
      if (document.readyState !== 'loading') return Promise.resolve();
      return new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    }
  
    function chatPageReadiness() {
      const chatMain = findChatMain();
      const composer = findComposer();
      const composerReady = Boolean(composer && composer.isConnected && isVisible(composer) && !composer.disabled && !composer.readOnly);
      const chatMainReady = Boolean(chatMain && chatMain.isConnected && isVisible(chatMain));
      return {
        ready: document.readyState !== 'loading' && chatMainReady && composerReady,
        chatMainReady,
        composerReady,
        composer,
        url: location.href,
      };
    }
  
    async function waitForChatPageReady(request, options = {}) {
      const timeoutMs = Math.max(5_000, Number(options.timeoutMs || request?.options?.pageReadyTimeoutMs || CONFIG.pageReadyTimeoutMs) || CONFIG.pageReadyTimeoutMs);
      const settleMs = Math.max(150, Number(options.settleMs ?? request?.options?.pageReadySettleMs ?? CONFIG.pageReadySettleMs) || CONFIG.pageReadySettleMs);
      const stage = String(options.stage || 'prompt');
      const started = Date.now();
      let readySince = 0;
      let readyUrl = '';
      let lastState = '';
  
      emitChatEvent(request, 'page.ready.wait', { stage, timeoutMs, settleMs });
      while (Date.now() - started < timeoutMs) {
        const state = chatPageReadiness();
        const signature = JSON.stringify([document.readyState, state.chatMainReady, state.composerReady, state.url]);
        if (signature !== lastState) {
          lastState = signature;
          diagnostic('page.ready.state', {
            requestId: request?.requestId,
            stage,
            documentReadyState: document.readyState,
            chatMainReady: state.chatMainReady,
            composerReady: state.composerReady,
            url: state.url,
          });
        }
        if (state.ready) {
          if (!readySince || readyUrl !== state.url) {
            readySince = Date.now();
            readyUrl = state.url;
          }
          if (Date.now() - readySince >= settleMs) {
            diagnostic('page.ready', { requestId: request?.requestId, stage, waitedMs: Date.now() - started, settleMs, url: state.url });
            emitChatEvent(request, 'page.ready', { stage, waitedMs: Date.now() - started, settleMs, url: state.url });
            schedulePageStatus('page.changed', 0);
            return state;
          }
        } else {
          readySince = 0;
          readyUrl = '';
        }
        await delay(200);
      }
  
      const state = chatPageReadiness();
      diagnostic('page.ready.timeout', {
        requestId: request?.requestId,
        stage,
        timeoutMs,
        documentReadyState: document.readyState,
        chatMainReady: state.chatMainReady,
        composerReady: state.composerReady,
        url: state.url,
      });
      throw new Error(`CHAT_PAGE_NOT_READY: ChatGPT composer did not become stable during ${stage} after ${timeoutMs}ms`);
    }
  
    async function applySessionOptions(options, request) {
      if (options.newSession) {
        emitChatEvent(request, 'session.new.started');
        const session = await openNewSession();
        emitChatEvent(request, 'session.new.done', { session });
        return;
      }
  
      if (options.sessionId) {
        emitChatEvent(request, 'session.select.started', { sessionId: options.sessionId });
        const session = await selectSessionById(options.sessionId);
        emitChatEvent(request, 'session.select.done', { session });
      }
    }
  
    async function applyModelOptions(options, request, { emitEvents = true } = {}) {
      const model = String(options.model || '').trim();
      const effort = String(options.effort || '').trim();
      if (!model && !effort) return;
  
      if (emitEvents) emitChatEvent(request, 'model.apply.started', { model, effort });
      diagnostic('model.apply.started', { requestId: request.requestId, model, effort });
  
      const result = { model, effort, modelApplied: false, effortApplied: false, warnings: [] };
      let modelSelection = null;
      let effortSelection = null;
  
      if (model) {
        modelSelection = await trySelectIntelligenceOption(model, 'model', request);
        if (!modelSelection.matched) result.warnings.push(`Could not find model option: ${model}`);
        if (effort) await delay(INTELLIGENCE_UI_TIMING.betweenSelectionsMs);
      }
  
      if (effort) {
        const effortLabel = effortLabelFromValue(effort);
        effortSelection = await trySelectIntelligenceOption(effortLabel, 'effort', request);
        if (!effortSelection.matched) result.warnings.push(`Could not find effort option: ${effort}`);
      }
  
      let state = null;
      let verificationError = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        diagnostic('model.apply.verification.started', { requestId: request.requestId, model, effort, attempt });
        try {
          state = await readIntelligenceState({ includeModels: Boolean(model) });
          result.modelApplied = model ? DOM_PARSER.intelligenceOptionMatches(state.selectedModel || {}, model) : false;
          result.effortApplied = effort ? DOM_PARSER.intelligenceOptionMatches(state.selectedEffort || {}, effortLabelFromValue(effort)) : false;
          const verified = (!model || result.modelApplied) && (!effort || result.effortApplied);
          if (verified) break;
          verificationError = new Error(`Picker state mismatch: model=${state.selectedModel?.label || ''} effort=${state.selectedEffort?.id || state.selectedEffort?.label || ''}`);
        } catch (err) {
          verificationError = err;
        }
        if (attempt < 2) {
          diagnostic('model.apply.verification.retry', { requestId: request.requestId, model, effort, attempt, message: verificationError?.message || 'state mismatch' });
          await delay(INTELLIGENCE_UI_TIMING.verificationRetryMs);
        }
      }
  
      if (model && !result.modelApplied) result.warnings.push(`Could not confirm model selection: ${model}`);
      if (effort && !result.effortApplied) result.warnings.push(`Could not confirm effort selection: ${effort}`);
      if (verificationError && result.warnings.length) result.warnings.push(`Verification detail: ${verificationError.message}`);
  
      const verifiedIntelligence = state ? {
        models: Array.isArray(state.models) ? state.models : [],
        efforts: Array.isArray(state.efforts) ? state.efforts : [],
        selectedModel: state.selectedModel || null,
        selectedEffort: state.selectedEffort || null,
        capturedAt: state.capturedAt || Date.now(),
      } : null;
      const completedResult = { ...result, intelligence: verifiedIntelligence };
      if (emitEvents) send({ type: 'chat.event', requestId: request.requestId, event: { type: 'model.apply.done', requestId: request.requestId, time: new Date().toISOString(), ...completedResult } });
      diagnostic('model.apply.done', {
        requestId: request.requestId,
        ...completedResult,
        modelSelection: modelSelection ? { matched: modelSelection.matched, clicked: modelSelection.clicked, alreadySelected: modelSelection.alreadySelected } : null,
        effortSelection: effortSelection ? { matched: effortSelection.matched, clicked: effortSelection.clicked, alreadySelected: effortSelection.alreadySelected } : null,
        selectedModel: state?.selectedModel?.label || '',
        selectedEffort: state?.selectedEffort?.id || state?.selectedEffort?.label || '',
      });
      return completedResult;
    }
  
    function effortLabelFromValue(value) {
      const normalized = String(value || '').toLowerCase();
      const map = {
        low: 'low',
        medium: 'medium',
        med: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        'x-high': 'xhigh',
        auto: 'auto',
        instant: 'instant',
        thinking: 'thinking',
      };
      return map[normalized] || value;
    }
  
  
    return Object.freeze({
      applyModelOptions,
      applySessionOptions,
      chatPageReadiness,
      waitForChatPageReady,
      waitForDocumentReady,
    });
  }

  globalThis.ChatGptRequestPreparation = Object.freeze({ createRequestPreparation });
})();
