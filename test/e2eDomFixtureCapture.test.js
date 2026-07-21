import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDomFixtureCapture, withDomCaptureMetadata } from '../scripts/e2e/dom-fixture-capture.js';
import { parseArgs } from '../scripts/e2e/cli.js';
import { reasoningTestPrompt } from '../scripts/e2e/reasoning-support.js';
import { createAssistantFixtureParser, parseAssistantFixture } from './helpers/offlineChatDom.js';

test('DOM fixture capture enables timeline metadata without discarding request metadata', () => {
  const body = withDomCaptureMetadata({ message: 'test', metadata: { existing: true } }, true);
  assert.equal(body.captureDomTimeline, true);
  assert.deepEqual(body.metadata, { existing: true, captureDomTimeline: true });
});

test('DOM fixture capture writes sanitized HTML and parser expectations', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-dom-capture-'));
  try {
    const capture = createDomFixtureCapture({ enabled: true, outputDir, runId: 'abc123', marker: 'BRIDGE_E2E_ABC123' });
    const written = await capture.capture({
      scope: 'response-markdown',
      requestId: 'turn/private-1',
      events: [{
        id: 'event-1',
        type: 'assistant.dom.snapshot',
        data: {
          phase: 'ASSISTANT_FINAL',
          answer: 'BRIDGE_E2E_ABC123 done',
          responseBlocks: [{ type: 'paragraph', markdown: 'BRIDGE_E2E_ABC123 done' }],
          parserAudit: {
            sourceHtml: '<div data-message-id="private-id"><a href="https://chatgpt.com/backend-api/files/private.zip?token=secret">BRIDGE_E2E_ABC123 done</a></div>',
            coverage: { unknownLeaves: 0, coveragePercent: 100 },
          },
        },
      }],
    });
    assert.equal(written.length, 1);
    const fixturePath = path.join(outputDir, written[0].fixture);
    const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
    const html = await fs.readFile(path.join(path.dirname(fixturePath), fixture.source.html), 'utf8');
    assert.match(html, /BRIDGE_E2E_CAPTURED_MARKER done/);
    assert.match(html, /data-message-id="captured-data-message-id"/);
    assert.match(html, /https:\/\/example\.invalid\/private\.zip/);
    assert.doesNotMatch(html, /private-id|token=secret|BRIDGE_E2E_ABC123/);
    assert.equal(fixture.expected.answer, 'BRIDGE_E2E_CAPTURED_MARKER done');
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('DOM fixture capture replaces a marker even when React splits it across text nodes', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-dom-capture-split-marker-'));
  try {
    const capture = createDomFixtureCapture({ enabled: true, outputDir, runId: 'abc123', marker: 'BRIDGE_E2E_ABC123' });
    const written = await capture.capture({
      scope: 'response-markdown',
      requestId: 'turn-1',
      events: [{
        id: 'event-1',
        type: 'assistant.dom.snapshot',
        data: {
          phase: 'ASSISTANT_FINAL',
          answer: 'BRIDGE_E2E_ABC123',
          parserAudit: {
            sourceHtml: '<div data-message-author-role="assistant"><div class="markdown"><p><span>BRIDGE_E2E_</span><span>ABC123</span></p></div></div>',
          },
        },
      }],
    });
    const fixturePath = path.join(outputDir, written[0].fixture);
    const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
    const html = await fs.readFile(path.join(path.dirname(fixturePath), fixture.source.html), 'utf8');
    const parsed = await parseAssistantFixture(html);
    assert.equal(fixture.expected.answer, 'BRIDGE_E2E_CAPTURED_MARKER');
    assert.equal(parsed.answer, fixture.expected.answer);
    assert.doesNotMatch(html, /CAPTURED_RUN_ID/);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('DOM fixture capture stores only replayable visible progress and canonicalizes localized UI text', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-dom-capture-progress-'));
  try {
    const capture = createDomFixtureCapture({ enabled: true, outputDir });
    const written = await capture.capture({
      scope: 'reasoning-lifecycle',
      requestId: 'turn-1',
      events: [{
        id: 'event-1',
        type: 'assistant.dom.snapshot',
        data: {
          phase: 'ASSISTANT_FINAL_STREAMING_WITH_HISTORY',
          progressItems: [
            { kind: 'thinking', text: '\u0421\u043a\u0440\u044b\u0442\u044b\u0439 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u043d\u044b\u0439 \u0448\u0430\u0433', state: 'completed', active: false, visible: false },
            { kind: 'action_status', text: '\u041e\u0431\u0440\u0430\u0431\u043e\u0442\u043a\u0430 \u0437\u0430\u043d\u044f\u043b\u0430 56s', state: 'completed', active: false, visible: true },
          ],
          parserAudit: {
            sourceHtml: '<section data-turn="assistant"><div aria-label="\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u044f \u0441 \u043e\u0442\u0432\u0435\u0442\u043e\u043c">ChatGPT \u0441\u043a\u0430\u0437\u0430\u043b:</div><div role="status">\u041e\u0431\u0440\u0430\u0431\u043e\u0442\u043a\u0430 \u0437\u0430\u043d\u044f\u043b\u0430 56s</div><div data-message-author-role="assistant"><p>Done</p></div></section>',
          },
        },
      }],
    });

    const fixturePath = path.join(outputDir, written[0].fixture);
    const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
    const html = await fs.readFile(path.join(path.dirname(fixturePath), fixture.source.html), 'utf8');
    assert.deepEqual(fixture.expected.progressItems.map((item) => item.text), ['Captured action step 01']);
    assert.match(html, /aria-label="Response actions"/);
    assert.match(html, /ChatGPT said:/);
    assert.match(html, /Captured action step 01/);
    assert.doesNotMatch(`${html}\n${JSON.stringify(fixture)}`, /[\u0400-\u04ff]/u);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('reasoning lifecycle prompt requires English-only visible output', () => {
  const prompt = reasoningTestPrompt('ENGLISH_ONLY');
  assert.match(prompt, /Use English only for every visible message/);
  assert.doesNotMatch(prompt, /[\u0400-\u04ff]/u);
});

test('captured source HTML keeps the scoped assistant turn and parser-critical attributes', async () => {
  const snapshot = await parseAssistantFixture(`
    <section data-turn="assistant" data-turn-id="private-turn" data-testid="conversation-turn-1">
      <div data-testid="cot-v5-summary">Finished reasoning</div>
      <div data-message-author-role="assistant" data-message-id="private-message" data-message-model-slug="private-model">
        <div class="markdown"><p><a href="https://chatgpt.com/backend-api/files/private.txt?token=secret">Done</a></p></div>
      </div>
    </section>
  `, { captureSourceHtml: true });

  const sourceHtml = snapshot.parserAudit?.sourceHtml || '';
  assert.match(sourceHtml, /^<section\b/);
  assert.match(sourceHtml, /data-turn="assistant"/);
  assert.match(sourceHtml, /data-turn-id="captured-data-turn-id"/);
  assert.match(sourceHtml, /data-message-author-role="assistant"/);
  assert.match(sourceHtml, /data-message-id="captured-data-message-id"/);
  assert.match(sourceHtml, /data-message-model-slug="captured-model"/);
  assert.match(sourceHtml, /href="https:\/\/example\.invalid\/private\.txt"/);
  assert.doesNotMatch(sourceHtml, /private-turn|private-message|private-model|token=secret/);
});

test('DOM fixture capture prefers timeline snapshots over aggregate terminal content', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-dom-capture-events-'));
  try {
    const capture = createDomFixtureCapture({ enabled: true, outputDir });
    const written = await capture.capture({
      scope: 'response-markdown',
      requestId: 'turn-1',
      turnSnapshot: {
        items: [{
          type: 'agent_message',
          content: {
            answer: 'aggregate terminal answer',
            parserAudit: { sourceHtml: '<div data-message-author-role="assistant"><p>aggregate terminal answer</p></div>' },
          },
        }],
      },
      response: {
        answer: 'sync response answer',
        parserAudit: { sourceHtml: '<div data-message-author-role="assistant"><p>sync response answer</p></div>' },
      },
      events: [{
        id: 'snapshot-1',
        type: 'assistant.dom.snapshot',
        data: {
          phase: 'ASSISTANT_FINAL',
          answer: 'timeline answer',
          parserAudit: { sourceHtml: '<div data-message-author-role="assistant"><p>timeline answer</p></div>' },
        },
      }],
    });

    assert.equal(written.length, 1);
    const fixture = JSON.parse(await fs.readFile(path.join(outputDir, written[0].fixture), 'utf8'));
    assert.equal(fixture.source.eventId, 'snapshot-1');
    assert.equal(fixture.expected.answer, 'timeline answer');
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('DOM fixture capture does not write aggregate synchronous output without timeline snapshots', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-dom-capture-aggregate-'));
  try {
    const warnings = [];
    const capture = createDomFixtureCapture({
      enabled: true,
      outputDir,
      log: (level, scope, message, data) => warnings.push({ level, scope, message, data }),
    });
    const written = await capture.capture({
      scope: 'bootstrap',
      requestId: 'turn-1',
      response: {
        answer: 'aggregate answer',
        parserAudit: { sourceHtml: '<div data-message-author-role="assistant"><p>aggregate answer</p></div>' },
      },
    });
    assert.deepEqual(written, []);
    assert.ok(warnings.some((entry) => entry.message.includes('not a replayable DOM timeline snapshot')));
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('offline captured DOM replay preserves reasoning history across snapshots from one turn', async () => {
  const parser = await createAssistantFixtureParser();
  const first = parser.parse(`
    <section data-turn="assistant" data-turn-id="captured-turn">
      <div class="loading-shimmer-tertiary">Thinking step</div>
      <div data-message-author-role="assistant" data-message-id="captured-message">
        <div class="markdown"><p>Partial answer</p></div>
      </div>
    </section>
  `);
  assert.ok(first.progressItems.some((item) => item.text === 'Thinking step' && item.active && item.visible));

  const second = parser.parse(`
    <section data-turn="assistant" data-turn-id="captured-turn">
      <div data-message-author-role="assistant" data-message-id="captured-message">
        <div class="markdown"><p>Final answer</p></div>
      </div>
    </section>
  `);
  assert.ok(second.progressItems.some((item) => item.text === 'Thinking step' && !item.active && !item.visible));
});

test('synchronous real E2E capture loads the public turn event timeline', async () => {
  const source = await fs.readFile(path.resolve('scripts/e2e-real.js'), 'utf8');
  assert.match(source, /\/turns\/\$\{encodeURIComponent\(response\.requestId\)\}\/events\?limit=5000/);
  assert.match(source, /capture\(\{ scope, requestId: response\.requestId, response, events, canonical \}\)/);
});

test('DOM fixture capture skips canonical traces that do not start with request.created', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-dom-capture-trace-'));
  try {
    const warnings = [];
    const capture = createDomFixtureCapture({
      enabled: true,
      outputDir,
      log: (level, scope, message, data) => warnings.push({ level, scope, message, data }),
    });
    const written = await capture.capture({
      scope: 'response-markdown',
      requestId: 'turn-1',
      events: [{
        type: 'assistant.dom.snapshot',
        data: {
          phase: 'ASSISTANT_FINAL',
          answer: 'done',
          parserAudit: { sourceHtml: '<div data-message-author-role="assistant"><p>done</p></div>' },
        },
      }],
      canonical: {
        state: { requestId: 'turn-1', lifecycle: 'completed', terminal: { code: 'completed' }, artifact: { status: 'none' } },
        history: [{ event: { type: 'observation.updated', occurredAt: 1, data: {} } }],
      },
    });

    const fixtureDirectory = path.dirname(path.join(outputDir, written[0].fixture));
    await assert.rejects(fs.access(path.join(fixtureDirectory, 'request-trace.json')));
    assert.ok(warnings.some((entry) => entry.message.includes('Skipped incomplete canonical request trace')));
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});


test('DOM fixture capture CLI flag and explicit output directory are supported', () => {
  const explicit = parseArgs(['--scenario', 'response-markdown', '--fixture-output-dir', './tmp/captured-dom']);
  assert.equal(explicit.captureDomFixtures, true);
  assert.equal(explicit.fixtureOutputDir, path.resolve('./tmp/captured-dom'));

  const automatic = parseArgs(['--scenario', 'response-markdown', '--capture-dom-fixtures', '--report-dir', './tmp/e2e-report']);
  assert.equal(automatic.captureDomFixtures, true);
  assert.equal(automatic.fixtureOutputDir, path.resolve('./tmp/e2e-report/dom-fixtures'));
});


test('real E2E CLI controls startup extension reload policy', () => {
  assert.equal(parseArgs(['--reload-extension']).extensionReloadPolicy, 'if-needed');
  assert.equal(parseArgs(['--force-reload-extension']).extensionReloadPolicy, 'always');
  assert.equal(parseArgs(['--no-reload-extension']).extensionReloadPolicy, 'never');
});
