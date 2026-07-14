// Model and effort picker commands for the extension content runtime.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createIntelligenceCommands(deps = {}) {
    const {
      DOM_PARSER,
      buttonSignalText,
      delay,
      diagnostic,
      findComposer,
      findComposerRootStrict,
      isUsableButton,
      isVisible,
      normalizeComparable,
      normalizeText,
      send,
      unique,
      visibleText,
    } = deps;

const INTELLIGENCE_UI_TIMING = Object.freeze({
  focusSettleMs: 140,
  pickerOpenWaitMs: 1_300,
  pickerStableMs: 180,
  submenuInitialHoverMs: 260,
  submenuPulseMs: 280,
  submenuOpenWaitMs: 1_500,
  submenuStableMs: 220,
  beforeOptionClickMs: 180,
  selectionSettleMs: 850,
  betweenSelectionsMs: 500,
  verificationRetryMs: 650,
  menuCloseSettleMs: 180,
});

function visibleIntelligencePickerContent() {
  return Array.from(document.querySelectorAll('[data-testid="composer-intelligence-picker-content"]')).find(isVisible) || null;
}

function intelligenceOptionFromElement(element) {
  const fallbackText = normalizeText(element?.innerText || element?.textContent || element?.getAttribute?.('aria-label') || '');
  const leafTexts = Array.from(element?.querySelectorAll?.('*') || [])
    .filter((node) => !node.children?.length && isVisible(node))
    .map((node) => normalizeText(node.innerText || node.textContent || ''))
    .filter(Boolean);
  const uniqueLeafTexts = unique(leafTexts);
  const label = uniqueLeafTexts[0] || fallbackText;
  const annotationParts = uniqueLeafTexts.slice(1).filter((text) => normalizeComparable(text) !== normalizeComparable(label));
  const annotation = annotationParts.join(' · ');
  const rawText = uniqueLeafTexts.length ? uniqueLeafTexts.join('\n') : fallbackText;
  return {
    label,
    rawText,
    selected: element?.getAttribute?.('aria-checked') === 'true' || element?.getAttribute?.('data-state') === 'checked',
    ...(annotation ? { annotation } : {}),
  };
}

async function waitForVisibleElement(getter, timeoutMs = 1500, pollMs = 80) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = getter();
    if (value) return value;
    await delay(pollMs);
  }
  return null;
}

async function waitForStableVisibleElement(getter, timeoutMs, stableMs = INTELLIGENCE_UI_TIMING.pickerStableMs) {
  const started = Date.now();
  let candidate = null;
  let candidateSince = 0;
  while (Date.now() - started < timeoutMs) {
    const value = getter();
    if (value) {
      if (value !== candidate) {
        candidate = value;
        candidateSince = Date.now();
      }
      if (Date.now() - candidateSince >= stableMs) return value;
    } else {
      candidate = null;
      candidateSince = 0;
    }
    await delay(80);
  }
  return null;
}

function intelligencePickerCandidateRoots() {
  const roots = [];
  const add = (root) => { if (root && !roots.includes(root)) roots.push(root); };
  const composer = findComposer();
  let current = findComposerRootStrict() || composer?.parentElement || null;
  for (let depth = 0; current && depth < 5; depth += 1) {
    add(current);
    current = current.parentElement;
  }
  const form = composer?.closest?.('form');
  add(form);
  add(document.body);
  return roots;
}

