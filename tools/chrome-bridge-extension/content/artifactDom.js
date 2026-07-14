// Assistant-turn artifact discovery and metadata normalization.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createArtifactDom(deps = {}) {
    const {
      DOM_PARSER,
      actionSelectorHint,
      guessMime,
      guessNameFromUrl,
      isVisible,
      normalizeText,
      simpleHash,
      visibleText,
    } = deps;

function isZipLikeLabel(text = '') {
  return /\.zip(?:\b|$)|application\/zip|zip archive|архив zip/i.test(String(text || ''));
}

function hasStrictArtifactIntent(text = '') {
  const value = String(text || '');
  return isZipLikeLabel(value) || /download|скачать|export|artifact|canvas|sandbox:|archive file|download file|save (?:file|artifact|archive)|сохранить (?:файл|архив)|выгрузить (?:файл|архив)/i.test(value);
}

function looksLikeThinkingProgressText(text = '') {
  const value = String(text || '');
  return /thinking|think|reasoning|thought|думаю|размыш|inspect|list|read|scan|upload|prepare|analyz|смотрю|читаю|провер|анализ/i.test(value);
}

function collectArtifactsForAssistantNode(node, meta = {}) {
  const scopes = [];
  const addScope = (scope) => {
    if (!scope || scopes.includes(scope)) return;
    scopes.push(scope);
  };
  addScope(node);
  const containingTurn = node.closest?.('section[data-testid^="conversation-turn"], section[data-turn-id][data-turn]') || null;
  addScope(containingTurn);
  const effectiveMeta = {
    ...meta,
    turnKey: meta.turnKey || turnKey(containingTurn || node, meta.turnIndex ?? -1),
  };
  // Output files can be children of the final Markdown node or sibling tool
  // result blocks, but the scan must remain inside the owning assistant turn.
  return mergeArtifacts(...scopes.map((scope) => collectArtifactsFromNode(scope, effectiveMeta)));
}

function artifactPhaseRank(phase = '') {
  return ({ FAILED: 4, READY: 3, GENERATING: 2, UPLOADING: 1 }[String(phase || '').toUpperCase()] || 0);
}

function mergeArtifactRecords(left, right) {
  if (!left) return right;
  if (!right) return left;
  const preferred = artifactPhaseRank(right.phase) >= artifactPhaseRank(left.phase) ? right : left;
  const fallback = preferred === right ? left : right;
  return {
    ...fallback,
    ...preferred,
    url: preferred.url || fallback.url || '',
    downloadUrl: preferred.downloadUrl || fallback.downloadUrl || '',
    src: preferred.src || fallback.src || '',
    selectorHint: preferred.selectorHint || fallback.selectorHint || '',
    actionLabel: preferred.actionLabel || fallback.actionLabel || '',
    downloadable: Boolean(preferred.downloadable || fallback.downloadable),
    downloadActionPresent: Boolean(preferred.downloadActionPresent || fallback.downloadActionPresent),
    rawAttributes: { ...(fallback.rawAttributes || {}), ...(preferred.rawAttributes || {}) },
  };
}

function mergeArtifacts(...lists) {
  const byKey = new Map();
  for (const artifact of lists.flat().filter(Boolean)) {
    const key = artifact.id || artifact.downloadUrl || artifact.url || artifact.src || [artifact.kind, artifact.name, artifact.blockStart, artifact.blockEnd, artifact.actionLabel].filter(Boolean).join('|');
    if (!key) continue;
    byKey.set(key, mergeArtifactRecords(byKey.get(key), artifact));
  }
  return [...byKey.values()];
}

function queryAllWithSelf(root, selector) {
  if (!root?.querySelectorAll) return [];
  const result = [];
  try {
    if (root.matches?.(selector)) result.push(root);
    result.push(...Array.from(root.querySelectorAll(selector)));
  } catch {
    // Ignore selector incompatibilities in older Chromium builds.
  }
  return result;
}

function elementDescriptor(element) {
  if (!element) return '';
  const own = [
    visibleText(element),
    element.getAttribute?.('aria-label'),
    element.getAttribute?.('title'),
    element.getAttribute?.('data-testid'),
    element.getAttribute?.('download'),
    element.getAttribute?.('href'),
    element.getAttribute?.('class'),
    element.getAttribute?.('data-state'),
    element.getAttribute?.('aria-busy'),
  ];
  const descendants = Array.from(element.querySelectorAll?.('[aria-label], [title], [data-testid], [data-state], [aria-busy], a[href], [download]') || [])
    .slice(0, 24)
    .flatMap((child) => [child.getAttribute('aria-label'), child.getAttribute('title'), child.getAttribute('data-testid'), child.getAttribute('data-state'), child.getAttribute('aria-busy'), child.getAttribute('download'), child.getAttribute('href')]);
  return normalizeText([...own, ...descendants].filter(Boolean).join(' '));
}

