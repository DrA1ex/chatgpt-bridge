import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const noop = () => {};

function createClassList() {
  const values = new Set();
  return {
    add: (...items) => items.forEach((item) => values.add(String(item))),
    remove: (...items) => items.forEach((item) => values.delete(String(item))),
    toggle: (item, force) => {
      const value = String(item);
      if (force === true) { values.add(value); return true; }
      if (force === false) { values.delete(value); return false; }
      if (values.has(value)) { values.delete(value); return false; }
      values.add(value); return true;
    },
    contains: (item) => values.has(String(item)),
    toString: () => Array.from(values).join(' '),
  };
}

function createElement(tagName = 'div') {
  const attributes = new Map();
  const classList = createClassList();
  const element = {
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    textContent: '',
    innerText: '',
    innerHTML: '',
    outerHTML: `<${String(tagName).toLowerCase()}></${String(tagName).toLowerCase()}>`,
    hidden: false,
    disabled: false,
    isConnected: true,
    childNodes: [],
    children: [],
    dataset: {},
    style: {},
    classList,
    attributes: [],
    parentElement: null,
    nextElementSibling: null,
    previousElementSibling: null,
    firstElementChild: null,
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    hasAttribute(name) { return attributes.has(name); },
    setAttribute(name, value) {
      attributes.set(String(name), String(value));
      this.attributes = Array.from(attributes, ([attributeName, attributeValue]) => ({ name: attributeName, value: attributeValue }));
    },
    removeAttribute(name) { attributes.delete(String(name)); },
    matches: () => false,
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    appendChild(child) { this.childNodes.push(child); return child; },
    append: noop,
    prepend: noop,
    remove: noop,
    click: noop,
    focus: noop,
    blur: noop,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 }),
    scrollIntoView: noop,
    cloneNode: () => createElement(tagName),
  };
  return new Proxy(element, {
    get(target, property) {
      if (property in target) return target[property];
      if (typeof property === 'symbol') return undefined;
      return noop;
    },
  });
}

function createSandbox() {
  const document = {
    readyState: 'complete',
    title: 'ChatGPT',
    documentElement: createElement('html'),
    body: createElement('body'),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement,
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text), parentElement: null }),
    addEventListener: noop,
    removeEventListener: noop,
  };
  const port = {
    postMessage: noop,
    disconnect: noop,
    onMessage: { addListener: noop },
    onDisconnect: { addListener: noop },
  };
  const chrome = {
    runtime: {
      id: 'bootstrap-test-extension',
      getManifest: () => ({ version: '2.0.0' }),
      connect: () => port,
      sendMessage: (_message, callback) => callback?.({ ok: true }),
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };
  const location = new URL('https://chatgpt.com/');
  const window = {
    top: null,
    self: null,
    location,
    addEventListener: noop,
    removeEventListener: noop,
    postMessage: noop,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', contentVisibility: 'visible', opacity: '1' }),
    innerWidth: 1280,
    innerHeight: 720,
  };
  window.top = window;
  window.self = window;
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Blob,
    Response,
    Request,
    Headers,
    AbortController,
    crypto: globalThis.crypto,
    structuredClone,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    window,
    unsafeWindow: window,
    document,
    location,
    history: { state: null, pushState: noop, replaceState: noop },
    navigator: { userAgent: 'extension-bootstrap-test', clipboard: { writeText: async () => {} } },
    chrome,
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    HTMLElement: class {},
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 },
    Event: class {},
    MouseEvent: class {},
    KeyboardEvent: class {},
    getComputedStyle: window.getComputedStyle,
    fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    setTimeout: () => 1,
    clearTimeout: noop,
    setInterval: () => 1,
    clearInterval: noop,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: noop,
    queueMicrotask: noop,
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    performance: { now: () => 0 },
    DOMParser: class { parseFromString() { return document; } },
    FormData: class {},
    File: class {},
    FileReader: class {},
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  Object.assign(window, {
    document,
    chrome,
    history: sandbox.history,
    navigator: sandbox.navigator,
    MutationObserver: sandbox.MutationObserver,
    ResizeObserver: sandbox.ResizeObserver,
    IntersectionObserver: sandbox.IntersectionObserver,
    setTimeout: sandbox.setTimeout,
    clearTimeout: sandbox.clearTimeout,
    setInterval: sandbox.setInterval,
    clearInterval: sandbox.clearInterval,
    requestAnimationFrame: sandbox.requestAnimationFrame,
    cancelAnimationFrame: sandbox.cancelAnimationFrame,
    fetch: sandbox.fetch,
    sessionStorage: sandbox.sessionStorage,
    localStorage: sandbox.localStorage,
  });
  return sandbox;
}

export async function bootstrapExtensionContentRuntime(root = path.resolve('tools/chrome-bridge-extension')) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts.find((entry) => entry.world !== 'MAIN')?.js || [];
  const sandbox = createSandbox();
  const context = vm.createContext(sandbox);
  for (const file of scripts) {
    if (file === 'content.js') {
      const factory = sandbox.ChatGptPageRuntimeObservers;
      sandbox.ChatGptPageRuntimeObservers = Object.freeze({
        ...factory,
        createPageRuntimeObservers(dependencies) {
          return { ...factory.createPageRuntimeObservers(dependencies), start() {} };
        },
      });
    }
    const source = await fs.readFile(path.join(root, file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }
  return { manifest, scripts, sandbox };
}
