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

  function isVisible(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    try {
      if (element.closest?.('[hidden], [aria-hidden="true"]')) return false;
      // Child computed styles do not reliably expose a display:none ancestor.
      // Walk the ancestor chain so hidden duplicate render trees never enter the
      // lossless audit.
      for (let current = element; current; current = current.parentElement) {
        const currentStyle = getComputedStyle(current);
        if (currentStyle.display === 'none'
          || currentStyle.visibility === 'hidden'
          || currentStyle.contentVisibility === 'hidden'
          || Number(currentStyle.opacity) === 0) return false;
      }
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect?.();
      if (rect && rect.width === 0 && rect.height === 0 && style.position !== 'fixed') {
        // display:contents and text-only wrappers intentionally have no box but
        // still own visible descendants.
        return style.display === 'contents' || Boolean(normalizeText(element.textContent || ''));
      }
      return true;
    } catch {
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

  function visibleTextLeafNodes(root) {
    const leaves = [];
    const visit = (node) => {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        const text = normalizeText(node.textContent || '');
        if (text && parent && isVisible(parent)) leaves.push(node);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName?.toLowerCase?.() || '';
      if (/^(?:script|style|template|noscript)$/.test(tag)) return;
      if (node !== root && !isVisible(node)) return;
      for (const child of Array.from(node.childNodes || [])) visit(child);
    };
    visit(root);
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

  function contentSourceForWidget(widget) {
    if (!widget) return { element: null, source: 'none', editorPre: null };
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
        score += Math.min(500, domPathForNode(element, widget).split('>').length * 10);
        return { element, index, score };
      }).sort((a, b) => b.score - a.score || a.index - b.index)[0];
      if (selectedEditor?.element) {
        return {
          element: selectedEditor.element,
          source: /cm-content/i.test(selectedEditor.element.getAttribute?.('class') || '') ? 'codemirror-pre' : 'editor-text',
          editorPre: selectedEditor.element.matches?.('pre') ? selectedEditor.element : selectedEditor.element.closest?.('pre') || null,
        };
      }
      return { element: widget, source: 'widget-text', editorPre: widget.matches?.('pre') ? widget : null };
    }
    const scored = candidates.map((element, index) => {
      const editorPre = element.closest?.('pre');
      const signal = `${editorPre?.getAttribute?.('class') || ''} ${element.getAttribute?.('class') || ''} ${element.closest?.('[id*="code-block" i], [class*="cm-editor" i], [class*="code" i]')?.getAttribute?.('class') || ''}`;
      let score = 0;
      if (/cm-content|cm-editor|code-block-viewer|readonly/i.test(signal)) score += 10_000;
      if (editorPre && editorPre !== widget) score += 2_000;
      if (element.parentElement === widget) score += 500;
      score += Math.min(500, domPathForNode(element, widget).split('>').length * 10);
      return { element, index, score, editorPre };
    }).sort((a, b) => b.score - a.score || a.index - b.index);
    const selected = scored[0];
    return {
      element: selected.element,
      editorPre: selected.editorPre || null,
      source: /cm-content|cm-editor/i.test(`${selected.editorPre?.className || ''} ${selected.element.className || ''}`)
        ? 'codemirror-code'
        : selected.editorPre && selected.editorPre !== widget ? 'nested-pre-code' : 'code-element',
    };
  }

  function rawCodeWidgetOwnerCandidate(element) {
    if (!element?.querySelectorAll) return null;
    const content = contentSourceForWidget(element);
    const contentSource = content?.element || null;
    if (!contentSource || !element.contains?.(contentSource)) return null;

    const codeElements = Array.from(new Set([
      ...(element.matches?.('code') ? [element] : []),
      ...Array.from(element.querySelectorAll('code')),
    ]));
    const independentCodeContainers = new Set(codeElements.map((code) => (
      code.closest?.('pre, [data-code-block-content], [data-testid*="code-content" i], [class*="cm-content" i]') || code
    )));
    // A broad ancestor containing multiple independent editors is not one code
    // widget. Multiple mirrors inside the same editor remain supported.
    if (independentCodeContainers.size > 1) return null;

    const tag = element.tagName?.toLowerCase?.() || '';
    const signal = `${element.getAttribute?.('id') || ''} ${element.getAttribute?.('class') || ''} ${element.getAttribute?.('data-testid') || ''} ${element.getAttribute?.('role') || ''}`;
    const editorEvidence = Boolean(
      content.editorPre
      || contentSource.closest?.('[class*="cm-editor" i], [id*="code-block" i], [data-code-block-content], [data-testid*="code-content" i]')
    );
    let chromeEvidence = false;
    let actionEvidence = false;
    let languageEvidence = false;
    for (const leaf of visibleTextLeafNodes(element)) {
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
    if (tag !== 'pre' && !actionEvidence && !structuralEvidence && !(languageEvidence && editorEvidence)) return null;
    if (tag === 'pre' && !codeElements.length && !editorEvidence && contentSource === element) return null;
    return { contentSource, chromeEvidence, actionEvidence, languageEvidence, editorEvidence, structuralEvidence, tag };
  }

  function isCodeWidgetOwner(element) {
    const candidate = rawCodeWidgetOwnerCandidate(element);
    if (!candidate) return false;
    if (!candidate.chromeEvidence) {
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const parentCandidate = rawCodeWidgetOwnerCandidate(ancestor);
        if (!parentCandidate || parentCandidate.contentSource !== candidate.contentSource) continue;
        if (parentCandidate.chromeEvidence || (candidate.tag === 'pre' && parentCandidate.structuralEvidence)) return false;
      }
    }
    // A response-level <pre> owns the whole code widget even when React
    // creates a nested CodeMirror <pre>. Prefer that stable outer boundary
    // before considering smaller descendants that happen to contain toolbar
    // text as well.
    if (candidate.tag === 'pre' && !element.parentElement?.closest?.('pre')) return true;
    if (candidate.chromeEvidence) {
      for (const descendant of Array.from(element.querySelectorAll('*'))) {
        if (descendant === candidate.contentSource || candidate.contentSource.contains?.(descendant)) continue;
        if (!descendant.contains?.(candidate.contentSource)) continue;
        const nested = rawCodeWidgetOwnerCandidate(descendant);
        if (nested?.chromeEvidence && nested.contentSource === candidate.contentSource) return false;
      }
      return true;
    }
    if (candidate.structuralEvidence) {
      for (const descendant of Array.from(element.children || [])) {
        const nested = rawCodeWidgetOwnerCandidate(descendant);
        if (nested && nested.contentSource === candidate.contentSource && (nested.chromeEvidence || nested.structuralEvidence)) return false;
      }
      return true;
    }
    return candidate.tag === 'pre';
  }

  function collectCodeWidgetOwners(root) {
    if (!root?.querySelectorAll) return [];
    const candidates = [root, ...Array.from(root.querySelectorAll('*'))]
      .filter((element) => isVisible(element) && isCodeWidgetOwner(element));
    return candidates.filter((element, index, all) => !all.some((other, otherIndex) => (
      otherIndex !== index
      && other.contains?.(element)
      && rawCodeWidgetOwnerCandidate(other)?.contentSource === rawCodeWidgetOwnerCandidate(element)?.contentSource
    )));
  }

  function inspectCodeWidget(widget) {
    const content = contentSourceForWidget(widget);
    const contentSource = content.element || widget;
    const leaves = visibleTextLeafNodes(widget);
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
      if (!isVisible(action) || seenInterfaceElements.has(action)) continue;
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

  globalThis.ChatGptResponseParserCore = Object.freeze({
    normalizeText,
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