function artifactActionSignal(element) {
  if (!element) return '';
  return normalizeText([
    visibleText(element),
    element.getAttribute?.('aria-label'),
    element.getAttribute?.('title'),
    element.getAttribute?.('data-testid'),
    element.getAttribute?.('download'),
    element.getAttribute?.('href'),
    element.getAttribute?.('data-state'),
    element.getAttribute?.('aria-busy'),
  ].filter(Boolean).join(' '));
}

function isBrowserOnlyArtifactUrl(url = '') {
  const value = String(url || '');
  return /^sandbox:/i.test(value) || /^filesystem:/i.test(value) || /\/mnt\/data\//i.test(value);
}

function isExcludedArtifactAction(element) {
  if (!element) return true;
  const signal = artifactActionSignal(element);
  if (/copy|копировать|citation|цитирование кода|share|поделиться|regenerate|повторить ответ/i.test(signal)) return true;
  if (element.closest?.('[data-testid="webpage-citation-pill"], [data-testid="copy-turn-action-button"], [data-testid*="turn-action" i], [role="group"][aria-label*="action" i]')) return true;
  return false;
}

function artifactBlockElement(element, root) {
  if (!element) return null;
  const stable = element.closest?.('[data-start][data-end], [data-testid*="artifact" i], [data-testid*="file" i]');
  if (stable && (!root?.contains || root.contains(stable))) return stable;
  const semantic = element.closest?.('p, li, figure');
  if (semantic && (!root?.contains || root.contains(semantic))) return semantic;
  return element.parentElement && (!root?.contains || root.contains(element.parentElement)) ? element.parentElement : element;
}

function artifactLocatorMeta(element, root) {
  const block = artifactBlockElement(element, root);
  const actions = block ? queryAllWithSelf(block, 'button, [role="button"], a[href]') : [];
  return {
    blockStart: block?.getAttribute?.('data-start') || '',
    blockEnd: block?.getAttribute?.('data-end') || '',
    blockTestId: block?.getAttribute?.('data-testid') || '',
    blockText: normalizeText(visibleText(block)).slice(0, 500),
    actionOrdinal: Math.max(0, actions.indexOf(element)),
    actionTag: element?.tagName?.toLowerCase?.() || '',
    actionRole: element?.getAttribute?.('role') || '',
    actionTestId: element?.getAttribute?.('data-testid') || '',
    actionAriaLabel: element?.getAttribute?.('aria-label') || '',
  };
}

function artifactFileName(element, root, url = '') {
  const namesFrom = (value) => {
    if (!value) return [];
    if (typeof DOM_PARSER.extractFileLikeNames === 'function') return DOM_PARSER.extractFileLikeNames(value);
    const one = DOM_PARSER.extractFileLikeName(value);
    return one ? [one] : [];
  };
  const directSignals = [
    element?.getAttribute?.('download'),
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('title'),
    visibleText(element),
    guessNameFromUrl(url),
  ].filter(Boolean);
  for (const signal of directSignals) {
    const direct = namesFrom(signal);
    if (direct.length === 1) return direct[0];
    const directZip = direct.find((name) => /\.zip$/i.test(name));
    if (directZip) return directZip;
  }

  const block = artifactBlockElement(element, root);
  const nearby = [];
  if (element?.previousElementSibling) nearby.push(element.previousElementSibling);
  if (element?.nextElementSibling) nearby.push(element.nextElementSibling);
  const parentChildren = Array.from(element?.parentElement?.children || []);
  const ownIndex = parentChildren.indexOf(element);
  if (ownIndex >= 0) {
    for (const distance of [1, 2]) {
      if (parentChildren[ownIndex - distance]) nearby.push(parentChildren[ownIndex - distance]);
      if (parentChildren[ownIndex + distance]) nearby.push(parentChildren[ownIndex + distance]);
    }
  }
  for (const candidateNode of nearby) {
    const candidates = namesFrom(visibleText(candidateNode));
    if (candidates.length === 1) return candidates[0];
  }

  const blockCandidates = namesFrom(visibleText(block));
  if (blockCandidates.length === 1) return blockCandidates[0];
  if (blockCandidates.length > 1) {
    const actionSignal = artifactActionSignal(element);
    const zipCandidate = blockCandidates.find((name) => /\.zip$/i.test(name));
    if (zipCandidate && /zip|archive|архив|bundle|download|скачать/i.test(actionSignal)) return zipCandidate;
  }
  return guessNameFromUrl(url) || '';
}

