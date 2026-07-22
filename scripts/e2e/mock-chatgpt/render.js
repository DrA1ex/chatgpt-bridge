import { markdownProjection } from './markdown.js';

function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function renderInline(value = '') {
  let text = escapeHtml(value);
  text = text.replace(/``\s*([^\n]*?)\s*``/g, '<code>$1</code>');
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  return text;
}

function renderMarkdown(markdown = '') {
  const projection = markdownProjection(markdown);
  return projection.blocks.map((block, index) => {
    if (block.type === 'code_block') {
      return `<div class="code-block cm-editor" data-testid="code-content-${index}" data-language="${escapeHtml(block.language)}"><div class="code-toolbar"><span>${escapeHtml(block.language)}</span><button type="button" aria-label="Copy code">Copy</button></div><pre data-code-block-content="true"><code class="language-${escapeHtml(block.language)}">${escapeHtml(block.code)}</code></pre></div>`;
    }
    return `<p>${renderInline(block.markdown).replaceAll('\n', '<br>')}</p>`;
  }).join('');
}

function renderArtifact(artifact = {}) {
  const phase = String(artifact.phase || 'READY');
  const pending = /PEND|GENERAT|LOAD|RUN/i.test(phase);
  const id = escapeHtml(artifact.id);
  return `<div class="artifact-card" data-testid="artifact-card-${id}" data-artifact-id="${id}" data-state="${escapeHtml(phase)}">
    <div class="artifact-icon">${artifact.mime === 'application/zip' ? 'ZIP' : 'FILE'}</div>
    <div class="artifact-copy"><strong>${escapeHtml(artifact.name)}</strong><span>${pending ? 'Generating…' : escapeHtml(artifact.mime || 'application/octet-stream')}</span></div>
    <button type="button" data-testid="artifact-preview-button" data-preview-artifact-id="${id}">Preview</button>
    <a role="button" data-testid="artifact-download-button" href="${escapeHtml(artifact.url || `/artifacts/${encodeURIComponent(artifact.id || '')}`)}" download="${escapeHtml(artifact.name)}">Download</a>
  </div>`;
}

function renderArtifactPreview(artifact = {}) {
  const id = escapeHtml(artifact.id);
  const name = escapeHtml(artifact.name || 'artifact');
  const previewId = `artifact-text-preview-${encodeURIComponent(artifact.name || artifact.id || 'artifact')}`;
  const preview = artifact.previewText
    ? `<div id="${escapeHtml(previewId)}" class="artifact-text-preview"><pre><code>${escapeHtml(artifact.previewText)}</code></pre></div>`
    : `<div class="artifact-binary-preview" data-testid="artifact-binary-preview">${escapeHtml(artifact.mime || 'application/octet-stream')}</div>`;
  return `<div class="artifact-preview-backdrop" role="dialog" aria-modal="true" aria-label="${name}" data-artifact-preview-dialog="${id}" hidden>
    <div data-testid="fullscreen-shell-body" class="artifact-preview-shell">
      <div data-testid="popcorn-toolbar" class="artifact-preview-toolbar"><h2>${name}</h2><div><a role="button" data-testid="artifact-preview-download-button" aria-label="Download ${name}" href="${escapeHtml(artifact.url || `/artifacts/${encodeURIComponent(artifact.id || '')}`)}" download="${name}">Download</a><button type="button" aria-label="Close preview" data-artifact-preview-close>Close</button></div></div>
      ${preview}
    </div>
  </div>`;
}

function renderComposerAttachments(attachments = []) {
  return `<div class="composer-attachments" data-testid="composer-attachments">${Array.from(attachments || []).map((item) => `<div class="attachment-chip" data-testid="composer-attachment" data-attachment-id="${escapeHtml(item.id)}"><span>${escapeHtml(item.name)}</span><button type="button" aria-label="Remove ${escapeHtml(item.name)}" data-testid="remove-attachment-button" data-remove-attachment="${escapeHtml(item.id || item.name)}">×</button></div>`).join('')}</div>`;
}

