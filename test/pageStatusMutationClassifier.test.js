import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

async function loadClassifier() {
  const source = await fs.readFile(
    path.resolve('tools/chrome-bridge-extension/content/pageStatusRuntime.js'),
    'utf8',
  );
  const context = vm.createContext({
    console,
    Node: { ELEMENT_NODE: 1 },
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'pageStatusRuntime.js' });
  return context.ChatGptPageStatusRuntime.createObservationMutationClassifier;
}

function element({ matches = [], closest = [], query = [] } = {}) {
  const matchSet = new Set(matches);
  const closestSet = new Set(closest);
  const querySet = new Set(query);
  return {
    nodeType: 1,
    parentElement: null,
    matches(selector) {
      return matchSet.has(selector);
    },
    closest(selector) {
      return closestSet.has(selector) ? this : null;
    },
    querySelector(selector) {
      return querySet.has(selector) ? {} : null;
    },
  };
}

test('active request composer control mutations are observed immediately', async () => {
  const createClassifier = await loadClassifier();
  const classify = createClassifier({ getActiveRequest: () => ({ requestId: 'request-1' }) });
  const composer = element({
    closest: ['#prompt-textarea,textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[data-testid="composer"],[data-testid*="composer" i],form[data-type="unified-composer"]'],
  });
  const stopButton = element({ matches: ['button, [role="button"]'] });
  stopButton.parentElement = composer;

  const result = classify([{
    target: composer,
    addedNodes: [],
    removedNodes: [stopButton],
  }]);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ignore: false,
    reason: 'mutation.active_request_control',
    delayMs: 60,
  });
});

test('ordinary composer mutations remain ignored during an active request', async () => {
  const createClassifier = await loadClassifier();
  const classify = createClassifier({ getActiveRequest: () => ({ requestId: 'request-1' }) });
  const composer = element({
    closest: ['#prompt-textarea,textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[data-testid="composer"],[data-testid*="composer" i],form[data-type="unified-composer"]'],
  });
  const textNode = { nodeType: 3, parentElement: composer };

  const result = classify([{
    target: textNode,
    addedNodes: [],
    removedNodes: [],
  }]);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ignore: true,
    reason: 'mutation.composer_ignored',
  });
});
