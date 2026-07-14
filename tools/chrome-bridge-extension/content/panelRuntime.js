(() => {
  'use strict';

  function createPanelRuntime({
    CONFIG,
    CONTENT_SCRIPT_VERSION,
    DEFAULT_CONFIG,
    EXTENSION_VERSION,
    authCheckUrl,
    connect,
    disconnectTransport,
    extensionHttpJson,
    getActiveRequest,
    getClientId,
    getCurrentSession,
    publicRequestStatus,
    saveConfigPatch,
  } = {}) {
    let panelState = { status: 'starting', lastError: '', connectedAt: 0, busy: '', compatibility: null, bridgeVersion: '' };
    const localLogs = [];

  function safeJsonParse(raw) {
    try { return JSON.parse(raw); } catch { return null; }
  }

  function safeUrlPath(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      return `${parsed.origin}${parsed.pathname}`;
    } catch { return String(rawUrl || '').slice(0, 120); }
  }


  function recordLocalLog(type, details = {}) {
    const entry = { time: new Date().toISOString(), type, details };
    localLogs.push(entry);
    while (localLogs.length > 200) localLogs.shift();
    updatePanel();
  }

  function summarizePayload(payload = {}) {
    return {
      type: payload.type || 'unknown',
      requestId: payload.requestId,
      commandId: payload.commandId,
      eventType: payload.event?.type,
      textLength: typeof payload.text === 'string' ? payload.text.length : undefined,
      answerLength: typeof payload.answer === 'string' ? payload.answer.length : undefined,
    };
  }

  function setPanelBusy(label) {
    panelState.busy = label || '';
    updatePanel();
  }

  function setButtonBusy(button, busy, label = '') {
    if (!button) return;
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent || '';
    button.disabled = Boolean(busy);
    button.classList.toggle('cgb-loading', Boolean(busy));
    button.textContent = busy ? `${label || button.dataset.originalText}…` : button.dataset.originalText;
  }

  function setPanelStatus(status, lastError = '') {
    const changed = panelState.status !== status || panelState.lastError !== lastError;
    panelState.status = status;
    panelState.lastError = lastError;
    if (isPanelOkStatus(status)) panelState.connectedAt = Date.now();
    if (changed) {
      localLogs.push({ time: new Date().toISOString(), type: 'status', details: { status, lastError } });
      while (localLogs.length > 200) localLogs.shift();
    }
    updatePanel();
  }

  function isPanelOkStatus(status) {
    const text = String(status || '').toLowerCase();
    if (!text) return false;
    if (/(auth|invalid|error|failed|fail|disconnected|not connected|reconnecting|unreachable|offline|not configured|queueing)/i.test(text)) return false;
    return /(connected|reachable|accepted)/i.test(text);
  }

  function isChatConversationUrl(value = location.href) {
    let url;
    try { url = new URL(String(value || location.href), location.origin); } catch { return false; }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/') return true;
    if (/^\/c\/[^/]+$/i.test(path)) return true;
    if (/^\/g\/[^/]+(?:\/c\/[^/]+)?$/i.test(path)) return true;
    return false;
  }

  function panelStatusView() {
    const status = String(panelState.status || '').toLowerCase();
    const compatibility = panelState.compatibility;
    if (compatibility?.compatible === false || /update required|outdated|incompatible/i.test(status)) {
      return {
        tone: 'danger',
        eyebrow: 'Update required',
        title: compatibility?.status === 'bridge_outdated' ? 'Update the local bridge' : 'Reload the browser extension',
        detail: compatibility?.message || panelState.lastError || 'The installed extension is not compatible with this bridge version.',
      };
    }
    if (!CONFIG.token) {
      return {
        tone: 'setup',
        eyebrow: 'One-time setup',
        title: 'Connect this ChatGPT tab',
        detail: 'Open the local setup page, copy the Bridge token, then paste it below.',
      };
    }
    if (panelState.busy) {
      return { tone: 'working', eyebrow: 'Working', title: panelState.busy, detail: 'Checking the local bridge connection…' };
    }
    if (isPanelOkStatus(panelState.status)) {
      return {
        tone: 'ok',
        eyebrow: 'Ready',
        title: getActiveRequest() ? 'Bridge is connected and working' : 'Bridge is connected',
        detail: getActiveRequest() ? `Current request: ${getActiveRequest().phase || getActiveRequest().requestId}` : 'This chat tab can receive prompts from the local bridge.',
      };
    }
    return {
      tone: 'danger',
      eyebrow: 'Needs attention',
      title: panelState.status || 'Not connected',
      detail: panelState.lastError || 'Check that the local bridge is running, then reconnect.',
    };
  }

  function syncFloatingPanelVisibility() {
    const root = document.getElementById('chatgpt-bridge-panel-root');
    if (!isChatConversationUrl()) {
      root?.remove();
      return;
    }
    if (!root) initFloatingPanel();
    else {
      root.hidden = false;
      updatePanel();
    }
  }

  function setFloatingPanelOpen(open) {
    const root = document.getElementById('chatgpt-bridge-panel-root');
    if (!root) return;
    const expanded = Boolean(open);
    root.classList.toggle('cgb-open', expanded);
    root.querySelector('#cgb-tab')?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  function initFloatingPanel() {
    if (!isChatConversationUrl()) return;
    if (document.getElementById('chatgpt-bridge-panel-root')) {
      updatePanel();
      return;
    }
    const root = document.createElement('div');
    root.id = 'chatgpt-bridge-panel-root';
    root.innerHTML = `
      <style>
        #chatgpt-bridge-panel-root{position:fixed;right:0;bottom:88px;z-index:2147483647;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171717;color-scheme:light dark;pointer-events:none}
        #cgb-launcher{pointer-events:auto;width:132px;transform:translateX(calc(100% - 38px));transition:transform .22s cubic-bezier(.2,.8,.2,1);will-change:transform}
        #cgb-launcher:hover,#cgb-launcher:focus-within,#chatgpt-bridge-panel-root.cgb-open #cgb-launcher{transform:translateX(0)}
        #cgb-tab{appearance:none;display:flex;align-items:center;gap:9px;width:132px;min-height:42px;padding:7px 12px 7px 7px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:rgba(24,24,27,.94);color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.24);backdrop-filter:blur(14px);cursor:pointer;transition:box-shadow .18s ease,background .18s ease;user-select:none;overflow:hidden}
        #cgb-tab:hover{box-shadow:0 14px 34px rgba(0,0,0,.3);background:#111113}
        #cgb-tab:focus-visible{outline:3px solid rgba(59,130,246,.38);outline-offset:2px}
        #cgb-mark{position:relative;display:grid;place-items:center;flex:0 0 auto;width:26px;height:26px;border-radius:9px;background:linear-gradient(145deg,#4f46e5,#2563eb);font-weight:800;font-size:12px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.22)}
        #cgb-label{white-space:nowrap;font-weight:650;opacity:0;transform:translateX(7px);visibility:hidden;transition:opacity .14s ease,transform .2s cubic-bezier(.2,.8,.2,1),visibility 0s linear .2s}
        #cgb-launcher:hover #cgb-label,#cgb-launcher:focus-within #cgb-label,#chatgpt-bridge-panel-root.cgb-open #cgb-label{opacity:1;transform:translateX(0);visibility:visible;transition-delay:.045s,.045s,0s}
        #cgb-dot{position:absolute;right:-2px;bottom:-2px;width:9px;height:9px;border:2px solid #18181b;border-radius:50%;background:#a1a1aa;box-shadow:0 0 0 2px rgba(161,161,170,.12)}
        #cgb-tab.cgb-ok #cgb-dot{background:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,.16)}
        #cgb-tab.cgb-bad #cgb-dot{background:#fb7185;box-shadow:0 0 0 3px rgba(251,113,133,.17)}
        #cgb-tab.cgb-unconfigured #cgb-dot,#cgb-tab.cgb-busy #cgb-dot{background:#fbbf24;animation:cgb-pulse 1.25s ease infinite}
        @keyframes cgb-pulse{0%,100%{opacity:1}50%{opacity:.38}}
        #cgb-panel{pointer-events:auto;display:none;position:absolute;right:14px;bottom:54px;width:min(390px,calc(100vw - 28px));box-sizing:border-box;background:#fff;color:#18181b;border:1px solid rgba(0,0,0,.1);border-radius:20px;box-shadow:0 24px 70px rgba(0,0,0,.28);overflow:hidden}
        #chatgpt-bridge-panel-root.cgb-open #cgb-panel{display:block}
        #cgb-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 18px 12px}
        #cgb-header h3{margin:0;font-size:17px;letter-spacing:-.01em}#cgb-header p{margin:3px 0 0;color:#71717a;font-size:12px}
        #cgb-close{appearance:none;border:0;background:transparent;color:#71717a;width:30px;height:30px;border-radius:9px;font-size:20px;line-height:1;cursor:pointer}#cgb-close:hover{background:#f4f4f5;color:#18181b}
        #cgb-state{margin:0 18px 14px;padding:13px 14px;border-radius:14px;border:1px solid #e4e4e7;background:#fafafa}
        #cgb-state[data-tone="ok"]{border-color:#bbf7d0;background:#f0fdf4}#cgb-state[data-tone="danger"]{border-color:#fecdd3;background:#fff1f2}#cgb-state[data-tone="working"],#cgb-state[data-tone="setup"]{border-color:#fde68a;background:#fffbeb}
        #cgb-state-eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:10px;font-weight:750;color:#71717a}#cgb-state-title{font-size:14px;font-weight:700;margin-top:2px}#cgb-state-detail{font-size:12px;color:#52525b;margin-top:3px;white-space:pre-wrap}
        #cgb-form{padding:0 18px 18px}#cgb-form label{display:flex;justify-content:space-between;gap:8px;margin:12px 0 5px;color:#52525b;font-size:12px;font-weight:650}
        .cgb-field{display:flex;align-items:center;gap:6px}.cgb-field input{box-sizing:border-box;min-width:0;flex:1;padding:10px 11px;border:1px solid #d4d4d8;border-radius:11px;background:#fff;color:#18181b;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;outline:none}.cgb-field input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.12)}
        .cgb-icon-button{appearance:none;border:1px solid #d4d4d8;background:#fff;color:#52525b;border-radius:10px;padding:9px;cursor:pointer}.cgb-icon-button:hover{background:#f4f4f5}
        #cgb-actions{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:14px}.cgb-button{appearance:none;border:1px solid #d4d4d8;border-radius:11px;padding:10px 13px;background:#fff;color:#27272a;font-weight:650;cursor:pointer}.cgb-button:hover{background:#f4f4f5}.cgb-button-primary{border-color:#2563eb;background:#2563eb;color:#fff}.cgb-button-primary:hover{background:#1d4ed8}.cgb-button:disabled{opacity:.6;cursor:wait}.cgb-loading::before{content:'⟳ ';display:inline-block;animation:cgb-spin .9s linear infinite}@keyframes cgb-spin{to{transform:rotate(360deg)}}
        #cgb-help{margin:10px 0 0;color:#71717a;font-size:11px}
        #cgb-advanced{border-top:1px solid #e4e4e7;padding:12px 18px 16px;background:#fafafa}#cgb-advanced summary{cursor:pointer;color:#52525b;font-weight:650;font-size:12px;user-select:none}#cgb-advanced-grid{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}#cgb-advanced-grid .cgb-button{font-size:11px;padding:7px 9px}
        #cgb-debug-state,#cgb-log{white-space:pre-wrap;overflow:auto;max-height:150px;margin:10px 0 0;padding:9px;border-radius:10px;background:#18181b;color:#e4e4e7;font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
        #cgb-footer{display:flex;justify-content:space-between;gap:10px;margin-top:10px;color:#a1a1aa;font:10px ui-monospace,SFMono-Regular,Menlo,monospace}
        @media(prefers-reduced-motion:reduce){#cgb-launcher,#cgb-label{transition:none}}
        @media(prefers-color-scheme:dark){#cgb-panel{background:#18181b;color:#f4f4f5;border-color:#3f3f46}#cgb-header p,#cgb-state-detail,#cgb-form label,#cgb-help,#cgb-advanced summary{color:#a1a1aa}#cgb-close:hover,.cgb-icon-button:hover,.cgb-button:hover{background:#27272a;color:#f4f4f5}#cgb-state{background:#202024;border-color:#3f3f46}#cgb-state[data-tone="ok"]{background:#10251a;border-color:#166534}#cgb-state[data-tone="danger"]{background:#30151b;border-color:#9f1239}#cgb-state[data-tone="working"],#cgb-state[data-tone="setup"]{background:#2b2411;border-color:#854d0e}.cgb-field input,.cgb-icon-button,.cgb-button{background:#202024;color:#f4f4f5;border-color:#3f3f46}#cgb-advanced{background:#151518;border-color:#3f3f46}}
      </style>
      <div id="cgb-launcher"><button id="cgb-tab" type="button" aria-label="Open ChatGPT Bridge settings" aria-expanded="false"><span id="cgb-mark">B<span id="cgb-dot" aria-hidden="true"></span></span><span id="cgb-label">Bridge</span></button></div>
      <section id="cgb-panel" aria-label="ChatGPT Bridge setup">
        <div id="cgb-header"><div><h3>ChatGPT Bridge</h3><p>Connect this chat to your local bridge.</p></div><button id="cgb-close" type="button" title="Close" aria-label="Close">×</button></div>
        <div id="cgb-state" data-tone="setup"><div id="cgb-state-eyebrow">Starting</div><div id="cgb-state-title">Checking connection</div><div id="cgb-state-detail">Connecting to the local bridge…</div></div>
        <div id="cgb-form">
          <label for="cgb-server"><span>Local bridge URL</span><span>Step 1</span></label>
          <div class="cgb-field"><input id="cgb-server" value="${escapeHtml(CONFIG.serverUrl)}" autocomplete="url" spellcheck="false"></div>
          <label for="cgb-token"><span>Bridge token</span><span>Step 2</span></label>
          <div class="cgb-field"><input id="cgb-token" type="password" value="${escapeHtml(CONFIG.token)}" placeholder="Copy from the local /setup page" autocomplete="off" spellcheck="false"><button id="cgb-token-toggle" class="cgb-icon-button" type="button" aria-label="Show token" title="Show token">Show</button></div>
          <div id="cgb-actions"><button id="cgb-save" class="cgb-button cgb-button-primary" type="button">Save & connect</button><button id="cgb-setup" class="cgb-button" type="button">Open setup guide</button></div>
          <p id="cgb-help">The Bridge token is local and separate from the API token. It is stored in this ChatGPT origin for this browser profile.</p>
        </div>
        <details id="cgb-advanced"><summary>Advanced & diagnostics</summary><div id="cgb-advanced-grid"><button id="cgb-test" class="cgb-button" type="button">Test connection</button><button id="cgb-diag" class="cgb-button" type="button">Open diagnostics</button><button id="cgb-copy" class="cgb-button" type="button">Copy diagnostics</button></div><pre id="cgb-debug-state"></pre><pre id="cgb-log"></pre><div id="cgb-footer"><span id="cgb-versions"></span><span id="cgb-page-session"></span></div></details>
      </section>`;
    (document.documentElement || document.body).appendChild(root);
    const tabButton = root.querySelector('#cgb-tab');
    tabButton.addEventListener('click', () => setFloatingPanelOpen(!root.classList.contains('cgb-open')));
    root.querySelector('#cgb-close').addEventListener('click', () => setFloatingPanelOpen(false));
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && root.classList.contains('cgb-open')) {
        setFloatingPanelOpen(false);
        tabButton.focus();
      }
    });
    root.querySelector('#cgb-token-toggle').addEventListener('click', (event) => {
      const input = root.querySelector('#cgb-token');
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      event.currentTarget.textContent = reveal ? 'Hide' : 'Show';
      event.currentTarget.setAttribute('aria-label', reveal ? 'Hide token' : 'Show token');
    });
    root.querySelector('#cgb-save').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      setButtonBusy(button, true, 'Connecting');
      setPanelBusy('Connecting');
      try {
        saveConfigPatch({
          serverUrl: root.querySelector('#cgb-server').value.trim() || DEFAULT_CONFIG.serverUrl,
          token: root.querySelector('#cgb-token').value.trim(),
        });
        panelState.compatibility = null;
        disconnectTransport();
        connect();
        recordLocalLog('ui.save_connect', { serverUrl: CONFIG.serverUrl, hasToken: Boolean(CONFIG.token) });
      } finally {
        setTimeout(() => { setButtonBusy(button, false); setPanelBusy(''); }, 650);
        updatePanel();
      }
    });
    root.querySelector('#cgb-test').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      setButtonBusy(button, true, 'Testing');
      setPanelBusy('Testing connection');
      try {
        const serverUrl = root.querySelector('#cgb-server').value.trim() || DEFAULT_CONFIG.serverUrl;
        const token = root.querySelector('#cgb-token').value.trim();
        const result = await extensionHttpJson({ method: 'GET', url: new URL('/setup/status', serverUrl).toString(), timeout: 5000 });
        const auth = await extensionHttpJson({ method: 'GET', url: authCheckUrl(serverUrl, token), timeout: 5000 });
        setPanelStatus('token accepted', `${result.clients?.length || 0} tab(s) connected. Bridge token accepted: ${Boolean(auth.bridgeTokenAccepted)}.`);
        recordLocalLog('ui.test.ok', { clients: result.clients?.length || 0, bridgeTokenAccepted: Boolean(auth.bridgeTokenAccepted) });
      } catch (err) {
        setPanelStatus('connection test failed', err.message || String(err));
        recordLocalLog('ui.test.failed', { error: err.message || String(err) });
      } finally { setButtonBusy(button, false); setPanelBusy(''); }
    });
    root.querySelector('#cgb-setup').addEventListener('click', () => window.open(new URL('/setup', root.querySelector('#cgb-server').value.trim() || CONFIG.serverUrl).toString(), '_blank'));
    root.querySelector('#cgb-diag').addEventListener('click', () => window.open(new URL('/diagnostics', CONFIG.serverUrl).toString(), '_blank'));
    root.querySelector('#cgb-copy').addEventListener('click', async () => {
      const text = JSON.stringify({
        versions: { extension: EXTENSION_VERSION, content: CONTENT_SCRIPT_VERSION, bridge: panelState.bridgeVersion || '' },
        compatibility: panelState.compatibility,
        config: { serverUrl: CONFIG.serverUrl, hasToken: Boolean(CONFIG.token) },
        status: panelState,
        url: location.href,
        clientId: getClientId(),
        activeRequest: getActiveRequest() ? publicRequestStatus(getActiveRequest()) : null,
      }, null, 2);
      try { await navigator.clipboard.writeText(text); } catch {}
    });
    setTimeout(() => { if (!CONFIG.token || panelState.compatibility?.compatible === false) setFloatingPanelOpen(true); }, 450);
    updatePanel();
  }

  function updatePanel() {
    const root = document.getElementById('chatgpt-bridge-panel-root');
    if (!root) return;
    if (!isChatConversationUrl()) {
      root.remove();
      return;
    }
    const tab = root.querySelector('#cgb-tab');
    const statusCard = root.querySelector('#cgb-state');
    const view = panelStatusView();
    if (tab) {
      tab.classList.remove('cgb-ok', 'cgb-bad', 'cgb-unconfigured', 'cgb-busy');
      if (panelState.busy) tab.classList.add('cgb-busy');
      else if (!CONFIG.token) tab.classList.add('cgb-unconfigured');
      else if (view.tone === 'ok') tab.classList.add('cgb-ok');
      else tab.classList.add('cgb-bad');
      tab.title = `ChatGPT Bridge: ${view.title}`;
      tab.setAttribute('aria-label', `ChatGPT Bridge: ${view.title}. Open settings`);
    }
    if (statusCard) statusCard.dataset.tone = view.tone;
    const eyebrow = root.querySelector('#cgb-state-eyebrow');
    const title = root.querySelector('#cgb-state-title');
    const detail = root.querySelector('#cgb-state-detail');
    if (eyebrow) eyebrow.textContent = view.eyebrow;
    if (title) title.textContent = view.title;
    if (detail) detail.textContent = view.detail;
    const debug = root.querySelector('#cgb-debug-state');
    if (debug) {
      debug.textContent = JSON.stringify({
        status: panelState.status,
        last: panelState.lastError,
        compatibility: panelState.compatibility,
        serverUrl: CONFIG.serverUrl,
        hasToken: Boolean(CONFIG.token),
        clientId: getClientId(),
        activeRequest: getActiveRequest() ? publicRequestStatus(getActiveRequest()) : null,
        page: location.href,
      }, null, 2);
    }
    const logNode = root.querySelector('#cgb-log');
    if (logNode) logNode.textContent = localLogs.slice(-20).map((entry) => `${entry.time} ${entry.type} ${JSON.stringify(entry.details || {})}`).join('\n') || 'No local extension logs yet.';
    const versions = root.querySelector('#cgb-versions');
    if (versions) versions.textContent = `ext ${EXTENSION_VERSION || '?'} · content ${CONTENT_SCRIPT_VERSION}${panelState.bridgeVersion ? ` · bridge ${panelState.bridgeVersion}` : ''}`;
    const pageSession = root.querySelector('#cgb-page-session');
    if (pageSession) pageSession.textContent = getCurrentSession()?.id || 'new chat';
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  function compareVersionStrings(left = '', right = '') {
    const parse = (value) => {
      const match = String(value || '').trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
      return match ? [Number(match[1] || 0), Number(match[2] || 0), Number(match[3] || 0)] : null;
    };
    const a = parse(left);
    const b = parse(right);
    if (!a || !b) return null;
    for (let index = 0; index < 3; index += 1) {
      if (a[index] > b[index]) return 1;
      if (a[index] < b[index]) return -1;
    }
    return 0;
  }

  function applyCompatibilityStatus(compatibility = {}, fallbackStatus = '') {
    if (!compatibility || typeof compatibility !== 'object') return;
    panelState.compatibility = compatibility;
    if (compatibility.compatible === false) {
      setPanelStatus(fallbackStatus || (compatibility.status === 'bridge_outdated' ? 'bridge update required' : 'extension update required'), compatibility.message || 'Extension compatibility check failed.');
      setFloatingPanelOpen(true);
    } else if (compatibility.compatible === true && /update required|outdated|incompatible/i.test(String(panelState.status || ''))) {
      setPanelStatus('connected', compatibility.message || 'Extension compatibility check passed.');
    } else {
      updatePanel();
    }
  }


  function setBridgeVersion(value) {
    panelState.bridgeVersion = String(value || '');
    updatePanel();
  }

  function getBridgeVersion() {
    return panelState.bridgeVersion || '';
  }

    return Object.freeze({
      applyCompatibilityStatus,
      compareVersionStrings,
      getBridgeVersion,
      recordLocalLog,
      safeJsonParse,
      safeUrlPath,
      setBridgeVersion,
      setPanelStatus,
      summarizePayload,
      syncFloatingPanelVisibility,
      updatePanel,
    });
  }

  globalThis.ChatGptPanelRuntime = Object.freeze({ createPanelRuntime });
})();