function renderTurn(turn = {}, index = 0) {
  const role = turn.role === 'assistant' ? 'assistant' : 'user';
  const reasoning = !turn.final && Array.isArray(turn.progressItems) && turn.progressItems.length
    ? `<div class="reasoning" data-testid="cot-v5-${escapeHtml(turn.key)}" role="status" aria-live="polite">${turn.progressItems.map((item) => `<div data-progress-id="${escapeHtml(item.logicalId || item.id || '')}" data-state="${escapeHtml(item.state || 'active')}">${escapeHtml(item.text || '')}</div>`).join('')}</div>`
    : '';
  const artifacts = Array.isArray(turn.artifacts) ? turn.artifacts.map(renderArtifact).join('') : '';
  return `<section data-testid="conversation-turn-${index}" data-turn="${role}" data-turn-id="${escapeHtml(turn.key)}">
    ${reasoning}
    <div class="turn-body" data-message-author-role="${role}" data-message-id="${escapeHtml(turn.messageId || turn.key)}" data-message-model-slug="gpt-mock">
      <div class="markdown prose">${role === 'assistant' ? renderMarkdown(turn.text || '') : `<p>${escapeHtml(turn.text || '')}</p>`}</div>
      ${artifacts}
      ${role === 'assistant' && turn.final ? '<div role="group" aria-label="Response actions"><button data-testid="copy-turn-action-button">Copy</button></div>' : ''}
    </div>
  </section>`;
}

function renderSession(session = {}) {
  const id = escapeHtml(session.id);
  const triggerId = `session-menu-trigger-${id}`;
  const menuId = `session-menu-${id}`;
  return `<li data-session-id="${id}"><a href="/c/${id}">${escapeHtml(session.title || session.id)}</a><button id="${triggerId}" data-testid="conversation-options-button" aria-haspopup="menu" aria-controls="${menuId}" aria-expanded="false">•••</button><div id="${menuId}" class="floating-menu session-menu" role="menu" aria-labelledby="${triggerId}" hidden><button type="button" role="menuitem" data-testid="delete-chat-menu-item">Delete chat</button></div></li>`;
}

function renderIntelligencePicker(state = {}) {
  const efforts = ['instant', 'low', 'medium', 'high', 'xhigh'];
  const models = ['GPT Mock', 'GPT Mock Thinking'];
  const effortOptions = efforts.map((value) => `<button type="button" role="menuitemradio" data-intelligence-kind="effort" data-value="${value}" aria-checked="${state.selectedEffort === value}">${value}</button>`).join('');
  const modelOptions = models.map((value) => `<button type="button" role="menuitemradio" data-intelligence-kind="model" data-value="${escapeHtml(value)}" aria-checked="${state.selectedModel === value}">${escapeHtml(value)}</button>`).join('');
  return `<div id="intelligence-picker" class="floating-menu intelligence-picker" role="menu" data-testid="composer-intelligence-picker-content" hidden><button id="model-submenu-trigger" type="button" role="menuitem" aria-haspopup="menu" aria-controls="model-submenu" data-has-submenu="true">${escapeHtml(state.selectedModel || 'GPT Mock')}</button><div role="group" aria-label="Reasoning effort">${effortOptions}</div></div><div id="model-submenu" class="floating-menu model-submenu" role="menu" aria-labelledby="model-submenu-trigger" hidden>${modelOptions}</div>`;
}