function intelligencePickerTriggerCandidates() {
  const composer = findComposer();
  const composerRect = composer?.getBoundingClientRect?.() || null;
  const seen = new Set();
  const candidates = [];
  for (const root of intelligencePickerCandidateRoots()) {
    for (const element of Array.from(root.querySelectorAll?.('button, [role="button"], [aria-haspopup="menu"]') || [])) {
      if (seen.has(element) || !isUsableButton(element)) continue;
      seen.add(element);
      const signal = `${buttonSignalText(element)} ${element.getAttribute('aria-controls') || ''}`;
      const hasMenu = element.getAttribute('aria-haspopup') === 'menu';
      const rect = element.getBoundingClientRect?.() || null;
      const nearComposer = Boolean(composerRect && rect
        && Math.abs(rect.bottom - composerRect.bottom) < 180
        && Math.abs(rect.left - composerRect.left) < Math.max(700, composerRect.width + 250));
      let score = 0;
      if (/composer-intelligence-picker-content|intelligence|reasoning-effort/i.test(signal)) score += 100;
      if (/instant|medium|high|thinking|reasoning|model|gpt|средн|высок|размыш|модель|интеллект/i.test(signal)) score += 35;
      if (hasMenu) score += 20;
      if (element.hasAttribute('aria-expanded')) score += 8;
      if (nearComposer) score += 6;
      if (root === document.body && !nearComposer && score < 35) continue;
      if (!hasMenu && score < 35) continue;
      candidates.push({ element, score, signal: normalizeText(signal).slice(0, 240) });
    }
  }
  return candidates.sort((left, right) => right.score - left.score);
}

function dispatchSinglePointerClick(element, point) {
  const PointerCtor = window.PointerEvent || window.MouseEvent;
  const common = { bubbles: true, cancelable: true, composed: true, ...point };
  try { element.dispatchEvent(new PointerCtor('pointerover', { ...common, pointerType: 'mouse', isPrimary: true, buttons: 0 })); } catch {}
  try { element.dispatchEvent(new MouseEvent('mouseover', { ...common, buttons: 0 })); } catch {}
  try { element.dispatchEvent(new PointerCtor('pointerdown', { ...common, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 })); } catch {}
  try { element.dispatchEvent(new MouseEvent('mousedown', { ...common, button: 0, buttons: 1 })); } catch {}
  try { element.dispatchEvent(new PointerCtor('pointerup', { ...common, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 })); } catch {}
  try { element.dispatchEvent(new MouseEvent('mouseup', { ...common, button: 0, buttons: 0 })); } catch {}
  try { element.dispatchEvent(new MouseEvent('click', { ...common, button: 0, buttons: 0, detail: 1 })); } catch {}
}

