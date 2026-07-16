import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAssistantFixtureParser } from './helpers/offlineChatDom.js';
import { replayRequestTrace } from '../src/bridge/replay/requestTrace.js';

const ROOT = path.resolve('test/fixtures/chat-dom/captured');

async function walk(directory, suffix) {
  const output = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(absolute, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) output.push(absolute);
  }
  return output.sort();
}

function responseBlockProjection(block = {}) {
  return {
    type: String(block.type || ''),
    markdown: String(block.markdown || block.text || ''),
    ...(block.language ? { language: String(block.language) } : {}),
    ...(block.code !== undefined ? { code: String(block.code || '') } : {}),
  };
}

function codeBlockProjection(block = {}) {
  return { language: String(block.language || ''), code: String(block.code || '') };
}

test('captured ChatGPT DOM fixtures reproduce parser semantics without a live browser', async (t) => {
  const fixtureFiles = await walk(ROOT, '.fixture.json');
  assert.ok(fixtureFiles.length > 0, 'At least one captured DOM fixture is required');
  for (const fixturePath of fixtureFiles) {
    await t.test(path.relative(ROOT, fixturePath), async (fixtureTest) => {
      const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
      assert.equal(fixture.schemaVersion, 1);
      if (fixture.source?.eventId === 'sync-response') {
        fixtureTest.skip('Legacy aggregate sync-response fixtures are not replayable from DOM alone; recapture them with test:e2e:capture-dom');
        return;
      }
      const htmlPath = path.resolve(path.dirname(fixturePath), fixture.source?.html || '');
      const html = await fs.readFile(htmlPath, 'utf8');
      const parser = await createAssistantFixtureParser();
      const actual = parser.parse(html);
      const expected = fixture.expected || {};
      if (Object.prototype.hasOwnProperty.call(expected, 'answer')) assert.equal(actual.answer, expected.answer);
      if (expected.format) assert.equal(actual.format, expected.format);
      if (Array.isArray(expected.responseBlocks)) {
        assert.deepEqual(Array.from(actual.responseBlocks, responseBlockProjection), expected.responseBlocks.map(responseBlockProjection));
      }
      if (Array.isArray(expected.codeBlocks)) {
        assert.deepEqual(Array.from(actual.codeBlocks, codeBlockProjection), expected.codeBlocks.map(codeBlockProjection));
      }
      if (Array.isArray(expected.artifacts)) {
        const actualArtifacts = Array.from(actual.artifacts, (item) => ({ kind: item.kind || '', name: item.name || '', phase: item.phase || '', downloadable: Boolean(item.downloadable) }));
        const expectedArtifacts = expected.artifacts.map((item) => ({ kind: item.kind || '', name: item.name || '', phase: item.phase || '', downloadable: Boolean(item.downloadable) }));
        assert.deepEqual(actualArtifacts, expectedArtifacts);
      }
      if (Array.isArray(expected.progressItems)) {
        const projection = (item) => ({
          kind: String(item.kind || ''),
          text: String(item.text || ''),
          state: String(item.state || ''),
          active: Boolean(item.active),
          visible: Boolean(item.visible),
        });
        const visibleActual = Array.from(actual.progressItems || []).filter((item) => item?.visible).map(projection);
        const visibleExpected = expected.progressItems.filter((item) => item?.visible).map(projection);
        assert.deepEqual(visibleActual, visibleExpected);
      }
      const expectedCoverage = expected.parserAudit?.coverage || null;
      if (expectedCoverage) {
        for (const key of ['unknownLeaves', 'unknownVisualElements', 'duplicateLeaves', 'coveragePercent']) {
          if (Object.prototype.hasOwnProperty.call(expectedCoverage, key)) assert.equal(actual.parserAudit?.coverage?.[key], expectedCoverage[key], `coverage.${key}`);
        }
      }
    });
  }
});

test('captured request traces replay through the canonical reducer', async (t) => {
  const traceFiles = await walk(ROOT, 'request-trace.json');
  for (const tracePath of traceFiles) {
    await t.test(path.relative(ROOT, tracePath), async () => {
      const trace = JSON.parse(await fs.readFile(tracePath, 'utf8'));
      const replay = replayRequestTrace(trace);
      assert.equal(replay.requestId, trace.requestId);
    });
  }
});
