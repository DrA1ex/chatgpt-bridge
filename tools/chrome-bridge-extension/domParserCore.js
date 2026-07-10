// Pure, DOM-independent state helpers for the ChatGPT content-script parser.
// Loaded before content.js and exposed as a global because MV3 content scripts
// listed in manifest.json are classic scripts, not ES modules.
(() => {
  'use strict';

  const PHASE = Object.freeze({
    USER: 'USER',
    ASSISTANT_PLACEHOLDER: 'ASSISTANT_PLACEHOLDER',
    ASSISTANT_REASONING: 'ASSISTANT_REASONING',
    ASSISTANT_FINAL_STREAMING: 'ASSISTANT_FINAL_STREAMING',
    ASSISTANT_FINAL_STREAMING_WITH_HISTORY: 'ASSISTANT_FINAL_STREAMING_WITH_HISTORY',
    ASSISTANT_FINAL: 'ASSISTANT_FINAL',
    TOOL_RUNNING: 'TOOL_RUNNING',
    NEEDS_CONFIRMATION: 'NEEDS_CONFIRMATION',
    NEEDS_CONTINUE: 'NEEDS_CONTINUE',
    ERROR: 'ERROR',
  });

  function normalizeText(value = '') {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function normalizeComparable(value = '') {
    return normalizeText(value).replace(/\s+/g, ' ').toLowerCase();
  }

  function classifyTurnPhase(signals = {}) {
    const role = String(signals.role || '').toLowerCase();
    if (role === 'user') return PHASE.USER;
    if (signals.hasError) return PHASE.ERROR;
    if (signals.needsConfirmation) return PHASE.NEEDS_CONFIRMATION;
    if (signals.needsContinue) return PHASE.NEEDS_CONTINUE;

    if (signals.hasActiveTool && signals.stopVisible) return PHASE.TOOL_RUNNING;
    if (signals.hasFinalNode && signals.stopVisible) {
      return signals.hasPriorVisibleBlocks
        ? PHASE.ASSISTANT_FINAL_STREAMING_WITH_HISTORY
        : PHASE.ASSISTANT_FINAL_STREAMING;
    }
    if (signals.hasFinalNode && !signals.stopVisible && signals.actionBarVisible && !signals.hasActiveTool) {
      return PHASE.ASSISTANT_FINAL;
    }
    if (!signals.hasFinalNode && signals.stopVisible && (signals.hasReasoningMarker || signals.hasVisibleStatusText)) {
      return PHASE.ASSISTANT_REASONING;
    }
    return PHASE.ASSISTANT_PLACEHOLDER;
  }

  function classifyVisibleBlock(block = {}) {
    const text = normalizeText(block.text || '');
    const testIds = Array.isArray(block.testIds) ? block.testIds : [];
    const signal = `${testIds.join(' ')} ${block.role || ''} ${block.state || ''} ${block.ariaBusy || ''} ${text}`;
    if (block.final) return 'final';
    if (/\bcot-v5-|thinking|reasoning|thought|размыш|дума/i.test(signal)) return 'reasoning-summary';
    if (block.hasCode || /stdout|stderr|python|terminal|tool|analysis tool|инструмент/i.test(signal)) return 'tool';
    if (/status|aria-live|progress|loading|working|processing|выполня|обрабаты/i.test(signal)) return 'status';
    return 'unknown';
  }

  function groupVisibleBlocks(blocks = []) {
    const normalized = blocks
      .map((block, index) => ({ ...block, index: block.index ?? index, text: normalizeText(block.text || '') }))
      .filter((block) => block.final || block.text);
    const result = [];

    for (let index = 0; index < normalized.length; index += 1) {
      const current = normalized[index];
      const next = normalized[index + 1];
      const currentKind = current.kind || classifyVisibleBlock(current);
      const nextKind = next ? (next.kind || classifyVisibleBlock(next)) : '';
      const shortStatusLabel = !current.final
        && current.text.length > 0
        && current.text.length <= 80
        && /^(?:проанализировано|анализ|готово|выполняется|running|worked|analyzed|analysis|thinking|думал|размышлял)(?:\s|$)/i.test(current.text);

      if (shortStatusLabel && next && !next.final && (nextKind === 'tool' || next.hasCode)) {
        result.push({
          ...next,
          index: current.index,
          kind: 'tool',
          text: normalizeText(`${current.text}\n${next.text}`),
          label: current.text,
          groupedIndexes: [current.index, next.index],
        });
        index += 1;
        continue;
      }

      result.push({ ...current, kind: currentKind });
    }
    return result;
  }

  function buildSnapshotSignature(snapshot = {}) {
    const blocks = Array.isArray(snapshot.visibleBlocks)
      ? snapshot.visibleBlocks.map((block) => [
          block.kind || '',
          normalizeComparable(block.text || ''),
          Array.isArray(block.testIds) ? [...block.testIds].sort() : [],
          block.state || '',
          block.expanded ?? null,
          Boolean(block.active),
        ])
      : [];
    return JSON.stringify({
      phase: snapshot.phase || '',
      turnId: snapshot.turnKey || snapshot.turnId || '',
      messageId: snapshot.messageId || '',
      modelSlug: snapshot.modelSlug || '',
      conversationId: snapshot.conversationId || '',
      answer: normalizeComparable(snapshot.answer || ''),
      stopVisible: Boolean(snapshot.stopVisible),
      sendVisible: Boolean(snapshot.sendVisible),
      sendVisible: Boolean(snapshot.sendVisible),
      actionBarVisible: Boolean(snapshot.actionBarVisible),
      needsConfirmation: Boolean(snapshot.needsConfirmation),
      needsContinue: Boolean(snapshot.needsContinue),
      hasError: Boolean(snapshot.hasError),
      artifacts: Array.isArray(snapshot.artifacts)
        ? snapshot.artifacts.map((item) => [item.id || '', item.name || '', item.url || item.downloadUrl || ''])
        : [],
      blocks,
    });
  }

  function isCompletedSnapshot(snapshot = {}, expectedConversationId = '') {
    if (!snapshot.hasFinalMessage) return false;
    if (snapshot.stopVisible || !snapshot.actionBarVisible) return false;
    if (snapshot.hasActiveTool || snapshot.needsConfirmation || snapshot.needsContinue || snapshot.hasError) return false;
    if (expectedConversationId && snapshot.conversationId && snapshot.conversationId !== expectedConversationId) return false;
    return snapshot.phase === PHASE.ASSISTANT_FINAL;
  }

  globalThis.ChatGptDomParserCore = Object.freeze({
    PHASE,
    normalizeText,
    normalizeComparable,
    classifyTurnPhase,
    classifyVisibleBlock,
    groupVisibleBlocks,
    buildSnapshotSignature,
    isCompletedSnapshot,
  });
})();
