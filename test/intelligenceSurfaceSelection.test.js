import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const FIXTURE = path.resolve('test/fixtures/chat-dom/captured/sidebar-exclusion/model-effort-surfaces.html');

function element({ surface = 'main', inTurn = false, signal = '', rect = null } = {}) {
  return {
    nodeType: 1,
    signal,
    parentElement: null,
    hasAttribute(name) { return name === 'aria-expanded'; },
    getAttribute(name) {
      if (name === 'aria-haspopup') return 'menu';
      if (name === 'aria-expanded') return 'false';
      if (name === 'aria-controls') return '';
      return '';
    },
    closest(selector) {
      if (selector === '[data-turn], [data-message-author-role]') return inTurn ? this : null;
      if (selector === 'form') return null;
      if (surface === 'sidebar' && /data-sidebar-item|sidebar-header|history|accounts-profile-button|scrolled-from-end/.test(selector)) return this;
      if (surface === 'panel' && selector.includes('chatgpt-bridge-panel-root')) return this;
      return null;
    },
    getBoundingClientRect() {
      return rect || { left: 0, right: 100, top: 0, bottom: 40, width: 100, height: 40 };
    },
  };
}

async function loadRuntime({ roots, composer, composerRoot }) {
  const context = {
    Node: { ELEMENT_NODE: 1 },
    window: { getComputedStyle: () => ({ visibility: 'visible', display: 'block', contentVisibility: 'visible', opacity: '1' }) },
    document: {
      body: { nodeType: 1 },
      querySelectorAll: () => [],
      getElementById: () => null,
    },
    globalThis: null,
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/domUtilities.js'), 'utf8'), context);
  vm.runInContext(await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/intelligenceCommands.js'), 'utf8'), context);
  const commands = context.ChatGptIntelligenceCommands.createIntelligenceCommands({
    DOM_PARSER: {},
    buttonSignalText: (candidate) => candidate.signal,
    delay: async () => {},
    diagnostic: () => {},
    findComposer: () => composer,
    findComposerRootStrict: () => composerRoot,
    isPrimaryChatSurfaceElement: context.ChatGptDomUtilities.isPrimaryChatSurfaceElement,
    isUsableButton: () => true,
    isVisible: () => true,
    normalizeComparable: (value) => String(value || '').toLowerCase().replace(/\s+/g, ''),
    normalizeText: (value) => String(value || '').trim(),
    send: () => {},
    unique: (values) => [...new Set(values)],
    visibleText: (candidate) => candidate.signal,
  });
  return { commands, utilities: context.ChatGptDomUtilities };
}

test('captured sidebar evidence keeps model and effort discovery on the composer surface', async () => {
  const html = await fs.readFile(FIXTURE, 'utf8');
  assert.match(html, /data-sidebar-item="true"/);
  assert.match(html, /data-turn="assistant"/);
  assert.match(html, /id="composer-intelligence"/);
  assert.match(html, /id="chatgpt-bridge-panel-root"/);
  assert.doesNotMatch(html, /Alexander|akoreshnyak|6a5c/i, 'Captured selector evidence must stay sanitized');

  const sidebar = element({ surface: 'sidebar', signal: 'Change model' });
  const messageAction = element({ inTurn: true, signal: 'Change model' });
  const bridgePanel = element({ surface: 'panel', signal: 'ChatGPT Bridge' });
  const composerTrigger = element({ signal: 'Instant', rect: { left: 300, right: 390, top: 700, bottom: 740, width: 90, height: 40 } });
  const composer = element({ rect: { left: 250, right: 900, top: 650, bottom: 750, width: 650, height: 100 } });
  const candidates = [sidebar, messageAction, bridgePanel, composerTrigger];
  const composerRoot = {
    nodeType: 1,
    parentElement: null,
    contains: (candidate) => candidate === composerTrigger || candidate === composer,
    querySelectorAll: () => candidates,
  };
  composer.parentElement = composerRoot;
  composer.closest = (selector) => selector === 'form' ? composerRoot : null;

  const { commands, utilities } = await loadRuntime({ roots: [composerRoot], composer, composerRoot });
  assert.equal(utilities.isPrimaryChatSurfaceElement(sidebar), false);
  assert.equal(utilities.isPrimaryChatSurfaceElement(bridgePanel), false);
  assert.equal(utilities.isPrimaryChatSurfaceElement(composerTrigger), true);

  const discovered = commands.intelligencePickerTriggerCandidates();
  assert.deepEqual(Array.from(discovered, (item) => String(item.signal)), ['Instant']);
  assert.equal(commands.isComposerIntelligenceTriggerCandidate(messageAction, composer, composerRoot), false);
});
