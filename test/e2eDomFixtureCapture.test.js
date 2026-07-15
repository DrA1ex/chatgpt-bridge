import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDomFixtureCapture, withDomCaptureMetadata } from '../scripts/e2e/dom-fixture-capture.js';
import { parseArgs } from '../scripts/e2e/cli.js';

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


test('DOM fixture capture CLI flag and explicit output directory are supported', () => {
  const explicit = parseArgs(['--scenario', 'response-markdown', '--fixture-output-dir', './tmp/captured-dom']);
  assert.equal(explicit.captureDomFixtures, true);
  assert.equal(explicit.fixtureOutputDir, path.resolve('./tmp/captured-dom'));

  const automatic = parseArgs(['--scenario', 'response-markdown', '--capture-dom-fixtures', '--report-dir', './tmp/e2e-report']);
  assert.equal(automatic.captureDomFixtures, true);
  assert.equal(automatic.fixtureOutputDir, path.resolve('./tmp/e2e-report/dom-fixtures'));
});