export function renderMockChatPage(state = {}) {
  const sessions = Array.from(state.sessions || []).map(renderSession).join('');
  const turns = Array.from(state.turns || []).map(renderTurn).join('');
  const previews = Array.from(state.turns || []).flatMap((turn) => Array.from(turn.artifacts || [])).map(renderArtifactPreview).join('');
  const generation = state.generating ? '<button type="button" data-testid="stop-button" aria-label="Stop generating">Stop</button>' : '<button type="submit" data-testid="send-button" aria-label="Send prompt">Send</button>';
  return `<!doctype html>
<html lang="en" data-bridge-mock-chatgpt="true"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(state.title || 'Mock ChatGPT')}</title><link rel="stylesheet" href="/mock-chatgpt.css"></head>
<body data-state="${escapeHtml(state.phase || 'idle')}">
<div class="app-shell">
  <aside><div class="brand">MockGPT <span>Local E2E</span></div><button data-testid="new-chat-button">New chat</button><nav><ul>${sessions}</ul></nav></aside>
  <main id="main" data-testid="chat-main">
    <header><button id="model-trigger" data-testid="model-switcher-dropdown-button" aria-haspopup="menu" aria-controls="intelligence-picker" aria-expanded="false">${escapeHtml(state.selectedModel || 'GPT Mock')}</button><button id="effort-trigger" data-testid="reasoning-effort-button" aria-haspopup="menu" aria-controls="intelligence-picker" aria-expanded="false">${escapeHtml(state.selectedEffort || 'high')}</button><span class="badge">offline deterministic state machine</span>${renderIntelligencePicker(state)}</header>
    <div id="conversation" aria-live="polite">${turns || '<div class="empty"><h1>How can I help?</h1><p>This page is a deterministic ChatGPT-shaped fixture used by local E2E.</p></div>'}</div>
    <form data-testid="composer" id="composer">${renderComposerAttachments(state.attachments)}<input id="mock-file-input" type="file" multiple hidden><button type="button" data-testid="composer-attach-button" aria-label="Attach files">Attach</button><div id="prompt-textarea" contenteditable="true" role="textbox" data-testid="prompt-textarea" aria-label="Message ChatGPT"></div>${generation}</form>
  </main>
</div>
${previews}
<div id="delete-confirmation" class="dialog-backdrop" hidden><div role="dialog" aria-modal="true" aria-labelledby="delete-title" data-testid="delete-conversation-confirmation"><h2 id="delete-title">Delete chat?</h2><p>This permanently removes the selected local fixture conversation.</p><div class="dialog-actions"><button type="button" data-dialog-cancel>Cancel</button><button type="button" data-testid="delete-conversation-confirm-button" data-destructive="true" data-dialog-confirm>Delete</button></div></div></div>
<script>
window.__BRIDGE_MOCK_STATE__=${JSON.stringify({ tabId: state.tabId, sessionId: state.sessionId, phase: state.phase, revision: state.revision, model: state.selectedModel, effort: state.selectedEffort })};
(() => {
  const mock = window.__BRIDGE_MOCK_STATE__;
  const post = async (action, payload = {}) => await fetch('/api/tabs/' + mock.tabId, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...payload }) });
  const act = async (action, payload = {}) => { await post(action, payload); location.reload(); };
  const hideMenus = () => { document.querySelectorAll('[role="menu"]').forEach((menu) => { menu.hidden = true; }); document.querySelectorAll('[aria-expanded="true"]').forEach((trigger) => trigger.setAttribute('aria-expanded', 'false')); };
  const openMenu = (trigger, menu) => { const opening = menu.hidden; hideMenus(); menu.hidden = !opening; trigger.setAttribute('aria-expanded', String(opening)); };
  document.querySelector('[data-testid="new-chat-button"]')?.addEventListener('click', () => act('new-session'));
  document.querySelectorAll('[data-session-id] a').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); act('select-session', { sessionId: link.closest('[data-session-id]').dataset.sessionId }); }));
  let pendingDeleteSessionId = '';
  document.querySelectorAll('[data-session-id] [data-testid="conversation-options-button"]').forEach((button) => button.addEventListener('click', () => openMenu(button, document.getElementById(button.getAttribute('aria-controls')))));
  document.querySelectorAll('[data-testid="delete-chat-menu-item"]').forEach((button) => button.addEventListener('click', () => { pendingDeleteSessionId = button.closest('[data-session-id]').dataset.sessionId; hideMenus(); document.querySelector('#delete-confirmation').hidden = false; }));
  document.querySelector('[data-dialog-cancel]')?.addEventListener('click', () => { document.querySelector('#delete-confirmation').hidden = true; pendingDeleteSessionId = ''; });
  document.querySelector('[data-dialog-confirm]')?.addEventListener('click', () => { if (pendingDeleteSessionId) act('delete-session', { sessionId: pendingDeleteSessionId }); });
  const picker = document.querySelector('#intelligence-picker');
  for (const id of ['model-trigger', 'effort-trigger']) document.querySelector('#' + id)?.addEventListener('click', (event) => openMenu(event.currentTarget, picker));
  const modelOpener = document.querySelector('#model-submenu-trigger');
  const modelMenu = document.querySelector('#model-submenu');
  const showModelMenu = () => { modelMenu.hidden = false; };
  modelOpener?.addEventListener('mouseenter', showModelMenu);
  modelOpener?.addEventListener('pointerover', showModelMenu);
  modelOpener?.addEventListener('keydown', (event) => { if (event.key === 'ArrowRight' || event.key === 'Enter') showModelMenu(); });
  document.querySelectorAll('[data-intelligence-kind]').forEach((button) => button.addEventListener('click', () => act('intelligence', { options: { [button.dataset.intelligenceKind]: button.dataset.value } })));
  const fileInput = document.querySelector('#mock-file-input');
  const attachmentRoot = document.querySelector('[data-testid="composer-attachments"]');
  document.querySelector('[data-testid="composer-attach-button"]')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => {
    const attachments = Array.from(fileInput.files || []).map((file, index) => ({ id: 'browser-file-' + Date.now() + '-' + index, name: file.name, mime: file.type || 'application/octet-stream', size: file.size }));
    attachmentRoot.innerHTML = attachments.map((item) => '<div class="attachment-chip" data-testid="composer-attachment" data-attachment-id="' + item.id + '"><span>' + item.name.replace(/[<>&"]/g, '') + '</span><button type="button" aria-label="Remove ' + item.name.replace(/[<>&"]/g, '') + '" data-testid="remove-attachment-button" data-remove-attachment="' + item.id + '">×</button></div>').join('');
    void post('set-attachments', { attachments });
  });
  document.addEventListener('click', (event) => {
    const remove = event.target.closest?.('[data-remove-attachment]');
    if (remove) { remove.closest('[data-testid="composer-attachment"]')?.remove(); void post('remove-attachment', { attachmentId: remove.dataset.removeAttachment }); return; }
    const preview = event.target.closest?.('[data-preview-artifact-id]');
    if (preview) { const dialog = document.querySelector('[data-artifact-preview-dialog="' + preview.dataset.previewArtifactId + '"]'); if (dialog) dialog.hidden = false; return; }
    if (event.target.closest?.('[data-artifact-preview-close]')) event.target.closest('[role="dialog"]')?.setAttribute('hidden', '');
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { hideMenus(); document.querySelector('#delete-confirmation').hidden = true; } });
  document.querySelector('#composer')?.addEventListener('submit', (event) => { event.preventDefault(); const box = document.querySelector('#prompt-textarea'); const message = box?.innerText || ''; if (message.trim()) act('prompt', { message }); });
  document.querySelector('[data-testid="stop-button"]')?.addEventListener('click', () => act('cancel'));
  if (document.body.dataset.state !== 'idle') setTimeout(() => location.reload(), 250);
})();
</script>
</body></html>`;
}

