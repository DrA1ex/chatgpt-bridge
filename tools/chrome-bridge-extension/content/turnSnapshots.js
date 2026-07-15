// Assistant/user turn anchoring, reasoning reconciliation, and terminal snapshots.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createTurnSnapshots(deps = {}) {
    const {
      DOM_PARSER,
      buttonSignalText,
      collectArtifactsForAssistantNode,
      collectArtifactsFromNode,
      codeUiActionText,
      conversationIdFromUrl,
      createResponseParserPass,
      delay,
      diagnostic,
      domPathForNode,
      emitChatEvent,
      extractResponseBlocks,
      finalizationControlRoots,
      findChatMain,
      findContinueButton,
      findSendButton,
      findStopButton,
      getActiveRequest,
      isVisible,
      mergeParserAudits,
      nextThinkingNodeToken,
      normalizeMarkdown,
      normalizeText,
      parserAuditForRoot,
      safeOuterHtml,
      setRequestPhase,
      simpleHash,
      thinkingNodeTokens,
      thinkingStateByTurn,
      visibleText,
    } = deps;

    for (const [name, value] of Object.entries({
      collectArtifactsForAssistantNode,
      collectArtifactsFromNode,
      setRequestPhase,
    })) {
      if (typeof value !== 'function') throw new TypeError(`ChatGPT turn snapshots requires dependency ${name}`);
    }

