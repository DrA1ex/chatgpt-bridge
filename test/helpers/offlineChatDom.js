import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_POSITION_PRECEDING = 2;
const DOCUMENT_POSITION_FOLLOWING = 4;
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function decodeEntities(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&nbsp;', '\u00a0');
}

function splitTopLevel(value = '', delimiter = ',') {
  const output = [];
  let current = '';
  let bracketDepth = 0;
  let parenDepth = 0;
  let quote = '';
  for (const char of String(value)) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === '[') bracketDepth += 1;
    else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === '(') parenDepth += 1;
    else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
    if (char === delimiter && bracketDepth === 0 && parenDepth === 0) {
      if (current.trim()) output.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) output.push(current.trim());
  return output;
}

function tokenizeSelector(selector = '') {
  const tokens = [];
  let current = '';
  let bracketDepth = 0;
  let parenDepth = 0;
  let quote = '';
  let pendingDescendant = false;
  const flush = () => {
    if (!current.trim()) return;
    if (pendingDescendant && tokens.length && tokens.at(-1) !== '>' && tokens.at(-1) !== ' ') tokens.push(' ');
    tokens.push(current.trim());
    current = '';
    pendingDescendant = false;
  };
  for (const char of String(selector).trim()) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === '[') bracketDepth += 1;
    else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === '(') parenDepth += 1;
    else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
    if (bracketDepth === 0 && parenDepth === 0 && char === '>') {
      flush();
      if (tokens.at(-1) === ' ') tokens.pop();
      tokens.push('>');
      pendingDescendant = false;
      continue;
    }
    if (bracketDepth === 0 && parenDepth === 0 && /\s/.test(char)) {
      flush();
      pendingDescendant = true;
      continue;
    }
    current += char;
  }
  flush();
  return tokens;
}

