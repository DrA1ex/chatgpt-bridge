import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapExtensionContentRuntime } from './helpers/extensionContentRuntime.js';

function composerDependencies(overrides = {}) {
  return {
    CONFIG: {},
    DOM_PARSER: {
      userTurnMatchesExpectedText(actual, expected) {
        const a = String(actual || '').trim();
        const e = String(expected || '').trim();
        return !e || a === e || a.endsWith(`\n${e}`) || a.startsWith(`${e}\n`);
      },
    },
    conversationIdFromUrl() { return 'session'; },
    async delay() {},
    diagnostic() {},
    emitChatEvent() {},
    emitRequestProgress() {},
    getActiveRequest() { return null; },
    getTurnNodes() { return []; },
    isGenerating() { return false; },
    isPrimaryChatSurfaceElement() { return true; },
    isVisible() { return true; },
    normalizeComparable(value) { return String(value || '').trim(); },
    setRequestPhase() {},
    turnKey(_turn, index) { return `turn-${index}`; },
    turnRole() { return ''; },
    visibleText(node) { return String(node?.textContent || ''); },
    async waitForChatPageReady() {},
    ...overrides,
  };
}

test('composer steering refuses to synthesize Enter while ChatGPT exposes only the stop control', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  let submitCount = 0;
  const events = [];
  const form = {
    tagName: 'FORM',
    matches() { return false; },
    querySelectorAll() { return []; },
    closest() { return null; },
    requestSubmit() { submitCount += 1; },
  };
  const composer = {
    tagName: 'DIV',
    disabled: false,
    readOnly: false,
    parentElement: form,
    getAttribute() { return null; },
    closest(selector) { return selector === 'form' ? form : null; },
    querySelectorAll() { return []; },
    dispatchEvent(event) { events.push(event); return true; },
  };
  sandbox.document.querySelectorAll = (selector) => selector.includes('#prompt-textarea[contenteditable]') ? [composer] : [];

  const diagnostics = [];
  const commands = sandbox.ChatGptComposerCommands.createComposerCommands(composerDependencies({
    diagnostic(name, data) { diagnostics.push({ name, data }); },
  }));

  assert.throws(() => commands.submitComposer(composer, { requestId: 'steer-request' }, { kind: 'steer', attempt: 2 }), (error) => {
    assert.equal(error.code, 'STEER_SUBMIT_NOT_READY');
    assert.equal(error.provenNotExecuted, true);
    return true;
  });
  assert.equal(submitCount, 0);
  assert.equal(events.length, 0);
  assert.deepEqual(diagnostics.map((entry) => entry.name), ['send_button.not_found_steer_blocked']);
  assert.equal(diagnostics[0].data.kind, 'steer');
  assert.equal(diagnostics[0].data.attempt, 2);
});


test('composer steering observes the real send control without relying on hidden-tab timer polling', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  let mutationCallback = null;
  let sendReady = false;
  let clickCount = 0;
  sandbox.MutationObserver = class {
    constructor(callback) { mutationCallback = callback; }
    observe() {}
    disconnect() {}
  };
  const sendButton = {
    disabled: false,
    isConnected: true,
    getAttribute(name) { return name === 'data-testid' ? 'send-button' : null; },
    click() { clickCount += 1; },
  };
  const stopButton = {
    disabled: false,
    isConnected: true,
    getAttribute(name) {
      if (name === 'data-testid') return 'stop-button';
      if (name === 'aria-label') return 'Stop generating';
      return null;
    },
  };
  const form = {
    nodeType: 1,
    tagName: 'FORM',
    isConnected: true,
    matches() { return false; },
    closest() { return null; },
    querySelectorAll(selector) {
      if (selector.includes('send') || selector.includes('Send')) return sendReady ? [sendButton] : [];
      if (selector.includes('stop') || selector.includes('Stop')) return sendReady ? [] : [stopButton];
      if (selector === 'button, [role="button"]') return sendReady ? [sendButton] : [stopButton];
      return [];
    },
    contains(node) { return node === composer || node === sendButton || node === stopButton; },
  };
  const composer = {
    nodeType: 1,
    tagName: 'DIV', isConnected: true, isContentEditable: true, disabled: false, readOnly: false,
    parentElement: form,
    getAttribute(name) { if (name === 'contenteditable') return 'plaintext-only'; if (name === 'id') return 'prompt-textarea'; return null; },
    closest(selector) { return selector === 'form' ? form : null; },
    querySelectorAll() { return []; },
  };
  sandbox.document.querySelectorAll = (selector) => selector.includes('#prompt-textarea[contenteditable]') ? [composer] : [];
  const diagnostics = [];
  const commands = sandbox.ChatGptComposerCommands.createComposerCommands(composerDependencies({
    CONFIG: { steerSubmitReadyTimeoutMs: 5_000 },
    diagnostic(name, data) { diagnostics.push({ name, data }); },
  }));

  const pending = commands.waitForSteerSubmitButton({ requestId: 'steer-wait', options: {} });
  await Promise.resolve();
  assert.equal(typeof mutationCallback, 'function');
  sendReady = true;
  mutationCallback([{ type: 'childList' }]);
  const ready = await pending;
  assert.equal(ready.button, sendButton);
  const method = commands.submitComposer(composer, { requestId: 'steer-wait' }, { kind: 'steer', button: ready.button });
  assert.equal(method, 'button');
  assert.equal(clickCount, 1);
  assert.equal(diagnostics.some((entry) => entry.name === 'steer.submit.waiting'), true);
  assert.equal(diagnostics.some((entry) => entry.name === 'steer.submit.ready'), true);
});