function getTurnNodes() {
  const selectors = [
    '[data-testid^="conversation-turn-"][data-turn]',
    'section[data-turn][data-turn-id]',
    'main section[data-turn]',
    '[role="main"] section[data-turn]',
  ];
  const seen = new Set();
  const turns = [];
  for (const selector of selectors) {
    for (const turn of Array.from(document.querySelectorAll(selector))) {
      if (seen.has(turn)) continue;
      seen.add(turn);
      turns.push(turn);
    }
  }
  return turns.sort((left, right) => {
    if (left === right) return 0;
    const position = left.compareDocumentPosition(right);
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
}

function isCredibleFinalAssistantNode(node) {
  if (!node?.matches?.('[data-message-author-role="assistant"]')) return false;
  if (node.getAttribute?.('data-message-id')) return true;
  if (node.getAttribute?.('data-message-model-slug')) return true;
  if (node.hasAttribute?.('data-turn-start-message')) return true;
  if (node.matches?.('.markdown') || node.querySelector?.('.markdown, [data-start][data-end], pre, code')) return true;
  return false;
}

function getFinalAssistantNode(root) {
  if (!root) return null;
  if (isCredibleFinalAssistantNode(root)) return root;
  return Array.from(root.querySelectorAll?.('[data-message-author-role="assistant"]') || []).find(isCredibleFinalAssistantNode) || null;
}

function turnKey(turn, index = -1) {
  if (!turn) return '';
  const finalNode = getFinalAssistantNode(turn);
  return turn.getAttribute?.('data-turn-id')
    || finalNode?.getAttribute?.('data-message-id')
    || turn.getAttribute?.('data-message-id')
    || turn.getAttribute?.('data-testid')
    || turn.getAttribute?.('data-turn-id-container')
    || (index >= 0 ? `turn-index-${index}` : '');
}

function turnRole(turn) {
  if (!turn) return '';
  const direct = turn.getAttribute?.('data-turn');
  if (direct) return direct;
  const msg = turn.querySelector?.('[data-message-author-role]');
  return msg?.getAttribute('data-message-author-role') || turn.getAttribute?.('data-message-author-role') || '';
}

function getAssistantNodes() {
  return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
}

function getAssistantNodeFromTurn(turn) {
  if (!turn) return null;
  if (turnRole(turn) === 'assistant') return turn;
  return getFinalAssistantNode(turn);
}

function requestTurnRecords() {
  return getTurnNodes().map((turn, index) => ({
    turn,
    index,
    key: turnKey(turn, index),
    role: turnRole(turn),
    text: visibleText(turn),
  }));
}

function resetAssistantAnchorAfterSteer(request, candidate) {
  const previousAssistantTurnKey = request.assistantTurnKey || '';
  request.assistantTurnKey = '';
  request.assistantTurnIndex = -1;
  request.assistantTurnLogged = false;
  request.assistantTurnMissingLogged = false;
  request.lastDomSignature = '';
  request.lastVisibleThinking = '';
  request.lastProgressText = '';
  request.lastProgressItemsFingerprint = '';
  request.lastAnswer = '';
  request.sawAnswer = false;
  request.lastArtifactsFingerprint = '';
  request.artifacts = [];
  request.stableSince = Date.now();
  request.lastSnapshotChangedAt = Date.now();
  request.generationIdleSince = 0;
  request.generationStoppedSent = false;
  request.terminalCandidateSince = 0;
  request.steerWaitStartedAt = 0;
  request.steerWaitExpiredAt = 0;
  diagnostic('steer.turn.reanchored', {
    requestId: request.requestId,
    submittedUserTurnKey: candidate.key,
    submittedUserTurnIndex: candidate.index,
    previousAssistantTurnKey,
  });
  emitChatEvent(request, 'steer.turn.reanchored', {
    submittedUserTurnKey: candidate.key,
    submittedUserTurnIndex: candidate.index,
    previousAssistantTurnKey,
  });
}

function adoptSubmittedUserTurn(request, baselineTurnKeys, { kind = 'prompt', replace = false } = {}) {
  if (!request || (!replace && request.submittedUserTurnKey)) return null;
  const records = requestTurnRecords();
  const baseline = baselineTurnKeys instanceof Set ? baselineTurnKeys : new Set(baselineTurnKeys || []);
  const expectedText = String(request.pendingSubmittedTurnExpectedText || '');
  const candidate = DOM_PARSER.selectLatestMatchingNewTurnRecord(records, baseline, 'user', expectedText);
  if (!candidate) {
    const unmatched = records.filter((record) => record?.key && record.role === 'user' && !baseline.has(record.key));
    if (unmatched.length && expectedText) {
      const mismatchSignature = unmatched.map((record) => `${record.key}:${simpleHash(record.text || '')}`).join('|');
      if (mismatchSignature !== request.lastUserTurnMismatchSignature) {
        request.lastUserTurnMismatchSignature = mismatchSignature;
        diagnostic(`${kind}.user_turn_text_mismatch`, {
          requestId: request.requestId,
          expectedTextHash: simpleHash(expectedText),
          candidates: unmatched.map((record) => ({ key: record.key, index: record.index, textHash: simpleHash(record.text || ''), textLength: String(record.text || '').length })),
        });
      }
    }
    return null;
  }
  const previousSubmittedUserTurnKey = request.submittedUserTurnKey || '';
  const changed = candidate.key !== previousSubmittedUserTurnKey;
  request.submittedUserTurnKey = candidate.key;
  request.submittedUserTurnIndex = candidate.index;
  request.pendingSubmittedTurnBaseline = null;
  request.pendingSubmittedTurnKind = '';
  request.pendingSubmittedTurnExpectedText = '';
  request.lastUserTurnMismatchSignature = '';

  if (kind === 'steer' && changed) resetAssistantAnchorAfterSteer(request, candidate);

  const eventName = kind === 'steer' ? 'steer_user_turn.captured' : 'submitted_user_turn.captured';
  diagnostic(eventName, {
    requestId: request.requestId,
    turnKey: candidate.key,
    turnIndex: candidate.index,
    textLength: candidate.text.length,
    textHash: simpleHash(candidate.text),
    promptHash: request.promptHash || '',
    previousSubmittedUserTurnKey,
  });
  emitChatEvent(request, kind === 'steer' ? 'steer_user_turn.captured' : 'user_turn.captured', {
    turnKey: candidate.key,
    turnIndex: candidate.index,
    textLength: candidate.text.length,
    textHash: simpleHash(candidate.text),
    promptHash: request.promptHash || '',
    previousSubmittedUserTurnKey,
  });
  setRequestPhase(request, 'waiting_for_assistant_turn', {
    submittedUserTurnKey: candidate.key,
    submittedUserTurnIndex: candidate.index,
    reanchoredAfterSteer: kind === 'steer',
  });
  return candidate;
}

async function waitForSubmittedUserTurnAnchor(request, baselineTurnKeys, { kind = 'prompt', replace = false, timeoutMs = 5_000 } = {}) {
  const baseline = baselineTurnKeys instanceof Set ? baselineTurnKeys : new Set(baselineTurnKeys || []);
  const alreadyCaptured = () => {
    const key = String(request?.submittedUserTurnKey || '');
    if (!key || baseline.has(key)) return null;
    return { key, index: request.submittedUserTurnIndex, reason: 'already_captured_by_dom_monitor' };
  };
  const started = Date.now();
  diagnostic(`${kind}.user_turn_anchor_wait.started`, {
    requestId: request?.requestId || '',
    timeoutMs,
    baselineCount: baseline.size,
    expectedTextHash: simpleHash(String(request?.pendingSubmittedTurnExpectedText || '')),
  });
  while (Date.now() - started < timeoutMs) {
    const existing = alreadyCaptured();
    if (existing) return existing;
    const candidate = adoptSubmittedUserTurn(request, baseline, { kind, replace });
    if (candidate) return candidate;
    await delay(100);
  }
  diagnostic(`${kind}.user_turn_anchor_pending`, {
    requestId: request?.requestId || '',
    timeoutMs,
    turnCount: getTurnNodes().length,
  });
  return null;
}

function refreshRequestTurnAnchors(request) {
  if (!request || !request.turnCaptureArmed) return;
  if (request.pendingSubmittedTurnBaseline) {
    const candidate = adoptSubmittedUserTurn(request, request.pendingSubmittedTurnBaseline, {
      kind: request.pendingSubmittedTurnKind || 'steer',
      replace: true,
    });
    if (candidate) return;
  }
  if (request.submittedUserTurnKey) return;
  const baseline = request.baselineTurnKeys instanceof Set ? request.baselineTurnKeys : new Set();
  adoptSubmittedUserTurn(request, baseline, { kind: 'prompt', replace: false });
}

function findAssistantTurnAfterSubmittedUser(request) {
  const records = requestTurnRecords();
  if (!records.length) return { node: null, turns: [], reason: 'no_turns' };
  if (!request?.submittedUserTurnKey) return { node: null, turns: records.map((record) => record.turn), reason: 'no_submitted_user_turn' };

  const selectedRecord = DOM_PARSER.selectLatestTurnAfterRecord(records, request.submittedUserTurnKey, 'assistant');
  const turns = records.map((record) => record.turn);
  if (!selectedRecord) {
    const startIndex = records.findIndex((record) => record.key === request.submittedUserTurnKey);
    return {
      node: null,
      turns,
      reason: startIndex < 0 ? 'submitted_user_turn_not_found' : 'no_assistant_turn_after_submitted_user',
      startIndex,
    };
  }
  const node = getAssistantNodeFromTurn(selectedRecord.turn);
  if (!node) return { node: null, turns, reason: 'assistant_turn_has_no_node', startIndex: selectedRecord.index };
  return {
    node,
    turn: selectedRecord.turn,
    turns,
    index: selectedRecord.index,
    key: selectedRecord.key,
    reason: 'selected_after_submitted_user',
  };
}

function findAssistantTurns(limit = 5) {
  const turns = getTurnNodes();
  const all = [];
  const seenNodes = new Set();
  const seenKeys = new Set();
  const scanLimit = Math.max(Number(limit) || 5, 40);
  const pushCandidate = (candidate) => {
    if (!candidate?.node || seenNodes.has(candidate.node)) return;
    const key = candidate.key || turnKey(candidate.turn, candidate.index) || candidate.node.getAttribute('data-message-id') || '';
    const nodeKey = key || `node-${all.length}`;
    if (seenKeys.has(nodeKey)) return;
    seenNodes.add(candidate.node);
    seenKeys.add(nodeKey);
    all.push({ ...candidate, key });
  };

  for (let index = turns.length - 1; index >= 0 && all.length < scanLimit; index -= 1) {
    const turn = turns[index];
    if (turnRole(turn) !== 'assistant') continue;
    const node = getAssistantNodeFromTurn(turn);
    pushCandidate({ node, turn, turns, index, key: turnKey(turn, index), reason: 'assistant_turn' });
  }

  // ChatGPT sometimes virtualizes turns or exposes assistant-message roots
  // without a matching visible conversation-turn section. Recovery should scan
  // those too, otherwise downloadable action buttons inside the latest answer
  // may be missed. Keep DOM order, but do not stop at the display limit: older
  // visible answers can contain artifact action buttons while newer turns are
  // only progress/thinking notes.
  const nodes = getAssistantNodes();
  for (let index = nodes.length - 1; index >= 0 && all.length < scanLimit; index -= 1) {
    const node = nodes[index];
    const containingTurn = node.closest?.('section[data-testid^="conversation-turn"], section[data-turn-id][data-turn]') || null;
    pushCandidate({
      node,
      turn: containingTurn,
      turns,
      index: containingTurn ? turns.indexOf(containingTurn) : -1,
      key: containingTurn ? turnKey(containingTurn, turns.indexOf(containingTurn)) : node.getAttribute('data-message-id') || '',
      reason: containingTurn ? 'assistant_node_turn_fallback' : 'assistant_node_fallback',
    });
  }

  // Last-resort artifact scan for markdown blocks that include artifact action
  // buttons but are not nested under a detected assistant node. This keeps
  // recovery useful after DOM churn or partial virtualization. Do this even if
  // the normal assistant-turn scan already found enough textual candidates.
  let artifactFallbacks = 0;
  for (const node of Array.from(document.querySelectorAll('[data-message-author-role="assistant"], .markdown, [data-message-author-role="assistant"] .markdown')).reverse()) {
    if (artifactFallbacks >= 20) break;
    if (!collectArtifactsFromNode(node, { reason: 'artifact_scan' }).length) continue;
    artifactFallbacks += 1;
    const containingTurn = node.closest?.('section[data-testid^="conversation-turn"], section[data-turn-id][data-turn]') || null;
    const turnIndex = containingTurn ? turns.indexOf(containingTurn) : -1;
    pushCandidate({
      node,
      turn: containingTurn,
      turns,
      index: turnIndex,
      key: containingTurn ? turnKey(containingTurn, turnIndex) : node.getAttribute('data-message-id') || `artifact-${simpleHash(visibleText(node))}`,
      reason: containingTurn ? 'artifact_turn_fallback' : 'artifact_markdown_fallback',
    });
  }
  return all;
}

function isMeaningfulRecoverySnapshot(snapshot) {
  if (!snapshot) return false;
  if (Array.isArray(snapshot.artifacts) && snapshot.artifacts.length) return true;
  // Recovery candidates must be actual assistant output. A transient
  // reasoning/tool snapshot is useful diagnostics, but it is not a response
  // that can safely replace the normal result pipeline.
  const answer = normalizeText(snapshot.answer || '');
  if (!answer) return false;
  if (/^(thinking|think|thinking stopped|thinking остановлено|остановлено|мысли остановлены)$/i.test(answer)) return false;
  return true;
}

function readSnapshotForCandidate(selected, candidateIndex = 1) {
  if (!selected?.node) return { answer: '', thinking: '', progress: '', progressItems: [], raw: '', count: getAssistantNodes().length, turnCount: selected?.turns?.length || 0, format: 'none', artifacts: [], reason: selected?.reason || 'no_assistant_node', candidateIndex };
  const snapshot = readAssistantNodeSnapshot(selected.node, { count: getAssistantNodes().length, turnCount: selected.turns.length, reason: selected.reason, turnKey: selected.key || '', turnIndex: selected.index ?? -1, candidateIndex });
  return { ...snapshot, turnKey: selected.key || '', turnIndex: selected.index ?? -1, candidateIndex };
}

function readRecoverySnapshots(limit = 5) {
  const displayLimit = Math.max(1, Math.min(20, Number(limit) || 5));
  const selected = [];
  const seen = new Set();
  const snapshots = findAssistantTurns(Math.max(displayLimit, 40))
    .map((candidate, index) => readSnapshotForCandidate(candidate, index + 1))
    .filter(isMeaningfulRecoverySnapshot);

  const add = (snapshot) => {
    const key = snapshot.turnKey || `${snapshot.reason}:${snapshot.answerLength || snapshot.answer?.length || 0}:${snapshot.artifactCount || snapshot.artifacts?.length || 0}:${simpleHash(snapshot.answer || snapshot.raw || '')}`;
    if (seen.has(key)) return;
    seen.add(key);
    selected.push({ ...snapshot, candidateIndex: selected.length + 1 });
  };

  // Keep recent useful assistant messages first.
  for (const snapshot of snapshots) {
    if (selected.length >= displayLimit) break;
    add(snapshot);
  }

  // Always include visible artifact-bearing messages if they were not among
  // the first displayLimit responses. This is the important recovery path for
  // inline buttons like “скачать обновлённый ZIP”.
  for (const snapshot of snapshots) {
    if (!Array.isArray(snapshot.artifacts) || !snapshot.artifacts.length) continue;
    add(snapshot);
    if (selected.length >= Math.max(displayLimit, 12)) break;
  }

  return selected;
}

function findLatestAssistantTurn(index = 1) {
  const snapshots = readRecoverySnapshots(Math.max(10, Number(index) || 1));
  const snapshot = snapshots[Math.max(0, (Number(index) || 1) - 1)];
  if (snapshot) return snapshot;
  return { answer: '', thinking: '', progress: '', progressItems: [], raw: '', count: getAssistantNodes().length, turnCount: getTurnNodes().length, format: 'none', artifacts: [], reason: 'no_assistant_node', turnKey: '', turnIndex: -1, candidateIndex: Number(index) || 1 };
}

function readLatestAssistantSnapshot(index = 1) {
  return findLatestAssistantTurn(index);
}

function readAssistantSnapshotByTurnKey(key = '') {
  const expectedKey = String(key || '');
  if (!expectedKey) return null;
  const turns = getTurnNodes();
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turnKey(turn, index) !== expectedKey) continue;
    const node = getAssistantNodeFromTurn(turn);
    if (!node) return null;
    return readAssistantNodeSnapshot(node, { turnCount: turns.length, reason: 'turn_key_recovery', turnKey: expectedKey, turnIndex: index });
  }
  const node = getAssistantNodes().find((item) => item.getAttribute('data-message-id') === expectedKey);
  if (!node) return null;
  return readAssistantNodeSnapshot(node, { count: getAssistantNodes().length, turnCount: turns.length, reason: 'turn_key_node_recovery', turnKey: expectedKey, turnIndex: -1 });
}

