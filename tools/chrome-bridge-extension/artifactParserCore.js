// Pure artifact-card and preview helpers shared by the DOM parser and browser tests.
(() => {
  'use strict';

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

  function normalizedDomToken(value = '') {
    return normalizeComparable(value).replace(/\s+/g, '-');
  }

  function artifactPreviewNameFromId(value = '') {
    const raw = String(value || '');
    const prefix = 'artifact-text-preview-';
    return raw.startsWith(prefix) ? raw.slice(prefix.length) : '';
  }


  function artifactNameParts(value = '') {
    const name = normalizeText(value).split(/[\\/]/).pop() || '';
    const match = name.match(/^(.*)\.([a-z0-9][a-z0-9+_-]{0,15})$/i);
    return {
      name,
      stem: match ? match[1] : name,
      extension: match ? match[2].toLowerCase() : '',
    };
  }

  const ARTIFACT_FORMAT_ALIASES = Object.freeze({
    txt: Object.freeze(['txt', 'text', 'plain text']),
    md: Object.freeze(['md', 'markdown']),
    json: Object.freeze(['json']),
    csv: Object.freeze(['csv', 'comma separated values', 'comma-separated values']),
    tsv: Object.freeze(['tsv', 'tab separated values', 'tab-separated values']),
    zip: Object.freeze(['zip', 'zip archive', 'archive']),
    pdf: Object.freeze(['pdf']),
    xlsx: Object.freeze(['xlsx', 'excel', 'spreadsheet']),
    xls: Object.freeze(['xls', 'excel', 'spreadsheet']),
    docx: Object.freeze(['docx', 'word', 'document']),
    pptx: Object.freeze(['pptx', 'powerpoint', 'presentation']),
    png: Object.freeze(['png', 'image']),
    jpg: Object.freeze(['jpg', 'jpeg', 'image']),
    jpeg: Object.freeze(['jpeg', 'jpg', 'image']),
    gif: Object.freeze(['gif', 'image']),
    mp4: Object.freeze(['mp4', 'video']),
  });

  const MIME_FORMATS = Object.freeze({
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'text/tab-separated-values': 'tsv',
    'application/json': 'json',
    'application/zip': 'zip',
    'application/x-zip-compressed': 'zip',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
  });

  function artifactFormatToken({ name = '', extension = '', mime = '' } = {}) {
    const explicit = normalizeComparable(extension).replace(/^\./, '');
    if (explicit) return explicit;
    const fromName = artifactNameParts(name).extension;
    if (fromName) return fromName;
    return MIME_FORMATS[String(mime || '').toLowerCase()] || '';
  }

  function artifactFormatLabelToken(value = '') {
    const normalized = normalizeActionLabel(value);
    if (!normalized) return '';
    for (const [token, aliases] of Object.entries(ARTIFACT_FORMAT_ALIASES)) {
      if (aliases.some((alias) => normalizeActionLabel(alias) === normalized)) return token;
    }
    return /^[a-z0-9][a-z0-9+_-]{0,15}$/.test(normalized) ? normalized : '';
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
    desiredExtension = '',
    desiredMime = '',
    dialogLabel = '',
    heading = '',
    fileNameCandidates = [],
    displayTitleCandidates = [],
    formatLabels = [],
    previewIds = [],
    controls = [],
    allowFormatOnly = false,
  } = {}) {
    const desired = normalizeComparable(desiredName);
    if (!desired) return { ok: false, reason: 'missing_desired_name' };

    const desiredParts = artifactNameParts(desiredName);
    const desiredStem = normalizeComparable(desiredParts.stem);
    const expectedFormat = artifactFormatToken({ name: desiredName, extension: desiredExtension, mime: desiredMime });
    const previewNames = Array.from(previewIds || []).map(artifactPreviewNameFromId).filter(Boolean);
    const observedNames = [dialogLabel, heading, ...fileNameCandidates, ...previewNames]
      .map(normalizeComparable)
      .filter(Boolean);
    const rawDisplayTitles = Array.from(displayTitleCandidates || []).map(normalizeText).filter(Boolean);
    const displayTitleComparables = rawDisplayTitles.map(normalizeComparable);
    const observedFormats = Array.from(formatLabels || []).map(artifactFormatLabelToken).filter(Boolean);
    const exactFilename = observedNames.includes(desired);
    const exactDisplayTitle = displayTitleComparables.includes(desired);
    const stemTitleMatched = Boolean(desiredStem && displayTitleComparables.includes(desiredStem));
    const formatMatched = Boolean(expectedFormat && observedFormats.includes(expectedFormat));
    const stemAndFormatMatched = Boolean(stemTitleMatched && formatMatched);
    const formatOnlyMatched = Boolean(allowFormatOnly && expectedFormat && formatMatched && displayTitleComparables.length === 1);
    const identitySource = exactFilename
      ? 'exact_filename'
      : exactDisplayTitle
        ? 'exact_display_title'
        : stemAndFormatMatched
          ? 'display_title_stem_and_format'
          : formatOnlyMatched
            ? 'unique_format_after_exact_action'
            : '';
    if (!identitySource) {
      return {
        ok: false,
        reason: 'preview_filename_mismatch',
        desiredName,
        desiredStem,
        expectedFormat,
        observedNames,
        displayTitles: rawDisplayTitles,
        observedFormats,
        allowFormatOnly: Boolean(allowFormatOnly),
      };
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
    const desiredExtensionToken = desiredParts.extension || normalizeComparable(desiredExtension).replace(/^\./, '');
    const downloadNameAliases = desiredExtensionToken
      ? rawDisplayTitles.map((title) => {
          const suffix = `.${desiredExtensionToken}`;
          return normalizeComparable(title).endsWith(suffix) ? title : `${title}${suffix}`;
        })
      : [];
    return {
      ok: true,
      source,
      identitySource,
      downloadControlIndex: download.index,
      closeControlIndex: close?.index ?? null,
      closeSource: close
        ? (close.testId === 'close-button' ? 'stable_close_testid' : 'localized_close_label')
        : '',
      textPreview: previewNames.map(normalizeComparable).includes(desired),
      observedNames,
      displayTitles: rawDisplayTitles,
      displayTitleComparables,
      observedFormats,
      expectedFormat,
      exactFilename,
      exactDisplayTitle,
      stemTitleMatched,
      formatMatched,
      formatOnlyMatched,
      downloadNameAliases,
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

  function scoreArtifactActionCandidate(artifact = {}, candidate = {}) {
    const desiredName = normalizeComparable(artifact.name || artifact.fileName || '');
    const candidateName = normalizeComparable(candidate.name || candidate.fileName || '');
    const exactName = Boolean(desiredName && candidateName && desiredName === candidateName);

    const exactBlockRange = Boolean(
      artifact.blockStart
      && artifact.blockEnd
      && candidate.blockStart === artifact.blockStart
      && candidate.blockEnd === artifact.blockEnd
    );
    const exactBlockTestId = Boolean(
      artifact.blockTestId
      && candidate.blockTestId
      && candidate.blockTestId === artifact.blockTestId
    );
    const exactActionTestId = Boolean(
      artifact.actionTestId
      && candidate.actionTestId
      && candidate.actionTestId === artifact.actionTestId
    );
    const exactActionAriaLabel = Boolean(
      artifact.actionAriaLabel
      && candidate.actionAriaLabel
      && candidate.actionAriaLabel === artifact.actionAriaLabel
    );
    const exactOrdinal = Number.isInteger(artifact.actionOrdinal)
      && Number.isInteger(candidate.actionOrdinal)
      && candidate.actionOrdinal === artifact.actionOrdinal;
    const exactTag = Boolean(
      artifact.actionTag
      && candidate.actionTag
      && candidate.actionTag === artifact.actionTag
    );

    // A selector hint is never identity. It is frequently a generic CSS path
    // shared by every generated-file button in the same assistant turn.
    const locatorIdentity = (exactBlockRange || exactBlockTestId)
      && (exactOrdinal || exactActionTestId || exactActionAriaLabel);
    const actionIdentityWithoutName = !desiredName && (locatorIdentity || exactActionTestId || exactActionAriaLabel);
    const eligible = exactName || locatorIdentity || actionIdentityWithoutName;

    let score = 0;
    if (exactName) score += 240;
    if (exactBlockRange) score += 120;
    if (exactBlockTestId) score += 90;
    if (exactActionTestId) score += 80;
    if (exactActionAriaLabel) score += 70;
    if (exactOrdinal) score += 30;
    if (exactTag) score += 5;
    if (candidate.selectorMatched) score += 2;

    return {
      eligible,
      score: eligible ? score : -Infinity,
      exactName,
      locatorIdentity,
      desiredName,
      candidateName,
    };
  }

  function selectArtifactActionCandidate(artifact = {}, candidates = []) {
    const ranked = Array.from(candidates || []).map((candidate, index) => ({
      index,
      candidate,
      match: scoreArtifactActionCandidate(artifact, candidate),
    }))
      .filter((entry) => entry.match.eligible && Number.isFinite(entry.match.score))
      .sort((left, right) => right.match.score - left.match.score || left.index - right.index);

    if (!ranked.length) {
      return {
        ok: false,
        reason: 'artifact_action_identity_not_found',
        desiredName: normalizeComparable(artifact.name || artifact.fileName || ''),
      };
    }
    if (ranked.length > 1 && ranked[0].match.score === ranked[1].match.score) {
      return {
        ok: false,
        reason: 'artifact_action_identity_ambiguous',
        score: ranked[0].match.score,
        candidateIndexes: ranked.filter((entry) => entry.match.score === ranked[0].match.score).map((entry) => entry.index),
      };
    }
    return {
      ok: true,
      index: ranked[0].index,
      score: ranked[0].match.score,
      exactName: ranked[0].match.exactName,
      locatorIdentity: ranked[0].match.locatorIdentity,
      candidateName: ranked[0].match.candidateName,
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

  function isArtifactLifecycleStateDescriptor(signals = {}) {
    const ariaBusy = String(signals.ariaBusy || '').toLowerCase() === 'true';
    const role = normalizeComparable(signals.role || '');
    if (ariaBusy || role === 'progressbar') return true;
    const attributes = normalizeComparable([
      signals.dataState,
      signals.testId,
      signals.className,
    ].filter(Boolean).join(' '));
    if (/(?:^|\b)(?:loading|generating|creating|preparing|processing|uploading|pending|failed|error|rejected|spinner|animate-spin|progress|созда|готовит|обрабаты|загруж|ошибк|отклон)(?:\b|$)/i.test(attributes)) return true;
    const tagName = normalizeComparable(signals.tagName || '');
    if (tagName === 'button' || tagName === 'a') return false;
    const ownText = normalizeComparable(signals.ownText || '');
    return /(?:^|\b)(?:loading|generating|creating|preparing|processing|uploading|pending|failed|error|rejected|созда|готовит|обрабаты|загруж|ошибк|отклон)(?:\b|$)/i.test(ownText);
  }

  function artifactBlocksCompletion(artifact = {}) {
    const phase = String(artifact?.phase || 'READY').toUpperCase();
    if (phase === 'READY' || phase === 'FAILED') return false;
    const materializable = Boolean(
      artifact?.downloadActionPresent
      || artifact?.downloadable
      || artifact?.url
      || artifact?.downloadUrl
      || artifact?.src
    );
    if (artifact?.lifecycleObserved === false && !materializable) return false;
    return true;
  }

  function allArtifactsReady(artifacts = []) {
    return !(Array.isArray(artifacts) ? artifacts : []).some(artifactBlocksCompletion);
  }


  globalThis.ChatGptArtifactParserCore = Object.freeze({
    normalizedDomToken,
    artifactPreviewNameFromId,
    artifactNameParts,
    artifactFormatToken,
    artifactFormatLabelToken,
    artifactPreviewActionKind,
    planArtifactPreviewDownload,
    isTextLikeArtifactDescriptor,
    shouldWaitForLateArtifactPreview,
    artifactPreviewReadiness,
    scoreArtifactActionCandidate,
    selectArtifactActionCandidate,
    extractFileLikeName,
    extractFileLikeNames,
    classifyArtifactPhase,
    isArtifactLifecycleStateDescriptor,
    artifactBlocksCompletion,
    allArtifactsReady,
  });
})();
