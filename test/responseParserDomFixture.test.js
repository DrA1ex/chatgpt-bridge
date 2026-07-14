import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function splitSelectors(selector = '') {
  return String(selector).split(',').map((value) => value.trim()).filter(Boolean);
}

function attributeMatch(element, expression) {
  const match = expression.match(/^([\w-]+)(?:([*]?=)"([^"]*)")?(?:\s+i)?$/i);
  if (!match) return false;
  const [, name, operator, expected = ''] = match;
  const actual = element.getAttribute(name);
  if (!operator) return actual !== null;
  if (actual === null) return false;
  const insensitive = /\s+i$/i.test(expression);
  const left = insensitive ? actual.toLowerCase() : actual;
  const right = insensitive ? expected.toLowerCase() : expected;
  return operator === '*=' ? left.includes(right) : left === right;
}

function simpleSelectorMatch(element, selector) {
  let value = selector.trim();
  if (!value) return false;
  if (value.includes(' ')) {
    const parts = value.split(/\s+/);
    const tail = parts.pop();
    if (!simpleSelectorMatch(element, tail)) return false;
    let ancestor = element.parentElement;
    while (ancestor) {
      if (simpleSelectorMatch(ancestor, parts.join(' '))) return true;
      ancestor = ancestor.parentElement;
    }
    return false;
  }
  if (value === '*') return true;
  const attributes = Array.from(value.matchAll(/\[([^\]]+)\]/g), (match) => match[1]);
  value = value.replace(/\[[^\]]+\]/g, '');
  for (const expression of attributes) if (!attributeMatch(element, expression)) return false;
  const classes = Array.from(value.matchAll(/\.([\w-]+)/g), (match) => match[1]);
  value = value.replace(/\.[\w-]+/g, '');
  for (const className of classes) if (!element.classList.includes(className)) return false;
  if (value && value !== '*' && element.tagName.toLowerCase() !== value.toLowerCase()) return false;
  return true;
}

function selectorMatch(element, selector) {
  return splitSelectors(selector).some((part) => simpleSelectorMatch(element, part));
}

class FakeText {
  constructor(value) {
    this.nodeType = TEXT_NODE;
    this.textContent = value;
    this.parentElement = null;
  }
  cloneNode() { return new FakeText(this.textContent); }
}

