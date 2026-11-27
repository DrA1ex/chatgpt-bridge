import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const SESSION_COMMANDS = await fs.readFile(
  path.resolve('tools/chrome-bridge-extension/content/sessionCommands.js'),
  'utf8',
);

function sessionHarness({
  redirectAfterMs = 0,
  readinessDelayMs = 0,
  startOnTarget = false,
  selectionTimeoutMs = 2_000,
} = {}) {
  const targetId = 'target-session-fixture';
  const targetUrl = `https://chatgpt.com/c/${targetId}`;
  const location = new URL(startOnTarget ? targetUrl : 'https://chatgpt.com/');
  const events = [];
  const startedAt = Date.now();
  let readyAt = startOnTarget ? startedAt + readinessDelayMs : Number.POSITIVE_INFINITY;
  const link = {
    href: targetUrl,
    textContent: 'planner fixture',
    getAttribute(name) { return name === 'href' ? targetUrl : null; },
    click() {
      setTimeout(() => {
        location.href = targetUrl;
        readyAt = Date.now() + readinessDelayMs;
        if (redirectAfterMs) {
          setTimeout(() => { location.href = 'https://chatgpt.com/'; }, redirectAfterMs);
        }
      }, 50);
    },
  };
  const document = {
    readyState: 'complete',
    title: 'ChatGPT',
    querySelectorAll(selector) { return selector.includes('a[href*="/c/"]') ? [link] : []; },
  };
  const context = {
    URL,
    document,
    location,
    setTimeout,
    clearTimeout,
    globalThis: null,
  };
  context.globalThis = context;
  vm.runInNewContext(SESSION_COMMANDS, context, { filename: 'sessionCommands.js' });
  const api = context.ChatGptSessionCommands.createSessionCommands({
    CONFIG: { pageReadySettleMs: 1_000, sessionSelectTimeoutMs: selectionTimeoutMs },
    chatPageReadiness() {
      return { ready: location.href === targetUrl && Date.now() >= readyAt, url: location.href };
    },
    delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); },
    send(event) { events.push(event); },
    visibleText(element) { return element.textContent || ''; },
  });
  return { api, events, location, targetId, targetUrl, startedAt };
}

test('session selection rejects a transient exact route that later returns to root', async () => {
  const harness = sessionHarness({ redirectAfterMs: 900, selectionTimeoutMs: 1_500 });

  const selection = harness.api.handleSessionsSelect({ commandId: 'fixture-select', sessionId: harness.targetId });
  await Promise.all([selection, new Promise((resolve) => setTimeout(resolve, 1_100))]);

  assert.equal(harness.location.pathname, '/');
  assert.equal(harness.events.some((event) => event.type === 'session.selected'), false);
  assert.equal(harness.events.at(-1)?.type, 'command.error');
  assert.equal(harness.events.at(-1)?.message.includes(harness.targetId), false);
});

test('session selection succeeds only after exact route and page readiness stay stable', async () => {
  const harness = sessionHarness({ readinessDelayMs: 200 });

  await harness.api.handleSessionsSelect({ commandId: 'fixture-select', sessionId: harness.targetId });

  assert.equal(harness.location.href, harness.targetUrl);
  assert.equal(harness.events.at(-1)?.type, 'session.selected');
  assert.equal(harness.events.at(-1)?.session?.id, harness.targetId);
});

test('an already selected session still waits for page readiness and route stability', async () => {
  const harness = sessionHarness({ startOnTarget: true, readinessDelayMs: 150 });
  const started = Date.now();

  const session = await harness.api.selectSessionById(harness.targetId);

  assert.equal(session.id, harness.targetId);
  assert.ok(Date.now() - started >= 1_100);
});