async function openIntelligencePicker() {
  const existing = visibleIntelligencePickerContent();
  if (existing) {
    diagnostic('intelligence.picker.waiting', { reason: 'existing-picker-stability', timeoutMs: INTELLIGENCE_UI_TIMING.pickerStableMs + 200, stableMs: INTELLIGENCE_UI_TIMING.pickerStableMs });
    await delay(INTELLIGENCE_UI_TIMING.pickerStableMs);
    if (visibleIntelligencePickerContent() === existing) {
      diagnostic('intelligence.picker.opened', { method: 'already-open', elapsedMs: INTELLIGENCE_UI_TIMING.pickerStableMs });
      return existing;
    }
  }
  const candidates = intelligencePickerTriggerCandidates();
  const deadline = Date.now() + 7_000;
  diagnostic('intelligence.picker.candidates', {
    count: candidates.length,
    candidates: candidates.slice(0, 12).map((item) => ({ score: item.score, signal: item.signal })),
  });

  for (const [candidateIndex, candidate] of candidates.slice(0, 2).entries()) {
    if (Date.now() >= deadline) break;
    diagnostic('intelligence.picker.candidate.selected', { index: candidateIndex + 1, score: candidate.score, signal: candidate.signal });
    try { candidate.element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch {}
    try { candidate.element.focus?.({ preventScroll: true }); } catch {}
    await delay(INTELLIGENCE_UI_TIMING.focusSettleMs);
    const rect = candidate.element.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
    const point = { clientX: rect.left + Math.max(1, rect.width / 2), clientY: rect.top + Math.max(1, rect.height / 2) };
    const activations = [
      { name: 'pointer-click', run: () => dispatchSinglePointerClick(candidate.element, point) },
      { name: 'keyboard-enter', run: () => {
        candidate.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        candidate.element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      } },
    ];
    for (const [activationIndex, activation] of activations.entries()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const waitMs = Math.min(INTELLIGENCE_UI_TIMING.pickerOpenWaitMs, remaining);
      const activationStarted = Date.now();
      diagnostic('intelligence.picker.activation', {
        score: candidate.score,
        signal: candidate.signal,
        method: activation.name,
        attempt: activationIndex + 1,
        waitMs,
      });
      try { activation.run(); } catch {}
      diagnostic('intelligence.picker.waiting', { reason: 'open-after-activation', timeoutMs: waitMs, stableMs: INTELLIGENCE_UI_TIMING.pickerStableMs, method: activation.name });
      const content = await waitForStableVisibleElement(
        visibleIntelligencePickerContent,
        waitMs,
        INTELLIGENCE_UI_TIMING.pickerStableMs,
      );
      if (content) {
        diagnostic('intelligence.picker.opened', { score: candidate.score, signal: candidate.signal, method: activation.name, elapsedMs: Date.now() - activationStarted });
        return content;
      }
      diagnostic('intelligence.picker.activation_timeout', { score: candidate.score, signal: candidate.signal, method: activation.name, attempt: activationIndex + 1, elapsedMs: Date.now() - activationStarted });
      if (activationIndex < activations.length - 1) await delay(240);
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await delay(INTELLIGENCE_UI_TIMING.menuCloseSettleMs);
  }
  diagnostic('intelligence.picker.not_found', { candidateCount: candidates.length });
  return null;
}

function modelSubmenuOpener(pickerContent) {
  const candidates = Array.from(pickerContent?.querySelectorAll?.('[role="menuitem"]') || []).filter(isVisible);
  return [...candidates].reverse().find((element) => (
    element.hasAttribute('data-has-submenu')
    || element.getAttribute('aria-haspopup') === 'menu'
    || Boolean(element.getAttribute('aria-controls'))
  )) || null;
}

function effortOptionsRoot(pickerContent) {
  const directGroups = Array.from(pickerContent?.children || [])
    .filter((element) => element.getAttribute?.('role') === 'group'
      && element.querySelector?.('[role="menuitemradio"]'));
  return directGroups[0] || pickerContent;
}

function visibleModelSubmenu(pickerContent, opener = null) {
  const pickerMenu = pickerContent?.closest?.('[role="menu"]') || null;
  const controlledId = opener?.getAttribute?.('aria-controls') || '';
  const controlled = controlledId ? document.getElementById(controlledId) : null;
  if (controlled && isVisible(controlled) && controlled.querySelector('[role="menuitemradio"]')) return controlled;

  const openerId = opener?.id || '';
  const menus = Array.from(document.querySelectorAll('[role="menu"]'))
    .filter((menu) => isVisible(menu)
      && menu !== pickerMenu
      && !pickerContent?.contains?.(menu)
      && menu.querySelector('[role="menuitemradio"]'));
  if (openerId) {
    const labelled = menus.find((menu) => menu.getAttribute('aria-labelledby') === openerId);
    if (labelled) return labelled;
  }
  return menus.find((menu) => /gpt|chatgpt|\bo\d\b|model|модел/i.test(visibleText(menu))) || menus[0] || null;
}

function modelSubmenuPoint(opener) {
  const rect = opener?.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
  return { clientX: rect.left + Math.max(1, rect.width / 2), clientY: rect.top + Math.max(1, rect.height / 2) };
}

function enterModelSubmenuHover(opener) {
  if (!opener) return;
  try { opener.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch {}
  try { opener.focus?.({ preventScroll: true }); } catch {}
  const point = modelSubmenuPoint(opener);
  const PointerCtor = window.PointerEvent || window.MouseEvent;
  for (const type of ['pointerover', 'pointerenter', 'pointermove']) {
    try { opener.dispatchEvent(new PointerCtor(type, { bubbles: true, pointerType: 'mouse', isPrimary: true, ...point })); } catch {}
  }
  for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
    try { opener.dispatchEvent(new MouseEvent(type, { bubbles: true, ...point })); } catch {}
  }
}

function maintainModelSubmenuHover(opener) {
  if (!opener) return;
  const point = modelSubmenuPoint(opener);
  const PointerCtor = window.PointerEvent || window.MouseEvent;
  try { opener.dispatchEvent(new PointerCtor('pointermove', { bubbles: true, pointerType: 'mouse', isPrimary: true, ...point })); } catch {}
  try { opener.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, ...point })); } catch {}
}