class FakeElement {
  constructor(tagName, attrs = {}, children = []) {
    this.nodeType = ELEMENT_NODE;
    this.tagName = String(tagName).toUpperCase();
    this._attrs = new Map(Object.entries(attrs).map(([key, value]) => [key, String(value)]));
    this.childNodes = [];
    this.parentElement = null;
    for (const child of children) this.append(child);
  }
  append(child) {
    const node = typeof child === 'string' ? new FakeText(child) : child;
    node.parentElement = this;
    this.childNodes.push(node);
    return node;
  }
  get children() { return this.childNodes.filter((node) => node.nodeType === ELEMENT_NODE); }
  get className() { return this.getAttribute('class') || ''; }
  get classList() { return this.className.split(/\s+/).filter(Boolean); }
  get id() { return this.getAttribute('id') || ''; }
  get attributes() { return Array.from(this._attrs, ([name, value]) => ({ name, value })); }
  get textContent() { return this.childNodes.map((node) => node.textContent || '').join(''); }
  set textContent(value) { this.childNodes = []; this.append(String(value)); }
  get innerText() { return this.textContent; }
  get outerHTML() {
    const attrs = Array.from(this._attrs, ([name, value]) => ` ${name}="${value.replaceAll('"', '&quot;')}"`).join('');
    return `<${this.tagName.toLowerCase()}${attrs}>${this.childNodes.map((node) => node.nodeType === TEXT_NODE ? node.textContent : node.outerHTML).join('')}</${this.tagName.toLowerCase()}>`;
  }
  getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null; }
  removeAttribute(name) { this._attrs.delete(name); }
  matches(selector) { return selectorMatch(this, selector); }
  closest(selector) {
    for (let current = this; current; current = current.parentElement) if (current.matches(selector)) return current;
    return null;
  }
  contains(node) {
    if (node === this) return true;
    return this.childNodes.some((child) => child === node || (child.nodeType === ELEMENT_NODE && child.contains(node)));
  }
  querySelectorAll(selector) {
    const result = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  cloneNode(deep = false) {
    const clone = new FakeElement(this.tagName, Object.fromEntries(this._attrs));
    if (deep) for (const child of this.childNodes) clone.append(child.cloneNode(true));
    return clone;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.childNodes = this.parentElement.childNodes.filter((node) => node !== this);
    this.parentElement = null;
  }
  getBoundingClientRect() {
    if (this.getAttribute('data-zero-box') === 'true') return { width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
    return { width: 100, height: 20, top: 0, bottom: 20, left: 0, right: 100 };
  }
}

function el(tag, attrs, ...children) {
  if (attrs === null || typeof attrs !== 'object' || attrs instanceof FakeElement || attrs instanceof FakeText) {
    children.unshift(attrs);
    attrs = {};
  }
  return new FakeElement(tag, attrs || {}, children.flat().filter((value) => value !== undefined && value !== null));
}

function codeWidget(language, code, { run = false } = {}) {
  const actions = [el('button', { 'aria-label': 'Копировать', 'data-state': 'closed' }, el('svg', { 'aria-hidden': 'true' }))];
  if (run) actions.push(el('button', { 'aria-label': 'Запустить код' }, el('span', {}, 'Запустить')));
  return el('pre', { class: 'overflow-visible! px-0!' },
    el('div', { class: 'relative w-full mt-4 mb-1' },
      el('div', { class: 'contents', 'data-display': 'contents', 'data-zero-box': 'true' },
        el('div', { class: 'select-none sticky' },
          el('div', { class: 'code-toolbar' },
            el('div', { class: 'text-sm font-medium' }, el('svg', { 'aria-hidden': 'true' }), language),
            el('div', {}, actions))),
        el('div', { class: 'cm-editor', id: 'code-block-viewer' },
          el('div', { class: 'cm-scroller' },
            el('pre', { class: 'cm-content readonly' }, el('code', {}, code)))))));
}

async function loadParser(metrics = null) {
  const [domCore, responseCore] = await Promise.all([
    fs.readFile(path.resolve('tools/chrome-bridge-extension/domParserCore.js'), 'utf8'),
    fs.readFile(path.resolve('tools/chrome-bridge-extension/responseParserCore.js'), 'utf8'),
  ]);
  const context = vm.createContext({
    Node: { ELEMENT_NODE, TEXT_NODE },
    CSS: { escape: (value) => String(value) },
    getComputedStyle: (element) => {
      if (metrics) metrics.computedStyleCalls = Number(metrics.computedStyleCalls || 0) + 1;
      return { display: element?.getAttribute?.('data-display') || 'block', visibility: 'visible', opacity: '1', position: 'static' };
    },
  });
  vm.runInContext(domCore, context, { filename: 'domParserCore.js' });
  vm.runInContext(responseCore, context, { filename: 'responseParserCore.js' });
  return context.ChatGptResponseParserCore;
}

test('response parser pass caches visibility and avoids repeated layout-style walks', async () => {
  const metrics = { computedStyleCalls: 0 };
  const parser = await loadParser(metrics);
  const root = el('div', { class: 'markdown' },
    ...Array.from({ length: 80 }, (_, index) => el('p', {}, `Paragraph ${index}`)),
    codeWidget('JavaScript', 'console.log(1);'),
    codeWidget('Python', 'print(1)', { run: true }));
  const pass = parser.createParserPass(root);
  const owners = Array.from(parser.collectCodeWidgetOwners(root, pass));
  assert.equal(owners.length, 2);
  for (const owner of owners) parser.inspectCodeWidget(owner, pass);
  parser.visibleTextLeafNodes(root, pass);
  const firstPassCalls = metrics.computedStyleCalls;
  for (const owner of owners) parser.inspectCodeWidget(owner, pass);
  parser.collectCodeWidgetOwners(root, pass);
  parser.visibleTextLeafNodes(root, pass);
  assert.equal(metrics.computedStyleCalls, firstPassCalls);
  assert.ok(firstPassCalls < 180, `expected cached style reads, got ${firstPassCalls}`);
});

test('DOM fixture parses outer code widgets and ignores nested CodeMirror pre elements', async () => {
  const parser = await loadParser();
  const javascript = codeWidget('JavaScript', 'const marker = "fixture";\nconsole.log(marker);');
  const python = codeWidget('Python', 'marker = "fixture"\nprint(marker)', { run: true });

  const javascriptOwners = Array.from(parser.collectCodeWidgetOwners(javascript));
  assert.equal(javascriptOwners.length, 1);
  assert.ok(javascriptOwners[0].contains(javascript.querySelector('code')));
  assert.notEqual(javascriptOwners[0], javascript.querySelector('pre.cm-content'));

  const js = parser.inspectCodeWidget(javascriptOwners[0]);
  assert.equal(js.language, 'javascript');
  assert.equal(js.confidence, 'high');
  assert.equal(js.contentSourceKind, 'codemirror-code');
  assert.equal(js.contentSource.textContent, 'const marker = "fixture";\nconsole.log(marker);');
  assert.deepEqual(Array.from(js.unknownChildren), []);
  assert.ok(Array.from(js.interfaceElements).some((item) => item.ariaLabel === 'Копировать'));

  const pythonOwners = Array.from(parser.collectCodeWidgetOwners(python));
  assert.equal(pythonOwners.length, 1);
  const py = parser.inspectCodeWidget(pythonOwners[0]);
  assert.equal(py.language, 'python');
  assert.equal(py.confidence, 'high');
  assert.equal(py.contentSourceKind, 'codemirror-code');
  assert.equal(py.contentSource.textContent, 'marker = "fixture"\nprint(marker)');
  assert.deepEqual(Array.from(py.unknownChildren), []);
  assert.ok(Array.from(py.interfaceElements).some((item) => item.ariaLabel === 'Запустить код'));
  assert.ok(!Array.from(py.warnings).includes('code_language_unresolved'));
});

test('DOM fixture exposes unclassified code-widget chrome instead of dropping it', async () => {
  const parser = await loadParser();
  const widget = codeWidget('Python', 'print(1)');
  widget.children[0].append(el('div', { class: 'future-chatgpt-control' }, 'New unknown control'));
  const parsed = parser.inspectCodeWidget(widget);
  assert.equal(parsed.language, 'python');
  assert.equal(parsed.unknownChildren.length, 1);
  assert.equal(parsed.unknownChildren[0].text, 'New unknown control');
  assert.ok(Array.from(parsed.warnings).includes('unclassified_code_widget_chrome'));
});


test('DOM fixture falls back to an editor pre when a future widget omits the code element', async () => {
  const parser = await loadParser();
  const widget = el('div', { class: 'code-block-shell' },
    el('div', { class: 'code-toolbar' }, el('span', {}, 'Rust'), el('button', { 'aria-label': 'Copy code' })),
    el('div', { class: 'cm-editor' }, el('pre', { class: 'cm-content readonly' }, 'fn main() {\n    println!("ok");\n}')));
  const parsed = parser.inspectCodeWidget(widget);
  assert.equal(parsed.language, 'rust');
  assert.equal(parsed.contentSourceKind, 'codemirror-pre');
  assert.equal(parsed.contentSource.textContent, 'fn main() {\n    println!("ok");\n}');
  assert.deepEqual(Array.from(parsed.unknownChildren), []);
});

test('DOM fixture selects a legacy wrapper that owns a sibling toolbar and plain pre', async () => {
  const parser = await loadParser();
  const wrapper = el('div', { class: 'legacy-code-wrapper' },
    el('div', { class: 'code-toolbar' }, el('span', {}, 'TypeScript'), el('button', { 'aria-label': 'Copy code' })),
    el('pre', {}, el('code', {}, 'const value: number = 1;')));
  const owners = Array.from(parser.collectCodeWidgetOwners(wrapper));
  assert.equal(owners.length, 1);
  assert.equal(owners[0], wrapper);
  const parsed = parser.inspectCodeWidget(owners[0]);
  assert.equal(parsed.language, 'typescript');
  assert.equal(parsed.code, undefined);
  assert.equal(parsed.contentSource.textContent, 'const value: number = 1;');
  assert.deepEqual(Array.from(parsed.unknownChildren), []);
});