function artifactState(element, root, extra = {}) {
  const block = artifactBlockElement(element, root);
  const busy = element?.getAttribute?.('aria-busy') === 'true' || block?.getAttribute?.('aria-busy') === 'true';
  const progressVisible = Boolean(block?.querySelector?.('[role="progressbar"], [aria-busy="true"]'));
  const disabled = Boolean(element?.disabled || element?.getAttribute?.('aria-disabled') === 'true');
  const state = [element?.getAttribute?.('data-state'), block?.getAttribute?.('data-state')].filter(Boolean).join(' ');
  const text = normalizeText(`${artifactActionSignal(element)} ${visibleText(block)}`);
  const phase = DOM_PARSER.classifyArtifactPhase({
    state,
    text,
    busy,
    progressVisible,
    disabled,
    failed: Boolean(extra.failed),
    downloadable: Boolean(extra.downloadable),
    downloadActionPresent: Boolean(extra.downloadActionPresent),
    href: extra.href || '',
  });
  return { phase, state, busy, progressVisible, disabled, text };
}

function collectArtifactsFromNode(node, meta = {}) {
  const artifacts = [];
  if (!node?.querySelectorAll) return artifacts;

  const push = (artifact) => {
    const url = artifact.downloadUrl || artifact.url || artifact.src || '';
    const locator = artifact.locator || artifactLocatorMeta(artifact.element || null, node);
    const selectorHint = artifact.selectorHint || actionSelectorHint(artifact.element || null);
    const fileName = artifact.fileName || artifactFileName(artifact.element || null, node, url);
    const name = normalizeText(fileName || artifact.name || artifact.title || artifact.text || guessNameFromUrl(url) || artifact.kind || 'artifact');
    const stateInfo = artifact.stateInfo || artifactState(artifact.element || null, node, {
      downloadable: artifact.downloadable,
      downloadActionPresent: artifact.downloadActionPresent,
      href: url,
      failed: artifact.failed,
    });
    const identity = [artifact.sourceTurnKey || meta.turnKey || '', name, locator.blockStart, locator.blockEnd, locator.blockTestId, artifact.groupOrdinal ?? locator.actionOrdinal, url && !name ? url : ''].join('|');
    const id = artifact.id || `artifact_${simpleHash(identity)}`;
    const { element, locator: ignoredLocator, stateInfo: ignoredState, ...publicArtifact } = artifact;
    const record = {
      id,
      name,
      fileName: name,
      extension: name.includes('.') ? name.split('.').pop().toLowerCase() : '',
      mime: artifact.mime || guessMime(name, url),
      sourceTurnKey: artifact.sourceTurnKey || meta.turnKey || '',
      sourceTurnIndex: artifact.sourceTurnIndex ?? meta.turnIndex ?? -1,
      sourceCandidateIndex: artifact.sourceCandidateIndex ?? meta.candidateIndex ?? 0,
      selectorHint,
      phase: artifact.phase || stateInfo.phase,
      state: artifact.state || stateInfo.state || '',
      progressText: artifact.progressText || (stateInfo.phase === 'GENERATING' ? stateInfo.text.slice(0, 300) : ''),
      errorText: artifact.errorText || (stateInfo.phase === 'FAILED' ? stateInfo.text.slice(0, 300) : ''),
      downloadable: Boolean(artifact.downloadable || url || artifact.downloadActionPresent),
      downloadActionPresent: Boolean(artifact.downloadActionPresent),
      urlMayExpire: Boolean(url && (/^blob:|^data:|^sandbox:|token=|signature=/i.test(url))),
      blockStart: locator.blockStart,
      blockEnd: locator.blockEnd,
      blockTestId: locator.blockTestId,
      blockText: locator.blockText,
      actionOrdinal: locator.actionOrdinal,
      actionTag: locator.actionTag,
      actionRole: locator.actionRole,
      actionTestId: locator.actionTestId,
      actionAriaLabel: locator.actionAriaLabel,
      rawAttributes: {
        href: artifact.element?.getAttribute?.('href') || '',
        download: artifact.element?.getAttribute?.('download') || '',
        ariaLabel: artifact.element?.getAttribute?.('aria-label') || '',
        testId: artifact.element?.getAttribute?.('data-testid') || '',
        state: artifact.element?.getAttribute?.('data-state') || '',
        busy: artifact.element?.getAttribute?.('aria-busy') || '',
      },
      ...publicArtifact,
    };
    const existingIndex = artifacts.findIndex((item) => item.id === id);
    if (existingIndex >= 0) artifacts[existingIndex] = mergeArtifactRecords(artifacts[existingIndex], record);
    else artifacts.push(record);
  };

  for (const anchor of queryAllWithSelf(node, 'a[href]')) {
    if (!isVisible(anchor) || isExcludedArtifactAction(anchor)) continue;
    const href = anchor.href || anchor.getAttribute('href') || '';
    const text = visibleText(anchor);
    const download = anchor.getAttribute('download') || '';
    const descriptor = elementDescriptor(anchor);
    const fileName = artifactFileName(anchor, node, href);
    const inFileCard = Boolean(anchor.closest?.('[data-testid*="file" i], [data-testid*="artifact" i], [download]'));
    const looksDownload = Boolean(
      download
      || href.startsWith('blob:')
      || href.startsWith('data:')
      || isBrowserOnlyArtifactUrl(href)
      || /\/(?:download|files?|artifacts?)(?:\/|\?|$)/i.test(href)
      || hasStrictArtifactIntent(`${download} ${text} ${descriptor}`)
      || (inFileCard && fileName)
    );
    if (!looksDownload) continue;
    push({
      kind: isBrowserOnlyArtifactUrl(href) ? 'action' : 'file',
      url: href,
      downloadUrl: href,
      name: fileName || download || text || guessNameFromUrl(href),
      text,
      actionLabel: text || download || descriptor,
      downloadable: true,
      downloadActionPresent: true,
      element: anchor,
    });
  }

  for (const image of queryAllWithSelf(node, '[data-testid*="generated-image" i] img[src], [data-testid*="artifact" i] img[src], a[download] img[src]')) {
    if (!isVisible(image)) continue;
    const src = image.currentSrc || image.src || image.getAttribute('src') || '';
    if (!src || src.startsWith('data:image/svg')) continue;
    const alt = image.getAttribute('alt') || image.getAttribute('aria-label') || '';
    const rect = image.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) continue;
    push({ kind: 'image', src, url: src, downloadUrl: src, name: DOM_PARSER.extractFileLikeName(alt) || alt || guessNameFromUrl(src) || 'image', width: Math.round(rect.width), height: Math.round(rect.height), downloadable: true, downloadActionPresent: true, element: image });
  }

  const actionElements = queryAllWithSelf(node, 'button, [role="button"], a[href]');
  for (const action of actionElements) {
    if (!isVisible(action) || isExcludedArtifactAction(action)) continue;
    const label = artifactActionSignal(action);
    const fileName = artifactFileName(action, node, action.href || action.getAttribute?.('href') || '');
    const strictIntent = hasStrictArtifactIntent(label);
    if (!strictIntent && !fileName) continue;
    if (!fileName && looksLikeThinkingProgressText(label)) continue;
    const stateInfo = artifactState(action, node, { downloadActionPresent: true, downloadable: isUsableButton(action) });
    push({
      kind: /canvas/i.test(label) ? 'canvas' : 'action',
      name: fileName || label || 'artifact action',
      text: label,
      actionLabel: label || fileName,
      phase: stateInfo.phase,
      downloadable: stateInfo.phase === 'READY' && isUsableButton(action),
      downloadActionPresent: true,
      stateInfo,
      element: action,
    });
  }

  const stateElements = queryAllWithSelf(node, '[aria-busy="true"], [role="progressbar"], [data-state]');
  for (const element of stateElements) {
    if (!isVisible(element) || isExcludedArtifactAction(element)) continue;
    const lifecycleObserved = DOM_PARSER.isArtifactLifecycleStateDescriptor({
      ariaBusy: element.getAttribute?.('aria-busy') || '',
      role: element.getAttribute?.('role') || '',
      dataState: element.getAttribute?.('data-state') || '',
      testId: element.getAttribute?.('data-testid') || '',
      className: element.getAttribute?.('class') || '',
      tagName: element.tagName || '',
      ownText: visibleText(element),
    });
    if (!lifecycleObserved) continue;
    const fileName = artifactFileName(element, node, '');
    if (!fileName) continue;
    const stateInfo = artifactState(element, node, {});
    if (!['GENERATING', 'FAILED'].includes(stateInfo.phase)) continue;
    push({
      kind: 'file',
      name: fileName,
      text: stateInfo.text,
      phase: stateInfo.phase,
      downloadable: false,
      downloadActionPresent: false,
      lifecycleObserved: true,
      stateInfo,
      element,
    });
  }

  return artifacts;
}


    return Object.freeze({
      collectArtifactsForAssistantNode,
      queryAllWithSelf,
      isBrowserOnlyArtifactUrl,
      isExcludedArtifactAction,
      artifactLocatorMeta,
      artifactFileName,
      collectArtifactsFromNode,
    });
  }

  globalThis.ChatGptArtifactDom = Object.freeze({ createArtifactDom });
})();