function readRecentAssistantSnapshots(limit = 5) {
  return readRecoverySnapshots(limit);
}

function readAssistantSnapshot(requestOrBaseline) {
  if (requestOrBaseline && typeof requestOrBaseline === 'object') {
    const request = requestOrBaseline;
    const selected = findAssistantTurnAfterSubmittedUser(request);
    if (selected.node) return readAssistantNodeSnapshot(selected.node, { turnCount: selected.turns.length, reason: selected.reason, turnKey: selected.key || '', turnIndex: selected.index ?? -1, captureSourceHtml: Boolean(request.options?.captureDomTimeline) });

    // Before the submitted user turn is visible, do not fall back to an older
    // assistant response. Virtualized ChatGPT DOM can reorder text and keeps
    // old assistant nodes around; old fallbacks caused stale answers and hangs.
    const nodes = getAssistantNodes();
    return { answer: '', thinking: '', progress: '', progressItems: [], raw: '', count: nodes.length, format: 'none', artifacts: [], reason: selected.reason, turnCount: selected.turns.length };
  }

  const nodes = getAssistantNodes();
  if (!nodes.length) return { answer: '', thinking: '', progress: '', progressItems: [], raw: '', count: 0, format: 'none', artifacts: [], reason: 'no_nodes' };
  const safeBaselineCount = Math.max(0, Number(requestOrBaseline) || 0);
  if (nodes.length <= safeBaselineCount) return { answer: '', thinking: '', progress: '', progressItems: [], raw: '', count: nodes.length, format: 'none', artifacts: [], reason: 'baseline_not_exceeded' };
  const candidateNodes = nodes.slice(safeBaselineCount);
  const node = candidateNodes[candidateNodes.length - 1];
  if (!node) return { answer: '', thinking: '', progress: '', progressItems: [], raw: '', count: nodes.length, format: 'none', artifacts: [], reason: 'no_candidate' };
  return readAssistantNodeSnapshot(node, { count: nodes.length, reason: 'baseline_candidate' });
}