function parseAttributeExpression(expression = '') {
  const match = String(expression).trim().match(/^([:\w-]+)\s*(?:(\^=|\$=|\*=|~=|\|=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?\s*(i)?$/i);
  if (!match) return null;
  return { name: match[1], operator: match[2] || '', expected: match[3] ?? match[4] ?? match[5] ?? '', insensitive: Boolean(match[6]) };
}

function attributeMatches(element, expression) {
  const parsed = parseAttributeExpression(expression);
  if (!parsed) return false;
  const actualValue = element.getAttribute(parsed.name);
  if (!parsed.operator) return actualValue !== null;
  if (actualValue === null) return false;
  const actual = parsed.insensitive ? actualValue.toLowerCase() : actualValue;
  const expected = parsed.insensitive ? parsed.expected.toLowerCase() : parsed.expected;
  if (parsed.operator === '=') return actual === expected;
  if (parsed.operator === '*=') return actual.includes(expected);
  if (parsed.operator === '^=') return actual.startsWith(expected);
  if (parsed.operator === '$=') return actual.endsWith(expected);
  if (parsed.operator === '~=') return actual.split(/\s+/).includes(expected);
  if (parsed.operator === '|=') return actual === expected || actual.startsWith(`${expected}-`);
  return false;
}

function compoundMatches(element, selector, scope) {
  let value = String(selector || '').trim();
  if (!value) return false;
  if (value === ':scope') return element === scope;

  for (const match of Array.from(value.matchAll(/:not\(([^()]*)\)/g))) {
    if (compoundMatches(element, match[1], scope)) return false;
  }
  value = value.replace(/:not\([^()]*\)/g, '');
  if (value.includes(':scope')) {
    if (element !== scope) return false;
    value = value.replaceAll(':scope', '');
  }
  value = value.replace(/:(?:first-child|last-child|only-child|empty|visible)\b/g, '');

  const attributes = Array.from(value.matchAll(/\[([^\]]+)\]/g), (match) => match[1]);
  value = value.replace(/\[[^\]]+\]/g, '');
  for (const expression of attributes) if (!attributeMatches(element, expression)) return false;

  const idMatches = Array.from(value.matchAll(/#([\w-]+)/g), (match) => match[1]);
  value = value.replace(/#[\w-]+/g, '');
  for (const id of idMatches) if (element.id !== id) return false;

  const classes = Array.from(value.matchAll(/\.([\w!/-]+)/g), (match) => match[1]);
  value = value.replace(/\.[\w!/-]+/g, '');
  for (const className of classes) if (!element.classList.contains(className)) return false;

  const tag = value.trim();
  return !tag || tag === '*' || element.tagName.toLowerCase() === tag.toLowerCase();
}

function complexMatches(element, selector, scope) {
  const tokens = tokenizeSelector(selector);
  if (!tokens.length) return false;
  let index = tokens.length - 1;
  let current = element;
  if (!compoundMatches(current, tokens[index], scope)) return false;
  index -= 1;
  while (index >= 0) {
    const combinator = tokens[index] === '>' || tokens[index] === ' ' ? tokens[index--] : ' ';
    const expected = tokens[index--];
    if (!expected) return false;
    if (combinator === '>') {
      current = current.parentElement;
      if (!current || !compoundMatches(current, expected, scope)) return false;
      continue;
    }
    let ancestor = current.parentElement;
    while (ancestor && !compoundMatches(ancestor, expected, scope)) ancestor = ancestor.parentElement;
    if (!ancestor) return false;
    current = ancestor;
  }
  return true;
}

function selectorMatches(element, selector, scope = null) {
  return splitTopLevel(selector).some((part) => complexMatches(element, part, scope));
}

class FakeText {
  constructor(value = '') {
    this.nodeType = TEXT_NODE;
    this.textContent = String(value);
    this.parentElement = null;
  }
  cloneNode() { return new FakeText(this.textContent); }
  get isConnected() { return Boolean(this.parentElement?.isConnected); }
  compareDocumentPosition(other) { return compareNodes(this, other); }
}

class FakeClassList {
  constructor(element) { this.element = element; }
  values() { return String(this.element.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  contains(value) { return this.values().includes(String(value)); }
  add(...values) { this.element.setAttribute('class', Array.from(new Set([...this.values(), ...values.map(String)])).join(' ')); }
  remove(...values) { const removed = new Set(values.map(String)); this.element.setAttribute('class', this.values().filter((item) => !removed.has(item)).join(' ')); }
  [Symbol.iterator]() { return this.values()[Symbol.iterator](); }
  get length() { return this.values().length; }
  item(index) { return this.values()[index] || null; }
  toString() { return this.values().join(' '); }
}

class FakeElement {
  constructor(tagName = 'div', attributes = {}) {
    this.nodeType = ELEMENT_NODE;
    this.tagName = String(tagName).toUpperCase();
    this._attributes = new Map(Object.entries(attributes).map(([name, value]) => [String(name), String(value)]));
    this.childNodes = [];
    this.parentElement = null;
    this.classList = new FakeClassList(this);
  }
  append(child) {
    const node = typeof child === 'string' ? new FakeText(child) : child;
    if (!node) return null;
    node.parentElement = this;
    this.childNodes.push(node);
    return node;
  }
  appendChild(child) { return this.append(child); }
  get children() { return this.childNodes.filter((node) => node.nodeType === ELEMENT_NODE); }
  get firstElementChild() { return this.children[0] || null; }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get previousElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) - 1] || null;
  }
  get id() { return this.getAttribute('id') || ''; }
  get className() { return this.getAttribute('class') || ''; }
  get attributes() { return Array.from(this._attributes, ([name, value]) => ({ name, value })); }
  get textContent() { return this.childNodes.map((node) => node.textContent || '').join(''); }
  set textContent(value) { this.childNodes = []; this.append(String(value)); }
  get innerText() { return this.textContent; }
  get innerHTML() { return this.childNodes.map((node) => node.nodeType === TEXT_NODE ? escapeHtml(node.textContent) : node.outerHTML).join(''); }
  get outerHTML() {
    const attrs = Array.from(this._attributes, ([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('');
    return `<${this.tagName.toLowerCase()}${attrs}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }
  get isConnected() { return true; }
  get hidden() { return this.hasAttribute('hidden'); }
  get dataset() {
    return Object.fromEntries(Array.from(this._attributes).filter(([name]) => name.startsWith('data-')).map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_m, char) => char.toUpperCase()), value]));
  }
  get style() {
    const entries = String(this.getAttribute('style') || '').split(';').map((item) => item.split(':')).filter((item) => item.length >= 2);
    return Object.fromEntries(entries.map(([name, ...rest]) => [name.trim().replace(/-([a-z])/g, (_m, char) => char.toUpperCase()), rest.join(':').trim()]));
  }
  getAttribute(name) { return this._attributes.has(String(name)) ? this._attributes.get(String(name)) : null; }
  hasAttribute(name) { return this._attributes.has(String(name)); }
  setAttribute(name, value) { this._attributes.set(String(name), String(value)); }
  removeAttribute(name) { this._attributes.delete(String(name)); }
  matches(selector) { return selectorMatches(this, selector, this); }
  closest(selector) {
    for (let current = this; current; current = current.parentElement) if (selectorMatches(current, selector, current)) return current;
    return null;
  }
  contains(node) {
    if (node === this) return true;
    return this.childNodes.some((child) => child === node || (child.nodeType === ELEMENT_NODE && child.contains(node)));
  }
  querySelectorAll(selector) {
    const output = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (selectorMatches(child, selector, this)) output.push(child);
        visit(child);
      }
    };
    visit(this);
    return output;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  cloneNode(deep = false) {
    const clone = new FakeElement(this.tagName, Object.fromEntries(this._attributes));
    if (deep) for (const child of this.childNodes) clone.append(child.cloneNode(true));
    return clone;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.childNodes = this.parentElement.childNodes.filter((node) => node !== this);
    this.parentElement = null;
  }
  checkVisibility() {
    const style = this.style;
    return !this.hidden && this.getAttribute('aria-hidden') !== 'true' && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }
  getBoundingClientRect() { return this.checkVisibility() ? { width: 100, height: 20, top: 0, bottom: 20, left: 0, right: 100 } : { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 }; }
  compareDocumentPosition(other) { return compareNodes(this, other); }
}

function escapeHtml(value = '') { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function escapeAttribute(value = '') { return escapeHtml(value).replaceAll('"', '&quot;'); }

function rootOf(node) { let current = node; while (current?.parentElement) current = current.parentElement; return current; }
function flatten(node, output = []) { output.push(node); if (node?.childNodes) for (const child of node.childNodes) flatten(child, output); return output; }
function compareNodes(left, right) {
  if (left === right) return 0;
  const nodes = flatten(rootOf(left));
  const a = nodes.indexOf(left); const b = nodes.indexOf(right);
  if (a < 0 || b < 0) return 0;
  return a < b ? DOCUMENT_POSITION_FOLLOWING : DOCUMENT_POSITION_PRECEDING;
}

function parseAttributes(source = '') {
  const attributes = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(source))) attributes[match[1]] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  return attributes;
}

export function parseCapturedHtml(html = '') {
  const documentRoot = new FakeElement('document');
  const stack = [documentRoot];
  const tokens = String(html).match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[^>]+>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      const tag = token.slice(2, -1).trim().toLowerCase();
      while (stack.length > 1) {
        const popped = stack.pop();
        if (popped.tagName.toLowerCase() === tag) break;
      }
      continue;
    }
    if (token.startsWith('<')) {
      const selfClosing = /\/>$/.test(token);
      const body = token.slice(1, token.length - (selfClosing ? 2 : 1)).trim();
      const tagMatch = body.match(/^([^\s/>]+)/);
      if (!tagMatch) continue;
      const tagName = tagMatch[1];
      const element = new FakeElement(tagName, parseAttributes(body.slice(tagMatch[0].length)));
      stack.at(-1).append(element);
      if (!selfClosing && !VOID_TAGS.has(tagName.toLowerCase())) stack.push(element);
      continue;
    }
    if (token) stack.at(-1).append(new FakeText(decodeEntities(token)));
  }
  return documentRoot.children[0] || documentRoot;
}

async function loadClassic(context, file) {
  const source = await fs.readFile(path.resolve(file), 'utf8');
  vm.runInContext(source, context, { filename: file });
}

export async function parseAssistantFixture(html = '') {
  const root = parseCapturedHtml(html);
  const document = new FakeElement('html');
  const body = new FakeElement('body');
  document.append(body);
  body.append(root);
  const window = {
    CSS: { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
    getComputedStyle: (element) => {
      const style = element?.style || {};
      return { display: style.display || 'block', visibility: style.visibility || 'visible', contentVisibility: style.contentVisibility || 'visible', opacity: style.opacity ?? '1', position: style.position || 'static' };
    },
  };
  const context = vm.createContext({
    console,
    window,
    document: body,
    location: new URL('https://chatgpt.com/c/captured-fixture'),
    URL,
    Node: { ELEMENT_NODE, TEXT_NODE, DOCUMENT_POSITION_PRECEDING, DOCUMENT_POSITION_FOLLOWING },
    CSS: window.CSS,
    getComputedStyle: window.getComputedStyle,
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
  });
  context.globalThis = context;
  await loadClassic(context, 'tools/chrome-bridge-extension/artifactParserCore.js');
  await loadClassic(context, 'tools/chrome-bridge-extension/domParserCore.js');
  await loadClassic(context, 'tools/chrome-bridge-extension/responseParserCore.js');
  await loadClassic(context, 'tools/chrome-bridge-extension/content/domUtilities.js');
  await loadClassic(context, 'tools/chrome-bridge-extension/content/responseDom.js');
  await loadClassic(context, 'tools/chrome-bridge-extension/content/artifactDom.js');
  await loadClassic(context, 'tools/chrome-bridge-extension/content/turnSnapshots.js');

  const utilities = context.ChatGptDomUtilities;
  const responseDom = context.ChatGptResponseDom.createResponseDom({
    DOM_PARSER: context.ChatGptDomParserCore,
    isVisible: utilities.isVisible,
    normalizeText: utilities.normalizeText,
    visibleText: utilities.visibleText,
  });
  const artifactDom = context.ChatGptArtifactDom.createArtifactDom({
    DOM_PARSER: context.ChatGptDomParserCore,
    actionSelectorHint: responseDom.actionSelectorHint,
    guessMime: responseDom.guessMime,
    guessNameFromUrl: responseDom.guessNameFromUrl,
    isVisible: utilities.isVisible,
    normalizeText: utilities.normalizeText,
    simpleHash: responseDom.simpleHash,
    visibleText: utilities.visibleText,
  });
  let thinkingToken = 0;
  const snapshots = context.ChatGptTurnSnapshots.createTurnSnapshots({
    DOM_PARSER: context.ChatGptDomParserCore,
    buttonSignalText: utilities.visibleText,
    collectArtifactsForAssistantNode: artifactDom.collectArtifactsForAssistantNode,
    collectArtifactsFromNode: artifactDom.collectArtifactsFromNode,
    codeUiActionText: responseDom.codeUiActionText,
    conversationIdFromUrl: context.ChatGptDomParserCore.conversationIdFromUrl,
    createResponseParserPass: responseDom.createResponseParserPass,
    delay: utilities.delay,
    diagnostic: () => {},
    domPathForNode: responseDom.domPathForNode,
    emitChatEvent: () => {},
    extractResponseBlocks: responseDom.extractResponseBlocks,
    finalizationControlRoots: () => [],
    findChatMain: () => body,
    findContinueButton: () => null,
    findSendButton: () => null,
    findStopButton: () => null,
    getActiveRequest: () => null,
    isVisible: utilities.isVisible,
    mergeParserAudits: responseDom.mergeParserAudits,
    nextThinkingNodeToken: () => `fixture-thinking-${++thinkingToken}`,
    normalizeMarkdown: responseDom.normalizeMarkdown,
    normalizeText: utilities.normalizeText,
    parserAuditForRoot: responseDom.parserAuditForRoot,
    safeOuterHtml: responseDom.safeOuterHtml,
    setRequestPhase: () => {},
    simpleHash: responseDom.simpleHash,
    thinkingNodeTokens: new WeakMap(),
    thinkingStateByTurn: new Map(),
    visibleText: utilities.visibleText,
  });
  return snapshots.readAssistantNodeSnapshot(root, { reason: 'offline_captured_fixture', captureSourceHtml: false });
}
