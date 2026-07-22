import test from 'node:test';
import assert from 'node:assert/strict';
import { MockChatGptStateMachine } from '../scripts/e2e/mock-chatgpt/state-machine.js';
import { renderMockChatPage } from '../scripts/e2e/mock-chatgpt/render.js';
import { startMockChatGptServer } from '../scripts/e2e/mock-chatgpt/server.js';
import { parseAssistantFixture } from './helpers/offlineChatDom.js';

test('mock ChatGPT layout exposes the selectors used by the content runtime', () => {
  const state = new MockChatGptStateMachine({ tabId: 7 });
  const html = renderMockChatPage(state.publicState());
  for (const selector of [
    'data-testid="chat-main"',
    'data-testid="prompt-textarea"',
    'data-testid="send-button"',
    'data-testid="model-switcher-dropdown-button"',
    'data-testid="reasoning-effort-button"',
    'data-testid="new-chat-button"',
    'data-testid="composer-intelligence-picker-content"',
    'role="menuitemradio"',
    'data-testid="delete-chat-menu-item"',
    'data-testid="delete-conversation-confirm-button"',
    'data-testid="composer-attach-button"',
    'type="file"',
  ]) assert.match(html, new RegExp(selector));
  assert.match(html, /data-bridge-mock-chatgpt="true"/);
});

test('mock state machine renders reasoning, markdown code and final response through parser-compatible DOM', async () => {
  const state = new MockChatGptStateMachine({ tabId: 8 });
  const prompt = 'Run reasoning test TEST_LOCAL_BEGIN and finish TEST_LOCAL_FINISH.';
  state.appendUser(prompt, { requestId: 'req-local', leaseId: 'lease-local', ownerServerInstanceId: 'server-local', responseEpoch: 0 });
  const snapshots = [];
  await state.generate(prompt, { onChange: async () => snapshots.push(renderMockChatPage(state.publicState())) });
  assert.ok(snapshots.some((html) => html.includes('data-testid="cot-v5-')));
  const finalHtml = snapshots.at(-1);
  assert.match(finalHtml, /class="code-block cm-editor"/);
  const assistantHtml = finalHtml.match(/<section[^>]+data-turn="assistant"[\s\S]*?<\/section>/)?.[0] || finalHtml;
  const parsed = await parseAssistantFixture(assistantHtml);
  assert.match(parsed.answer, /TEST_LOCAL_BEGIN/);
  assert.ok(parsed.codeBlocks.some((block) => block.language === 'javascript'));
  assert.equal(parsed.parserAudit.coverage.unknownLeaves, 0);
});


test('mock ChatGPT layout renders composer attachment chips and artifact preview contracts', async () => {
  const state = new MockChatGptStateMachine({ tabId: 10 });
  state.setAttachments([{ id: 'project-zip', name: 'project.zip', mime: 'application/zip', size: 42 }]);
  const prompt = 'Create and attach three separate downloadable files, not code blocks: one.txt containing the single line PREVIEW_ONE; two.json containing valid JSON {"marker":"PREVIEW_TWO"}; and three.csv containing the CSV rows key,value and marker,PREVIEW_THREE. Attach all three files in one response.';
  state.appendUser(prompt);
  await state.generate(prompt);
  const html = renderMockChatPage(state.publicState());
  assert.match(html, /data-testid="composer-attachment"/);
  assert.match(html, /aria-label="Remove project\.zip"/);
  assert.match(html, /data-testid="artifact-preview-button"/);
  assert.match(html, /role="dialog"[^>]+data-artifact-preview-dialog=/);
  assert.match(html, /data-testid="fullscreen-shell-body"/);
  assert.match(html, /data-testid="popcorn-toolbar"/);
  assert.match(html, /id="artifact-text-preview-one\.txt"/);
  assert.match(html, /data-testid="artifact-preview-download-button"/);
});

test('mock server can drive layout state by HTTP actions and serve rendered artifact links', async () => {
  const state = new MockChatGptStateMachine({ tabId: 9 });
  const artifactPrompt = 'Create one real ZIP file named layout-download.zip. The archive must contain exactly two files: alpha.txt with content LAYOUT_ALPHA and nested/beta.txt with content LAYOUT_BETA.';
  state.appendUser(artifactPrompt);
  await state.generate(artifactPrompt);
  const tab = { state, publishObservation: async () => {}, publicLayoutUrl: () => '' };
  const tabs = new Map([[9, tab]]);
  const server = await startMockChatGptServer({ tabs });
  try {
    const response = await fetch(`${server.loopbackOrigin}/api/tabs/9`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'intelligence', options: { model: 'GPT Mock Thinking', effort: 'instant' } }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.state.selectedModel, 'GPT Mock Thinking');
    assert.equal(payload.state.selectedEffort, 'instant');
    const page = await fetch(`${server.loopbackOrigin}/?tab=9`).then((value) => value.text());
    assert.match(page, /GPT Mock Thinking/);
    assert.match(page, /offline deterministic state machine/);
    const href = page.match(/data-testid="artifact-download-button" href="([^"]+)"/)?.[1] || '';
    assert.match(href, /^\/artifacts\//);
    const downloaded = await fetch(`${server.loopbackOrigin}${href}`);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get('content-type'), 'application/zip');
    assert.ok((await downloaded.arrayBuffer()).byteLength > 0);
  } finally { await server.close(); }
});
