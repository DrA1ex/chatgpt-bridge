import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

async function loadComposerCommands() {
  const source = await fs.readFile(
    path.resolve('tools/chrome-bridge-extension/content/composerCommands.js'),
    'utf8',
  );
  const context = vm.createContext({ console });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'composerCommands.js' });
  return context.ChatGptComposerCommands.createComposerCommands({
    isPrimaryChatSurfaceElement: () => true,
    isVisible: () => true,
  });
}

function button(attributes = {}) {
  const values = new Map(Object.entries(attributes).map(([key, value]) => [key, String(value)]));
  return {
    disabled: false,
    textContent: attributes.textContent || '',
    getAttribute(name) {
      return values.has(name) ? values.get(name) : null;
    },
  };
}

function rootFor({ stop = null, send = null } = {}) {
  return {
    matches() { return false; },
    querySelectorAll(selector) {
      if (selector === 'button[type="submit"]') return stop ? [stop] : [];
      if (selector === '[role="button"][type="submit"]') return [];
      if (selector === '[data-testid="send-button"]') return send ? [send] : [];
      if (selector === '[data-testid*="send" i]') return send ? [send] : [];
      if (selector === 'button[aria-label*="Send" i]') return [];
      if (selector === '[role="button"][aria-label*="Send" i]') return [];
      if (selector === 'button, [role="button"]') return [stop, send].filter(Boolean);
      return [];
    },
  };
}

test('steering does not treat a submit-typed stop control as a send button', async () => {
  const commands = await loadComposerCommands();
  const stop = button({
    type: 'submit',
    'data-testid': 'stop-button',
    'aria-label': 'Stop generating',
  });

  assert.equal(commands.findSendButton([rootFor({ stop })]), null);
});

test('steering still selects the real send control when it becomes available', async () => {
  const commands = await loadComposerCommands();
  const stop = button({
    type: 'submit',
    'data-testid': 'stop-button',
    'aria-label': 'Stop generating',
  });
  const send = button({
    type: 'submit',
    'data-testid': 'send-button',
    'aria-label': 'Send prompt',
  });

  assert.equal(commands.findSendButton([rootFor({ stop, send })]), send);
});