function directChildContaining(parent, descendant) {
  if (!parent || !descendant) return null;
  return Array.from(parent.children || []).find((child) => child === descendant || child.contains?.(descendant)) || null;
}

function isMeaningfulVisibleElement(element) {
  if (!element || !isVisible(element)) return false;
  if (element.matches?.('script, style, noscript')) return false;
  if (element.matches?.('[data-testid="copy-turn-action-button"]')) return false;
  if (element.matches?.('[data-testid*="turn-action" i], [data-testid*="message-action" i]')) return false;
  if (element.matches?.('[role="group"][aria-label]')) {
    const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('data-testid') || ''}`;
    if (/action|response|message|действ|ответ/i.test(label)) return false;
  }
  if (!element.querySelector?.('[data-message-author-role="assistant"]')
    && element.querySelector?.('[data-testid="copy-turn-action-button"]')) return false;
  const text = visibleText(element);
  return Boolean(text || element.querySelector?.('pre, code, img, a[href], button, [role="status"], [aria-live], [data-testid^="cot-v5-"]'));
}

function findMessageStack(turn, finalNode) {
  if (!turn || !finalNode) return { stack: turn || finalNode, finalBranch: finalNode };
  let branch = finalNode;
  let parent = finalNode.parentElement;
  while (parent && (parent === turn || turn.contains?.(parent))) {
    const finalBranch = directChildContaining(parent, finalNode) || branch;
    const children = Array.from(parent.children || []).filter(isMeaningfulVisibleElement);
    const finalIndex = children.indexOf(finalBranch);
    if (finalIndex > 0) return { stack: parent, finalBranch };
    if (parent === turn) break;
    branch = parent;
    parent = parent.parentElement;
  }
  return { stack: finalNode.parentElement || turn, finalBranch: finalNode };
}

function findTemporaryMessageStack(turn) {
  if (!turn) return null;
  let current = turn;
  for (let depth = 0; depth < 8; depth += 1) {
    const children = Array.from(current.children || []).filter(isMeaningfulVisibleElement);
    if (children.length !== 1) break;
    const child = children[0];
    if (child.matches?.('[data-testid^="cot-v5-"], [role="status"], [aria-live], pre, code')) break;
    current = child;
  }
  return current;
}

function blockTestIds(element) {
  if (!element) return [];
  const ids = [];
  const own = element.getAttribute?.('data-testid');
  if (own) ids.push(own);
  for (const child of Array.from(element.querySelectorAll?.('[data-testid]') || [])) {
    const value = child.getAttribute('data-testid');
    if (value) ids.push(value);
  }
  return Array.from(new Set(ids)).slice(0, 40);
}

function blockIsActive(element) {
  if (!element) return false;
  const activeSelector = [
    '[aria-busy="true"]',
    '[data-state="loading"]',
    '[data-state="running"]',
    '[data-state="pending"]',
    '[data-state="streaming"]',
    '[data-status="running"]',
    '[data-status="pending"]',
  ].join(',');
  if (element.matches?.(activeSelector) || element.querySelector?.(activeSelector)) return true;
  if (element.matches?.('[role="progressbar"]') || element.querySelector?.('[role="progressbar"]')) return true;
  const testIdSignal = blockTestIds(element).join(' ');
  if (/spinner|loading|running|pending|streaming|progress/i.test(testIdSignal)) return true;

  // Text is only a fallback for compact status labels. Tool source/output can
  // legitimately contain words such as "running" and must not keep a
  // completed turn permanently active.
  const hasCode = Boolean(element.matches?.('pre, code') || element.querySelector?.('pre, code'));
  const text = normalizeText(visibleText(element));
  const signal = `${element.getAttribute?.('aria-label') || ''} ${element.getAttribute?.('data-state') || ''} ${text}`;
  return !hasCode
    && text.length <= 180
    && /^(?:running|working|processing|loading|in progress|выполняется|обрабатывается|загрузка)(?:\b|\s|[.…])/i.test(normalizeText(signal));
}

function thinkingNodeToken(element) {
  if (!element) return '';
  let token = thinkingNodeTokens.get(element);
  if (!token) {
    token = nextThinkingNodeToken();
    thinkingNodeTokens.set(element, token);
  }
  return token;
}

function hasClassToken(element, token) {
  return Boolean(element?.classList?.contains?.(token));
}

function isThinkingUiExcluded(element) {
  if (!element) return true;
  if (element.closest?.('form, [data-testid*="composer" i], pre, code, [data-testid="webpage-citation-pill"]')) return true;
  if (element.closest?.('[data-testid="copy-turn-action-button"], [data-testid*="turn-action" i], [data-testid*="message-action" i], [role="group"][aria-label*="action" i]')) return true;
  if (element.closest?.('[data-testid*="artifact" i], [data-testid*="file" i]')) return true;
  const interactive = element.closest?.('button, [role="button"], a[href]');
  if (interactive && !interactive.querySelector?.('[data-testid^="cot-v5-"]')) {
    const signal = buttonSignalText(interactive);
    if (/copy|download|save|open file|regenerate|retry|share|копир|скач|сохран|открыть файл|повтор|поделиться/i.test(signal)) return true;
  }
  return false;
}

function nearestThinkingScope(element, turn) {
  let current = element;
  while (current && current !== turn) {
    if (current.hasAttribute?.('data-start') && current.hasAttribute?.('data-end')) return current;
    if (current.hasAttribute?.('data-item-anchor') || current.hasAttribute?.('data-transition-position')) return current;
    const testId = current.getAttribute?.('data-testid') || '';
    if (testId && !/^cot-v5-(?:tool-icon-pile|native-tool-icon)$/i.test(testId)) return current;
    current = current.parentElement;
  }
  return element;
}

function thinkingStructuralHint(element, turn, ordinal = 0) {
  const scope = nearestThinkingScope(element, turn);
  const attributes = [
    scope?.getAttribute?.('data-testid') || '',
    scope?.getAttribute?.('data-start') || '',
    scope?.getAttribute?.('data-end') || '',
    scope?.getAttribute?.('data-item-anchor') || '',
    scope?.getAttribute?.('data-transition-position') || '',
    scope?.getAttribute?.('role') || '',
    scope?.tagName?.toLowerCase?.() || '',
  ].filter(Boolean).join('|');
  return `${attributes || 'thinking-slot'}:${ordinal}`;
}

function thinkingLabelText(element) {
  if (!element) return '';
  const clone = element.cloneNode?.(true);
  if (!clone) return visibleText(element);
  for (const excluded of Array.from(clone.querySelectorAll?.('[data-testid^="cot-v5-"], svg, [aria-hidden="true"], .sr-only') || [])) excluded.remove();
  return normalizeText(clone.innerText || clone.textContent || '');
}

function isReasoningTransitionContext(element, turn, finalNode) {
  if (!element || !turn?.contains?.(element)) return false;
  if (hasClassToken(element, 'loading-shimmer-tertiary')) return true;
  if (element.querySelector?.('[data-testid^="cot-v5-"]') || element.closest?.('[data-testid^="cot-v5-"]')) return true;
  const transition = element.closest?.('[data-item-anchor], [data-transition-position]');
  if (!transition || !turn.contains(transition)) return false;
  if (!hasClassToken(element, 'text-token-text-tertiary') && !element.querySelector?.('.text-token-text-tertiary')) return false;
  if (finalNode && !finalNode.contains(element)) {
    const { stack, finalBranch } = findMessageStack(turn, finalNode);
    const children = Array.from(stack?.children || []);
    const elementBranch = directChildContaining(stack, element);
    return elementBranch && finalBranch && children.indexOf(elementBranch) < children.indexOf(finalBranch);
  }
  return true;
}

function collectExplicitThinkingCandidates(turn, finalNode) {
  if (!turn?.querySelectorAll) return [];
  const roots = [];
  const add = (element) => {
    if (!element || !isVisible(element) || isThinkingUiExcluded(element)) return;
    if (!turn.contains(element)) return;
    if (roots.some((root) => root === element || root.contains?.(element))) return;
    for (let index = roots.length - 1; index >= 0; index -= 1) {
      if (element.contains?.(roots[index])) roots.splice(index, 1);
    }
    roots.push(element);
  };

  for (const element of Array.from(turn.querySelectorAll('.loading-shimmer-tertiary'))) add(element);
  for (const marker of Array.from(turn.querySelectorAll('[data-testid^="cot-v5-"]'))) {
    add(marker.closest?.('button, [role="button"]') || marker.parentElement);
  }
  for (const element of Array.from(turn.querySelectorAll('.text-token-text-tertiary'))) {
    if (!isReasoningTransitionContext(element, turn, finalNode)) continue;
    add(element.closest?.('button, [role="button"]') || element);
  }

  return roots.map((element, index) => {
    const text = thinkingLabelText(element);
    const testIds = blockTestIds(element);
    const shimmer = hasClassToken(element, 'loading-shimmer-tertiary') || Boolean(element.querySelector?.('.loading-shimmer-tertiary'));
    const cot = testIds.some((value) => /^cot-v5-/i.test(value));
    const active = shimmer || blockIsActive(element);
    return {
      _element: element,
      _exclusionRoot: nearestThinkingScope(element, turn) || element,
      index,
      text,
      kind: element.querySelector?.('pre, code') ? 'tool_status' : 'thinking',
      active,
      state: active ? 'active' : 'completed',
      nodeToken: thinkingNodeToken(element),
      structuralHint: thinkingStructuralHint(element, turn, index),
      source: cot ? 'cot-v5' : shimmer ? 'loading-shimmer-tertiary' : 'tertiary-transition',
      testIds,
    };
  }).filter((candidate) => candidate.text);
}

function thinkingRegistryForTurn(turnId = '') {
  const key = String(turnId || 'unknown-turn');
  if (!thinkingStateByTurn.has(key)) thinkingStateByTurn.set(key, { turnId: key, scan: 0, nextSequence: 1, records: [] });
  while (thinkingStateByTurn.size > 24) thinkingStateByTurn.delete(thinkingStateByTurn.keys().next().value);
  return thinkingStateByTurn.get(key);
}

function reconcileThinkingCandidates(turnId, candidates, options = {}) {
  const reconciled = DOM_PARSER.reconcileThinkingBlocks(thinkingRegistryForTurn(turnId), candidates, {
    turnId,
    now: Date.now(),
    finalSeen: Boolean(options.finalSeen),
  });
  thinkingStateByTurn.set(String(turnId || 'unknown-turn'), reconciled.state);
  return reconciled;
}

function readVisibleBlock(element, index, finalNode = null) {
  const final = Boolean(finalNode && (element === finalNode || element.contains?.(finalNode)));
  const textRoot = final ? finalNode : element;
  const text = visibleText(textRoot);
  const testIds = blockTestIds(element);
  const block = {
    index,
    final,
    text,
    testIds,
    role: element.getAttribute?.('role') || '',
    state: element.getAttribute?.('data-state') || null,
    ariaBusy: element.getAttribute?.('aria-busy') || null,
    expanded: element.hasAttribute?.('aria-expanded') ? element.getAttribute('aria-expanded') === 'true' : null,
    hasCode: Boolean(element.matches?.('pre, code') || element.querySelector?.('pre, code')),
    active: !final && blockIsActive(element),
    key: `${testIds[0] || element.tagName || 'block'}:${simpleHash(`${testIds.join('|')}|${text}`)}`,
    nodeToken: thinkingNodeToken(element),
    structuralHint: thinkingStructuralHint(element, element.closest?.('[data-turn]') || null, index),
    _element: element,
  };
  return { ...block, kind: DOM_PARSER.classifyVisibleBlock(block) };
}

function readAssistantVisibleBlocks(turn, finalNode) {
  if (!turn) return [];
  const { stack, finalBranch } = finalNode
    ? findMessageStack(turn, finalNode)
    : { stack: findTemporaryMessageStack(turn), finalBranch: null };
  const roots = Array.from(stack?.children || []).filter(isMeaningfulVisibleElement);
  const source = roots.length ? roots : [stack || turn].filter(Boolean);
  const blocks = source.map((element, index) => readVisibleBlock(element, index, finalNode));

  // Some transient reasoning summaries are nested and later replaced wholesale.
  // Capture top-most cot/status nodes even when the temporary stack has only one wrapper.
  if (!finalNode) {
    const markers = Array.from(turn.querySelectorAll?.('[data-testid^="cot-v5-"], [role="status"], [aria-live], [aria-busy="true"]') || [])
      .filter((element) => isMeaningfulVisibleElement(element))
      .filter((element, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.contains?.(element)));
    for (const marker of markers) {
      if (blocks.some((block) => block.text === visibleText(marker))) continue;
      blocks.push(readVisibleBlock(marker, blocks.length, null));
    }
  }

  const grouped = DOM_PARSER.groupVisibleBlocks(blocks);
  return grouped.filter((block) => block.final || block.text);
}

function responseActionBarVisible(turn) {
  if (!turn?.querySelectorAll) return false;
  const copy = Array.from(turn.querySelectorAll('[data-testid="copy-turn-action-button"]')).find(isVisible);
  if (copy) return true;
  return Array.from(turn.querySelectorAll('[role="group"][aria-label], [data-testid*="turn-action" i], [data-testid*="message-action" i]'))
    .some((group) => isVisible(group) && /action|response|message|действ|ответ/i.test(`${group.getAttribute('aria-label') || ''} ${group.getAttribute('data-testid') || ''}`));
}

function readConfirmationState(turn) {
  const root = turn?.closest?.('main') || turn?.closest?.('[role="main"]') || turn || findChatMain();
  if (!root?.querySelectorAll) return false;
  return Array.from(root.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-testid*="confirm" i], [data-testid*="approval" i]'))
    .some((element) => {
      if (!isVisible(element)) return false;
      const buttons = Array.from(element.querySelectorAll('button, [role="button"]')).filter(isVisible);
      const text = `${visibleText(element)} ${buttons.map(buttonSignalText).join(' ')}`;
      return buttons.length > 0 && /confirm|allow|approve|continue|разреш|подтверд|одобр/i.test(text);
    });
}

function readErrorState(turn) {
  const root = turn?.closest?.('main') || turn?.closest?.('[role="main"]') || findChatMain() || turn;
  if (!root?.querySelectorAll) return { hasError: false, text: '' };
  const candidate = Array.from(root.querySelectorAll('[role="alert"], [data-testid*="error" i], [data-testid*="rate-limit" i]'))
    .find((element) => {
      if (!isVisible(element)) return false;
      const text = visibleText(element);
      return /error|failed|something went wrong|rate limit|try again|ошиб|не удалось|лимит/i.test(text);
    });
  return { hasError: Boolean(candidate), text: candidate ? visibleText(candidate) : '' };
}

function unknownTurnTestIds(turn) {
  if (!turn?.querySelectorAll) return [];
  const known = /^(?:conversation-turn-|cot-v5-|copy-turn-action-button$|webpage-citation-pill$|send-button$|stop-button$|composer-|turn-|message-|artifact|file|download)/i;
  return Array.from(new Set(Array.from(turn.querySelectorAll('[data-testid]'))
    .map((element) => element.getAttribute('data-testid') || '')
    .filter((value) => value && !known.test(value))))
    .slice(0, 40);
}

function isCodeBlockChromeElement(element) {
  if (!element || element.closest?.('pre') || element.querySelector?.('pre')) return false;
  const tag = element.tagName?.toLowerCase?.() || '';
  if (/^(?:p|h[1-6]|li|blockquote|table|thead|tbody|tr|td|th)$/.test(tag)) return false;
  let wrapper = element.parentElement;
  let targetPre = null;
  for (let depth = 0; wrapper && depth < 8; depth += 1, wrapper = wrapper.parentElement) {
    const blocks = Array.from(wrapper.querySelectorAll?.('pre') || []);
    if (blocks.length === 1) { targetPre = blocks[0]; break; }
    if (blocks.length > 1 || wrapper.matches?.('.markdown')) break;
  }
  if (!targetPre) return false;
  const relation = element.compareDocumentPosition?.(targetPre) || 0;
  const beforePre = Boolean(relation & Node.DOCUMENT_POSITION_FOLLOWING);
  const afterPre = Boolean(relation & Node.DOCUMENT_POSITION_PRECEDING);
  if (!beforePre && !afterPre) return false;
  const text = visibleText(element);
  const signal = `${element.getAttribute?.('class') || ''} ${element.getAttribute?.('data-testid') || ''} ${element.getAttribute?.('role') || ''} ${element.getAttribute?.('aria-label') || ''}`;
  const structural = /header|toolbar|code|language|syntax/i.test(signal);
  const action = codeUiActionText(`${text} ${element.getAttribute?.('aria-label') || ''} ${element.getAttribute?.('title') || ''}`)
    || Boolean(element.querySelector?.('button, [role="button"]'));
  const languages = DOM_PARSER.codeLanguageLabelsFromText(text);
  return structural || action || (languages.length > 0 && text.length <= 100);
}

function extractFinalAnswer(finalNode, excludedRoots = []) {
  if (!finalNode) return { answer: '', format: 'none', responseBlocks: [], codeBlocks: [], codeBlockDiagnostics: [], parserAudit: null };
  const exclusions = (Array.isArray(excludedRoots) ? excludedRoots : []).filter(Boolean);
  const isExcluded = (element) => Boolean(
    exclusions.some((root) => root === element || root.contains?.(element))
    || element?.matches?.('button, [role="button"], [data-testid="copy-turn-action-button"], [data-testid*="turn-action" i]')
    || element?.closest?.('[data-testid*="turn-action" i], [role="group"][aria-label*="action" i]')
    || isCodeBlockChromeElement(element)
  );
  const markdownNodes = [];
  if (finalNode.matches?.('.markdown')) markdownNodes.push(finalNode);
  markdownNodes.push(...Array.from(finalNode.querySelectorAll?.('.markdown') || []));
  const uniqueMarkdownNodes = markdownNodes.filter((element, index, all) => all.indexOf(element) === index && !all.some((other, otherIndex) => otherIndex !== index && other.contains?.(element)));
  const roots = uniqueMarkdownNodes.length ? uniqueMarkdownNodes : [finalNode];
  const parserPasses = new Map(roots.map((root) => [root, createResponseParserPass(root)]));
  const extractedBlocks = roots.flatMap((element) => extractResponseBlocks(element, isExcluded, parserPasses.get(element)))
    .map((block, index) => ({ ...block, index }));
  const codeBlockDiagnostics = extractedBlocks
    .filter((block) => block.type === 'code_block')
    .map((block, codeIndex) => ({ index: block.index, codeIndex, ...(block._languageDiagnostic || {}) }));
  const rootAudits = roots.map((root) => parserAuditForRoot(
    root,
    extractedBlocks.filter((block) => root.contains?.(block._element) || root === block._element),
    isExcluded,
    parserPasses.get(root),
  ));
  const parserAudit = mergeParserAudits(rootAudits);
  const passMetrics = roots
    .map((root) => globalThis.ChatGptResponseParserCore?.parserPassMetrics?.(parserPasses.get(root)))
    .filter(Boolean);
  if (parserAudit && passMetrics.length) {
    parserAudit.performance = {
      roots: passMetrics.length,
      durationMs: Number(passMetrics.reduce((sum, item) => sum + Number(item.durationMs || 0), 0).toFixed(3)),
      maxRootDurationMs: Number(Math.max(...passMetrics.map((item) => Number(item.durationMs || 0))).toFixed(3)),
      computedStyleReads: passMetrics.reduce((sum, item) => sum + Number(item.computedStyleReads || 0), 0),
      visibilityChecks: passMetrics.reduce((sum, item) => sum + Number(item.visibilityChecks || 0), 0),
      visibilityCacheHits: passMetrics.reduce((sum, item) => sum + Number(item.visibilityCacheHits || 0), 0),
      leafWalks: passMetrics.reduce((sum, item) => sum + Number(item.leafWalks || 0), 0),
      ownerCandidateChecks: passMetrics.reduce((sum, item) => sum + Number(item.ownerCandidateChecks || 0), 0),
      ownerCandidatesEnumerated: passMetrics.reduce((sum, item) => sum + Number(item.ownerCandidatesEnumerated || 0), 0),
    };
  }
  const responseBlocks = extractedBlocks.map(({ _languageDiagnostic, _codeInspection, _blockDiagnostic, _element, _ownedLeaves, ...block }) => ({
    ...block,
    ...(block.type === 'code_block' ? { diagnostic: _languageDiagnostic || null } : _blockDiagnostic ? { diagnostic: _blockDiagnostic } : {}),
  }));
  const codeBlocks = responseBlocks.filter((block) => block.type === 'code_block').map((block) => ({
    index: block.index,
    language: block.language || '',
    code: block.code || '',
    markdown: block.markdown || '',
  }));
  const answer = normalizeMarkdown(responseBlocks.map((block) => block.markdown || block.text || '').filter(Boolean).join('\n\n'));
  return {
    answer,
    format: answer ? (uniqueMarkdownNodes.length ? 'markdown' : 'structured') : 'none',
    responseBlocks,
    codeBlocks,
    codeBlockDiagnostics,
    parserAudit,
  };
}

function readAssistantNodeSnapshot(node, meta = {}) {
  if (!node) return { answer: '', thinking: '', progress: '', progressItems: [], visibleBlocks: [], raw: '', count: meta.count || 0, turnCount: meta.turnCount || 0, format: 'none', artifacts: [], reason: meta.reason || 'no_node', turnKey: meta.turnKey || '', turnIndex: meta.turnIndex ?? -1, candidateIndex: meta.candidateIndex ?? 0, phase: DOM_PARSER.PHASE.ASSISTANT_PLACEHOLDER, signature: '' };

  const turn = node.closest?.('[data-testid^="conversation-turn-"][data-turn], section[data-turn][data-turn-id], main section[data-turn]')
    || (turnRole(node) === 'assistant' ? node : null);
  const parseRoot = turn || node;
  const finalNode = getFinalAssistantNode(parseRoot);
  const visibleBlocks = readAssistantVisibleBlocks(parseRoot, finalNode);
  const explicitThinking = collectExplicitThinkingCandidates(parseRoot, finalNode);
  const broadCandidates = visibleBlocks.filter((block) => block.kind !== 'final').map((block, index) => {
    const element = block._element;
    const overlaps = element ? explicitThinking.filter((candidate) => {
      const root = candidate._element;
      return Boolean(root && (root === element || root.contains?.(element) || element.contains?.(root)));
    }) : [];
    const exactDuplicate = explicitThinking.some((candidate) => normalizeText(candidate.text) === normalizeText(block.text));
    const ownedByExplicitRoot = overlaps.some((candidate) => candidate._element === element || candidate._element?.contains?.(element));
    if (exactDuplicate || ownedByExplicitRoot) return null;

    const nested = overlaps.filter((candidate) => element?.contains?.(candidate._element));
    const candidateText = nested.length
      ? DOM_PARSER.stripTrailingNestedProgressLabels(block.text, nested.map((candidate) => candidate.text))
      : block.text;
    const active = Boolean(block.active || nested.some((candidate) => candidate.active));
    return {
      _element: block._element,
      index: explicitThinking.length + index,
      text: candidateText,
      kind: block.kind === 'reasoning-summary' ? 'thinking' : block.kind === 'tool' ? 'tool_status' : block.kind === 'status' ? 'progress' : 'action_status',
      active,
      state: active ? 'active' : 'completed',
      nodeToken: block.nodeToken || thinkingNodeToken(block._element),
      structuralHint: block.structuralHint || thinkingStructuralHint(block._element, parseRoot, explicitThinking.length + index),
      source: block.testIds?.join(' ') || block.kind,
      testIds: block.testIds || [],
    };
  }).filter((candidate) => candidate?.text && !DOM_PARSER.isAssistantAuthorLabel(candidate.text));
  const logicalTurnKey = meta.turnKey || turnKey(turn, meta.turnIndex ?? -1) || finalNode?.getAttribute?.('data-message-id') || 'assistant-turn';
  const reconciledThinking = reconcileThinkingCandidates(logicalTurnKey, [...explicitThinking, ...broadCandidates], { finalSeen: Boolean(finalNode) });
  const progressItems = reconciledThinking.items;
  const activeProgressItems = progressItems.filter((item) => item.active && item.visible);
  const thinking = activeProgressItems.filter((item) => item.kind === 'thinking').map((item) => item.text).join('\n');
  const progress = activeProgressItems.filter((item) => item.kind !== 'thinking').map((item) => item.text).join('\n');
  const reasoningHistory = progressItems.filter((item) => item.state === 'completed' && item.kind === 'thinking');
  const artifacts = collectArtifactsForAssistantNode(parseRoot, meta);
  const { answer, format, responseBlocks, codeBlocks, codeBlockDiagnostics, parserAudit } = extractFinalAnswer(finalNode, explicitThinking.map((candidate) => candidate._exclusionRoot || candidate._element));
  const raw = visibleText(parseRoot);
  const stopVisible = Boolean(findStopButton(finalizationControlRoots(getActiveRequest(), { turnKey: meta.turnKey || turnKey(turn, meta.turnIndex ?? -1) })));
  const sendVisible = Boolean(findSendButton(finalizationControlRoots(getActiveRequest(), { turnKey: meta.turnKey || turnKey(turn, meta.turnIndex ?? -1) })));
  const actionBarVisible = responseActionBarVisible(parseRoot);
  const hasActiveTool = progressItems.some((item) => item.kind === 'tool_status' && item.active && item.visible);
  const needsContinue = Boolean(findContinueButton(finalizationControlRoots(getActiveRequest(), { turnKey: meta.turnKey || turnKey(turn, meta.turnIndex ?? -1) })));
  const needsConfirmation = readConfirmationState(parseRoot);
  const errorState = readErrorState(parseRoot);
  const failedArtifacts = artifacts.filter((artifact) => String(artifact.phase || '').toUpperCase() === 'FAILED');
  const artifactErrorText = failedArtifacts.map((artifact) => artifact.errorText || artifact.name || artifact.id).filter(Boolean).join('; ');
  const testIds = blockTestIds(parseRoot);
  const hasReasoningMarker = testIds.some((value) => /^cot-v5-/i.test(value)) || progressItems.some((item) => item.kind === 'thinking');
  const role = turnRole(parseRoot) || 'assistant';
  const phase = DOM_PARSER.classifyTurnPhase({
    role,
    hasFinalNode: Boolean(finalNode),
    stopVisible,
    actionBarVisible,
    hasPriorVisibleBlocks: progressItems.length > 0,
    hasReasoningMarker,
    hasVisibleStatusText: activeProgressItems.some((block) => block.text),
    hasActiveTool,
    needsConfirmation,
    needsContinue,
    hasError: errorState.hasError || failedArtifacts.length > 0,
  });
  if (parserAudit?.coverage) parserAudit.coverage.reasoningLeaves = progressItems.filter((item) => item.kind === 'thinking' && item.text).length;
  if (parserAudit && finalNode && (phase === DOM_PARSER.PHASE.ASSISTANT_FINAL || meta.captureSourceHtml)) {
    parserAudit.sourceHtml = safeOuterHtml(finalNode, 50_000);
    parserAudit.sourceDomPath = domPathForNode(finalNode, parseRoot);
  }
  const snapshot = {
    answer,
    thinking,
    progress,
    progressItems,
    reasoningHistory,
    visibleBlocks: visibleBlocks.map(({ _element, nodeToken, structuralHint, ...block }) => block),
    raw,
    count: meta.count || getAssistantNodes().length,
    turnCount: meta.turnCount || getTurnNodes().length,
    format,
    responseBlocks,
    codeBlocks,
    codeBlockDiagnostics,
    parserAudit,
    artifacts,
    reason: meta.reason || (finalNode ? 'final_author_node' : 'assistant_turn_without_final'),
    turnKey: meta.turnKey || turnKey(turn, meta.turnIndex ?? -1) || finalNode?.getAttribute?.('data-message-id') || '',
    turnIndex: meta.turnIndex ?? -1,
    candidateIndex: meta.candidateIndex ?? 0,
    messageId: finalNode?.getAttribute?.('data-message-id') || '',
    modelSlug: finalNode?.getAttribute?.('data-message-model-slug') || '',
    phase,
    stopVisible,
    sendVisible,
    actionBarVisible,
    hasFinalMessage: Boolean(finalNode),
    hasActiveTool,
    needsConfirmation,
    needsContinue,
    hasError: errorState.hasError || failedArtifacts.length > 0,
    errorText: errorState.text || artifactErrorText,
    conversationId: conversationIdFromUrl(location.href) || '',
    unknownTestIds: unknownTurnTestIds(parseRoot),
  };
  snapshot.signature = DOM_PARSER.buildSnapshotSignature(snapshot);
  return snapshot;
}


    return Object.freeze({
      getTurnNodes,
      getFinalAssistantNode,
      turnKey,
      turnRole,
      getAssistantNodes,
      getAssistantNodeFromTurn,
      waitForSubmittedUserTurnAnchor,
      refreshRequestTurnAnchors,
      readLatestAssistantSnapshot,
      readAssistantSnapshotByTurnKey,
      readRecentAssistantSnapshots,
      readAssistantSnapshot,
      responseActionBarVisible,
      readAssistantNodeSnapshot,
    });
  }

  globalThis.ChatGptTurnSnapshots = Object.freeze({ createTurnSnapshots });
})();
