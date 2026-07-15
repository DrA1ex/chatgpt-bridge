import fs from 'node:fs/promises';
import vm from 'node:vm';

const COMMON_GLOBALS = new Set([
  'AggregateError', 'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array', 'BigUint64Array',
  'Blob', 'Boolean', 'CompressionStream', 'DataView', 'Date', 'DecompressionStream', 'DOMException',
  'Error', 'EvalError', 'File', 'FinalizationRegistry', 'Float32Array', 'Float64Array', 'FormData',
  'Headers', 'Infinity', 'Int16Array', 'Int32Array', 'Int8Array', 'Intl', 'JSON', 'Map', 'Math',
  'MessageChannel', 'NaN', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError', 'ReadableStream',
  'ReferenceError', 'Reflect', 'RegExp', 'Request', 'Response', 'Set', 'SharedArrayBuffer', 'String',
  'Symbol', 'SyntaxError', 'TextDecoder', 'TextEncoder', 'TransformStream', 'TypeError', 'URIError',
  'URL', 'URLSearchParams', 'Uint16Array', 'Uint32Array', 'Uint8Array', 'Uint8ClampedArray', 'WeakMap',
  'WeakRef', 'WeakSet', 'WebAssembly', 'WebSocket', 'WritableStream', 'AbortController', 'AbortSignal',
  'atob', 'btoa', 'clearInterval', 'clearTimeout', 'console', 'crypto', 'decodeURI', 'decodeURIComponent',
  'encodeURI', 'encodeURIComponent', 'escape', 'fetch', 'globalThis', 'isFinite', 'isNaN', 'parseFloat',
  'parseInt', 'performance', 'queueMicrotask', 'setInterval', 'setTimeout', 'structuredClone', 'undefined',
  'unescape',
]);

const NODE_GLOBALS = new Set([
  'Buffer', '__dirname', '__filename', 'clearImmediate', 'exports', 'global', 'module', 'process',
  'require', 'setImmediate',
]);

const BROWSER_GLOBALS = new Set([
  'BroadcastChannel', 'CSS', 'CSSStyleSheet', 'ClipboardEvent', 'CloseEvent', 'CustomEvent',
  'DOMParser', 'DataTransfer', 'Event', 'EventTarget', 'FileReader', 'FocusEvent', 'HTMLAnchorElement',
  'HTMLButtonElement', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLOptionElement',
  'HTMLSelectElement', 'HTMLTextAreaElement', 'InputEvent', 'IntersectionObserver', 'KeyboardEvent',
  'MessageEvent', 'MouseEvent', 'MutationObserver', 'Node', 'NodeFilter', 'PointerEvent', 'ResizeObserver',
  'XMLHttpRequest', 'XMLSerializer', 'alert', 'cancelAnimationFrame', 'cancelIdleCallback', 'chrome',
  'confirm', 'document', 'frames', 'getComputedStyle', 'history', 'indexedDB', 'localStorage', 'location',
  'navigator', 'open', 'parent', 'prompt', 'requestAnimationFrame', 'requestIdleCallback', 'screen',
  'self', 'sessionStorage', 'top', 'window',
]);

class Scope {
  constructor(parent, type) {
    this.parent = parent;
    this.type = type;
    this.declarations = new Set();
    this.references = [];
    this.children = [];
    if (parent) parent.children.push(this);
  }
}

function loadBundledAcorn() {
  const source = process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'];
  if (!source) throw new Error('Node.js bundled Acorn parser is unavailable');
  const parserModule = { exports: {} };
  const wrapper = vm.runInThisContext(
    `(function(exports, require, module, __filename, __dirname) { ${source}\n})`,
    { filename: 'node:internal/deps/acorn/acorn/dist/acorn' },
  );
  wrapper(parserModule.exports, () => { throw new Error('Unexpected bundled parser dependency'); }, parserModule, 'acorn.js', '.');
  return parserModule.exports;
}

const ACORN = loadBundledAcorn();

function functionScope(scope) {
  let current = scope;
  while (current && current.type !== 'function' && current.type !== 'program') current = current.parent;
  return current;
}

function declarePattern(pattern, scope) {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier': scope.declarations.add(pattern.name); break;
    case 'RestElement': declarePattern(pattern.argument, scope); break;
    case 'AssignmentPattern': declarePattern(pattern.left, scope); break;
    case 'ArrayPattern': pattern.elements.forEach((item) => declarePattern(item, scope)); break;
    case 'ObjectPattern':
      pattern.properties.forEach((property) => declarePattern(property.type === 'RestElement' ? property.argument : property.value, scope));
      break;
    default: break;
  }
}

function visitPatternDefaults(pattern, scope, visit) {
  if (!pattern) return;
  if (pattern.type === 'AssignmentPattern') visit(pattern.right, scope, pattern, 'right');
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((item) => visitPatternDefaults(item, scope, visit));
  else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      if (property.computed) visit(property.key, scope, property, 'key');
      visitPatternDefaults(property.type === 'RestElement' ? property.argument : property.value, scope, visit);
    }
  } else if (pattern.type === 'RestElement') visitPatternDefaults(pattern.argument, scope, visit);
}

