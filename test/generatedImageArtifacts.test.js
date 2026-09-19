import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createAssistantFixtureParser } from './helpers/offlineChatDom.js';

const fixtureUrl = new URL('./fixtures/chat-dom/generated-image-ready.html', import.meta.url);

test('generated image media is detected as a first-class artifact', async () => {
  const parser = await createAssistantFixtureParser();
  const html = await fs.readFile(fixtureUrl, 'utf8');
  const snapshot = parser.parse(html);
  assert.equal(snapshot.artifacts.length, 1);
  const artifact = snapshot.artifacts[0];
  assert.equal(artifact.kind, 'image');
  assert.equal(artifact.name, 'Generated image');
  assert.match(artifact.mime, /^image\//);
  assert.equal(artifact.downloadable, true);
  assert.equal(artifact.downloadActionPresent, false);
  assert.equal(artifact.sourceTurnKey, 'turn-generated-image');
  assert.match(artifact.downloadUrl, /\/backend-api\/estuary\/content/);
});

test('generated image keeps one stable artifact id when its signed media URL changes', async () => {
  const parser = await createAssistantFixtureParser();
  const html = await fs.readFile(fixtureUrl, 'utf8');
  const first = parser.parse(html).artifacts[0];
  const second = parser.parse(html.replace('sig=first', 'sig=second')).artifacts[0];
  assert.ok(first?.id);
  assert.equal(second?.id, first.id);
  assert.notEqual(second?.downloadUrl, first.downloadUrl);
});

test('ordinary assistant images are not promoted to generated artifacts', async () => {
  const parser = await createAssistantFixtureParser();
  const snapshot = parser.parse(`
    <section data-testid="conversation-turn-8" data-turn="assistant" data-turn-id="turn-inline-image">
      <div data-message-author-role="assistant" data-message-id="message-inline-image">
        <p>Reference image:</p>
        <img alt="Documentation logo" src="https://example.com/logo.png" width="256" height="256">
      </div>
    </section>
  `);
  assert.equal(snapshot.artifacts.length, 0);
});
