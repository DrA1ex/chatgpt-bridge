import test from 'node:test';
import assert from 'node:assert/strict';
import { findFreeIdentifiers } from '../scripts/source-scope-check.js';

test('source scope check reports unresolved identifiers inside deferred functions', () => {
  const unresolved = findFreeIdentifiers(`
    (() => {
      function collect() { return missingDependency(); }
      globalThis.example = collect;
    })();
  `, 'tools/chrome-bridge-extension/content/example.js');
  assert.deepEqual(unresolved.map((item) => item.name), ['missingDependency']);
});

test('source scope check accepts imports, lexical declarations, browser globals, and explicit factory dependencies', () => {
  const unresolved = findFreeIdentifiers(`
    import value from './value.js';
    (() => {
      function createFeature({ isUsableButton }) {
        return (element) => isUsableButton(element) && document.contains(element) && Boolean(value);
      }
      globalThis.Feature = { createFeature };
    })();
  `, 'tools/chrome-bridge-extension/content/example.js');
  assert.deepEqual(unresolved, []);
});
