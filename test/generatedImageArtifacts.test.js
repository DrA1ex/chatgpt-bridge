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

test('historical generated images remain artifacts while an Edit control is excluded from reasoning', async () => {
  const parser = await createAssistantFixtureParser();
  const snapshot = parser.parse(`
    <section data-testid="conversation-turn-9" data-turn="assistant" data-turn-id="turn-image-history">
      <div data-message-author-role="assistant" data-message-id="message-image-history">
        <button data-testid="cot-v5-edit-image" aria-label="Редактировать">Редактировать</button>
        <figure data-testid="image-generation-result">
          <img alt="Generated image one" src="https://chatgpt.com/backend-api/estuary/content?id=history-one&amp;sig=first" width="1024" height="1024">
        </figure>
        <figure data-testid="image-generation-result">
          <img alt="Generated image two" src="https://chatgpt.com/backend-api/estuary/content?id=history-two&amp;sig=second" width="1024" height="1024">
        </figure>
      </div>
    </section>
  `);

  assert.equal(snapshot.artifacts.length, 2);
  assert.equal(snapshot.artifacts.every((artifact) => artifact.kind === 'image'), true);
  assert.equal((snapshot.progressItems || []).some((item) => /редактировать/i.test(item.text || '')), false);
  assert.doesNotMatch(snapshot.thinking || '', /редактировать/i);
});

test('historical multi-image picker keeps full outputs and ignores its thumbnail copies', async () => {
  const parser = await createAssistantFixtureParser();
  const fullImages = [1, 2, 3].map((number) => `
    <figure data-testid="image-generation-result">
      <div role="button">
        <img alt="Generated image ${number}" src="https://chatgpt.com/backend-api/estuary/content?id=full-${number}&amp;sig=full" width="1024" height="1024">
        <img alt="Generated image ${number}" src="https://chatgpt.com/backend-api/estuary/content?id=full-${number}&amp;sig=crossfade" width="1024" height="1024">
      </div>
    </figure>`).join('');
  const thumbnails = [1, 2, 3].map((number) => `
    <button aria-label="Show generated image ${number}">
      <img alt="Generated image ${number}" src="https://chatgpt.com/backend-api/estuary/content?id=full-${number}&amp;sig=thumbnail" width="48" height="48" data-fake-complete="false" data-fake-natural-width="0">
    </button>`).join('');
  const snapshot = parser.parse(`
    <section data-testid="conversation-turn-10" data-turn="assistant" data-turn-id="turn-image-picker">
      <div data-message-author-role="assistant" data-message-id="message-image-picker">
        <div class="generated-output-stack">${fullImages}</div>
        <nav aria-label="Generated image picker">${thumbnails}</nav>
      </div>
    </section>
  `);

  assert.equal(snapshot.artifacts.length, 3);
  assert.equal(
    snapshot.artifacts.map((artifact) => artifact.name).join('|'),
    'Generated image 1|Generated image 2|Generated image 3',
  );
  assert.equal(new Set(snapshot.artifacts.map((artifact) => artifact.id)).size, 3);
});

test('an unloaded lazy Estuary image is published so Bridge can fetch it directly', async () => {
  const parser = await createAssistantFixtureParser();
  const snapshot = parser.parse(`
    <section data-testid="conversation-turn-11" data-turn="assistant" data-turn-id="turn-lazy-image">
      <div data-message-author-role="assistant">
        <figure data-testid="image-generation-result">
          <img loading="lazy" alt="Generated lazy image" src="https://chatgpt.com/backend-api/estuary/content?id=lazy-output&amp;sig=signed" width="1024" height="1024" data-fake-complete="false" data-fake-natural-width="0">
        </figure>
      </div>
    </section>
  `);

  assert.equal(snapshot.artifacts.length, 1);
  assert.equal(snapshot.artifacts[0].name, 'Generated lazy image');
  assert.equal(snapshot.artifacts[0].downloadable, true);
});

test('a historical lazy image exposed through srcset is still an artifact', async () => {
  const parser = await createAssistantFixtureParser();
  const snapshot = parser.parse(`
    <section data-testid="conversation-turn-12" data-turn="assistant" data-turn-id="turn-srcset-image">
      <figure data-testid="image-generation-result">
        <img loading="lazy" alt="Generated srcset image" srcset="https://chatgpt.com/backend-api/estuary/content?id=srcset-output&amp;sig=signed 1024w" width="1024" height="1024" data-fake-complete="false">
      </figure>
    </section>
  `);

  assert.equal(snapshot.artifacts.length, 1);
  assert.match(snapshot.artifacts[0].downloadUrl, /id=srcset-output/);
});
