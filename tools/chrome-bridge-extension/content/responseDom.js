// Structured assistant-response DOM and Markdown extraction.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createResponseDom(deps = {}) {
    const { DOM_PARSER, isVisible, normalizeText, visibleText } = deps;

function actionSelectorHint(element) {
  if (!element) return '';
  const parts = [];
  let current = element;
  for (let depth = 0; current && current.nodeType === 1 && depth < 5; depth += 1, current = current.parentElement) {
    let part = current.tagName.toLowerCase();
    const testId = current.getAttribute('data-testid');
    if (testId) part += `[data-testid="${cssEscape(testId)}"]`;
    const role = current.getAttribute('role');
    if (role) part += `[role="${cssEscape(role)}"]`;
    const cls = Array.from(current.classList || []).filter((item) => /behavior-btn|entity-underline/.test(item)).slice(0, 2);
    if (cls.length) part += cls.map((item) => `.${cssEscape(item)}`).join('');
    parts.unshift(part);
  }
  return parts.join(' > ');
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(String(value));
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function guessNameFromUrl(url) {
  try {
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return '';
    const parsed = new URL(url, location.href);
    const last = parsed.pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last).slice(0, 120);
  } catch { return ''; }
}

function guessMime(name, url) {
  const source = `${name || ''} ${url || ''}`.toLowerCase();
  if (/\.png\b|image\/png/.test(source)) return 'image/png';
  if (/\.jpe?g\b|image\/jpe?g/.test(source)) return 'image/jpeg';
  if (/\.webp\b|image\/webp/.test(source)) return 'image/webp';
  if (/\.gif\b|image\/gif/.test(source)) return 'image/gif';
  if (/\.pdf\b|application\/pdf/.test(source)) return 'application/pdf';
  if (/\.csv\b/.test(source)) return 'text/csv';
  if (/\.json\b/.test(source)) return 'application/json';
  if (/\.zip(?:\b|$)|application\/zip|zip archive|архив zip/.test(source)) return 'application/zip';
  if (/\.txt\b/.test(source)) return 'text/plain';
  return 'application/octet-stream';
}