test('modern plaintext-only composer and visible chat surface satisfy initial page readiness', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const hiddenMain = {
    nodeType: 1,
    tagName: 'MAIN',
    isConnected: true,
    hiddenForTest: true,
    contains() { return false; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getAttribute() { return null; },
  };
  const visibleMain = {
    nodeType: 1,
    tagName: 'MAIN',
    isConnected: true,
    contains(node) { return node === composer; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getAttribute() { return null; },
  };
  const composer = {
    nodeType: 1,
    tagName: 'DIV',
    isConnected: true,
    isContentEditable: true,
    disabled: false,
    readOnly: false,
    parentElement: visibleMain,
    getAttribute(name) {
      if (name === 'contenteditable') return 'plaintext-only';
      if (name === 'role') return 'textbox';
      if (name === 'id') return 'prompt-textarea';
      return null;
    },
    closest(selector) { return selector.includes('main') ? visibleMain : null; },
    querySelectorAll() { return []; },
  };
  sandbox.document.querySelectorAll = (selector) => {
    if (selector.includes('#prompt-textarea[contenteditable]')) return [composer];
    if (selector === 'main, [role="main"]') return [hiddenMain, visibleMain];
    return [];
  };

  const isVisible = (element) => element !== hiddenMain;
  const diagnostics = [];
  const commands = sandbox.ChatGptComposerCommands.createComposerCommands(composerDependencies({
    diagnostic(name, data) { diagnostics.push({ name, data }); },
    isVisible,
  }));
  assert.equal(commands.findComposer(), composer);
  assert.equal(commands.findChatMain(), visibleMain);

  const preparation = sandbox.ChatGptRequestPreparation.createRequestPreparation({
    CONFIG: { pageReadyTimeoutMs: 5_000, pageReadySettleMs: 150 },
    DOM_PARSER: {},
    INTELLIGENCE_UI_TIMING: {},
    async delay() {},
    diagnostic() {},
    emitChatEvent() {},
    findChatMain: commands.findChatMain,
    findComposer: commands.findComposer,
    isVisible,
    async openNewSession() {},
    async readIntelligenceState() { return null; },
    schedulePageStatus() {},
    async selectSessionById() {},
    send() {},
    async trySelectIntelligenceOption() { return null; },
  });
  const readiness = preparation.chatPageReadiness();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.chatMainReady, true);
  assert.equal(readiness.composerReady, true);
  assert.equal(readiness.composer, composer);
  assert.equal(readiness.url, 'https://chatgpt.com/');
  assert.equal(diagnostics.some((entry) => entry.name === 'dom_schema.composer_ambiguous'), false);
});

test('turn lookup honors the recorded index and otherwise chooses the newest duplicate React key', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const turns = [
    { id: 'old', key: 'duplicate-key' },
    { id: 'middle', key: 'other-key' },
    { id: 'new', key: 'duplicate-key' },
  ];
  const commands = sandbox.ChatGptComposerCommands.createComposerCommands(composerDependencies({
    getTurnNodes() { return turns; },
    turnKey(turn) { return turn.key; },
  }));

  assert.equal(commands.findTurnByKey('duplicate-key', 0), turns[0]);
  assert.equal(commands.findTurnByKey('duplicate-key', 99), turns[2]);
  assert.equal(commands.findTurnByKey('duplicate-key'), turns[2]);
});