async function openModelSubmenu(pickerContent) {
  const opener = modelSubmenuOpener(pickerContent);
  if (!opener) return { submenu: null, opener: null };
  const trigger = intelligenceOptionFromElement(opener).rawText || '';
  diagnostic('model.submenu.search.started', { trigger });
  const existing = visibleModelSubmenu(pickerContent, opener);
  if (existing) {
    diagnostic('model.submenu.waiting', { method: 'already-open', timeoutMs: INTELLIGENCE_UI_TIMING.submenuStableMs + 300, stableMs: INTELLIGENCE_UI_TIMING.submenuStableMs });
    const stable = await waitForStableVisibleElement(
      () => visibleModelSubmenu(pickerContent, opener),
      INTELLIGENCE_UI_TIMING.submenuStableMs + 300,
      INTELLIGENCE_UI_TIMING.submenuStableMs,
    );
    if (stable) {
      diagnostic('model.submenu.opened', { method: 'already-open', count: stable.querySelectorAll?.('[role="menuitemradio"]').length || 0 });
      return { submenu: stable, opener };
    }
  }

  diagnostic('model.submenu.hover.started', { trigger });
  enterModelSubmenuHover(opener);
  await delay(INTELLIGENCE_UI_TIMING.submenuInitialHoverMs);
  const started = Date.now();
  diagnostic('model.submenu.waiting', { method: 'hover', timeoutMs: INTELLIGENCE_UI_TIMING.submenuOpenWaitMs, stableMs: INTELLIGENCE_UI_TIMING.submenuStableMs });
  while (Date.now() - started < INTELLIGENCE_UI_TIMING.submenuOpenWaitMs) {
    const submenu = visibleModelSubmenu(pickerContent, opener);
    if (submenu) {
      const stable = await waitForStableVisibleElement(
        () => visibleModelSubmenu(pickerContent, opener),
        INTELLIGENCE_UI_TIMING.submenuStableMs + 400,
        INTELLIGENCE_UI_TIMING.submenuStableMs,
      );
      if (stable) {
        diagnostic('model.submenu.opened', { method: 'hover', elapsedMs: Date.now() - started, count: stable.querySelectorAll?.('[role="menuitemradio"]').length || 0 });
        return { submenu: stable, opener };
      }
    }
    maintainModelSubmenuHover(opener);
    await delay(INTELLIGENCE_UI_TIMING.submenuPulseMs);
  }

  diagnostic('model.submenu.hover_timeout', { trigger });
  diagnostic('model.submenu.keyboard_retry', { trigger, elapsedMs: Date.now() - started });
  try { opener.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); } catch {}
  const submenu = await waitForStableVisibleElement(
    () => visibleModelSubmenu(pickerContent, opener),
    900,
    INTELLIGENCE_UI_TIMING.submenuStableMs,
  );
  if (submenu) diagnostic('model.submenu.opened', { method: 'keyboard-arrow-right', count: submenu.querySelectorAll?.('[role="menuitemradio"]').length || 0 });
  return { submenu, opener };
}

