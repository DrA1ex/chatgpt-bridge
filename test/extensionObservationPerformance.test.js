import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

async function loadClassicScript(file, globals = {}) {
  const source = await fs.readFile(path.resolve(file), 'utf8');
  const context = vm.createContext({ console, ...globals });
  vm.runInContext(source, context, { filename: path.basename(file) });
  return context;
}

function fakeElement(kind = 'peripheral') {
  const element = {
    nodeType: 1,
    parentElement: null,
    matches(selector = '') {
      return kind === 'turn' && /conversation-turn|section\[data-turn\]|data-message-author-role/.test(selector);
    },
    closest(selector = '') {
      if (kind === 'composer' && /prompt-textarea|contenteditable|composer|unified-composer|textarea/.test(selector)) return element;
      if ((kind === 'turn' || kind === 'turn-editor') && /conversation-turn|section\[data-turn\]|data-message-author-role/.test(selector)) return element;
      if (kind === 'turn-editor' && /contenteditable/.test(selector)) return element;
      return null;
    },
    querySelector: () => null,
  };
  return element;
}

const Node = Object.freeze({ ELEMENT_NODE: 1, TEXT_NODE: 3 });

test('observation mutation classifier ignores composer typing but keeps turn changes urgent', async () => {
  const context = await loadClassicScript('tools/chrome-bridge-extension/content/pageStatusRuntime.js', { Node });
  const factory = context.ChatGptPageStatusRuntime;
  const idleClassifier = factory.createObservationMutationClassifier({ getActiveRequest: () => null });
  const composer = fakeElement('composer');
  const composerText = { nodeType: 3, parentElement: composer };
  const ignored = idleClassifier([{ type: 'characterData', target: composerText }]);
  assert.equal(ignored.ignore, true);
  assert.equal(ignored.reason, 'mutation.composer_ignored');

  const turn = fakeElement('turn');
  const relevant = idleClassifier([{ type: 'childList', target: turn, addedNodes: [], removedNodes: [] }]);
  assert.equal(relevant.ignore, false);
  assert.equal(relevant.reason, 'mutation.turn');
  assert.equal(relevant.delayMs, 60);

  const assistantEditor = idleClassifier([{ type: 'characterData', target: fakeElement('turn-editor') }]);
  assert.equal(assistantEditor.ignore, false, 'contenteditable output inside an assistant turn must remain observable');
  assert.equal(assistantEditor.reason, 'mutation.turn');

  const peripheral = idleClassifier([{ type: 'attributes', target: fakeElement('peripheral') }]);
  assert.equal(peripheral.ignore, false);
  assert.equal(peripheral.reason, 'mutation.peripheral');
  assert.equal(peripheral.delayMs, 180);

  const activeClassifier = factory.createObservationMutationClassifier({ getActiveRequest: () => ({ requestId: 'req-1' }) });
  assert.equal(activeClassifier([{ type: 'attributes', target: fakeElement('peripheral') }]).delayMs, 60);
});

test('always-on observer performs no parser read for composer-only mutation batches', async () => {
  let mutationListener = null;
  class FakeMutationObserver {
    constructor(listener) { mutationListener = listener; }
    observe() {}
    disconnect() {}
  }
  const pageContext = await loadClassicScript('tools/chrome-bridge-extension/content/pageStatusRuntime.js', { Node });
  const classifier = pageContext.ChatGptPageStatusRuntime.createObservationMutationClassifier({ getActiveRequest: () => null });
  const observerContext = await loadClassicScript('tools/chrome-bridge-extension/observation/tabObserver.js', {
    Node,
    MutationObserver: FakeMutationObserver,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    Date,
    Math,
    performance,
  });

  let reads = 0;
  const observer = observerContext.ChatGptTabObserver.createTabObserver({
    MutationObserver: FakeMutationObserver,
    pollMs: 100_000,
    settleMs: 1,
    stabilityMilestones: [5_000],
    classifyMutations: classifier,
    resolveRoot: () => ({ tagName: 'MAIN', getAttribute: () => '' }),
    read: () => { reads += 1; return { degraded: false, state: 'idle' }; },
    signature: (value) => JSON.stringify(value),
    emit: () => {},
  });
  observer.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reads, 1);

  const composer = fakeElement('composer');
  mutationListener?.([{ type: 'characterData', target: { nodeType: 3, parentElement: composer } }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reads, 1, 'typing in the composer must not start a full observation parser pass');
  assert.equal(observer.metrics().ignoredMutationBatches, 1);

  mutationListener?.([{ type: 'childList', target: fakeElement('turn'), addedNodes: [], removedNodes: [] }]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(reads, 2, 'conversation changes must still be observed');
  observer.stop();
});

test('normal observation hot path avoids historic recovery scans and DOM source cloning', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/turnSnapshots.js'), 'utf8');
  const latestStart = source.indexOf('function findLatestAssistantTurn(index = 1)');
  const latestEnd = source.indexOf('function readLatestAssistantSnapshot', latestStart);
  assert.ok(latestStart >= 0 && latestEnd > latestStart);
  const latestBody = source.slice(latestStart, latestEnd);
  assert.doesNotMatch(latestBody, /readRecoverySnapshots/, 'ordinary observations must not scan historic recovery candidates');
  assert.match(latestBody, /for \(let turnIndex = turns\.length - 1;/);
  assert.match(source, /document\.querySelectorAll\(TURN_SELECTOR\)/, 'turn discovery should use one document-ordered selector pass');
  assert.doesNotMatch(source, /for \(const selector of selectors\)/, 'turn discovery must not rescan the document once per selector');
  assert.match(source, /if \(meta\.captureSourceHtml\) parserAudit\.sourceHtml = safeOuterHtml/);
  assert.doesNotMatch(source, /phase === DOM_PARSER\.PHASE\.ASSISTANT_FINAL \|\| meta\.captureSourceHtml/,
    'normal final observations must not clone and sanitize the response DOM');
});


test('explicit response recovery may scan history without putting recovery work on the observation hot path', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/responseRecovery.js'), 'utf8');
  assert.match(source, /readRecentAssistantSnapshots\(index\)\[index - 1\] \|\| readLatestAssistantSnapshot\(index\)/);
});