test('artifact source lookup forwards both the stored turn key and turn index', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const calls = [];
  const expected = { id: 'source-turn' };
  const transfer = sandbox.ChatGptArtifactTransfer.createArtifactTransfer({
    isBrowserOnlyArtifactUrl() { return false; },
    isCurrentPageNavigationUrl() { return false; },
    findTurnByKey(key, index) { calls.push({ key, index }); return expected; },
  });

  const root = transfer.artifactSourceRoot({ sourceTurnKey: 'duplicate-key', sourceTurnIndex: 17 });
  assert.equal(root, expected);
  assert.deepEqual(calls, [{ key: 'duplicate-key', index: 17 }]);
});


test('prompt submission evidence is armed before click and resolves from a DOM mutation when timers are throttled', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  let mutationCallback = null;
  let observerArmed = false;
  let turns = [];
  sandbox.MutationObserver = class {
    constructor(callback) { mutationCallback = callback; }
    observe() { observerArmed = true; }
    disconnect() {}
  };
  sandbox.setTimeout = () => 1;
  sandbox.clearTimeout = () => {};
  sandbox.DataTransfer = class {
    constructor() { this.value = ''; }
    setData(_type, value) { this.value = String(value); }
  };
  sandbox.ClipboardEvent = class {
    constructor(type, options = {}) { this.type = type; this.clipboardData = options.clipboardData; }
  };
  sandbox.InputEvent = class { constructor(type) { this.type = type; } };

  const prompt = 'hidden tab prompt';
  const userTurn = { textContent: prompt };
  const sendButton = {
    disabled: false,
    isConnected: true,
    getAttribute(name) { return name === 'data-testid' ? 'send-button' : null; },
    click() {
      assert.equal(observerArmed, true, 'submission observer must be armed before the physical click');
      turns = [userTurn];
      mutationCallback([{ type: 'childList' }]);
    },
  };
  const form = {
    nodeType: 1,
    tagName: 'FORM',
    isConnected: true,
    matches() { return false; },
    closest() { return null; },
    querySelectorAll(selector) {
      if (selector.includes('send') || selector.includes('Send') || selector === 'button, [role="button"]') return [sendButton];
      return [];
    },
    contains(node) { return node === composer || node === sendButton; },
    getAttribute() { return null; },
  };
  const composer = {
    nodeType: 1,
    tagName: 'TEXTAREA',
    value: '',
    disabled: false,
    readOnly: false,
    isConnected: true,
    parentElement: form,
    focus() {},
    getAttribute(name) { return name === 'id' ? 'prompt-textarea' : null; },
    closest(selector) { return selector === 'form' ? form : selector.includes('main') ? main : null; },
    querySelectorAll() { return []; },
    dispatchEvent(event) {
      if (event?.type === 'paste') this.value = String(event.clipboardData?.value || '');
      return true;
    },
  };
  const main = {
    nodeType: 1,
    tagName: 'MAIN',
    isConnected: true,
    contains(node) { return node === composer || node === form || node === sendButton || node === userTurn; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getAttribute() { return null; },
  };
  sandbox.document.querySelectorAll = (selector) => {
    if (selector.includes('textarea#prompt-textarea')) return [composer];
    if (selector === 'main, [role="main"]') return [main];
    return [];
  };

  const commands = sandbox.ChatGptComposerCommands.createComposerCommands(composerDependencies({
    CONFIG: { promptSubmitAckTimeoutMs: 4_000 },
    DOM_PARSER: sandbox.ChatGptDomParserCore,
    getTurnNodes() { return turns; },
    turnKey() { return 'user-hidden'; },
    turnRole() { return 'user'; },
    visibleText(node) { return node.textContent; },
  }));
  const evidence = await commands.enterPrompt(prompt, { requestId: 'hidden-request', options: {} }, { kind: 'prompt' });
  assert.equal(evidence.confirmed, true);
  assert.equal(evidence.reason, 'new_user_turn');
  assert.equal(evidence.turnKey, 'user-hidden');
});