function collectRadioOptions(root, kind) {
  if (!root?.querySelectorAll) return [];
  const seen = new Set();
  const elements = [];
  const descriptors = [];
  for (const element of Array.from(root.querySelectorAll('[role="menuitemradio"]')).filter(isVisible)) {
    const descriptor = intelligenceOptionFromElement(element);
    const key = normalizeComparable(descriptor.rawText || descriptor.label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    elements.push(element);
    descriptors.push(descriptor);
  }
  return DOM_PARSER.normalizeIntelligenceOptions(kind, descriptors)
    .map((option, index) => ({ ...option, element: elements[index] }));
}


async function waitForStableRadioOptions(rootGetter, kind, timeoutMs = 1_200) {
  const started = Date.now();
  diagnostic('intelligence.options.wait.started', { kind, timeoutMs });
  let lastSignature = '';
  let stableSince = 0;
  let lastOptions = [];
  while (Date.now() - started < timeoutMs) {
    const root = typeof rootGetter === 'function' ? rootGetter() : rootGetter;
    const options = collectRadioOptions(root, kind);
    const signature = options.map((option) => `${option.id}|${option.label}|${option.selected ? 1 : 0}`).join('\n');
    if (options.length && signature === lastSignature) {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= INTELLIGENCE_UI_TIMING.submenuStableMs) {
        diagnostic('intelligence.options.stable', { kind, count: options.length, elapsedMs: Date.now() - started });
        return options;
      }
    } else {
      lastSignature = signature;
      stableSince = options.length ? Date.now() : 0;
      lastOptions = options;
    }
    await delay(90);
  }
  diagnostic('intelligence.options.timeout', { kind, count: lastOptions.length, elapsedMs: Date.now() - started });
  return lastOptions;
}

async function closeIntelligenceMenus(beforeActive = null) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await delay(90);
  if (visibleIntelligencePickerContent() || Array.from(document.querySelectorAll('[role="menu"]')).some(isVisible)) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
  await delay(INTELLIGENCE_UI_TIMING.menuCloseSettleMs);
  try { beforeActive?.focus?.({ preventScroll: true }); } catch {}
}

async function readIntelligenceState({ includeModels = true } = {}) {
  diagnostic('intelligence.state.read.started', { includeModels });
  const beforeActive = document.activeElement;
  const pickerContent = await openIntelligencePicker();
  if (!pickerContent) throw new Error('DOM_SCHEMA_CHANGED: intelligence picker content was not found.');

  try {
    const effortsWithElements = collectRadioOptions(effortOptionsRoot(pickerContent), 'effort');
    if (!effortsWithElements.length) throw new Error('DOM_SCHEMA_CHANGED: intelligence effort options were not found.');
    const opener = modelSubmenuOpener(pickerContent);
    const triggerDescriptor = opener ? intelligenceOptionFromElement(opener) : null;
    if (!opener) throw new Error('DOM_SCHEMA_CHANGED: current model submenu trigger was not found.');

    let modelsWithElements = [];
    if (includeModels) {
      const opened = await openModelSubmenu(pickerContent);
      if (opened.submenu) {
        const submenuResolver = () => visibleModelSubmenu(pickerContent, opener) || opened.submenu;
        modelsWithElements = await waitForStableRadioOptions(submenuResolver, 'model');
        if (!modelsWithElements.length) {
          diagnostic('model.submenu.empty_retry', {
            trigger: triggerDescriptor?.rawText || '',
            action: 'read-only-hover-and-rescan',
          });
          // Give a late Radix/React mount one extra read-only window. Do not
          // activate or click the submenu opener again in this state read.
          maintainModelSubmenuHover(opener);
          await delay(INTELLIGENCE_UI_TIMING.verificationRetryMs);
          modelsWithElements = await waitForStableRadioOptions(submenuResolver, 'model');
        }
      }
      if (!modelsWithElements.length) throw new Error('DOM_SCHEMA_CHANGED: transient model submenu was not found or contained no models.');
    }

    const efforts = effortsWithElements.map(({ element, ...option }) => option);
    const rawModels = modelsWithElements.map(({ element, ...option }) => option);
    const modelState = DOM_PARSER.resolveCurrentModel(rawModels, triggerDescriptor);
    const selectedEffort = efforts.find((option) => option.selected) || null;
    diagnostic('intelligence.state.read', {
      efforts: efforts.map((option) => ({ id: option.id, label: option.label, selected: option.selected })),
      models: modelState.models.map((option) => ({ id: option.id, label: option.label, selected: option.selected, checked: option.checked })),
      selectedEffort: selectedEffort?.id || '',
      selectedModel: modelState.current?.label || '',
      modelTrigger: triggerDescriptor?.rawText || '',
    });
    return {
      efforts,
      models: modelState.models,
      selectedEffort,
      selectedModel: modelState.current,
      modelTrigger: modelState.trigger,
      capturedAt: Date.now(),
    };
  } finally {
    await closeIntelligenceMenus(beforeActive);
  }
}