function simpleHash(input) {
  let hash = 2166136261;
  const text = String(input || '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function findThinkingElements(root) {
  const lowerNeedle = /(thinking|reasoning|thought|дума|думаю|размыш|мысл)/i;
  const statusNeedle = /^(?:thinking|think|думаю|размышляю)\s*(?:\.|…)?$|^(?:thought for|думал|размышлял)\b/i;
  return Array.from(root.querySelectorAll('*')).filter((element) => {
    const attributes = [element.getAttribute('data-testid'), element.getAttribute('aria-label'), element.getAttribute('class'), element.getAttribute('id')].filter(Boolean).join(' ');
    const text = visibleText(element);
    return lowerNeedle.test(attributes) || statusNeedle.test(text);
  });
}

function inlineCodeMarkdown(value) {
  const text = String(value || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(Math.max(1, longestRun + 1));
  const padded = /^(?:\s|`)|(?:\s|`)$/.test(text) && text.trim() ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

function inlineMarkdown(element, context = null) {
  if (!element) return '';
  const preserved = [];
  const preserve = (value) => {
    const index = preserved.push(String(value || '')) - 1;
    return `\uE000${index}\uE001`;
  };
  const render = (node) => {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return String(node.textContent || '').replace(/\u00a0/g, ' ');
    if (node.nodeType !== Node.ELEMENT_NODE || context?.isExcluded?.(node) || !parserElementVisible(node, context?.parserPass || null)) return '';
    const tag = node.tagName?.toLowerCase?.() || '';
    if (tag === 'br') return '\n';
    if (tag === 'code' && node.closest?.('pre') === null) return preserve(inlineCodeMarkdown(node.textContent || ''));
    const inner = Array.from(node.childNodes || []).map(render).join('');
    if (!inner) return '';
    if (tag === 'strong' || tag === 'b') return `**${inner}**`;
    if (tag === 'em' || tag === 'i') return `*${inner}*`;
    if (tag === 'del' || tag === 's') return `~~${inner}~~`;
    if (tag === 'kbd') return preserve(`<kbd>${String(node.textContent || '')}</kbd>`);
    if (tag === 'a') {
      const href = String(node.getAttribute?.('href') || '').trim();
      if (href && !/^javascript:/i.test(href)) return `[${inner}](${href})`;
    }
    return inner;
  };
  let result = render(element)
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  result = result.replace(/\uE000(\d+)\uE001/g, (_match, index) => preserved[Number(index)] || '');
  return result;
}

function sanitizeCapturedUrl(value = '') {
  const raw = String(value || '');
  if (!raw) return '';
  if (/^data:/i.test(raw)) return 'data:application/octet-stream;base64,REDACTED';
  if (/^blob:/i.test(raw)) return 'blob:https://chatgpt.com/captured-fixture';
  try {
    const parsed = new URL(raw, location.href);
    const basename = parsed.pathname.split('/').filter(Boolean).pop() || 'resource';
    return `${parsed.protocol === 'http:' ? 'http:' : 'https:'}//example.invalid/${encodeURIComponent(basename)}`;
  } catch {
    return raw.replace(/[?#].*$/, '');
  }
}

function safeOuterHtml(element, maxLength = 6000, options = {}) {
  if (!element?.cloneNode) return '';
  try {
    const clone = element.cloneNode(true);
    for (const unwanted of Array.from(clone.querySelectorAll?.('script, style, svg use') || [])) unwanted.remove();
    const captureFixture = Boolean(options.captureFixture);
    const fixtureAttribute = /^(?:id|class|role|title|alt|hidden|disabled|aria-[\w-]+|data-testid|data-message-author-role|data-message-id|data-message-model-slug|data-turn|data-turn-id|data-turn-id-container|data-turn-start-message|data-code-block-content|data-start|data-end|data-item-anchor|data-language|data-lang|data-math|data-syntax|data-state|data-status|data-transition-position|href|src|download)$/i;
    const diagnosticAttribute = /^(?:id|class|role|title|aria-[\w-]+|data-testid|data-language|data-lang|data-syntax|data-state)$/i;
    for (const node of [clone, ...Array.from(clone.querySelectorAll?.('*') || [])]) {
      for (const attr of Array.from(node.attributes || [])) {
        const name = String(attr.name || '');
        if (!(captureFixture ? fixtureAttribute : diagnosticAttribute).test(name)) {
          node.removeAttribute(name);
          continue;
        }
        if (!captureFixture) continue;
        if (/^(?:data-message-id|data-turn-id|data-turn-id-container)$/i.test(name)) {
          node.setAttribute(name, `captured-${name}`);
        } else if (/^data-message-model-slug$/i.test(name)) {
          node.setAttribute(name, 'captured-model');
        } else if (/^(?:href|src)$/i.test(name)) {
          node.setAttribute(name, sanitizeCapturedUrl(attr.value));
        }
      }
    }
    const html = String(clone.outerHTML || '');
    return html.length > maxLength ? `${html.slice(0, maxLength)}…` : html;
  } catch {
    return '';
  }
}

function codeUiActionText(value = '') {
  return /(?:copy(?:\s+code)?|copied|run(?:\s+code)?|execute|edit|download|preview|open|save|share|full\s*screen|копировать(?:\s+код)?|скопировано|запустить(?:\s+код)?|выполнить|редактировать|скачать|предпросмотр|открыть|сохранить|поделиться|на\s+весь\s+экран|copiar(?:\s+código)?|copiado|ejecutar(?:\s+código)?|code\s+kopieren|kopiert|code\s+ausführen|ausführen|copier(?:\s+le\s+code)?|copié|exécuter(?:\s+le\s+code)?|executar(?:\s+código)?|copia(?:\s+codice)?|copiato|esegui(?:\s+codice)?|コードをコピー|コピー|実行|코드\s+복사|복사|실행|复制代码|复制|运行代码|运行)/iu.test(String(value || ''));
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

function createResponseParserPass(root) {
  const createPass = globalThis.ChatGptResponseParserCore?.createParserPass;
  return typeof createPass === 'function' ? createPass(root) : null;
}

function parserElementVisible(element, pass = null) {
  const sharedVisible = globalThis.ChatGptResponseParserCore?.isVisible;
  if (typeof sharedVisible === 'function') return sharedVisible(element, pass);
  return isVisible(element);
}

function visibleTextLeafNodes(root, pass = null) {
  const sharedLeaves = globalThis.ChatGptResponseParserCore?.visibleTextLeafNodes;
  if (typeof sharedLeaves === 'function') return sharedLeaves(root, pass);
  const leaves = [];
  const visit = (node) => {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      const text = normalizeText(node.textContent || '');
      if (text && parent && parserElementVisible(parent)) leaves.push(node);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName?.toLowerCase?.() || '';
    if (/^(?:script|style|template|noscript)$/.test(tag)) return;
    if (node !== root && !parserElementVisible(node)) return;
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

function codeWidgetContentSource(widget) {
  if (!widget) return { element: null, source: 'none' };
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
        editorPre: selectedEditor.element.matches?.('pre') ? selectedEditor.element : selectedEditor.element.closest?.('pre') || null,
        source: /cm-content/i.test(selectedEditor.element.getAttribute?.('class') || '') ? 'codemirror-pre' : 'editor-text',
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

function codeWidgetInspection(widget, pass = null) {
  const sharedInspection = globalThis.ChatGptResponseParserCore?.inspectCodeWidget?.(widget, pass);
  if (sharedInspection) return sharedInspection;
  const content = codeWidgetContentSource(widget);
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
      for (const language of DOM_PARSER.codeLanguageLabelsFromText(rawValue || '')) {
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
    const languages = DOM_PARSER.codeLanguageLabelsFromText(text);
    if (languages.length) {
      const signal = `${parent.getAttribute?.('class') || ''} ${parent.getAttribute?.('data-testid') || ''} ${parent.getAttribute?.('role') || ''}`;
      const headerLike = /header|toolbar|language|syntax|font-medium|select-none|sticky/i.test(signal)
        || Boolean(parent.parentElement?.querySelector?.('button, [role="button"]'));
      let accepted = false;
      for (const language of languages) {
        const known = DOM_PARSER.isKnownCodeLanguageLabel(language);
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

  // Include icon-only actions in diagnostics even when they have no text leaf.
  for (const action of Array.from(widget.querySelectorAll?.('button, [role="button"], [data-testid*="copy" i], [data-testid*="run" i]') || [])) {
    if (!parserElementVisible(action, pass) || seenInterfaceElements.has(action)) continue;
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

function discoverCodeLanguage(pre, code) {
  return codeWidgetInspection(pre, code).language;
}

function codeTextFromPre(element, inspection = null) {
  const details = inspection || codeWidgetInspection(element);
  const code = details?.contentSource || element?.querySelector?.('code') || element;
  return String(code?.textContent || '').replace(/\r\n?/g, '\n');
}

function rawCodeWidgetOwnerCandidate(element, pass = null) {
  const sharedCandidate = globalThis.ChatGptResponseParserCore?.rawCodeWidgetOwnerCandidate?.(element, pass);
  if (sharedCandidate) return sharedCandidate;
  if (!element?.querySelectorAll) return null;
  const codeElements = Array.from(element.querySelectorAll('code'));
  if (element.matches?.('code')) codeElements.unshift(element);
  const uniqueCode = Array.from(new Set(codeElements));
  if (uniqueCode.length !== 1) return null;
  const content = globalThis.ChatGptResponseParserCore?.contentSourceForWidget?.(element, pass) || codeWidgetContentSource(element);
  const contentSource = content?.element || uniqueCode[0];
  if (!contentSource || !element.contains?.(contentSource)) return null;
  const tag = element.tagName?.toLowerCase?.() || '';
  const signal = `${element.getAttribute?.('id') || ''} ${element.getAttribute?.('class') || ''} ${element.getAttribute?.('data-testid') || ''} ${element.getAttribute?.('role') || ''}`;
  let chromeEvidence = false;
  for (const leaf of visibleTextLeafNodes(element, pass)) {
    if (contentSource === leaf || contentSource.contains?.(leaf)) continue;
    const parent = leaf.parentElement;
    const text = normalizeText(leaf.textContent || '');
    const interactive = Boolean(closestWithin(leaf, 'button, [role="button"], [data-testid*="copy" i], [data-testid*="run" i]', element));
    const classified = DOM_PARSER.classifyCodeWidgetChromeText?.(text, {
      interactive,
      ariaLabel: parent?.getAttribute?.('aria-label') || '',
      title: parent?.getAttribute?.('title') || '',
    });
    if (classified?.kind === 'language' || classified?.kind === 'interface_action') {
      chromeEvidence = true;
      break;
    }
  }
  const structuralEvidence = /(?:code[-_ ]?block|codeblock|cm-editor|code-viewer|syntax|highlight)/i.test(signal);
  if (tag !== 'pre' && !chromeEvidence && !structuralEvidence) return null;
  return { contentSource, chromeEvidence, structuralEvidence, tag };
}

function isResponseCodeWidgetOwner(element, pass = null) {
  const sharedOwner = globalThis.ChatGptResponseParserCore?.isCodeWidgetOwner?.(element, pass);
  if (typeof sharedOwner === 'boolean') return sharedOwner;
  const candidate = rawCodeWidgetOwnerCandidate(element, pass);
  if (!candidate) return false;
  if (!candidate.chromeEvidence) {
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const parentCandidate = rawCodeWidgetOwnerCandidate(ancestor, pass);
      if (!parentCandidate || parentCandidate.contentSource !== candidate.contentSource) continue;
      if (parentCandidate.chromeEvidence || (candidate.tag === 'pre' && parentCandidate.structuralEvidence)) return false;
    }
  }
  if (candidate.tag === 'pre' && !element.parentElement?.closest?.('pre')) {
    // React can create a response-level pre containing the complete widget,
    // including a nested CodeMirror pre. Keep the outer pre as the atomic
    // owner instead of descending into zero-box/display:contents wrappers.
    return true;
  }
  if (candidate.chromeEvidence) {
    for (const descendant of Array.from(element.querySelectorAll('*'))) {
      if (descendant === candidate.contentSource || candidate.contentSource.contains?.(descendant)) continue;
      if (!descendant.contains?.(candidate.contentSource)) continue;
      const nested = rawCodeWidgetOwnerCandidate(descendant, pass);
      if (nested?.chromeEvidence && nested.contentSource === candidate.contentSource) return false;
    }
    return true;
  }
  if (candidate.structuralEvidence) {
    for (const descendant of Array.from(element.children || [])) {
      const nested = rawCodeWidgetOwnerCandidate(descendant, pass);
      if (nested && nested.contentSource === candidate.contentSource && (nested.chromeEvidence || nested.structuralEvidence)) return false;
    }
    return true;
  }
  return candidate.tag === 'pre';
}

function semanticResponseBlockType(element, pass = null) {
  const tag = element?.tagName?.toLowerCase?.() || '';
  const signal = `${element?.getAttribute?.('data-testid') || ''} ${element?.getAttribute?.('class') || ''} ${element?.getAttribute?.('role') || ''}`;
  if (/artifact|file-card|download-card|attachment/i.test(signal)) return 'artifact';
  if (/citation|source-pill|webpage/i.test(signal)) return 'citation';
  const responseLevelPreWithCode = tag === 'pre'
    && !element?.parentElement?.closest?.('pre')
    && Boolean(element?.querySelector?.('code, pre[class*="cm-content" i], [data-code-block-content], [data-testid*="code-content" i]'));
  if (responseLevelPreWithCode || isResponseCodeWidgetOwner(element, pass)) return 'code_block';
  if (tag === 'p') return 'paragraph';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'ul' || tag === 'ol') return 'list';
  if (tag === 'table') return 'table';
  if (tag === 'blockquote') return 'blockquote';
  if (tag === 'hr') return 'separator';
  if (tag === 'figure' || /^(?:img|video|audio|canvas|iframe|object|embed)$/.test(tag) || element?.matches?.('[role="img"]')) return 'media';
  if (tag === 'math' || element?.matches?.('.katex, .MathJax, [data-math], [data-testid*="math" i]')) return 'math';
  if (/widget|canvas|interactive|chart|diagram/i.test(signal)) return 'rich_widget';
  return '';
}

function nodeDocumentOrder(left, right) {
  if (left === right) return 0;
  const relation = left?.compareDocumentPosition?.(right) || 0;
  if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

function blockOwnsLeaf(block, leaf) {
  if (!block || !leaf) return false;
  if (Array.isArray(block._ownedLeaves)) return block._ownedLeaves.includes(leaf);
  return Boolean(block._element?.contains?.(leaf));
}

function fallbackUnknownOwner(leaf, root, knownElements) {
  let owner = leaf?.parentElement || null;
  if (!owner) return null;
  for (let parent = owner.parentElement; parent && parent !== root; parent = parent.parentElement) {
    if (knownElements.some((element) => parent.contains?.(element))) break;
    owner = parent;
  }
  return owner;
}

function responseBlockElements(root, isExcluded, pass = null) {
  const known = [];
  const sharedCollector = globalThis.ChatGptResponseParserCore?.collectCodeWidgetOwners;
  const codeWidgetOwners = new Set(typeof sharedCollector === 'function' ? sharedCollector(root, pass) : []);
  const visit = (element) => {
    if (!element || isExcluded(element) || !parserElementVisible(element, pass)) return;
    const type = codeWidgetOwners.has(element) ? 'code_block' : semanticResponseBlockType(element, pass);
    if (type) {
      known.push({ element, type, ownedLeaves: null, orderNode: element });
      return;
    }
    const children = Array.from(element.children || []).filter((child) => !isExcluded(child) && parserElementVisible(child, pass));
    if (!children.length) return;
    for (const child of children) visit(child);
  };
  for (const child of Array.from(root?.children || [])) visit(child);

  const knownElements = known.map((entry) => entry.element);
  const unownedLeaves = visibleTextLeafNodes(root, pass).filter((leaf) => {
    const parent = leaf.parentElement;
    return parent && !isExcluded(parent) && !knownElements.some((element) => element.contains?.(leaf));
  });
  const unknownGroups = new Map();
  for (const leaf of unownedLeaves) {
    const owner = fallbackUnknownOwner(leaf, root, knownElements) || leaf.parentElement;
    if (!owner) continue;
    // If the fallback parent also contains a known block, leaves before and
    // after that block must remain separate so their document order is not
    // collapsed around the known child.
    const ownerContainsKnown = knownElements.some((element) => owner.contains?.(element));
    const key = ownerContainsKnown ? leaf : owner;
    const group = unknownGroups.get(key) || { element: owner, ownedLeaves: [] };
    group.ownedLeaves.push(leaf);
    unknownGroups.set(key, group);
  }
  const unknown = Array.from(unknownGroups.values(), ({ element, ownedLeaves }) => ({
    element,
    type: 'unknown',
    ownedLeaves,
    orderNode: ownedLeaves[0] || element,
  }));
  const entries = [...known, ...unknown].sort((left, right) => nodeDocumentOrder(left.orderNode, right.orderNode));
  if (!entries.length && root && !isExcluded(root) && parserElementVisible(root, pass)) {
    const leaves = visibleTextLeafNodes(root, pass).filter((leaf) => !isExcluded(leaf.parentElement));
    if (leaves.length) entries.push({ element: root, type: 'unknown', ownedLeaves: leaves, orderNode: leaves[0] });
  }
  return entries;
}

function mediaBlockMarkdown(element) {
  const media = element.matches?.('img, video, audio') ? element : element.querySelector?.('img, video, audio');
  const label = normalizeText(media?.getAttribute?.('alt') || media?.getAttribute?.('aria-label') || element.getAttribute?.('aria-label') || visibleText(element) || 'media');
  const src = String(media?.getAttribute?.('src') || media?.getAttribute?.('href') || '').trim();
  if (media?.tagName?.toLowerCase?.() === 'img' && src) return `![${label || 'image'}](${src})`;
  if (src) return `[${label || 'media'}](${src})`;
  return label;
}

function unknownOwnedText(ownedLeaves = []) {
  const values = [];
  for (const leaf of ownedLeaves) {
    const value = String(leaf?.textContent || '').replace(/\u00a0/g, ' ');
    if (value) values.push(value);
  }
  return normalizeText(values.join(' '));
}

function extractResponseBlocks(root, isExcluded, pass = null) {
  return responseBlockElements(root, isExcluded, pass).map((entry, index) => {
    const element = entry.element;
    const tag = element?.tagName?.toLowerCase?.() || '';
    const type = entry.type || semanticResponseBlockType(element, pass) || 'unknown';
    const base = { index, type, tag, _element: element, _ownedLeaves: entry.ownedLeaves || null };
    if (type === 'code_block') {
      const inspection = codeWidgetInspection(element, pass);
      const code = codeTextFromPre(element, inspection);
      return {
        ...base,
        markdown: preToMarkdown(element, inspection.language, code),
        language: inspection.language,
        code,
        _codeInspection: inspection,
        _languageDiagnostic: {
          language: inspection.language,
          source: inspection.source,
          confidence: inspection.confidence,
          selected: inspection.selected,
          candidates: inspection.candidates,
          warnings: inspection.warnings,
          sourceRoot: inspection.sourceRoot,
          contentSource: inspection.contentSourceKind,
          contentSourcePath: inspection.contentSourcePath,
          excludedUi: inspection.interfaceElements,
          unknownChildren: inspection.unknownChildren,
          domContext: inspection.domContext,
        },
      };
    }
    if (type === 'unknown') {
      const text = unknownOwnedText(entry.ownedLeaves || []);
      return {
        ...base,
        markdown: text,
        text,
        inlineCode: [],
        _blockDiagnostic: {
          sourceRoot: domPathForNode(element, root),
          reason: 'unclassified-visible-content',
          ownedLeafCount: entry.ownedLeaves?.length || 0,
          domContext: safeOuterHtml(element, 5000),
        },
      };
    }
    const markdown = type === 'media'
      ? mediaBlockMarkdown(element)
      : elementToMarkdown(element, { isExcluded, listDepth: 0, parserPass: pass }) || inlineMarkdown(element, { isExcluded, parserPass: pass });
    const inlineCode = Array.from(element.querySelectorAll?.('code') || [])
      .filter((code) => !code.closest?.('pre') && !isExcluded(code) && parserElementVisible(code, pass))
      .map((code) => String(code.textContent || '').replace(/\r\n?/g, '\n'));
    return {
      ...base,
      markdown,
      text: inlineMarkdown(element, { isExcluded, parserPass: pass }),
      inlineCode,
      _blockDiagnostic: {
        sourceRoot: domPathForNode(element, root),
        domContext: safeOuterHtml(element, 5000),
      },
    };
  });
}

function parserAuditForRoot(root, blocks, isExcluded, pass = null) {
  const leaves = visibleTextLeafNodes(root, pass);
  const contentItems = [];
  const interfaceItems = [];
  const artifactItems = [];
  const interfaceControls = [];
  const unknownItems = [];
  const duplicateItems = [];
  const blockEntries = Array.isArray(blocks) ? blocks : [];

  const pushLeaf = (target, leaf, category, extra = {}) => {
    target.push({
      category,
      text: normalizeText(leaf.textContent || '').slice(0, 1000),
      domPath: domPathForNode(leaf, root),
      ...extra,
    });
  };

  for (const leaf of leaves) {
    const parent = leaf.parentElement;
    const owners = blockEntries.filter((block) => blockOwnsLeaf(block, leaf));
    if (owners.length > 1) {
      pushLeaf(duplicateItems, leaf, 'duplicate', { ownerIndexes: owners.map((block) => block.index) });
      continue;
    }
    const owner = owners[0] || null;
    if (owner?.type === 'code_block') {
      const inspection = owner._codeInspection;
      if (inspection?.contentSource?.contains?.(leaf) || inspection?.contentSource === leaf) {
        pushLeaf(contentItems, leaf, 'content', { blockIndex: owner.index, blockType: owner.type });
      } else if (inspection?.interfaceLeaves?.includes?.(leaf) || inspection?.languageLeaves?.includes?.(leaf)) {
        pushLeaf(interfaceItems, leaf, 'interface', { blockIndex: owner.index, reason: 'code-widget-chrome' });
      } else {
        pushLeaf(unknownItems, leaf, 'unknown', { blockIndex: owner.index, reason: 'unclassified-code-widget-chrome', html: safeOuterHtml(parent, 1600) });
      }
      continue;
    }
    if (owner) {
      if (owner.type === 'unknown') pushLeaf(unknownItems, leaf, 'unknown', { blockIndex: owner.index, reason: 'unknown-response-block', html: safeOuterHtml(parent, 1600) });
      else if (isExcluded(parent)) pushLeaf(interfaceItems, leaf, 'interface', { blockIndex: owner.index, reason: 'excluded-interface' });
      else if (owner.type === 'artifact') pushLeaf(artifactItems, leaf, 'artifact', { blockIndex: owner.index, blockType: owner.type });
      else pushLeaf(contentItems, leaf, 'content', { blockIndex: owner.index, blockType: owner.type });
      continue;
    }
    if (isExcluded(parent)) pushLeaf(interfaceItems, leaf, 'interface', { reason: 'excluded-interface' });
    else pushLeaf(unknownItems, leaf, 'unknown', { reason: 'unowned-visible-text', html: safeOuterHtml(parent, 1600) });
  }

  const seenInterfaceControls = new Set();
  const addInterfaceControl = (descriptor) => {
    if (!descriptor) return;
    const key = `${descriptor.domPath || ''}|${descriptor.role || ''}|${descriptor.ariaLabel || ''}|${descriptor.title || ''}|${descriptor.text || ''}`;
    if (seenInterfaceControls.has(key)) return;
    seenInterfaceControls.add(key);
    interfaceControls.push(descriptor);
  };
  for (const block of blockEntries) {
    for (const descriptor of block._codeInspection?.interfaceElements || []) addInterfaceControl({ ...descriptor, blockIndex: block.index });
  }
  for (const control of Array.from(root.querySelectorAll?.('button, [role="button"], [role="menuitem"], [role="menuitemradio"]') || [])) {
    if (!parserElementVisible(control, pass) || !isExcluded(control)) continue;
    addInterfaceControl(describeInterfaceElement(control, root, 'excluded-interface-control'));
  }

  const visualUnknown = [];
  for (const element of Array.from(root.querySelectorAll?.('img, video, audio, canvas, iframe, object, embed, [role="img"]') || [])) {
    if (!parserElementVisible(element, pass) || isExcluded(element)) continue;
    const owners = blockEntries.filter((block) => block._element?.contains?.(element));
    if (!owners.length) {
      visualUnknown.push({
        category: 'unknown-visual',
        tag: element.tagName?.toLowerCase?.() || '',
        domPath: domPathForNode(element, root),
        ariaLabel: element.getAttribute?.('aria-label') || '',
        alt: element.getAttribute?.('alt') || '',
        html: safeOuterHtml(element, 1600),
      });
    }
  }

  const unknownCount = unknownItems.length + visualUnknown.length;
  const classified = contentItems.length + interfaceItems.length + artifactItems.length;
  // The denominator must come from the independent full DOM walk, never from
  // parser output. Otherwise a skipped subtree can incorrectly report 100%.
  const visibleCount = leaves.length;
  const accountedLeaves = classified + unknownItems.length + duplicateItems.length;
  const coveragePercent = visibleCount > 0 ? Number(((classified / visibleCount) * 100).toFixed(2)) : 100;
  const blockDiagnostics = blockEntries.map((block) => ({
    index: block.index,
    type: block.type,
    tag: block.tag,
    sourceRoot: domPathForNode(block._element, root),
    language: block.language || '',
    languageSource: block._codeInspection?.source || '',
    languageConfidence: block._codeInspection?.confidence || '',
    unknownChildren: block._codeInspection?.unknownChildren || [],
  }));
  const warnings = [];
  if (unknownCount) warnings.push('unknown_visible_content');
  if (duplicateItems.length) warnings.push('duplicate_leaf_ownership');
  if (accountedLeaves !== visibleCount) warnings.push('leaf_accounting_gap');
  for (const block of blockEntries) for (const warning of block._codeInspection?.warnings || []) warnings.push(`block_${block.index}:${warning}`);

  return {
    version: 1,
    coverage: {
      visibleTextLeaves: visibleCount,
      contentLeaves: contentItems.length,
      interfaceLeaves: interfaceItems.length,
      artifactLeaves: artifactItems.length,
      reasoningLeaves: 0,
      unknownLeaves: unknownItems.length,
      unknownVisualElements: visualUnknown.length,
      duplicateLeaves: duplicateItems.length,
      classifiedLeaves: classified,
      accountedLeaves,
      coveragePercent,
    },
    blocks: blockDiagnostics,
    contentItems: contentItems.slice(0, 300),
    interfaceItems: interfaceItems.slice(0, 300),
    artifactItems: artifactItems.slice(0, 300),
    interfaceControls: interfaceControls.slice(0, 300),
    unknownItems: [...unknownItems, ...visualUnknown].slice(0, 120),
    duplicateItems: duplicateItems.slice(0, 120),
    warnings: Array.from(new Set(warnings)),
  };
}

function mergeParserAudits(audits = []) {
  const valid = (Array.isArray(audits) ? audits : []).filter(Boolean);
  const coverage = valid.reduce((result, audit) => {
    for (const key of ['visibleTextLeaves', 'contentLeaves', 'interfaceLeaves', 'artifactLeaves', 'reasoningLeaves', 'unknownLeaves', 'unknownVisualElements', 'duplicateLeaves', 'classifiedLeaves']) result[key] += Number(audit.coverage?.[key] || 0);
    return result;
  }, { visibleTextLeaves: 0, contentLeaves: 0, interfaceLeaves: 0, artifactLeaves: 0, reasoningLeaves: 0, unknownLeaves: 0, unknownVisualElements: 0, duplicateLeaves: 0, classifiedLeaves: 0 });
  coverage.coveragePercent = coverage.visibleTextLeaves > 0
    ? Number(((coverage.classifiedLeaves / coverage.visibleTextLeaves) * 100).toFixed(2))
    : 100;
  return {
    version: 1,
    coverage,
    blocks: valid.flatMap((audit) => audit.blocks || []),
    contentItems: valid.flatMap((audit) => audit.contentItems || []).slice(0, 500),
    interfaceItems: valid.flatMap((audit) => audit.interfaceItems || []).slice(0, 500),
    artifactItems: valid.flatMap((audit) => audit.artifactItems || []).slice(0, 500),
    interfaceControls: valid.flatMap((audit) => audit.interfaceControls || []).slice(0, 500),
    unknownItems: valid.flatMap((audit) => audit.unknownItems || []).slice(0, 200),
    duplicateItems: valid.flatMap((audit) => audit.duplicateItems || []).slice(0, 200),
    warnings: Array.from(new Set(valid.flatMap((audit) => audit.warnings || []))),
  };
}

function extractMarkdownFromElement(root, isExcluded, pass = null) {
  const blocks = [];
  for (const child of Array.from(root.children)) {
    if (isExcluded(child) || !parserElementVisible(child, pass)) continue;
    const value = elementToMarkdown(child, { isExcluded, listDepth: 0, parserPass: pass });
    if (value) blocks.push(value);
  }
  const markdown = normalizeMarkdown(blocks.join('\n\n'));
  return markdown || inlineMarkdown(root, { isExcluded, parserPass: pass });
}

function elementToMarkdown(element, context) {
  if (!element || context.isExcluded(element) || !parserElementVisible(element, context.parserPass)) return '';
  const tag = element.tagName.toLowerCase();
  if (tag === 'pre') return preToMarkdown(element);
  if (tag === 'table') return tableToMarkdown(element);
  if (tag === 'blockquote') return blockquoteToMarkdown(element, context);
  if (tag === 'ul' || tag === 'ol') return listToMarkdown(element, context, tag === 'ol');
  if (tag === 'li') return listItemToMarkdown(element, context, false, 1);
  if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag.slice(1)))} ${inlineMarkdown(element, context)}`.trim();
  if (tag === 'p') return inlineMarkdown(element, context);
  if (tag === 'hr') return '---';

  const childBlocks = [];
  for (const child of Array.from(element.children)) {
    if (context.isExcluded(child) || !parserElementVisible(child, context.parserPass)) continue;
    const childTag = child.tagName.toLowerCase();
    if (isBlockTag(childTag)) {
      const value = elementToMarkdown(child, context);
      if (value) childBlocks.push(value);
    }
  }
  if (childBlocks.length) return normalizeMarkdown(childBlocks.join('\n\n'));
  return inlineMarkdown(element, context);
}

function isBlockTag(tag) { return /^(p|div|section|article|pre|table|blockquote|ul|ol|li|h[1-6]|hr)$/i.test(tag); }
function inlineText(element, context = null) {
  if (!context?.isExcluded) return visibleText(element).replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const collect = (node) => {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (node.nodeType !== Node.ELEMENT_NODE || context.isExcluded(node) || !parserElementVisible(node, context.parserPass)) return '';
    return Array.from(node.childNodes || []).map(collect).join(' ');
  };
  return normalizeText(collect(element)).replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}
function preToMarkdown(element, resolvedLanguage = null, resolvedText = null) {
  const code = element.querySelector('code') || element;
  const language = resolvedLanguage == null ? discoverCodeLanguage(element, code) : String(resolvedLanguage || '');
  const text = resolvedText == null ? codeTextFromPre(element) : String(resolvedText || '');
  if (!text) return '';
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  const suffix = text.endsWith('\n') ? '' : '\n';
  return `${fence}${language}\n${text}${suffix}${fence}`;
}

function tableToMarkdown(table) {
  const rows = Array.from(table.querySelectorAll('tr')).map((row) => Array.from(row.querySelectorAll('th,td')).map((cell) => inlineText(cell).replace(/\|/g, '\\|'))).filter((cells) => cells.length);
  if (!rows.length) return visibleText(table);
  const header = rows[0];
  const separator = header.map(() => '---');
  const body = rows.slice(1);
  return [header, separator, ...body].map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}
function blockquoteToMarkdown(element, context) { return (elementToMarkdownChildren(element, context) || visibleText(element)).split('\n').map((line) => `> ${line}`).join('\n'); }
function elementToMarkdownChildren(element, context) {
  const values = [];
  for (const child of Array.from(element.children)) {
    const value = elementToMarkdown(child, context);
    if (value) values.push(value);
  }
  return normalizeMarkdown(values.join('\n\n'));
}
function listToMarkdown(list, context, ordered) {
  const items = Array.from(list.children).filter((child) => child.tagName.toLowerCase() === 'li');
  return items.map((item, index) => listItemToMarkdown(item, context, ordered, index + 1)).filter(Boolean).join('\n');
}
function listItemToMarkdown(item, context, ordered, number) {
  const depth = context.listDepth || 0;
  const prefix = ordered ? `${number}. ` : '- ';
  const nestedLists = Array.from(item.children).filter((child) => ['ul', 'ol'].includes(child.tagName.toLowerCase()));
  const clone = item.cloneNode(true);
  for (const nested of Array.from(clone.children).filter((child) => ['ul', 'ol'].includes(child.tagName.toLowerCase()))) nested.remove();
  const ownText = inlineText(clone);
  const indent = '  '.repeat(depth);
  const lines = ownText ? [`${indent}${prefix}${ownText}`] : [];
  for (const nested of nestedLists) {
    if (context.isExcluded(nested)) continue;
    const nestedMarkdown = listToMarkdown(nested, { ...context, listDepth: depth + 1 }, nested.tagName.toLowerCase() === 'ol');
    if (nestedMarkdown) lines.push(nestedMarkdown);
  }
  return lines.join('\n');
}

function normalizeCode(value) { return String(value || '').replace(/\n+$/g, '').replace(/^\n+/g, ''); }
function normalizeMarkdown(value) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let fenceChar = '';
  let fenceLength = 0;
  let outsideBlankRun = 0;
  for (const original of lines) {
    const opening = original.match(/^\s*(`{3,}|~{3,})/);
    if (fenceChar) {
      output.push(original);
      const closing = original.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (closing && closing[1][0] === fenceChar && closing[1].length >= fenceLength) {
        fenceChar = '';
        fenceLength = 0;
      }
      continue;
    }
    const line = original.replace(/\u00a0/g, ' ').replace(/[ \t]+$/g, '');
    if (opening) {
      output.push(line);
      fenceChar = opening[1][0];
      fenceLength = opening[1].length;
      outsideBlankRun = 0;
      continue;
    }
    if (!line) {
      outsideBlankRun += 1;
      if (outsideBlankRun <= 1) output.push('');
    } else {
      outsideBlankRun = 0;
      output.push(line);
    }
  }
  while (output[0] === '') output.shift();
  while (output.at(-1) === '') output.pop();
  return output.join('\n');
}


    return Object.freeze({
      actionSelectorHint,
      guessNameFromUrl,
      guessMime,
      simpleHash,
      safeOuterHtml,
      codeUiActionText,
      domPathForNode,
      createResponseParserPass,
      extractResponseBlocks,
      parserAuditForRoot,
      mergeParserAudits,
      normalizeMarkdown,
    });
  }

  globalThis.ChatGptResponseDom = Object.freeze({ createResponseDom });
})();