test('steer waits for Stop to disappear and Send to remain stable before submitting', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  let mutationCallback = null;
  let scheduled = null;
  let stopVisible = true;
  let sendVisible = false;
  let sendClicks = 0;

  sandbox.MutationObserver = class {
    constructor(callback) { mutationCallback = callback; }
    observe() {}
    disconnect() {}
  };
  sandbox.setTimeout = (fn) => {
    scheduled = fn;
    return 1;
  };
  sandbox.clearTimeout = () => { scheduled = null; };

  const stopButton = {
    disabled: false,
    isConnected: true,
    getAttribute(name) {
      if (name === 'data-testid') return 'stop-button';
      if (name === 'aria-label') return 'Stop generating';
      return null;
    },
  };
  const sendButton = {
    disabled: false,
    isConnected: true,
    getAttribute(name) {
      if (name === 'data-testid') return 'send-button';
      if (name === 'aria-label') return 'Send prompt';
      return null;
    },
    click() { sendClicks += 1; },
  };
  const form = {
    nodeType: 1,
    tagName: 'FORM',
    isConnected: true,
    matches() { return false; },
    closest() { return null; },
    querySelectorAll(selector) {
      if (selector.includes('stop') || selector.includes('Stop')) return stopVisible ? [stopButton] : [];
      if (selector.includes('send') || selector.includes('Send')) return sendVisible ? [sendButton] : [];
      if (selector === 'button, [role="button"]') return [
        ...(stopVisible ? [stopButton] : []),
        ...(sendVisible ? [sendButton] : []),
      ];
      return [];
    },
    contains(node) { return node === composer || node === stopButton || node === sendButton; },
    getAttribute() { return null; },
  };
  const composer = {
    nodeType: 1,
    tagName: 'TEXTAREA',
    value: 'STEER_RESULT BLUE',
    disabled: false,
    readOnly: false,
    isConnected: true,
    parentElement: form,
    focus() {},
    getAttribute(name) { return name === 'id' ? 'prompt-textarea' : null; },
    closest(selector) { return selector === 'form' ? form : selector.includes('main') ? main : null; },
    querySelectorAll() { return []; },
  };
  const main = {
    nodeType: 1,
    tagName: 'MAIN',
    isConnected: true,
    contains(node) { return node === composer || node === form || node === stopButton || node === sendButton; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getAttribute() { return null; },
  };

  sandbox.document.querySelectorAll = (selector) => {
    if (selector.includes('textarea#prompt-textarea')) return [composer];
    if (selector === 'main, [role="main"]') return [main];
    return [];
  };

  const commands = sandbox.ChatGptComposerCommands.createComposerCommands(composerDependencies({
    CONFIG: { steerSubmitReadyTimeoutMs: 5_000 },
  }));

  const pending = commands.waitForSteerSubmitButton({ requestId: 'steer-stable', options: {} });
  await Promise.resolve();
  assert.equal(typeof mutationCallback, 'function');
  assert.equal(sendClicks, 0);

  sendVisible = true;
  mutationCallback([{ type: 'attributes' }]);
  assert.equal(sendClicks, 0, 'Send must not be used while Stop is still visible');

  stopVisible = false;
  mutationCallback([{ type: 'childList' }]);
  assert.equal(typeof scheduled, 'function');
  assert.equal(sendClicks, 0, 'Send must settle before submission');

  scheduled();
  const ready = await pending;
  assert.equal(ready.button, sendButton);
  const method = commands.submitComposer(composer, { requestId: 'steer-stable' }, {
    kind: 'steer',
    attempt: 1,
    button: ready.button,
  });
  assert.equal(method, 'button');
  assert.equal(sendClicks, 1);
});

