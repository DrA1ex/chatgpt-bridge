import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapExtensionContentRuntime } from './helpers/extensionContentRuntime.js';

function composerDependencies(overrides = {}) {
  return {
    CONFIG: {},
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

test('composer submission uses the native form algorithm when an active steer has no send button', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  let submitCount = 0;
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
    dispatchEvent() { throw new Error('keyboard fallback must not run when requestSubmit is available'); },
  };
  sandbox.document.querySelectorAll = (selector) => selector === '#prompt-textarea[contenteditable="true"]' ? [composer] : [];

  const diagnostics = [];
  const commands = sandbox.ChatGptComposerCommands.createComposerCommands(composerDependencies({
    diagnostic(name, data) { diagnostics.push({ name, data }); },
  }));

  const method = commands.submitComposer(composer, { requestId: 'steer-request' }, { kind: 'steer', attempt: 2 });
  assert.equal(method, 'form_request_submit');
  assert.equal(submitCount, 1);
  assert.deepEqual(diagnostics.map((entry) => entry.name), ['send_button.not_found_form_submit_fallback']);
  assert.equal(diagnostics[0].data.kind, 'steer');
  assert.equal(diagnostics[0].data.attempt, 2);
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