async function trySelectIntelligenceOption(label, kind, request) {
  const desired = normalizeComparable(label);
  if (!desired) return { matched: false, clicked: false, alreadySelected: false };
  diagnostic(`${kind}.selection.started`, { requestId: request?.requestId, kind, label });
  const pickerContent = await openIntelligencePicker();
  if (!pickerContent) {
    diagnostic(`${kind}.picker_not_found`, { requestId: request?.requestId, label });
    return { matched: false, clicked: false, alreadySelected: false };
  }

  const beforeActive = document.activeElement;
  let options = [];
  try {
    if (kind === 'model') {
      const opened = await openModelSubmenu(pickerContent);
      options = await waitForStableRadioOptions(
        () => visibleModelSubmenu(pickerContent, opened.opener) || opened.submenu,
        'model',
      );
    } else {
      options = await waitForStableRadioOptions(effortOptionsRoot(pickerContent), 'effort', 900);
    }
    const match = options.find((option) => DOM_PARSER.intelligenceOptionMatches(option, label));
    if (!match) {
      diagnostic(`${kind}.option_not_found_scoped`, {
        requestId: request?.requestId,
        label,
        available: options.map((option) => ({ id: option.id, label: option.label, rawText: option.rawText })),
      });
      return { matched: false, clicked: false, alreadySelected: false };
    }
    if (match.selected) {
      diagnostic(`${kind}.selection.already_selected`, {
        requestId: request?.requestId,
        kind,
        label,
        matchedId: match.id,
        matchedLabel: match.label,
      });
      return { matched: true, clicked: false, alreadySelected: true, option: match };
    }

    await delay(INTELLIGENCE_UI_TIMING.beforeOptionClickMs);
    diagnostic(`${kind}.selection.click`, {
      requestId: request?.requestId,
      kind,
      label,
      matchedId: match.id,
      matchedLabel: match.label,
    });
    match.element.click();
    await delay(INTELLIGENCE_UI_TIMING.selectionSettleMs);
    diagnostic(`${kind}.selection.clicked`, {
      requestId: request?.requestId,
      kind,
      label,
      matchedId: match.id,
      matchedLabel: match.label,
      settleMs: INTELLIGENCE_UI_TIMING.selectionSettleMs,
    });
    return { matched: true, clicked: true, alreadySelected: false, option: match };
  } finally {
    await closeIntelligenceMenus(beforeActive);
  }
}


async function handleModelsList(payload) {
  try {
    const state = await readIntelligenceState({ includeModels: true });
    send({ type: 'models.snapshot', commandId: payload.commandId, models: state.models, current: state.selectedModel, intelligence: state });
  } catch (err) {
    send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
  }
}

async function handleEffortsList(payload) {
  try {
    const state = await readIntelligenceState({ includeModels: false });
    send({ type: 'efforts.snapshot', commandId: payload.commandId, efforts: state.efforts, current: state.selectedEffort, intelligence: state });
  } catch (err) {
    send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
  }
}




    return Object.freeze({
      INTELLIGENCE_UI_TIMING,
      readIntelligenceState,
      trySelectIntelligenceOption,
      handleModelsList,
      handleEffortsList,
    });
  }

  globalThis.ChatGptIntelligenceCommands = Object.freeze({ createIntelligenceCommands });
})();