test('steer retries once after an interrupt-only first click and requires a real user turn', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const observerCallbacks = [];
  let turns = [];
  let generationActive = true;
  let clickCount = 0;

  sandbox.MutationObserver = class {
    constructor(callback) { observerCallbacks.push(callback); }
    observe() {}
    disconnect() {}
  };
  sandbox.setTimeout = (fn) => {
    queueMicrotask(fn);
    return 1;
  };
  sandbox.clearTimeout = () => {};
  sandbox.DataTransfer = class {
    constructor() { this.value = ''; }
    setData(_type, value) { this.value = String(value); }
  };
  sandbox.ClipboardEvent = class {
    constructor(type, options = {}) { this.type = type; this.clipboardData = options.clipboardData; }
  };
  sandbox.InputEvent = class { constructor(type) { this.type = type; } };

  const prompt = 'STEER_RESULT BLUE';
  const userTurn = { textContent: prompt };

  const firstButton = {
    disabled: false,
    isConnected: true,
    getAttribute(name) {
      if (name === 'data-testid') return 'send-button';
      if (name === 'aria-label') return 'Send prompt';
      return null;
    },
    click() {
      clickCount += 1;
      generationActive = false;
    },
  };
  const secondButton = {
    disabled: false,
    isConnected: true,
    getAttribute(name) {
      if (name === 'data-testid') return 'send-button';
      if (name === 'aria-label') return 'Send prompt';
      return null;
    },
    click() {
      clickCount += 1;
      composer.value = '';
      turns = [userTurn];
      for (const callback of observerCallbacks) callback([{ type: 'childList' }]);
    },
  };

  const form = {
    nodeType: 1,
    tagName: 'FORM',
    isConnected: true,
    matches() { return false; },
    closest() { return null; },
    querySelectorAll(selector) {
      const button = generationActive ? firstButton : secondButton;
      if (selector.includes('send') || selector.includes('Send') || selector === 'button, [role="button"]') return [button];
      if (selector.includes('stop') || selector.includes('Stop')) return [];
      return [];
    },
    contains(node) {
      return node === composer || node === firstButton || node === secondButton;
    },
    getAttribute() { return null; },
  };
  const composer = {
    nodeType: 1,
    tagName: 'TEXTAREA',
    value: '',
    disabled: false,
    readOnly: false,
    isConnected: true,
    parentElement: form,
    focus() {},
    getAttribute(name) { return name === 'id' ? 'prompt-textarea' : null; },
    closest(selector) { return selector === 'form' ? form : selector.includes('main') ? main : null; },
    querySelectorAll() { return []; },
    dispatchEvent(event) {
      if (event?.type === 'paste') this.value = String(event.clipboardData?.value || '');
      return true;
    },
  };
  const main = {
    nodeType: 1,
    tagName: 'MAIN',
    isConnected: true,
    contains(node) {
      return node === composer || node === form || node === firstButton || node === secondButton || node === userTurn;
    },
    querySelectorAll() { return []; },
    closest() { return null; },
    getAttribute() { return null; },
  };

  sandbox.document.querySelectorAll = (selector) => {
    if (selector.includes('textarea#prompt-textarea')) return [composer];
    if (selector === 'main, [role="main"]') return [main];
    return [];
  };

  const diagnostics = [];
  const commands = sandbox.ChatGptComposerCommands.createComposerCommands(composerDependencies({
    CONFIG: {
      promptSubmitAckTimeoutMs: 1_000,
      steerSubmitAckTimeoutMs: 1_000,
      steerSubmitReadyTimeoutMs: 1_000,
    },
    DOM_PARSER: sandbox.ChatGptDomParserCore,
    diagnostic(name, data) { diagnostics.push({ name, data }); },
    getTurnNodes() { return turns; },
    isGenerating() { return generationActive; },
    turnKey() { return 'steer-user-turn'; },
    turnRole() { return 'user'; },
    visibleText(node) { return node.textContent; },
  }));

  const evidence = await commands.enterPrompt(
    prompt,
    { requestId: 'steer-interrupt-only', options: {} },
    { kind: 'steer' },
  );

  assert.equal(clickCount, 2);
  assert.equal(evidence.confirmed, true);
  assert.equal(evidence.reason, 'new_user_turn');
  assert.equal(evidence.turnKey, 'steer-user-turn');
  assert.equal(diagnostics.some((entry) => entry.name === 'steer.submit.interrupt_only'), true);
  assert.equal(
    diagnostics.some((entry) => entry.name === 'prompt.submit.attempt' && entry.data.attempt === 2),
    true,
  );
});

test('steer acknowledgement uses a longer bounded proof window than an ordinary prompt', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const commands = sandbox.ChatGptComposerCommands.createComposerCommands(composerDependencies({
    CONFIG: { promptSubmitAckTimeoutMs: 4_000, steerSubmitAckTimeoutMs: 30_000, steerSubmitReadyTimeoutMs: 90_000 },
  }));
  assert.equal(commands.resolveSubmissionAckTimeoutMs({ options: {} }, 'prompt'), 4_000);
  assert.equal(commands.resolveSubmissionAckTimeoutMs({ options: {} }, 'steer'), 30_000);
  assert.equal(commands.resolveSubmissionAckTimeoutMs({ options: { promptSubmitAckTimeoutMs: 12_000 } }, 'steer'), 30_000);
  assert.equal(commands.resolveSubmissionAckTimeoutMs({ options: { steerSubmitAckTimeoutMs: 8_000 } }, 'steer'), 8_000);
});


