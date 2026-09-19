import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createAssistantFixtureParser } from './helpers/offlineChatDom.js';

const fixtureUrl = new URL('./fixtures/chat-dom/captured/generated-image/01-ready.html', import.meta.url);

test('captured ChatGPT generated-image turn produces one logical READY image artifact', async () => {
  const parser = await createAssistantFixtureParser();
  const html = await fs.readFile(fixtureUrl, 'utf8');
  const snapshot = parser.parse(html);

  assert.equal(snapshot.phase, 'ASSISTANT_FINAL');
  assert.equal(snapshot.hasFinalMessage, true);
  assert.equal(snapshot.artifacts.length, 1);

  const artifact = snapshot.artifacts[0];
  assert.equal(artifact.kind, 'image');
  assert.equal(artifact.generatedImage, true);
  assert.equal(artifact.downloadable, true);
  assert.equal(artifact.downloadActionPresent, false);
  assert.equal(artifact.sourceTurnKey, 'request-WEB:b5e77e57-ddc5-44ae-920b-10a85765a3ae-2');
  assert.match(artifact.name, /Сформированное изображение/);
  assert.match(artifact.downloadUrl, /\/backend-api\/estuary\/content/);
  assert.equal(artifact.width, 1448);
  assert.equal(artifact.height, 1086);
});

test('captured ChatGPT generated-image turn keeps the artifact id when the signed URL rotates', async () => {
  const parser = await createAssistantFixtureParser();
  const html = await fs.readFile(fixtureUrl, 'utf8');
  const first = parser.parse(html).artifacts[0];
  const second = parser.parse(html.replaceAll('f8d999b325ab07935cfc945a313f273f33b6ead80a1c142c3ce1a34245474845', 'rotated-signature')).artifacts[0];

  assert.ok(first?.id);
  assert.equal(second?.id, first.id);
  assert.notEqual(second?.downloadUrl, first.downloadUrl);
});
