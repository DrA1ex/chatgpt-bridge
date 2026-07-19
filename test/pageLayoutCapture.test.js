import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { parseArgs } from '../scripts/e2e/cli.js';
import { createPageLayoutCapture } from '../scripts/e2e/page-layout-capture.js';

function attributeList(record = {}) {
  return Object.entries(record).map(([name, value]) => ({ name, value: String(value) }));
}

function text(value) {
  return { nodeType: 3, textContent: String(value), parentElement: null };
}

function element(tagName, attributes = {}, children = [], options = {}) {
  const node = {
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    attributes: attributeList(attributes),
    childNodes: children,
    parentElement: null,
    sensitive: Boolean(options.sensitive),
    interactive: Boolean(options.interactive),
    getBoundingClientRect: () => options.rect || ({ left: 1, top: 2, width: 100, height: 30 }),
    matches(selector) {
      if (this.sensitive && selector.includes('[data-message-author-role]')) return true;
      return false;
    },
    closest(selector) {
      if (selector.includes('[data-message-author-role]') && this.sensitive) return this;
      if (selector.startsWith('button,') && this.interactive) return this;
      return this.parentElement?.closest?.(selector) || null;
    },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

async function loadLayoutCaptureFactory(body) {
  const sandbox = {
    console,
    URL,
    location: new URL('https://chatgpt.com/c/private-conversation?token=secret'),
    document: { body, documentElement: body, title: 'Private conversation title' },
    window: {
      innerWidth: 1440,
      innerHeight: 900,
      getComputedStyle: () => ({ display: 'block', position: 'static' }),
    },
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/layoutCapture.js'), 'utf8'), sandbox);
  return sandbox.ChatGptLayoutCapture;
}

test('real E2E CLI enables sanitized structural page layout capture explicitly', () => {
  const options = parseArgs(['--capture-page-layout', '--scenario', 'reload-mid-request']);
  assert.equal(options.capturePageLayout, true);
  assert.deepEqual(options.scenarioIds, ['reload-mid-request']);
  assert.equal(parseArgs(['--capture-layout']).capturePageLayout, true);
});

test('content layout capture preserves selector evidence while redacting conversation and account data', async () => {
  const sidebar = element('a', {
    href: 'https://chatgpt.com/c/private-conversation?token=secret',
    'data-sidebar-item': 'true',
    'aria-label': 'Secret private chat title',
  }, [text('Secret private chat title')], { sensitive: true });
  const modelButton = element('button', {
    'data-testid': 'model-switcher-dropdown-button',
    'aria-label': 'Model selector',
    'aria-expanded': 'false',
  }, [text('GPT-5.6 Thinking')], { interactive: true, rect: { left: 300, top: 700, width: 120, height: 40 } });
  const answer = element('div', { 'data-message-author-role': 'assistant' }, [text('PRIVATE ANSWER BODY')], { sensitive: true });
  const image = element('img', { src: 'https://private.invalid/avatar.png?token=secret', alt: 'Alexander private avatar' });
  const body = element('body', {}, [sidebar, modelButton, answer, image]);
  const factory = await loadLayoutCaptureFactory(body);
  const sent = [];
  const runtime = factory.createLayoutCapture({
    isVisible: () => true,
    normalizeText: (value) => String(value || '').replace(/\s+/g, ' ').trim(),
    send: (payload) => sent.push(payload),
  });
  const capture = runtime.capturePageLayout();

  assert.match(capture.html, /data-testid="model-switcher-dropdown-button"/);
  assert.match(capture.html, /GPT-5\.6 Thinking/);
  assert.match(capture.html, /\/c\/&lt;conversation&gt;|\/c\/<conversation>/);
  assert.match(capture.html, /data-cgb-rect="300,700,120,40"/);
  assert.doesNotMatch(capture.html, /private-conversation|Secret private chat title|PRIVATE ANSWER BODY|Alexander private avatar|token=secret|avatar\.png/i);
  assert.ok(capture.metadata.redactedTextNodes >= 2);

  runtime.handleLayoutCapture({ commandId: 'layout-command', requestId: 'active-request' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'page.layout.captured');
  assert.equal(sent[0].commandId, 'layout-command');
  assert.equal(sent[0].requestId, 'active-request');
  assert.doesNotMatch(sent[0].html, /PRIVATE ANSWER BODY/);
});

test('E2E layout archive writer deduplicates identical captures and records failures without failing the run', async () => {
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-layout-capture-'));
  const report = {};
  let calls = 0;
  const runtime = createPageLayoutCapture({
    enabled: true,
    reportDir,
    options: {},
    report,
    getClient: () => ({ id: 'client-layout', activeRequest: { requestId: 'request-layout' } }),
    api: async () => {
      calls += 1;
      if (calls === 3) throw new Error('capture transport failed');
      return { html: '<html><body><button>Model</button></body></html>', metadata: { nodeCount: 3 } };
    },
  });
  try {
    const first = await runtime.capture('scenario-before', { scenarioId: 'scenario', phase: 'before' });
    const second = await runtime.capture('scenario-after', { scenarioId: 'scenario', phase: 'after' });
    const failed = await runtime.capture('scenario-failed', { scenarioId: 'scenario', phase: 'failed' });
    assert.equal(first.file, second.file);
    assert.equal(second.duplicateOf, first.file);
    assert.equal(failed.error, 'capture transport failed');
    const index = JSON.parse(await fs.readFile(path.join(reportDir, 'page-layout', 'index.json'), 'utf8'));
    assert.equal(index.entries.length, 3);
    assert.equal(index.sanitized, true);
    assert.equal(report.pageLayoutCapture.entries.length, 3);
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true });
  }
});