function isReference(node, parent, property) {
  if (!parent) return true;
  if (parent.type === 'VariableDeclarator' && property === 'id') return false;
  if (/Function/.test(parent.type) && (property === 'id' || property === 'params')) return false;
  if ((parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') && property === 'id') return false;
  if (/^Import/.test(parent.type) || (parent.type === 'CatchClause' && property === 'param')) return false;
  if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && property === 'property' && !parent.computed) return false;
  if (parent.type === 'Property' && property === 'key' && !parent.computed) return false;
  if ((parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && property === 'key' && !parent.computed) return false;
  if (parent.type === 'ExportSpecifier' && property === 'exported') return false;
  if (parent.type === 'LabeledStatement' && property === 'label') return false;
  if ((parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') && property === 'label') return false;
  return true;
}

function buildScopeTree(ast) {
  const root = new Scope(null, 'program');

  function visit(node, scope, parent = null, property = null) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'Program': node.body.forEach((item) => visit(item, scope, node, 'body')); return;
      case 'ImportDeclaration': node.specifiers.forEach((item) => scope.declarations.add(item.local.name)); return;
      case 'ExportNamedDeclaration':
        if (node.declaration) visit(node.declaration, scope, node, 'declaration');
        else if (!node.source) node.specifiers.forEach((item) => visit(item.local, scope, item, 'local'));
        return;
      case 'ExportDefaultDeclaration': visit(node.declaration, scope, node, 'declaration'); return;
      case 'ExportAllDeclaration': return;
      case 'VariableDeclaration':
        for (const declaration of node.declarations) {
          declarePattern(declaration.id, node.kind === 'var' ? functionScope(scope) : scope);
          if (declaration.init) visit(declaration.init, scope, declaration, 'init');
        }
        return;
      case 'FunctionDeclaration': {
        if (node.id) scope.declarations.add(node.id.name);
        const child = new Scope(scope, 'function');
        child.declarations.add('arguments');
        if (node.id) child.declarations.add(node.id.name);
        node.params.forEach((parameter) => { declarePattern(parameter, child); visitPatternDefaults(parameter, child, visit); });
        visit(node.body, child, node, 'body');
        return;
      }
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        const child = new Scope(scope, 'function');
        if (node.type !== 'ArrowFunctionExpression') child.declarations.add('arguments');
        if (node.id) child.declarations.add(node.id.name);
        node.params.forEach((parameter) => { declarePattern(parameter, child); visitPatternDefaults(parameter, child, visit); });
        visit(node.body, child, node, 'body');
        return;
      }
      case 'BlockStatement': {
        const child = parent && /Function/.test(parent.type) ? scope : new Scope(scope, 'block');
        node.body.forEach((item) => visit(item, child, node, 'body'));
        return;
      }
      case 'ClassDeclaration':
      case 'ClassExpression': {
        if (node.type === 'ClassDeclaration' && node.id) scope.declarations.add(node.id.name);
        if (node.superClass) visit(node.superClass, scope, node, 'superClass');
        const child = new Scope(scope, 'class');
        if (node.id) child.declarations.add(node.id.name);
        visit(node.body, child, node, 'body');
        return;
      }
      case 'ClassBody': node.body.forEach((item) => visit(item, scope, node, 'body')); return;
      case 'MethodDefinition':
      case 'PropertyDefinition':
        if (node.computed) visit(node.key, scope, node, 'key');
        if (node.value) visit(node.value, scope, node, 'value');
        return;
      case 'StaticBlock': {
        const child = new Scope(scope, 'block');
        node.body.forEach((item) => visit(item, child, node, 'body'));
        return;
      }
      case 'CatchClause': {
        const child = new Scope(scope, 'block');
        declarePattern(node.param, child);
        visit(node.body, child, node, 'body');
        return;
      }
      case 'Identifier':
        if (isReference(node, parent, property)) scope.references.push({ name: node.name, line: node.loc.start.line, column: node.loc.start.column + 1 });
        return;
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        visit(node.object, scope, node, 'object');
        if (node.computed) visit(node.property, scope, node, 'property');
        return;
      case 'Property':
        if (node.computed) visit(node.key, scope, node, 'key');
        visit(node.value, scope, node, 'value');
        return;
      case 'LabeledStatement': visit(node.body, scope, node, 'body'); return;
      case 'BreakStatement':
      case 'ContinueStatement':
      case 'MetaProperty':
      case 'PrivateIdentifier': return;
      default:
        for (const [key, value] of Object.entries(node)) {
          if (['type', 'start', 'end', 'loc', 'range'].includes(key)) continue;
          if (Array.isArray(value)) value.forEach((item) => item?.type && visit(item, scope, node, key));
          else if (value?.type) visit(value, scope, node, key);
        }
    }
  }

  visit(ast, root);
  return root;
}

function allowedGlobalsFor(filePath) {
  const allowed = new Set(COMMON_GLOBALS);
  const normalized = String(filePath || '').replaceAll('\\', '/');
  const browserSource = normalized.includes('/tools/chrome-bridge-extension/') || normalized.startsWith('tools/chrome-bridge-extension/');
  for (const name of browserSource ? BROWSER_GLOBALS : NODE_GLOBALS) allowed.add(name);
  return allowed;
}

function collectUnresolved(scope, allowed, output = []) {
  for (const reference of scope.references) {
    let current = scope;
    let resolved = false;
    while (current) {
      if (current.declarations.has(reference.name)) { resolved = true; break; }
      current = current.parent;
    }
    if (!resolved && !allowed.has(reference.name)) output.push(reference);
  }
  scope.children.forEach((child) => collectUnresolved(child, allowed, output));
  return output;
}

export function findFreeIdentifiers(source, filePath = '') {
  let ast;
  try {
    ast = ACORN.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
  } catch {
    ast = ACORN.parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true });
  }
  return collectUnresolved(buildScopeTree(ast), allowedGlobalsFor(filePath));
}

export async function checkFileFreeIdentifiers(filePath) {
  const source = await fs.readFile(filePath, 'utf8');
  return findFreeIdentifiers(source, filePath);
}
