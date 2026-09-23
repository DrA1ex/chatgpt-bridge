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

async function loadRuntime({
  roots,
  composer,
  composerRoot,
  documentQueries = {},
  delay = async () => {},
  isVisible = () => true,
}) {
  const context = {
    Node: { ELEMENT_NODE: 1 },
    window: { getComputedStyle: () => ({ visibility: 'visible', display: 'block', contentVisibility: 'visible', opacity: '1' }) },
    document: {
      body: { nodeType: 1 },
      querySelectorAll: documentQueries.querySelectorAll || (() => []),
      getElementById: documentQueries.getElementById || (() => null),
    },
    globalThis: null,
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/domUtilities.js'), 'utf8'), context);
  vm.runInContext(await fs.readFile(path.resolve('tools/chrome-bridge-extension/artifactParserCore.js'), 'utf8'), context);
  vm.runInContext(await fs.readFile(path.resolve('tools/chrome-bridge-extension/domParserCore.js'), 'utf8'), context);
  vm.runInContext(await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/intelligenceCommands.js'), 'utf8'), context);
  const commands = context.ChatGptIntelligenceCommands.createIntelligenceCommands({
    DOM_PARSER: context.ChatGptDomParserCore,
    buttonSignalText: (candidate) => candidate.signal,
    delay,
    diagnostic: () => {},
    findComposer: () => composer,
    findComposerRootStrict: () => composerRoot,
    isPrimaryChatSurfaceElement: context.ChatGptDomUtilities.isPrimaryChatSurfaceElement,
    isUsableButton: () => true,
    isVisible,
    normalizeComparable: (value) => String(value || '').toLowerCase().replace(/\s+/g, ''),
    normalizeText: (value) => String(value || '').trim(),
    send: () => {},
    unique: (values) => [...new Set(values)],
    visibleText: (candidate) => candidate.signal,
  });
  return { commands, utilities: context.ChatGptDomUtilities };
}

test('captured empty-home Russian fixture keeps localized effort and voice-only idle composer evidence', async () => {
  const html = await fs.readFile(path.resolve('test/fixtures/chat-dom/empty-home-effort-ru.html'), 'utf8');
  assert.match(html, /data-type="unified-composer"/);
  assert.match(html, />Высокий</);
  assert.match(html, /aria-label="Запустить голосовой режим"/);
  assert.match(html, /data-testid="composer-model-picker-slider-simple-view"/);
  assert.match(html, /role="slider"/);
  assert.equal((html.match(/class="effort-tick"/g) || []).length, 3);
  assert.doesNotMatch(html, /data-testid="send-button"/);
});

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

test('current Radix intelligence menu is discovered through its composer trigger without the legacy test id', async () => {
  const composer = element({ rect: { left: 250, right: 900, top: 650, bottom: 750, width: 650, height: 100 } });
  const trigger = element({ signal: 'High', rect: { left: 300, right: 390, top: 700, bottom: 740, width: 90, height: 40 } });
  trigger.id = 'radix-effort-trigger';
  trigger.getAttribute = (name) => {
    if (name === 'aria-haspopup') return 'menu';
    if (name === 'aria-expanded') return 'true';
    if (name === 'aria-controls') return '';
    return '';
  };
  const radio = element({ signal: 'High' });
  radio.getAttribute = (name) => name === 'role' ? 'menuitemradio' : name === 'aria-checked' ? 'true' : '';
  const model = element({ signal: 'GPT-5.6 Sol' });
  model.getAttribute = (name) => name === 'role' ? 'menuitem' : name === 'aria-haspopup' ? 'menu' : '';
  model.hasAttribute = (name) => name === 'data-has-submenu';
  const menu = element({ signal: 'Intelligence High GPT-5.6 Sol' });
  menu.getAttribute = (name) => {
    if (name === 'role') return 'menu';
    if (name === 'data-state') return 'open';
    if (name === 'aria-labelledby') return trigger.id;
    return '';
  };
  menu.querySelector = (selector) => selector === '[role="menuitemradio"]' ? radio
    : selector === '[role="menuitem"][data-has-submenu], [role="menuitem"][aria-haspopup="menu"]' ? model
      : null;
  menu.querySelectorAll = (selector) => selector === '[role="menuitemradio"]' ? [radio] : [];
  menu.closest = (selector) => selector === '[role="menu"]' ? menu : null;

  const composerRoot = {
    nodeType: 1,
    parentElement: null,
    contains: (candidate) => candidate === trigger || candidate === composer,
    querySelectorAll: () => [trigger],
  };
  composer.parentElement = composerRoot;
  composer.closest = (selector) => selector === 'form' ? composerRoot : null;

  const { commands } = await loadRuntime({
    roots: [composerRoot],
    composer,
    composerRoot,
    documentQueries: {
      querySelectorAll: (selector) => selector.includes('[role="menu"]') ? [menu] : [],
      getElementById: (id) => id === trigger.id ? trigger : null,
    },
  });

  assert.equal(commands.visibleIntelligencePickerContent(), menu);
});

test('empty-home Russian effort pill is recognized as the current slider trigger', async () => {
  const composer = element({ rect: { left: 250, right: 900, top: 650, bottom: 750, width: 650, height: 100 } });
  const trigger = element({ signal: 'Высокий', rect: { left: 700, right: 790, top: 700, bottom: 740, width: 90, height: 40 } });
  trigger.id = 'radix-empty-home-effort';
  trigger.getAttribute = (name) => {
    if (name === 'aria-haspopup') return 'menu';
    if (name === 'aria-expanded') return 'true';
    return '';
  };
  trigger.querySelectorAll = () => [];
  const slider = element();
  const menu = element({ signal: 'Power' });
  menu.getAttribute = (name) => name === 'role' ? 'menu' : '';
  menu.querySelector = (selector) => (
    selector === '[role="slider"], [data-testid="composer-model-picker-slider-simple-view"]' ? slider : null
  );
  menu.closest = (selector) => selector === '[role="menu"]' ? menu : null;

  const composerRoot = {
    nodeType: 1,
    parentElement: null,
    contains: (candidate) => candidate === trigger || candidate === composer,
    querySelectorAll: () => [trigger],
  };
  composer.parentElement = composerRoot;
  composer.closest = (selector) => selector === 'form' ? composerRoot : null;

  const { commands } = await loadRuntime({
    roots: [composerRoot],
    composer,
    composerRoot,
    documentQueries: {
      querySelectorAll: (selector) => selector.includes('[role="menu"]') ? [menu] : [],
      getElementById: () => null,
    },
  });

  const candidates = commands.intelligencePickerTriggerCandidates();
  assert.equal(candidates[0]?.element, trigger);
  assert.equal(commands.visibleIntelligencePickerContent(), menu);
  assert.equal(commands.intelligencePickerTriggerForContent(menu), trigger);
});

test('empty-home English effort pill is recognized without legacy effort test ids', async () => {
  const composer = element({ rect: { left: 250, right: 900, top: 650, bottom: 750, width: 650, height: 100 } });
  const trigger = element({ signal: 'High', rect: { left: 700, right: 790, top: 700, bottom: 740, width: 90, height: 40 } });
  trigger.getAttribute = (name) => {
    if (name === 'aria-haspopup') return 'menu';
    if (name === 'aria-expanded') return 'false';
    return '';
  };
  trigger.querySelectorAll = () => [];

  const composerRoot = {
    nodeType: 1,
    parentElement: null,
    contains: (candidate) => candidate === trigger || candidate === composer,
    querySelectorAll: () => [trigger],
  };
  composer.parentElement = composerRoot;
  composer.closest = (selector) => selector === 'form' ? composerRoot : null;

  const { commands } = await loadRuntime({ roots: [composerRoot], composer, composerRoot });
  const candidates = commands.intelligencePickerTriggerCandidates();
  assert.equal(candidates[0]?.element, trigger);
  assert.ok(candidates[0]?.score >= 70);
});

test('current slider picker finds the embedded model-view toggle without submenu attributes', async () => {
  const composer = element();
  const composerRoot = { nodeType: 1, parentElement: null, contains: () => true, querySelectorAll: () => [] };
  const advancedView = element();
  const powerControl = element({ signal: 'Power' });
  powerControl.hasAttribute = () => false;
  powerControl.querySelector = (selector) => selector === '[role="slider"]' ? element() : null;
  const viewToggle = element({ signal: 'High' });
  viewToggle.hasAttribute = (name) => name === 'aria-expanded';
  viewToggle.getAttribute = (name) => name === 'aria-expanded' ? 'false' : '';
  viewToggle.querySelector = () => null;
  const picker = element();
  picker.querySelector = (selector) => selector === '[data-testid="composer-model-picker-slider-advanced-view"]' ? advancedView : null;
  picker.querySelectorAll = (selector) => selector === '[role="menuitem"]' ? [powerControl, viewToggle] : [];

  const { commands } = await loadRuntime({ roots: [composerRoot], composer, composerRoot });
  assert.equal(commands.modelSubmenuOpener(picker), viewToggle);
});

test('startup discovery waits for the intelligence control instead of opening an earlier attachment menu', async () => {
  const composer = element({ rect: { left: 250, right: 900, top: 650, bottom: 750, width: 650, height: 100 } });
  const attachment = element({ signal: 'Add files', rect: { left: 250, right: 290, top: 700, bottom: 740, width: 40, height: 40 } });
  const effort = element({ signal: 'High', rect: { left: 300, right: 390, top: 700, bottom: 740, width: 90, height: 40 } });
  let scans = 0;
  const composerRoot = {
    nodeType: 1,
    parentElement: null,
    contains: (candidate) => [composer, attachment, effort].includes(candidate),
    querySelectorAll: () => (++scans < 2 ? [attachment] : [attachment, effort]),
  };
  composer.parentElement = composerRoot;
  composer.closest = (selector) => selector === 'form' ? composerRoot : null;

  const { commands } = await loadRuntime({ roots: [composerRoot], composer, composerRoot });
  const candidates = await commands.waitForIntelligencePickerTriggerCandidates(500);

  assert.equal(candidates[0].element, effort);
  assert.ok(scans >= 2);
});

test('current Radix trigger opens through HTMLElement click before synthetic pointer fallbacks', async () => {
  const composer = element({ rect: { left: 250, right: 900, top: 650, bottom: 750, width: 650, height: 100 } });
  const trigger = element({ signal: 'High', rect: { left: 300, right: 390, top: 700, bottom: 740, width: 90, height: 40 } });
  trigger.id = 'radix-effort-trigger';
  let opened = false;
  trigger.getAttribute = (name) => {
    if (name === 'aria-haspopup') return 'menu';
    if (name === 'aria-expanded') return opened ? 'true' : 'false';
    return '';
  };
  trigger.click = () => { opened = true; };
  const radio = element({ signal: 'High' });
  const model = element({ signal: 'GPT-5.6 Sol' });
  const menu = element({ signal: 'High GPT-5.6 Sol' });
  menu.getAttribute = (name) => name === 'aria-labelledby' ? trigger.id : '';
  menu.querySelector = (selector) => selector === '[role="menuitemradio"]' ? radio
    : selector === '[role="menuitem"][data-has-submenu], [role="menuitem"][aria-haspopup="menu"]' ? model
      : null;

  const composerRoot = {
    nodeType: 1,
    parentElement: null,
    contains: (candidate) => candidate === trigger || candidate === composer,
    querySelectorAll: () => [trigger],
  };
  composer.parentElement = composerRoot;
  composer.closest = (selector) => selector === 'form' ? composerRoot : null;

  const { commands } = await loadRuntime({
    roots: [composerRoot],
    composer,
    composerRoot,
    documentQueries: {
      querySelectorAll: (selector) => selector.includes('[role="menu"]') && opened ? [menu] : [],
      getElementById: (id) => id === trigger.id ? trigger : null,
    },
  });

  assert.equal(await commands.openIntelligencePicker(), menu);
  assert.equal(opened, true);
});


test('model listing reads mounted inactive advanced-view options without opening it', async () => {
  const composer = element({ rect: { left: 250, right: 900, top: 650, bottom: 750, width: 650, height: 100 } });
  const trigger = element({ signal: 'Высокий', rect: { left: 700, right: 790, top: 700, bottom: 740, width: 90, height: 40 } });
  trigger.id = 'radix-intelligence-trigger';
  trigger.getAttribute = (name) => {
    if (name === 'aria-haspopup') return 'menu';
    if (name === 'aria-expanded') return 'true';
    return '';
  };

  const toggle = element({ signal: 'Высокий' });
  toggle.hasAttribute = (name) => name === 'aria-expanded';
  toggle.getAttribute = (name) => name === 'aria-expanded' ? 'false' : '';
  let toggleClicks = 0;
  toggle.click = () => { toggleClicks += 1; };
  toggle.querySelector = () => null;

  function radio(label, selected, { hidden = false } = {}) {
    const item = element({ signal: label });
    item.hidden = hidden;
    item.innerText = label;
    item.textContent = label;
    item.children = [];
    item.querySelectorAll = () => [];
    item.getAttribute = (name) => {
      if (name === 'aria-checked') return selected ? 'true' : 'false';
      if (name === 'data-state') return selected ? 'checked' : 'unchecked';
      return '';
    };
    return item;
  }

  const sol = radio('GPT-5.6 Sol', true, { hidden: true });
  const legacy = radio('GPT-5.5', false, { hidden: true });
  const advanced = element();
  advanced.hidden = true;
  advanced.hasAttribute = (name) => name === 'inert';
  advanced.getAttribute = (name) => name === 'data-active' ? 'false' : '';
  advanced.querySelector = (selector) => selector === '[role="menuitemradio"]' ? sol : null;
  advanced.querySelectorAll = (selector) => selector === '[role="menuitemradio"]' ? [sol, legacy] : [];

  const slider = element();
  slider.getAttribute = (name) => {
    if (name === 'aria-valuenow') return '2';
    if (name === 'role') return 'slider';
    return '';
  };
  slider.closest = (selector) => selector === '[aria-disabled]' ? sliderRoot
    : selector === '[role="menuitem"]' ? sliderControl
      : null;
  const ticks = [0, 1, 2].map((index) => {
    const tick = element({ rect: {
      left: 10 + (index * 40), right: 14 + (index * 40),
      top: 10, bottom: 14, width: 4, height: 4,
    } });
    tick.children = [];
    return tick;
  });
  const sliderRoot = element({ rect: { left: 0, right: 100, top: 0, bottom: 24, width: 100, height: 24 } });
  sliderRoot.querySelectorAll = (selector) => selector === 'span' ? ticks : [];
  const sliderControl = element({ signal: 'Power' });
  const simple = element();
  simple.querySelector = (selector) => selector === '[role="slider"]' ? slider : null;

  const picker = element({ signal: 'Высокий Power GPT-5.6 Sol GPT-5.5' });
  picker.children = [];
  picker.getAttribute = (name) => name === 'role' ? 'group' : '';
  picker.querySelector = (selector) => {
    if (selector === '[data-testid="composer-model-picker-slider-advanced-view"]') return advanced;
    if (selector === '[data-testid="composer-model-picker-slider-simple-view"]') return simple;
    return null;
  };
  picker.querySelectorAll = (selector) => {
    if (selector === '[role="menuitem"]') return [toggle, sliderControl];
    if (selector === '[role="menuitemradio"]') return [sol, legacy];
    return [];
  };
  picker.closest = (selector) => selector === '[role="menu"]' ? menu : null;

  const menu = element({ signal: picker.signal });
  menu.getAttribute = (name) => {
    if (name === 'role') return 'menu';
    if (name === 'aria-labelledby') return trigger.id;
    return '';
  };
  menu.querySelector = (selector) => {
    if (selector.includes('[role="slider"]')) return slider;
    return null;
  };

  const composerRoot = {
    nodeType: 1,
    parentElement: null,
    contains: (candidate) => candidate === trigger || candidate === composer,
    querySelectorAll: () => [trigger],
  };
  composer.parentElement = composerRoot;
  composer.closest = (selector) => selector === 'form' ? composerRoot : null;

  const { commands } = await loadRuntime({
    roots: [composerRoot],
    composer,
    composerRoot,
    isVisible: (candidate) => !candidate?.hidden,
    documentQueries: {
      querySelectorAll: (selector) => {
        if (selector === '[data-testid="composer-intelligence-picker-content"]') return [picker];
        if (selector.includes('[role="menu"]')) return [menu];
        return [];
      },
      getElementById: (id) => id === trigger.id ? trigger : null,
    },
  });

  const state = await commands.readIntelligenceState({ includeModels: true });
  assert.deepEqual(Array.from(state.models, (model) => model.label), ['GPT-5.6 Sol', 'GPT-5.5']);
  assert.equal(state.selectedModel?.label, 'GPT-5.6 Sol');
  assert.equal(state.selectedEffort?.id, 'high');
  assert.equal(toggleClicks, 0, 'read-only model discovery must not open an already mounted inactive advanced view');
});