test('prompt submission evidence rejects an unrelated new user turn even when the composer cleared', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const unrelatedTurn = { textContent: 'stale passive workflow prompt' };
  const commands = sandbox.ChatGptComposerCommands.createComposerCommands(composerDependencies({
    DOM_PARSER: sandbox.ChatGptDomParserCore,
    getTurnNodes() { return [unrelatedTurn]; },
    turnKey() { return 'user-stale'; },
    turnRole() { return 'user'; },
    visibleText(node) { return node.textContent; },
  }));
  const evidence = commands.promptSubmissionEvidence(
    { requestId: 'project-request' },
    new Set(),
    'current project-context prompt',
    { textContent: 'current project-context prompt' },
  );
  assert.equal(evidence.confirmed, false);
  assert.equal(evidence.reason, 'new_user_turn_text_mismatch');
  assert.equal(evidence.turnKey, 'user-stale');
});

test('prompt submission evidence accepts an attachment-prefixed turn only when its prompt text matches', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const matchingTurn = { textContent: 'project.zip\nZIP-архив\n\ncurrent project-context prompt' };
  const commands = sandbox.ChatGptComposerCommands.createComposerCommands(composerDependencies({
    DOM_PARSER: sandbox.ChatGptDomParserCore,
    getTurnNodes() { return [matchingTurn]; },
    turnKey() { return 'user-project'; },
    turnRole() { return 'user'; },
    visibleText(node) { return node.textContent; },
  }));
  const evidence = commands.promptSubmissionEvidence(
    { requestId: 'project-request' },
    new Set(),
    'current project-context prompt',
    { textContent: 'current project-context prompt' },
  );
  assert.equal(evidence.confirmed, true);
  assert.equal(evidence.reason, 'new_user_turn');
  assert.equal(evidence.turnKey, 'user-project');
});

test('a proven unsubmitted passive prompt is rolled back instead of poisoning the next request', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  sandbox.DataTransfer = class {
    constructor() { this.value = ''; }
    setData(_type, value) { this.value = String(value); }
  };
  sandbox.ClipboardEvent = class {
    constructor(type, options = {}) { this.type = type; this.clipboardData = options.clipboardData; }
  };
  sandbox.InputEvent = class { constructor(type) { this.type = type; } };

  const sendButton = {
    disabled: false,
    isConnected: true,
    getAttribute(name) { return name === 'data-testid' ? 'send-button' : null; },
    click() {},
  };
  const form = {
    nodeType: 1,
    tagName: 'FORM',
    isConnected: true,
    matches() { return false; },
    closest() { return null; },
    querySelectorAll(selector) {
      if (selector.includes('send') || selector.includes('Send') || selector === 'button, [role="button"]') return [sendButton];
      return [];
    },
    contains(node) { return node === composer || node === sendButton; },
    getAttribute() { return null; },
  };
  const composer = {
    nodeType: 1,
    tagName: 'TEXTAREA',
    value: '',
    disabled: false,
    readOnly: false,
    isConnected: true,
    parentElement: form,
    focus() {},
    getAttribute(name) { return name === 'id' ? 'prompt-textarea' : null; },
    closest(selector) { return selector === 'form' ? form : selector.includes('main') ? main : null; },
    querySelectorAll() { return []; },
    dispatchEvent(event) {
      if (event?.type === 'paste') this.value = String(event.clipboardData?.value || '');
      return true;
    },
  };
  const main = {
    nodeType: 1,
    tagName: 'MAIN',
    isConnected: true,
    contains(node) { return node === composer || node === form || node === sendButton; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getAttribute() { return null; },
  };
  sandbox.document.querySelectorAll = (selector) => {
    if (selector.includes('textarea#prompt-textarea')) return [composer];
    if (selector === 'main, [role="main"]') return [main];
    return [];
  };

  sandbox.setTimeout = globalThis.setTimeout;
  sandbox.clearTimeout = globalThis.clearTimeout;
  const diagnostics = [];
  const commands = sandbox.ChatGptComposerCommands.createComposerCommands(composerDependencies({
    CONFIG: { promptSubmitAckTimeoutMs: 1_000 },
    DOM_PARSER: sandbox.ChatGptDomParserCore,
    diagnostic(name, data) { diagnostics.push({ name, data }); },
    async delay() {},
  }));

  await assert.rejects(
    commands.enterPrompt('stale passive workflow prompt', { requestId: 'passive-stale', options: {} }, { kind: 'passive' }),
    (error) => {
      assert.equal(error.code, 'PROMPT_SUBMIT_NOT_EXECUTED');
      assert.equal(error.provenNotExecuted, true);
      return true;
    },
  );
  assert.equal(composer.value, '');
  assert.equal(diagnostics.some((entry) => entry.name === 'prompt.submit.rolled_back'), true);
});
