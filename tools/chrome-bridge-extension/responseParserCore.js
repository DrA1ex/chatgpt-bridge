// DOM-aware, lossless response-parser helpers shared by the extension runtime
// and browser fixture tests. Loaded after domParserCore.js and before content.js.
(() => {
  'use strict';

  const CORE = globalThis.ChatGptDomParserCore;
  if (!CORE) throw new Error('ChatGptDomParserCore must be loaded before responseParserCore.js');

  function normalizeText(value = '') {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function createParserPass(root = null) {
    return {
      kind: 'chatgpt-response-parser-pass',
      root: root || null,
      visibility: new WeakMap(),
      styles: new WeakMap(),
      leaves: new WeakMap(),
      contentSources: new WeakMap(),
      ownerCandidates: new WeakMap(),
      owners: new WeakMap(),
      metrics: {
        startedAt: globalThis.performance?.now?.() ?? Date.now(),
        visibilityChecks: 0,
        visibilityCacheHits: 0,
        computedStyleReads: 0,
        leafWalks: 0,
        ownerCandidateChecks: 0,
        ownerCandidatesEnumerated: 0,
      },
    };
  }

  function parserPass(pass = null, root = null) {
    return pass?.kind === 'chatgpt-response-parser-pass' ? pass : createParserPass(root);
  }

  function cachedStyle(element, pass) {
    if (pass.styles.has(element)) return pass.styles.get(element);
    pass.metrics.computedStyleReads += 1;
    const style = getComputedStyle(element);
    pass.styles.set(element, style);
    return style;
  }

  function isVisible(element, providedPass = null) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const pass = parserPass(providedPass, element);
    pass.metrics.visibilityChecks += 1;
    if (pass.visibility.has(element)) {
      pass.metrics.visibilityCacheHits += 1;
      return pass.visibility.get(element);
    }
    try {
      let visible = true;
      if (element.hasAttribute?.('hidden') || element.getAttribute?.('aria-hidden') === 'true') visible = false;
      if (visible && element.parentElement) visible = isVisible(element.parentElement, pass);
      if (visible) {
        const style = cachedStyle(element, pass);
        visible = style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.visibility !== 'collapse'
          && style.contentVisibility !== 'hidden'
          && Number(style.opacity) !== 0;
      }
      pass.visibility.set(element, visible);
      return visible;
    } catch {
      pass.visibility.set(element, true);
      return true;
    }
  }

  function visibleText(element) {
    if (!element) return '';
    return normalizeText(element.innerText || element.textContent || '');
  }

  function cssEscape(value) {
    if (globalThis.CSS?.escape) return CSS.escape(String(value));
    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function domPathForNode(node, boundary = null) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!element) return '';
    const parts = [];
    for (let current = element, depth = 0; current && current !== boundary && depth < 12; current = current.parentElement, depth += 1) {
      let part = current.tagName?.toLowerCase?.() || 'node';
      const testId = current.getAttribute?.('data-testid');
      const role = current.getAttribute?.('role');
      const id = current.id;
      if (testId) part += `[data-testid="${String(testId).replaceAll('"', '\\"')}"]`;
      else if (id && !/^radix-/i.test(id)) part += `#${cssEscape(id)}`;
      else if (role) part += `[role="${String(role).replaceAll('"', '\\"')}"]`;
      else {
        const classes = Array.from(current.classList || []).filter((value) => /^[a-zA-Z_][\w-]{1,40}$/.test(value)).slice(0, 2);
        if (classes.length) part += classes.map((value) => `.${cssEscape(value)}`).join('');
      }
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children || []).filter((child) => child.tagName === current.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
      }
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  function safeOuterHtml(element, maxLength = 6000) {
    if (!element?.cloneNode) return '';
    try {
      const clone = element.cloneNode(true);
      for (const unwanted of Array.from(clone.querySelectorAll?.('script, style, svg use') || [])) unwanted.remove();
      for (const node of [clone, ...Array.from(clone.querySelectorAll?.('*') || [])]) {
        for (const attr of Array.from(node.attributes || [])) {
          if (!/^(?:id|class|role|title|aria-[\w-]+|data-testid|data-language|data-lang|data-syntax|data-state)$/i.test(attr.name)) node.removeAttribute(attr.name);
        }
      }
      const html = String(clone.outerHTML || '');
      return html.length > maxLength ? `${html.slice(0, maxLength)}…` : html;
    } catch {
      return '';
    }
  }

  function visibleTextLeafNodes(root, providedPass = null) {
    const pass = parserPass(providedPass, root);
    if (pass.leaves.has(root)) return pass.leaves.get(root);
    pass.metrics.leafWalks += 1;
    const leaves = [];
    const visit = (node, parentVisible = true) => {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = normalizeText(node.textContent || '');
        if (text && parentVisible) leaves.push(node);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName?.toLowerCase?.() || '';
      if (/^(?:script|style|template|noscript)$/.test(tag)) return;
      const visible = node === root ? isVisible(node, pass) : parentVisible && isVisible(node, pass);
      if (!visible) return;
      for (const child of Array.from(node.childNodes || [])) visit(child, visible);
    };
    visit(root, true);
    pass.leaves.set(root, leaves);
    return leaves;
  }

  function closestWithin(node, selector, boundary) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    const match = element?.closest?.(selector) || null;
    return match && boundary?.contains?.(match) ? match : null;
  }

  function codeUiActionText(value = '') {
    return /(?:copy(?:\s+code)?|copied|run(?:\s+code)?|execute|edit|download|preview|open|save|share|full\s*screen|копировать(?:\s+код)?|скопировано|запустить(?:\s+код)?|выполнить|редактировать|скачать|предпросмотр|открыть|сохранить|поделиться|на\s+весь\s+экран|copiar(?:\s+código)?|copiado|ejecutar(?:\s+código)?|code\s+kopieren|kopiert|code\s+ausführen|ausführen|copier(?:\s+le\s+code)?|copié|exécuter(?:\s+le\s+code)?|executar(?:\s+código)?|copia(?:\s+codice)?|copiato|esegui(?:\s+codice)?|コードをコピー|コピー|実行|코드\s+복사|복사|실행|复制代码|复制|运行代码|运行)/iu.test(String(value || ''));
  }

  function describeInterfaceElement(element, boundary, reason = 'interface-control') {
    if (!element) return null;
    return {
      kind: reason,
      tag: element.tagName?.toLowerCase?.() || '',
      role: element.getAttribute?.('role') || '',
      testId: element.getAttribute?.('data-testid') || '',
      ariaLabel: element.getAttribute?.('aria-label') || '',
      title: element.getAttribute?.('title') || '',
      text: normalizeText(visibleText(element)).slice(0, 500),
      domPath: domPathForNode(element, boundary),
    };
  }

  function relativeDepth(element, boundary) {
    let depth = 0;
    for (let current = element; current && current !== boundary && depth < 64; current = current.parentElement) depth += 1;
    return depth;
  }

  function contentSourceForWidget(widget, providedPass = null) {
    if (!widget) return { element: null, source: 'none', editorPre: null };
    const pass = parserPass(providedPass, widget);
    if (pass.contentSources.has(widget)) return pass.contentSources.get(widget);
    const candidates = Array.from(widget.querySelectorAll?.('code') || []);
    if (!candidates.length && widget.matches?.('code')) candidates.push(widget);
    if (!candidates.length) {
      const editorCandidates = Array.from(widget.querySelectorAll?.('pre, [class*="cm-content" i], [data-code-block-content], [data-testid*="code-content" i]') || [])
        .filter((element) => element !== widget);
      const selectedEditor = editorCandidates.map((element, index) => {
        const signal = `${element.getAttribute?.('class') || ''} ${element.getAttribute?.('data-testid') || ''} ${element.getAttribute?.('data-code-block-content') || ''}`;
        let score = 0;
        if (/cm-content|readonly|code-content|code-block/i.test(signal)) score += 10_000;
        if (element.matches?.('pre')) score += 2_000;
        score += Math.min(500, relativeDepth(element, widget) * 10);
        return { element, index, score };
      }).sort((a, b) => b.score - a.score || a.index - b.index)[0];
      if (selectedEditor?.element) {
        const result = {
          element: selectedEditor.element,
          source: /cm-content/i.test(selectedEditor.element.getAttribute?.('class') || '') ? 'codemirror-pre' : 'editor-text',
          editorPre: selectedEditor.element.matches?.('pre') ? selectedEditor.element : selectedEditor.element.closest?.('pre') || null,
        };
        pass.contentSources.set(widget, result);
        return result;
      }
      const result = { element: widget, source: 'widget-text', editorPre: widget.matches?.('pre') ? widget : null };
      pass.contentSources.set(widget, result);
      return result;
    }
    const scored = candidates.map((element, index) => {
      const editorPre = element.closest?.('pre');
      const signal = `${editorPre?.getAttribute?.('class') || ''} ${element.getAttribute?.('class') || ''} ${element.closest?.('[id*="code-block" i], [class*="cm-editor" i], [class*="code" i]')?.getAttribute?.('class') || ''}`;
      let score = 0;
      if (/cm-content|cm-editor|code-block-viewer|readonly/i.test(signal)) score += 10_000;
      if (editorPre && editorPre !== widget) score += 2_000;
      if (element.parentElement === widget) score += 500;
      score += Math.min(500, relativeDepth(element, widget) * 10);
      return { element, index, score, editorPre };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
    const selected = scored[0];
    const result = {
      element: selected.element,
      editorPre: selected.editorPre || null,
      source: /cm-content|cm-editor/i.test(`${selected.editorPre?.className || ''} ${selected.element.className || ''}`)
        ? 'codemirror-code'
        : selected.editorPre && selected.editorPre !== widget ? 'nested-pre-code' : 'code-element',
    };
    pass.contentSources.set(widget, result);
    return result;
  }

  function rawCodeWidgetOwnerCandidate(element, providedPass = null) {
    if (!element?.querySelectorAll) return null;
    const pass = parserPass(providedPass, element);
    if (pass.ownerCandidates.has(element)) return pass.ownerCandidates.get(element);
    pass.metrics.ownerCandidateChecks += 1;
    const content = contentSourceForWidget(element, pass);
    const contentSource = content?.element || null;
    if (!contentSource || !element.contains?.(contentSource)) {
      pass.ownerCandidates.set(element, null);
      return null;
    }

    const codeElements = Array.from(new Set([
      ...(element.matches?.('code') ? [element] : []),
      ...Array.from(element.querySelectorAll('code')),
    ]));
    const independentCodeContainers = new Set(codeElements.map((code) => (
      code.closest?.('pre, [data-code-block-content], [data-testid*="code-content" i], [class*="cm-content" i]') || code
    )));
    // A broad ancestor containing multiple independent editors is not one code
    // widget. Multiple mirrors inside the same editor remain supported.
    if (independentCodeContainers.size > 1) {
      pass.ownerCandidates.set(element, null);
      return null;
    }

    const tag = element.tagName?.toLowerCase?.() || '';
    const signal = `${element.getAttribute?.('id') || ''} ${element.getAttribute?.('class') || ''} ${element.getAttribute?.('data-testid') || ''} ${element.getAttribute?.('role') || ''}`;
    const editorEvidence = Boolean(
      content.editorPre
      || contentSource.closest?.('[class*="cm-editor" i], [id*="code-block" i], [data-code-block-content], [data-testid*="code-content" i]')
    );
    let chromeEvidence = false;
    let actionEvidence = false;
    let languageEvidence = false;
    for (const leaf of visibleTextLeafNodes(element, pass)) {
      if (contentSource === leaf || contentSource.contains?.(leaf)) continue;
      const parent = leaf.parentElement;
      const text = normalizeText(leaf.textContent || '');
      const interactive = Boolean(closestWithin(leaf, 'button, [role="button"], [data-testid*="copy" i], [data-testid*="run" i]', element));
      const classified = CORE.classifyCodeWidgetChromeText?.(text, {
        interactive,
        ariaLabel: parent?.getAttribute?.('aria-label') || '',
        title: parent?.getAttribute?.('title') || '',
      });
      if (classified?.kind === 'interface_action') actionEvidence = true;
      if (classified?.kind === 'language') languageEvidence = true;
      if (actionEvidence || languageEvidence) chromeEvidence = true;
    }
    const structuralEvidence = /(?:code[-_ ]?block|codeblock|cm-editor|code-viewer|syntax|highlight)/i.test(signal);
    if (tag !== 'pre' && !actionEvidence && !structuralEvidence && !(languageEvidence && editorEvidence)) {
      pass.ownerCandidates.set(element, null);
      return null;
    }
    if (tag === 'pre' && !codeElements.length && !editorEvidence && contentSource === element) {
      pass.ownerCandidates.set(element, null);
      return null;
    }
    const result = { contentSource, chromeEvidence, actionEvidence, languageEvidence, editorEvidence, structuralEvidence, tag };
    pass.ownerCandidates.set(element, result);
    return result;
  }

  function isCodeWidgetOwner(element, providedPass = null) {
    const pass = parserPass(providedPass, element);
    if (pass.owners.has(element)) return pass.owners.get(element);
    const candidate = rawCodeWidgetOwnerCandidate(element, pass);
    if (!candidate) {
      pass.owners.set(element, false);
      return false;
    }
    if (!candidate.chromeEvidence) {
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const parentCandidate = rawCodeWidgetOwnerCandidate(ancestor, pass);
        if (!parentCandidate || parentCandidate.contentSource !== candidate.contentSource) continue;
        if (parentCandidate.chromeEvidence || (candidate.tag === 'pre' && parentCandidate.structuralEvidence)) {
          pass.owners.set(element, false);
          return false;
        }
        if (ancestor === pass.root) break;
      }
    }
    // A response-level <pre> owns the whole code widget even when React
    // creates a nested CodeMirror <pre>. Prefer that stable outer boundary
    // before considering smaller descendants that happen to contain toolbar
    // text as well.
    if (candidate.tag === 'pre' && !element.parentElement?.closest?.('pre')) {
      pass.owners.set(element, true);
      return true;
    }
    if (candidate.chromeEvidence) {
      for (let descendant = candidate.contentSource.parentElement; descendant && descendant !== element; descendant = descendant.parentElement) {
        const nested = rawCodeWidgetOwnerCandidate(descendant, pass);
        if (nested?.chromeEvidence && nested.contentSource === candidate.contentSource) {
          pass.owners.set(element, false);
          return false;
        }
      }
      pass.owners.set(element, true);
      return true;
    }
    if (candidate.structuralEvidence) {
      for (const descendant of Array.from(element.children || [])) {
        const nested = rawCodeWidgetOwnerCandidate(descendant, pass);
        if (nested && nested.contentSource === candidate.contentSource && (nested.chromeEvidence || nested.structuralEvidence)) {
          pass.owners.set(element, false);
          return false;
        }
      }
      pass.owners.set(element, true);
      return true;
    }
    const result = candidate.tag === 'pre';
    pass.owners.set(element, result);
    return result;
  }

  function collectCodeWidgetOwners(root, providedPass = null) {
    if (!root?.querySelectorAll) return [];
    const pass = parserPass(providedPass, root);
    const candidateSet = new Set();
    const selector = 'pre, code, [data-code-block-content], [data-testid*="code-content" i], [class*="cm-content" i], [class*="cm-editor" i], [class*="code-block" i], [class*="codeblock" i], [class*="code-viewer" i], [id*="code-block" i]';
    const anchors = [];
    if (root.matches?.(selector)) anchors.push(root);
    anchors.push(...Array.from(root.querySelectorAll(selector)));
    for (const anchor of anchors) {
      for (let current = anchor, depth = 0; current && depth < 8; current = current.parentElement, depth += 1) {
        if (current !== root && !root.contains?.(current)) break;
        candidateSet.add(current);
        if (current === root) break;
      }
    }
    const candidates = Array.from(candidateSet)
      .filter((element) => isVisible(element, pass) && isCodeWidgetOwner(element, pass));
    pass.metrics.ownerCandidatesEnumerated += candidateSet.size;
    return candidates.filter((element, index, all) => !all.some((other, otherIndex) => (
      otherIndex !== index
      && other.contains?.(element)
      && rawCodeWidgetOwnerCandidate(other, pass)?.contentSource === rawCodeWidgetOwnerCandidate(element, pass)?.contentSource
    )));
  }

  function inspectCodeWidget(widget, providedPass = null) {
    const pass = parserPass(providedPass, widget);
    const content = contentSourceForWidget(widget, pass);
    const contentSource = content.element || widget;
    const leaves = visibleTextLeafNodes(widget, pass);
    const contentLeaves = [];
    const interfaceLeaves = [];
    const unknownLeaves = [];
    const languageCandidates = [];
    const interfaceElements = [];
    const seenInterfaceElements = new Set();
    const directLanguageCandidates = [];

    const addDirectLanguage = (element, sourcePrefix, score) => {
      if (!element) return;
      const values = [
        ['data-language', element.getAttribute?.('data-language')],
        ['data-lang', element.getAttribute?.('data-lang')],
        ['data-syntax', element.getAttribute?.('data-syntax')],
        ['aria-label', element.getAttribute?.('aria-label')],
        ['title', element.getAttribute?.('title')],
        ...Array.from(String(element.getAttribute?.('class') || '').matchAll(/(?:^|\s)(?:language|lang)-([\w.+#/-]+)/gi), (match) => ['class', match[1]]),
      ];
      for (const [source, rawValue] of values) {
        for (const language of CORE.codeLanguageLabelsFromText(rawValue || '')) {
          directLanguageCandidates.push({
            language,
            source: `${sourcePrefix}-${source}`,
            confidence: 'high',
            score,
            text: String(rawValue || ''),
            domPath: domPathForNode(element, widget),
          });
        }
      }
    };

    addDirectLanguage(contentSource, 'content', 50_000);
    addDirectLanguage(content.editorPre, 'editor-pre', 45_000);
    addDirectLanguage(widget, 'widget', 40_000);

    for (const leaf of leaves) {
      const parent = leaf.parentElement;
      const text = normalizeText(leaf.textContent || '');
      if (!text || !parent) continue;
      if (contentSource === leaf || contentSource?.contains?.(leaf)) {
        contentLeaves.push(leaf);
        continue;
      }
      const actionRoot = closestWithin(leaf, 'button, [role="button"], [role="menuitem"], [role="menuitemradio"], [data-testid*="copy" i], [data-testid*="run" i], .cm-gutters, .cm-lineNumbers, [class*="line-number" i]', widget);
      const actionSignal = `${text} ${actionRoot?.getAttribute?.('aria-label') || ''} ${actionRoot?.getAttribute?.('title') || ''}`;
      if (actionRoot || codeUiActionText(actionSignal)) {
        interfaceLeaves.push(leaf);
        const owner = actionRoot || parent;
        if (!seenInterfaceElements.has(owner)) {
          seenInterfaceElements.add(owner);
          const descriptor = describeInterfaceElement(owner, widget, 'code-action');
          if (descriptor) interfaceElements.push(descriptor);
        }
        continue;
      }
      const languages = CORE.codeLanguageLabelsFromText(text);
      if (languages.length) {
        const signal = `${parent.getAttribute?.('class') || ''} ${parent.getAttribute?.('data-testid') || ''} ${parent.getAttribute?.('role') || ''}`;
        const headerLike = /header|toolbar|language|syntax|font-medium|select-none|sticky/i.test(signal)
          || Boolean(parent.parentElement?.querySelector?.('button, [role="button"]'));
        let accepted = false;
        for (const language of languages) {
          const known = CORE.isKnownCodeLanguageLabel(language);
          if (!known && !headerLike) continue;
          accepted = true;
          languageCandidates.push({
            language,
            source: 'widget-chrome-text',
            confidence: known ? 'high' : 'medium',
            score: (known ? 30_000 : 20_000) + (headerLike ? 2_000 : 0),
            text,
            domPath: domPathForNode(parent, widget),
            _leaf: leaf,
          });
        }
        if (accepted) {
          interfaceLeaves.push(leaf);
          continue;
        }
      }
      unknownLeaves.push(leaf);
    }

    for (const action of Array.from(widget.querySelectorAll?.('button, [role="button"], [data-testid*="copy" i], [data-testid*="run" i]') || [])) {
      if (!isVisible(action, pass) || seenInterfaceElements.has(action)) continue;
      seenInterfaceElements.add(action);
      const descriptor = describeInterfaceElement(action, widget, 'code-action');
      if (descriptor) interfaceElements.push(descriptor);
    }

    const ranked = [...directLanguageCandidates, ...languageCandidates]
      .sort((a, b) => b.score - a.score || a.domPath.localeCompare(b.domPath));
    const selected = ranked[0] || null;
    const language = selected?.language || '';
    const warnings = [];
    if (!language) warnings.push('code_language_unresolved');
    else if (selected?.confidence !== 'high') warnings.push('code_language_low_confidence');
    if (unknownLeaves.length) warnings.push('unclassified_code_widget_chrome');

    return {
      language,
      source: selected?.source || 'unresolved',
      confidence: selected?.confidence || 'none',
      selected: selected ? { ...selected, _leaf: undefined } : null,
      candidates: ranked.slice(0, 30).map(({ _leaf, ...candidate }) => candidate),
      contentSource,
      editorPre: content.editorPre || null,
      contentSourceKind: content.source,
      contentLeaves,
      interfaceLeaves,
      unknownLeaves,
      languageLeaves: languageCandidates.map((candidate) => candidate._leaf).filter(Boolean),
      interfaceElements,
      unknownChildren: unknownLeaves.slice(0, 40).map((leaf) => ({
        text: normalizeText(leaf.textContent || '').slice(0, 500),
        domPath: domPathForNode(leaf, widget),
        html: safeOuterHtml(leaf.parentElement, 1400),
      })),
      warnings,
      sourceRoot: domPathForNode(widget, widget.closest?.('.markdown') || null),
      contentSourcePath: domPathForNode(contentSource, widget),
      domContext: safeOuterHtml(widget, 14_000),
    };
  }

  function parserPassMetrics(pass) {
    if (pass?.kind !== 'chatgpt-response-parser-pass') return null;
    const endedAt = globalThis.performance?.now?.() ?? Date.now();
    return {
      ...pass.metrics,
      durationMs: Number(Math.max(0, endedAt - Number(pass.metrics.startedAt || endedAt)).toFixed(3)),
    };
  }

  globalThis.ChatGptResponseParserCore = Object.freeze({
    normalizeText,
    createParserPass,
    parserPassMetrics,
    isVisible,
    visibleText,
    domPathForNode,
    safeOuterHtml,
    visibleTextLeafNodes,
    codeUiActionText,
    contentSourceForWidget,
    rawCodeWidgetOwnerCandidate,
    isCodeWidgetOwner,
    collectCodeWidgetOwners,
    inspectCodeWidget,
  });
})();
