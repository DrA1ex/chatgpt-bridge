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

  function conversationIdFromUrl(value = '') {
    try {
      const parsed = new URL(String(value || ''), 'https://chatgpt.com');
      return parsed.pathname.match(/^\/c\/([^/?#]+)\/?$/)?.[1] || '';
    } catch {
      return '';
    }
  }

  function canonicalConversationUrl(value = '') {
    try {
      const parsed = new URL(String(value || ''), 'https://chatgpt.com');
      const id = conversationIdFromUrl(parsed.toString());
      if (!id) return '';
      const host = parsed.hostname.toLowerCase();
      if (host !== 'chatgpt.com' && host !== 'chat.openai.com') return '';
      return `${parsed.protocol}//${host}/c/${id}`;
    } catch {
      return '';
    }
  }

  function verifySessionDeletionTarget({ currentUrl = '', expectedUrl = '', expectedSessionId = '' } = {}) {
    const currentId = conversationIdFromUrl(currentUrl);
    const expectedIdFromUrl = conversationIdFromUrl(expectedUrl);
    const expectedId = String(expectedSessionId || '').trim();
    const currentCanonical = canonicalConversationUrl(currentUrl);
    const expectedCanonical = canonicalConversationUrl(expectedUrl);

    if (!expectedId) return { ok: false, reason: 'missing_expected_session_id' };
    if (!expectedUrl) return { ok: false, reason: 'missing_expected_url' };
    if (!currentId || !currentCanonical) return { ok: false, reason: 'current_url_is_not_a_conversation' };
    if (!expectedIdFromUrl || !expectedCanonical) return { ok: false, reason: 'expected_url_is_not_a_conversation' };
    if (expectedId !== expectedIdFromUrl) {
      return { ok: false, reason: 'expected_session_url_mismatch', currentId, expectedId, expectedIdFromUrl };
    }
    if (currentId !== expectedId) {
      return { ok: false, reason: 'current_session_mismatch', currentId, expectedId };
    }
    if (currentCanonical !== expectedCanonical) {
      return { ok: false, reason: 'current_url_mismatch', currentCanonical, expectedCanonical, currentId, expectedId };
    }
    return { ok: true, currentId, expectedId, currentCanonical, expectedCanonical };
  }


  function normalizedDomToken(value = '') {
    return normalizeComparable(value).replace(/\s+/g, '-');
  }

  function artifactPreviewNameFromId(value = '') {
    const raw = String(value || '');
    const prefix = 'artifact-text-preview-';
    return raw.startsWith(prefix) ? raw.slice(prefix.length) : '';
  }

  const ARTIFACT_PREVIEW_ACTION_LABELS = Object.freeze({
    download: Object.freeze([
      'download', 'скачать', 'telecharger', 'herunterladen', 'descargar', 'scarica', 'baixar',
      'downloaden', 'pobierz', 'indir', 'ダウンロード', '다운로드', '下载', '下載',
    ]),
    close: Object.freeze([
      'close', 'закрыть', 'exit full screen', 'exit fullscreen', 'leave full screen',
      'выйти из полноэкранного режима', 'quitter le plein ecran', 'fermer',
      'vollbildmodus verlassen', 'schliessen', 'salir de pantalla completa', 'cerrar',
      'esci da schermo intero', 'chiudi', 'sair da tela cheia', 'fechar',
      'volledig scherm afsluiten', 'sluiten', 'zamknij', '全画面表示を終了', '閉じる',
      '전체 화면 종료', '닫기', '退出全屏', '关闭', '關閉',
    ]),
  });

  function normalizeActionLabel(value = '') {
    return normalizeComparable(value)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\s_-]+/g, ' ')
      .trim();
  }

  function artifactPreviewActionKind({ ariaLabel = '', title = '', testId = '', hasDownloadAttribute = false } = {}) {
    const normalizedTestId = normalizedDomToken(testId);
    if (hasDownloadAttribute) return 'download';
    if (normalizedTestId === 'close-button' || /(?:^|[-_])close(?:[-_]|$)/.test(normalizedTestId)) return 'close';
    if (/download/.test(normalizedTestId) && !/upload/.test(normalizedTestId)) return 'download';

    const label = normalizeActionLabel(ariaLabel || title || '');
    if (!label) return '';
    const matches = (items) => items.some((item) => {
      const candidate = normalizeActionLabel(item);
      return label === candidate || label.startsWith(`${candidate} `) || label.endsWith(` ${candidate}`);
    });
    if (matches(ARTIFACT_PREVIEW_ACTION_LABELS.download)) return 'download';
    if (matches(ARTIFACT_PREVIEW_ACTION_LABELS.close)) return 'close';
    return '';
  }

  // ChatGPT currently exposes file-preview actions inconsistently. Prefer
  // stable metadata, but accept a bounded multilingual aria-label fallback for
  // the exact filename-bound preview container. Never search globally by text.
  function planArtifactPreviewDownload({
    desiredName = '',
    dialogLabel = '',
    heading = '',
    fileNameCandidates = [],
    previewIds = [],
    controls = [],
  } = {}) {
    const desired = normalizeComparable(desiredName);
    if (!desired) return { ok: false, reason: 'missing_desired_name' };

    const previewNames = Array.from(previewIds || []).map(artifactPreviewNameFromId).filter(Boolean);
    const observedNames = [dialogLabel, heading, ...fileNameCandidates, ...previewNames]
      .map(normalizeComparable)
      .filter(Boolean);
    if (!observedNames.includes(desired)) {
      return { ok: false, reason: 'preview_filename_mismatch', desiredName, observedNames };
    }

    const normalizedControls = Array.from(controls || []).map((control, index) => {
      const descriptor = {
        index,
        tagName: String(control?.tagName || '').toLowerCase(),
        testId: normalizedDomToken(control?.testId || ''),
        ariaLabel: String(control?.ariaLabel || ''),
        title: String(control?.title || ''),
        hasDownloadAttribute: Boolean(control?.hasDownloadAttribute),
      };
      return { ...descriptor, actionKind: artifactPreviewActionKind(descriptor) };
    });
    const downloads = normalizedControls.filter((control) => control.actionKind === 'download');
    if (downloads.length !== 1) {
      return {
        ok: false,
        reason: downloads.length ? 'ambiguous_download_controls' : 'download_control_not_identified',
        controlCount: normalizedControls.length,
        downloadCount: downloads.length,
      };
    }
    const closes = normalizedControls.filter((control) => control.actionKind === 'close');
    if (closes.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous_close_controls',
        controlCount: normalizedControls.length,
        closeCount: closes.length,
      };
    }

    const download = downloads[0];
    const close = closes[0] || null;
    const stableDownload = download.hasDownloadAttribute
      || /download/.test(download.testId)
      || (download.tagName === 'a' && download.hasDownloadAttribute);
    const source = stableDownload
      ? 'stable_download_metadata'
      : 'localized_download_label';
    return {
      ok: true,
      source,
      downloadControlIndex: download.index,
      closeControlIndex: close?.index ?? null,
      closeSource: close
        ? (close.testId === 'close-button' ? 'stable_close_testid' : 'localized_close_label')
        : '',
      textPreview: previewNames.map(normalizeComparable).includes(desired),
      observedNames,
    };
  }


  function isTextLikeArtifactDescriptor(artifact = {}) {
    const name = String(artifact.name || artifact.fileName || '').toLowerCase();
    const mime = String(artifact.mime || '').toLowerCase();
    if (mime.startsWith('text/')) return true;
    if (/^(?:application\/(?:json|ld\+json|xml|javascript|x-javascript|yaml|x-yaml))$/.test(mime)) return true;
    return /\.(?:txt|md|markdown|json|jsonl|ndjson|csv|tsv|xml|yaml|yml|js|mjs|cjs|ts|tsx|jsx|css|html?|svg|sql|sh|bash|zsh|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|ini|toml|conf|log)$/i.test(name);
  }

  function shouldWaitForLateArtifactPreview({ artifact = {}, result = {}, previewObserved = false } = {}) {
    if (previewObserved || !isTextLikeArtifactDescriptor(artifact)) return false;
    return ['page-url', 'dom-url'].includes(String(result.captureSource || ''));
  }

  function artifactPreviewReadiness({
    plan = null,
    downloadControlUsable = false,
    textContentMounted = false,
    loaderVisible = false,
  } = {}) {
    if (!plan?.ok) return { ready: false, reason: plan?.reason || 'preview_plan_not_ready' };
    if (!downloadControlUsable) {
      return { ready: false, reason: loaderVisible ? 'preview_loading' : 'download_control_not_ready' };
    }
    if (plan.textPreview && !textContentMounted) {
      return { ready: false, reason: loaderVisible ? 'preview_loading' : 'text_content_not_ready' };
    }
    return { ready: true, reason: 'ready' };
  }

  // Destructive UI automation must not depend on localized visible labels.
  // Only stable DOM metadata is accepted; visible text is retained solely for
  // diagnostics by the caller.
  function isConversationDeleteActionDescriptor({ testId = '', role = '' } = {}) {
    const normalizedTestId = normalizedDomToken(testId);
    if (!normalizedTestId) return false;
    if (/(?:^|[-_])(?:all|every|bulk)(?:[-_]|$)|(?:^|[-_])clear(?:[-_]|$)/.test(normalizedTestId)) return false;
    const exact = /^(?:delete-chat-menu-item|delete-conversation-menu-item|chat-delete-menu-item|conversation-delete-menu-item)$/.test(normalizedTestId);
    const semantic = /delete/.test(normalizedTestId)
      && /(?:chat|conversation)/.test(normalizedTestId)
      && /(?:menu|item|action|button)/.test(normalizedTestId);
    if (!exact && !semantic) return false;
    const normalizedRole = normalizedDomToken(role);
    return !normalizedRole || /^(?:menuitem|button)$/.test(normalizedRole);
  }

  function isConversationDeleteConfirmationDescriptor({
    testId = '',
    role = '',
    dataColor = '',
    dataVariant = '',
    dataDestructive = '',
  } = {}) {
    const normalizedTestId = normalizedDomToken(testId);
    const normalizedRole = normalizedDomToken(role);
    const semanticTestId = Boolean(normalizedTestId)
      && /(?:confirm.*delete|delete.*confirm)/.test(normalizedTestId)
      && /(?:chat|conversation)/.test(normalizedTestId);
    if (semanticTestId) return !normalizedRole || normalizedRole === 'button';

    // This fallback is safe only when the caller scopes it to the modal that
    // appeared directly after clicking the exact conversation-delete item.
    const destructive = ['danger', 'destructive'].includes(normalizedDomToken(dataColor))
      || ['danger', 'destructive'].includes(normalizedDomToken(dataVariant))
      || normalizedDomToken(dataDestructive) === 'true';
    return destructive && (!normalizedRole || normalizedRole === 'button');
  }

  function menuTriggerOwnsMenu({ triggerId = '', triggerAriaControls = '', menuId = '', menuAriaLabelledby = '' } = {}) {
    const trigger = String(triggerId || '').trim();
    const controls = String(triggerAriaControls || '').trim();
    const menu = String(menuId || '').trim();
    const labelledBy = String(menuAriaLabelledby || '').trim().split(/\s+/).filter(Boolean);
    return Boolean((trigger && labelledBy.includes(trigger)) || (controls && menu && controls === menu));
  }

  function selectLatestNewTurnRecord(records = [], baselineKeys = [], role = 'user') {
    const baseline = baselineKeys instanceof Set ? baselineKeys : new Set(Array.isArray(baselineKeys) ? baselineKeys : []);
    const expectedRole = String(role || '').trim();
    const candidates = (Array.isArray(records) ? records : [])
      .filter((record) => record && record.key && (!expectedRole || record.role === expectedRole) && !baseline.has(record.key));
    return candidates[candidates.length - 1] || null;
  }

  function selectFirstTurnAfterRecord(records = [], startKey = '', role = 'assistant') {
    const list = Array.isArray(records) ? records : [];
    const startIndex = list.findIndex((record) => record?.key === startKey);
    if (startIndex < 0) return null;
    const expectedRole = String(role || '').trim();
    return list.slice(startIndex + 1).find((record) => record && (!expectedRole || record.role === expectedRole)) || null;
  }

  function comparableTokens(value = '') {
    return normalizeComparable(value)
      .split(/[^\p{L}\p{N}]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3)
      .map((token) => token.slice(0, Math.min(7, token.length)));
  }

  function textSimilarity(left = '', right = '') {
    const a = normalizeComparable(left);
    const b = normalizeComparable(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) {
      const shorter = Math.min(a.length, b.length);
      const longer = Math.max(a.length, b.length);
      return Math.max(0.72, shorter / Math.max(1, longer));
    }
    const aTokens = new Set(comparableTokens(a));
    const bTokens = new Set(comparableTokens(b));
    if (!aTokens.size || !bTokens.size) return 0;
    let intersection = 0;
    for (const token of aTokens) if (bTokens.has(token)) intersection += 1;
    return intersection / Math.max(aTokens.size, bTokens.size);
  }

  function normalizedThinkingState(candidate = {}) {
    if (candidate.state === 'completed' || candidate.state === 'removed') return candidate.state;
    return candidate.active ? 'active' : 'completed';
  }

  function thinkingRecordPublic(record = {}) {
    return {
      id: record.id,
      key: record.id,
      sequence: record.sequence,
      kind: record.kind,
      state: record.state,
      text: record.text,
      revision: record.revision,
      active: record.state === 'active',
      visible: Boolean(record.visible),
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
      structuralHint: record.structuralHint || '',
      source: record.source || '',
      testIds: Array.isArray(record.testIds) ? record.testIds : [],
    };
  }

  /**
   * Reconcile React DOM snapshots into logical thinking/progress records.
   *
   * The same logical block may be rerendered into a different DOM node or move
   * from an active shimmer label to a completed cot-v5 button. Conversely, a
   * transition slot may be reused for a genuinely new step. This helper keeps
   * stable IDs across the first case and allocates a new ID for the second.
   */
  function reconcileThinkingBlocks(previousState = {}, candidates = [], options = {}) {
    const now = Number(options.now || Date.now());
    const turnId = String(options.turnId || previousState.turnId || 'turn');
    const scan = Number(previousState.scan || 0) + 1;
    let nextSequence = Math.max(1, Number(previousState.nextSequence || 1));
    const records = (Array.isArray(previousState.records) ? previousState.records : []).map((record) => ({ ...record, visible: false }));
    const assigned = new Set();
    const events = [];

    const normalizedCandidates = (Array.isArray(candidates) ? candidates : [])
      .map((candidate, index) => ({
        ...candidate,
        index: Number.isFinite(candidate.index) ? candidate.index : index,
        text: normalizeText(candidate.text || ''),
        kind: String(candidate.kind || 'thinking'),
        state: normalizedThinkingState(candidate),
        structuralHint: String(candidate.structuralHint || ''),
        nodeToken: String(candidate.nodeToken || ''),
      }))
      .filter((candidate) => candidate.text);

    const findMatch = (candidate) => {
      const available = records.filter((record) => !assigned.has(record.id) && record.state !== 'removed');
      if (candidate.nodeToken) {
        const sameNode = available.find((record) => record.nodeToken && record.nodeToken === candidate.nodeToken);
        if (sameNode) return sameNode;
      }

      if (candidate.structuralHint) {
        const sameSlot = available
          .filter((record) => record.structuralHint === candidate.structuralHint && record.kind === candidate.kind)
          .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
        for (const record of sameSlot) {
          const similarity = textSimilarity(record.text, candidate.text);
          if (record.state === 'active' && candidate.state === 'completed') return record;
          if (record.state === 'active' && candidate.state === 'active' && similarity >= 0.34) return record;
          if (record.state === 'completed' && candidate.state === 'completed' && similarity >= 0.82) return record;
          if (record.state === 'completed' && candidate.state === 'active' && similarity >= 0.92) return record;
        }
      }

      const exact = available.find((record) => record.kind === candidate.kind && normalizeComparable(record.text) === normalizeComparable(candidate.text));
      if (exact) return exact;

      const similarActive = available
        .filter((record) => record.kind === candidate.kind && record.state === 'active')
        .map((record) => ({ record, score: textSimilarity(record.text, candidate.text) }))
        .sort((a, b) => b.score - a.score)[0];
      return similarActive?.score >= 0.58 ? similarActive.record : null;
    };

    for (const candidate of normalizedCandidates) {
      let record = findMatch(candidate);
      if (!record) {
        const sequence = nextSequence++;
        record = {
          id: `thinking-${turnId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-18) || 'turn'}-${sequence}`,
          sequence,
          kind: candidate.kind,
          state: candidate.state,
          text: candidate.text,
          revision: 1,
          firstSeenAt: now,
          lastSeenAt: now,
          lastSeenScan: scan,
          misses: 0,
          visible: true,
          structuralHint: candidate.structuralHint,
          nodeToken: candidate.nodeToken,
          source: candidate.source || '',
          testIds: candidate.testIds || [],
        };
        records.push(record);
        events.push({ type: 'started', item: thinkingRecordPublic(record) });
      } else {
        assigned.add(record.id);
        const changed = record.text !== candidate.text
          || record.state !== candidate.state
          || record.kind !== candidate.kind
          || record.structuralHint !== candidate.structuralHint;
        record.kind = candidate.kind;
        record.state = candidate.state;
        record.text = candidate.text;
        record.structuralHint = candidate.structuralHint || record.structuralHint;
        record.nodeToken = candidate.nodeToken || record.nodeToken;
        record.source = candidate.source || record.source;
        record.testIds = candidate.testIds || record.testIds;
        record.lastSeenAt = now;
        record.lastSeenScan = scan;
        record.misses = 0;
        record.visible = true;
        if (changed) {
          record.revision = Number(record.revision || 1) + 1;
          events.push({ type: record.state === 'completed' ? 'completed' : 'updated', item: thinkingRecordPublic(record) });
        }
      }
      assigned.add(record.id);
    }

    for (const record of records) {
      if (record.lastSeenScan === scan || record.state === 'removed') continue;
      record.misses = Number(record.misses || 0) + 1;
      const shouldComplete = record.state === 'active' && (Boolean(options.finalSeen) || record.misses >= 2);
      if (shouldComplete) {
        record.state = 'completed';
        record.revision = Number(record.revision || 1) + 1;
        record.lastSeenAt = now;
        events.push({ type: 'completed', item: thinkingRecordPublic(record), reason: options.finalSeen ? 'final_seen' : 'disappeared' });
      }
    }

    const retained = records
      .filter((record) => record.state !== 'removed')
      .sort((a, b) => a.sequence - b.sequence)
      .slice(-80);
    return {
      state: { turnId, scan, nextSequence, records: retained },
      items: retained.map(thinkingRecordPublic),
      events,
    };
  }


  const FILE_EXTENSION_SOURCE = '(?:zip|txt|csv|json|js|mjs|cjs|ts|tsx|jsx|md|pdf|png|jpe?g|webp|gif|svg|html?|css|xml|ya?ml|toml|ini|log|py|sh|bash|zsh|sql|tar|gz|tgz|7z|rar|docx|xlsx|pptx|odt|ods|odp|mp3|wav|mp4|mov|webm)';
  const FILE_NAME_PATTERN = new RegExp(`(?:^|[\\s(\"'\`])([^\\s\\/\\\\:*?\"<>|()]{1,180}\\.${FILE_EXTENSION_SOURCE})(?:$|[\\s),.;:\"'\`])`, 'i');
  const FILE_NAME_PATTERN_GLOBAL = new RegExp(`(?:^|[\\s("'\`])([^\\s\\/\\\\:*?"<>|()]{1,180}\\.${FILE_EXTENSION_SOURCE})(?=$|[\\s),.;:"'\`])`, 'ig');
  const WHOLE_FILE_LABEL_PATTERN = new RegExp(`^[^\\n\\r\\/\\\\:*?\"<>|]{1,180}\\.${FILE_EXTENSION_SOURCE}$`, 'i');

  function extractFileLikeNames(value = '') {
    const text = normalizeText(value);
    if (!text) return [];
    const withoutAction = text
      .replace(/^(?:(?:click|tap|нажмите)\s+(?:to\s+)?|(?:download|save|open|скачать|сохранить|открыть)\s*[:—-]?\s*)+/i, '')
      .trim();
    const extensionHits = withoutAction.match(new RegExp(`\\.${FILE_EXTENSION_SOURCE}(?=$|[\\s),.;:"'\`])`, 'ig')) || [];
    if (WHOLE_FILE_LABEL_PATTERN.test(withoutAction) && extensionHits.length === 1) return [withoutAction];

    const result = [];
    FILE_NAME_PATTERN_GLOBAL.lastIndex = 0;
    let match;
    while ((match = FILE_NAME_PATTERN_GLOBAL.exec(text))) {
      const name = match[1] || '';
      if (name && !result.includes(name)) result.push(name);
      if (match[0] === '') FILE_NAME_PATTERN_GLOBAL.lastIndex += 1;
    }
    return result;
  }

  function extractFileLikeName(value = '') {
    return extractFileLikeNames(value)[0] || '';
  }

  function classifyArtifactPhase(signals = {}) {
    const state = normalizeComparable(`${signals.state || ''} ${signals.text || ''}`);
    if (signals.failed || /(?:^|\b)(?:failed|error|rejected|could not|не удалось|ошибк|отклон)/i.test(state)) return 'FAILED';
    if (signals.busy || signals.progressVisible || signals.disabled || /(?:^|\b)(?:loading|generating|creating|preparing|processing|uploading|pending|созда|готовит|обрабаты|загруж)/i.test(state)) return 'GENERATING';
    if (signals.downloadable || signals.downloadActionPresent || signals.href) return 'READY';
    return 'GENERATING';
  }

  function allArtifactsReady(artifacts = []) {
    return (Array.isArray(artifacts) ? artifacts : []).every((artifact) => {
      const phase = String(artifact?.phase || 'READY').toUpperCase();
      return phase === 'READY';
    });
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
      actionBarVisible: Boolean(snapshot.actionBarVisible),
      needsConfirmation: Boolean(snapshot.needsConfirmation),
      needsContinue: Boolean(snapshot.needsContinue),
      hasError: Boolean(snapshot.hasError),
      artifacts: Array.isArray(snapshot.artifacts)
        ? snapshot.artifacts.map((item) => [item.id || '', item.name || '', item.url || item.downloadUrl || '', item.phase || '', Boolean(item.downloadable), item.state || ''])
        : [],
      blocks,
    });
  }

  function isCompletedSnapshot(snapshot = {}, expectedConversationId = '') {
    if (!snapshot.hasFinalMessage) return false;
    if (snapshot.stopVisible || !snapshot.actionBarVisible) return false;
    if (snapshot.hasActiveTool || snapshot.needsConfirmation || snapshot.needsContinue || snapshot.hasError) return false;
    if (!allArtifactsReady(snapshot.artifacts)) return false;
    if (expectedConversationId && snapshot.conversationId && snapshot.conversationId !== expectedConversationId) return false;
    return snapshot.phase === PHASE.ASSISTANT_FINAL;
  }

  globalThis.ChatGptDomParserCore = Object.freeze({
    PHASE,
    normalizeText,
    normalizeComparable,
    conversationIdFromUrl,
    canonicalConversationUrl,
    verifySessionDeletionTarget,
    artifactPreviewNameFromId,
    artifactPreviewActionKind,
    planArtifactPreviewDownload,
    isTextLikeArtifactDescriptor,
    shouldWaitForLateArtifactPreview,
    artifactPreviewReadiness,
    isConversationDeleteActionDescriptor,
    isConversationDeleteConfirmationDescriptor,
    menuTriggerOwnsMenu,
    selectLatestNewTurnRecord,
    selectFirstTurnAfterRecord,
    textSimilarity,
    reconcileThinkingBlocks,
    extractFileLikeName,
    extractFileLikeNames,
    classifyArtifactPhase,
    allArtifactsReady,
    classifyTurnPhase,
    classifyVisibleBlock,
    groupVisibleBlocks,
    buildSnapshotSignature,
    isCompletedSnapshot,
  });
})();