export function renderMockCss() {
  return `:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#ececec;background:#212121}*{box-sizing:border-box}body{margin:0;background:#212121}.app-shell{display:grid;grid-template-columns:260px 1fr;min-height:100vh}aside{background:#171717;padding:14px;border-right:1px solid #333}.brand{font-weight:700;font-size:18px;margin:8px 4px 20px}.brand span,.badge{font-size:11px;font-weight:500;color:#9ca3af}aside button{width:100%;padding:10px;border:1px solid #444;border-radius:9px;background:#262626;color:#eee}ul{padding:0;list-style:none}li{display:flex;gap:6px;align-items:center;margin:4px 0}li a{flex:1;color:#ddd;text-decoration:none;padding:8px;border-radius:8px;overflow:hidden;text-overflow:ellipsis}li a:hover{background:#2a2a2a}li button{width:auto;border:0;background:transparent}main{display:grid;grid-template-rows:54px 1fr auto;max-height:100vh}header{display:flex;align-items:center;gap:8px;padding:8px 18px;border-bottom:1px solid #333}header button{background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:8px;padding:8px 12px}.badge{margin-left:auto}#conversation{overflow:auto;padding:32px max(24px,calc((100vw - 980px)/2)) 120px}.empty{text-align:center;margin-top:18vh;color:#aaa}section{padding:18px 0;border-bottom:1px solid #303030}article{max-width:800px;margin:auto}.message-content{line-height:1.65}.message-content p{white-space:normal}.sr-only{position:absolute;left:-9999px}.reasoning{background:#272727;border-left:3px solid #8b8b8b;padding:10px 14px;margin-bottom:14px;color:#cfcfcf}.reasoning div{padding:2px 0}.code-block{background:#111;border:1px solid #3a3a3a;border-radius:10px;overflow:hidden;margin:16px 0}.code-toolbar{display:flex;justify-content:space-between;padding:8px 12px;background:#202020;color:#aaa}.code-toolbar button{background:transparent;color:#ccc;border:0}.code-block pre{padding:16px;margin:0;overflow:auto}.artifact-card{display:flex;align-items:center;gap:12px;border:1px solid #454545;border-radius:12px;padding:12px;margin-top:12px;background:#292929}.artifact-icon{width:46px;height:46px;display:grid;place-items:center;border-radius:8px;background:#404040;font-size:11px}.artifact-copy{display:flex;flex:1;flex-direction:column}.artifact-copy span{font-size:12px;color:#aaa}.artifact-card a{color:#fff;border:1px solid #555;padding:8px 12px;border-radius:8px;text-decoration:none}#composer{position:sticky;bottom:0;display:flex;gap:8px;max-width:820px;width:calc(100% - 40px);margin:0 auto 20px;padding:10px;background:#303030;border:1px solid #4a4a4a;border-radius:18px}#prompt-textarea{min-height:42px;max-height:180px;overflow:auto;flex:1;padding:10px;outline:none}#composer button{align-self:flex-end;border:0;border-radius:10px;padding:10px 14px;background:#f2f2f2;color:#111}.floating-menu{position:absolute;z-index:20;min-width:220px;padding:6px;background:#2b2b2b;border:1px solid #4a4a4a;border-radius:10px;box-shadow:0 14px 40px #0008}.floating-menu[hidden],.dialog-backdrop[hidden]{display:none}.floating-menu button{display:block;width:100%;text-align:left;border:0;background:transparent;color:#eee;padding:9px;border-radius:7px}.floating-menu button:hover,.floating-menu [aria-checked="true"]{background:#414141}.session-menu{left:232px}.intelligence-picker{top:48px;left:18px}.model-submenu{top:48px;left:250px}.dialog-backdrop{position:fixed;inset:0;z-index:30;display:grid;place-items:center;background:#0009}.dialog-backdrop [role="dialog"]{width:min(420px,calc(100vw - 40px));padding:22px;background:#2b2b2b;border:1px solid #555;border-radius:14px}.dialog-actions{display:flex;justify-content:flex-end;gap:8px}.dialog-actions button{border:1px solid #555;border-radius:8px;background:#383838;color:#eee;padding:8px 12px}.dialog-actions [data-destructive="true"]{background:#a33;border-color:#b44}.composer-attachments{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.attachment-chip{display:flex;align-items:center;gap:5px;padding:5px 8px;border:1px solid #555;border-radius:8px;background:#262626;font-size:12px}.attachment-chip button{padding:0 4px!important;background:transparent!important;color:#ddd!important}.artifact-card button{color:#fff;border:1px solid #555;padding:8px 12px;border-radius:8px;background:transparent}.artifact-preview-backdrop{position:fixed;inset:0;z-index:40;display:grid;place-items:center;background:#000b}.artifact-preview-backdrop[hidden]{display:none}.artifact-preview-shell{width:min(900px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow:auto;background:#202020;border:1px solid #555;border-radius:14px}.artifact-preview-toolbar{position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#292929;border-bottom:1px solid #444}.artifact-preview-toolbar div{display:flex;gap:8px}.artifact-preview-toolbar a,.artifact-preview-toolbar button{color:#eee;background:#333;border:1px solid #555;border-radius:8px;padding:8px 10px;text-decoration:none}.artifact-text-preview,.artifact-binary-preview{padding:20px}.artifact-text-preview pre{white-space:pre-wrap}.artifact-binary-preview{min-height:240px;display:grid;place-items:center;color:#aaa}@media(max-width:800px){.app-shell{grid-template-columns:1fr}aside{display:none}#conversation{padding:20px 18px 110px}}`;
}
