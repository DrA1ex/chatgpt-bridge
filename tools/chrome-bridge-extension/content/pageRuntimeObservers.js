// Passive assistant-turn observation, network completion hints, and page lifecycle resync.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createPageRuntimeObservers(deps = {}) {
    const {
      CONFIG,
      DOM_PARSER,
      PASSIVE_TURN_POLICY,
      REQUEST_SNAPSHOT_POLICY,
      attachDomObserver,
      collectAndEmit,
      connect,
      diagnostic,
      findChatMain,
      getActiveRequest,
      getAssistantNodeFromTurn,
      getClientId,
      getCurrentSession,
      getTurnNodes,
      readAssistantNodeSnapshot,
      scheduleCollect,
      schedulePageStatus,
      scheduleTabObservation,
      send,
      startPageReadinessMonitor,
      startTabObserver,
      syncFloatingPanelVisibility,
      turnKey,
      turnRole,
      visibleText,
    } = deps;

    const HOOK_SOURCE = 'chatgpt-browser-bridge-network-hook';
    const HOOK_NONCE = `nonce-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const PASSIVE_TURN_STORAGE_PREFIX = 'chatgpt-bridge-observed-turns-v1:';
    let networkHookInjected = false;
    const passiveTurnState = {
      observer: null,
      root: null,
      timer: null,
      interval: null,
      sessionId: '',
      dirtyTurns: new Map(),
      scanRunning: false,
      scanAgain: false,
      pending: new Map(),
      emitted: new Map(),
      initializedSessions: new Set(),
      promptBoundary: null,
      liveSnapshots: new Map(),
    };

    function passiveStorageKey(sessionId = '') {
      return `${PASSIVE_TURN_STORAGE_PREFIX}${sessionId || 'new'}`;
    }

    function loadPassiveEmitted(sessionId) {
      if (passiveTurnState.initializedSessions.has(sessionId)) return;
      passiveTurnState.initializedSessions.add(sessionId);
      while (passiveTurnState.initializedSessions.size > 12) {
        const oldest = passiveTurnState.initializedSessions.values().next().value;
        passiveTurnState.initializedSessions.delete(oldest);
        for (const key of Array.from(passiveTurnState.emitted.keys())) {
          if (key.startsWith(`${oldest}:`)) passiveTurnState.emitted.delete(key);
        }
      }
      try {
        const parsed = JSON.parse(sessionStorage.getItem(passiveStorageKey(sessionId)) || '{}');
        for (const [key, signature] of Object.entries(parsed || {})) passiveTurnState.emitted.set(`${sessionId}:${key}`, String(signature || ''));
      } catch {}
    }

    function savePassiveEmitted(sessionId) {
      try {
        const sessionEntries = Array.from(passiveTurnState.emitted.entries())
          .filter(([key]) => key.startsWith(`${sessionId}:`))
          .slice(-200);
        for (const [key] of Array.from(passiveTurnState.emitted.entries())) {
          if (key.startsWith(`${sessionId}:`) && !sessionEntries.some(([kept]) => kept === key)) passiveTurnState.emitted.delete(key);
        }
        const entries = sessionEntries.map(([key, value]) => [key.slice(sessionId.length + 1), value]);
        sessionStorage.setItem(passiveStorageKey(sessionId), JSON.stringify(Object.fromEntries(entries)));
      } catch {}
    }

    function passiveTerminal(snapshot = {}) {
      return PASSIVE_TURN_POLICY.isTerminalSnapshot(snapshot, DOM_PARSER);
    }

    function passiveSnapshotSignature(snapshot = {}) {
      return JSON.stringify([
        snapshot.signature || '',
        (snapshot.artifacts || []).map((artifact) => [artifact.id || '', artifact.name || '', artifact.phase || '', artifact.downloadable ? 1 : 0]),
      ]);
    }

    function precedingUserPrompt(ref = {}) {
      const turns = getTurnNodes();
      const start = Math.min(Number(ref.index) - 1, turns.length - 1);
      for (let index = start; index >= 0; index -= 1) {
        const turn = turns[index];
        const role = typeof turnRole === 'function' ? turnRole(turn) : turn?.getAttribute?.('data-turn') || '';
        if (role !== 'user') continue;
        return {
          key: String(turnKey(turn, index) || `user-${index}`),
          text: String(typeof visibleText === 'function' ? visibleText(turn) : turn?.innerText || turn?.textContent || '').trim(),
        };
      }
      return { key: '', text: '' };
    }

    function baselinePassiveUserTurns(sessionId) {
      const turns = getTurnNodes();
      for (let index = 0; index < turns.length; index += 1) {
        const turn = turns[index];
        const role = typeof turnRole === 'function' ? turnRole(turn) : turn?.getAttribute?.('data-turn') || '';
        if (role !== 'user') continue;
        const key = String(turnKey(turn, index) || `user-${index}`);
        const value = String(typeof visibleText === 'function' ? visibleText(turn) : turn?.innerText || turn?.textContent || '').trim();
        if (value) passiveTurnState.liveSnapshots.set(`user:${sessionId}:${key}`, value);
      }
      while (passiveTurnState.liveSnapshots.size > 300) passiveTurnState.liveSnapshots.delete(passiveTurnState.liveSnapshots.keys().next().value);
    }

    function emitPassiveUserTurn(turn, index, reason = 'user-mutation') {
      const role = typeof turnRole === 'function' ? turnRole(turn) : turn?.getAttribute?.('data-turn') || '';
      if (role !== 'user') return false;
      const userPrompt = String(typeof visibleText === 'function' ? visibleText(turn) : turn?.innerText || turn?.textContent || '').trim();
      if (!userPrompt) return false;
      const session = getCurrentSession();
      const sessionId = String(session?.id || passiveTurnState.sessionId || 'new');
      const key = String(turnKey(turn, index) || `user-${index}`);
      const storageKey = `user:${sessionId}:${key}`;
      if (passiveTurnState.liveSnapshots.get(storageKey) === userPrompt) return false;
      passiveTurnState.liveSnapshots.set(storageKey, userPrompt);
      while (passiveTurnState.liveSnapshots.size > 300) passiveTurnState.liveSnapshots.delete(passiveTurnState.liveSnapshots.keys().next().value);
      send({
        type: 'observed.turn.snapshot',
        observedAt: new Date().toISOString(),
        reason,
        session,
        url: location.href,
        title: document.title,
        turnKey: key,
        userTurnKey: key,
        turnIndex: index,
        userPrompt,
        reasoning: '',
        progress: '',
        answer: '',
        phase: 'waiting-for-assistant',
        terminal: false,
      });
      return true;
    }

    function completeReasoningText(snapshot = {}) {
      const seen = new Set();
      const lines = [];
      for (const item of Array.isArray(snapshot.progressItems) ? snapshot.progressItems : []) {
        if (item?.kind !== 'thinking') continue;
        const value = String(item.text || '').trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        lines.push(value);
      }
      return lines.join('\n');
    }

    function completeProgressText(snapshot = {}) {
      const seen = new Set();
      const lines = [];
      for (const item of Array.isArray(snapshot.progressItems) ? snapshot.progressItems : []) {
        if (item?.kind === 'thinking') continue;
        const value = String(item.text || '').trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        lines.push(value);
      }
      return lines.join('\n');
    }

    function emitPassiveLiveSnapshot(ref, snapshot, session, sessionId, reason) {
      const user = precedingUserPrompt(ref);
      const userPrompt = user.text;
      const reasoning = completeReasoningText(snapshot);
      const progress = completeProgressText(snapshot);
      const answer = String(snapshot.answer || '');
      if (!userPrompt) return;
      const key = `${sessionId}:${ref.key}`;
      const signature = JSON.stringify([userPrompt, reasoning, progress, answer, snapshot.phase || '', snapshot.hasFinalMessage ? 1 : 0]);
      if (passiveTurnState.liveSnapshots.get(key) === signature) return;
      passiveTurnState.liveSnapshots.set(key, signature);
      while (passiveTurnState.liveSnapshots.size > 300) passiveTurnState.liveSnapshots.delete(passiveTurnState.liveSnapshots.keys().next().value);
      send({
        type: 'observed.turn.snapshot',
        observedAt: new Date().toISOString(),
        reason,
        session,
        url: location.href,
        title: document.title,
        turnKey: snapshot.turnKey || ref.key,
        userTurnKey: user.key,
        turnIndex: snapshot.turnIndex ?? ref.index,
        messageId: snapshot.messageId || '',
        modelSlug: snapshot.modelSlug || '',
        userPrompt,
        reasoning,
        progress,
        answer,
        phase: snapshot.phase || '',
        terminal: passiveTerminal(snapshot),
      });
    }

    function registerPassivePromptBoundary(request = {}, baselineTurnKeys = null) {
      // Prompt submission may assign a conversation id and change the URL.
      // Align observer state with that post-submit session before storing the
      // boundary; otherwise the next scan treats it as a session change and
      // clears the boundary before the assistant turn can be observed.
      const sessionId = ensurePassiveSession('passive-prompt-boundary');
      passiveTurnState.promptBoundary = {
        sessionId,
        submittedUserTurnKey: String(request.submittedUserTurnKey || ''),
        submittedUserTurnIndex: Number.isInteger(request.submittedUserTurnIndex) ? request.submittedUserTurnIndex : -1,
        baselineTurnKeys: new Set(baselineTurnKeys && typeof baselineTurnKeys[Symbol.iterator] === 'function'
          ? Array.from(baselineTurnKeys)
          : []),
        registeredAt: Date.now(),
      };
      queuePromptBoundaryTurns('passive-prompt-boundary');
      diagnostic('observed.turns.prompt_boundary', {
        sessionId,
        submittedUserTurnKey: passiveTurnState.promptBoundary.submittedUserTurnKey,
        submittedUserTurnIndex: passiveTurnState.promptBoundary.submittedUserTurnIndex,
        baselineTurnCount: passiveTurnState.promptBoundary.baselineTurnKeys.size,
      });
      schedulePassiveTurnScan('passive-prompt-boundary', 250);
    }

    function queuePromptBoundaryTurns(reason = 'passive-prompt-watch') {
      const boundary = passiveTurnState.promptBoundary;
      if (!boundary) return 0;
      if (Date.now() - Number(boundary.registeredAt || 0) > 15 * 60_000) {
        diagnostic('observed.turns.prompt_boundary.expired', {
          sessionId: boundary.sessionId || '',
          submittedUserTurnKey: boundary.submittedUserTurnKey || '',
        });
        passiveTurnState.promptBoundary = null;
        return 0;
      }
      const sessionId = ensurePassiveSession('prompt-boundary-rescan');
      if (passiveTurnState.promptBoundary !== boundary) return 0;
      let queued = 0;
      for (const ref of currentAssistantTurnRefs(16)) {
        if (!PASSIVE_TURN_POLICY.isAfterPromptBoundary(ref, boundary, sessionId)) continue;
        const storageKey = `${sessionId}:${ref.key}`;
        if (passiveTurnState.emitted.get(storageKey) === 'baseline') passiveTurnState.emitted.delete(storageKey);
        if (passiveTurnState.emitted.has(storageKey) && !passiveTurnState.pending.has(storageKey)) continue;
        passiveTurnState.dirtyTurns.set(ref.key, { ...ref, reason });
        queued += 1;
      }
      return queued;
    }

    function currentAssistantTurnRefs(limit = 80) {
      const allTurns = getTurnNodes();
      const offset = Math.max(0, allTurns.length - Math.max(1, Number(limit) || 80));
      const turns = allTurns.slice(offset);
      const result = [];
      for (let localIndex = 0; localIndex < turns.length; localIndex += 1) {
        const index = offset + localIndex;
        const key = turnKey(turns[index], index);
        if (!key) continue;
        const node = getAssistantNodeFromTurn(turns[index]);
        if (!node) continue;
        result.push({ key, node, turn: turns[index], index, turnCount: allTurns.length });
      }
      return result;
    }

    function markPassiveTurnDirty(turn, reason = 'mutation') {
      if (!turn?.isConnected) return;
      const allTurns = getTurnNodes();
      const index = allTurns.indexOf(turn);
      if (index < 0) return;
      const key = turnKey(turn, index);
      const node = getAssistantNodeFromTurn(turn);
      if (!key || !node) return;
      passiveTurnState.dirtyTurns.set(key, { key, node, turn, index, turnCount: allTurns.length, reason });
    }

    function markPassiveMutationRecords(records = []) {
      const marked = new Set();
      const addNode = (node) => {
        const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        const turn = element?.closest?.('[data-testid^="conversation-turn-"][data-turn], section[data-turn][data-turn-id], main section[data-turn]');
        if (!turn || marked.has(turn)) return;
        marked.add(turn);
        const allTurns = getTurnNodes();
        const index = allTurns.indexOf(turn);
        if (index >= 0 && emitPassiveUserTurn(turn, index, 'mutation')) return;
        markPassiveTurnDirty(turn, 'mutation');
      };
      for (const record of records) {
        addNode(record.target);
        for (const node of Array.from(record.addedNodes || [])) addNode(node);
      }
    }

    function baselinePassiveTurns(reason = 'baseline', options = {}) {
      const sessionId = getCurrentSession()?.id || 'new';
      loadPassiveEmitted(sessionId);
      const refs = currentAssistantTurnRefs(200);
      const latest = refs.at(-1) || null;
      const markAll = PASSIVE_TURN_POLICY.shouldBaselineAll(reason, options);
      for (const ref of refs) {
        const storageKey = `${sessionId}:${ref.key}`;
        if (markAll || ref !== latest) {
          passiveTurnState.pending.delete(storageKey);
          passiveTurnState.dirtyTurns.delete(ref.key);
          passiveTurnState.emitted.set(storageKey, 'baseline');
          continue;
        }
        const snapshot = readAssistantNodeSnapshot(ref.node, {
          turnCount: ref.turnCount,
          reason: `passive_observer:${reason}`,
          turnKey: ref.key,
          turnIndex: ref.index,
        });
        if (passiveTerminal(snapshot)) passiveTurnState.emitted.set(storageKey, 'baseline');
        else passiveTurnState.dirtyTurns.set(ref.key, { ...ref, reason: 'baseline-incomplete-latest' });
      }
      savePassiveEmitted(sessionId);
      diagnostic('observed.turns.baseline', { reason, sessionId, count: refs.length, markAll });
    }

    function ensurePassiveSession(reason = 'session-check') {
      const sessionId = getCurrentSession()?.id || 'new';
      if (passiveTurnState.sessionId === sessionId) return sessionId;
      passiveTurnState.sessionId = sessionId;
      passiveTurnState.dirtyTurns.clear();
      passiveTurnState.pending.clear();
      passiveTurnState.promptBoundary = null;
      passiveTurnState.liveSnapshots.clear();
      baselinePassiveUserTurns(sessionId);
      if (passiveTurnState.timer) {
        clearTimeout(passiveTurnState.timer);
        passiveTurnState.timer = null;
      }
      const hasStoredState = (() => {
        try { return Boolean(sessionStorage.getItem(passiveStorageKey(sessionId))); } catch { return false; }
      })();
      if (hasStoredState) loadPassiveEmitted(sessionId);
      else baselinePassiveTurns(reason);
      return sessionId;
    }

    function schedulePassiveTurnScan(reason = 'mutation', delayMs = 250) {
      clearTimeout(passiveTurnState.timer);
      passiveTurnState.timer = setTimeout(() => scanPassiveTurns(reason), Math.max(0, Number(delayMs) || 0));
    }

    function scanPassiveTurns(reason = 'poll') {
      if (passiveTurnState.scanRunning) {
        passiveTurnState.scanAgain = true;
        return;
      }
      passiveTurnState.scanRunning = true;
      try {
        const session = getCurrentSession();
        const sessionId = ensurePassiveSession('scan-session-change');
        loadPassiveEmitted(sessionId);
        const refs = Array.from(passiveTurnState.dirtyTurns.values());
        passiveTurnState.dirtyTurns.clear();
        if (!refs.length) return;
        const now = Date.now();
        for (const ref of refs) {
          if (!ref.node?.isConnected) continue;
          const storageKey = `${sessionId}:${ref.key}`;
          const boundary = passiveTurnState.promptBoundary;
          const afterPromptBoundary = PASSIVE_TURN_POLICY.isAfterPromptBoundary(ref, boundary, sessionId);
          // While an explicit passive prompt is pending, only assistant turns
          // created after its anchored user turn may satisfy that boundary.
          // ChatGPT can remount or re-key older assistant containers during a
          // later generation; treating those as new responses caused workflows
          // to fail early with no_materializable_artifacts.
          if (PASSIVE_TURN_POLICY.shouldSuppressOutsidePromptBoundary(ref, boundary, sessionId)) {
            passiveTurnState.pending.delete(storageKey);
            passiveTurnState.emitted.set(storageKey, 'baseline');
            continue;
          }
          // Once a passive turn is baselined or emitted, later toolbar/hover
          // mutations must not re-run the full response parser indefinitely.
          if (passiveTurnState.emitted.has(storageKey)) {
            if (afterPromptBoundary && passiveTurnState.emitted.get(storageKey) === 'baseline') {
              passiveTurnState.emitted.delete(storageKey);
            } else {
              continue;
            }
          }
          const snapshot = readAssistantNodeSnapshot(ref.node, {
            turnCount: ref.turnCount,
            reason: `passive_observer:${ref.reason || reason}`,
            turnKey: ref.key,
            turnIndex: ref.index,
          });
          emitPassiveLiveSnapshot(ref, snapshot, session, sessionId, reason);
          if (!passiveTerminal(snapshot)) {
            passiveTurnState.pending.delete(storageKey);
            if (afterPromptBoundary) {
              passiveTurnState.dirtyTurns.set(ref.key, { ...ref, reason: 'passive-prompt-incomplete' });
            }
            continue;
          }
          const signature = passiveSnapshotSignature(snapshot);
          const activeRequest = getActiveRequest();
          const disposition = PASSIVE_TURN_POLICY.activeRequestDisposition(snapshot, activeRequest, REQUEST_SNAPSHOT_POLICY);
          if (disposition === 'suppress-owned') {
            passiveTurnState.pending.delete(storageKey);
            passiveTurnState.emitted.set(storageKey, signature);
            continue;
          }
          if (disposition === 'defer') {
            const pending = passiveTurnState.pending.get(storageKey);
            if (!pending || pending.signature !== signature) passiveTurnState.pending.set(storageKey, { signature, since: now, ref });
            passiveTurnState.dirtyTurns.set(ref.key, { ...ref, reason: 'active-request-deferred' });
            schedulePassiveTurnScan('active-request-deferred', 850);
            continue;
          }
          if (passiveTurnState.emitted.get(storageKey) === signature) continue;
          const pending = passiveTurnState.pending.get(storageKey);
          if (!pending || pending.signature !== signature) {
            passiveTurnState.pending.set(storageKey, { signature, since: now, ref });
            passiveTurnState.dirtyTurns.set(ref.key, ref);
            schedulePassiveTurnScan('terminal-settle', 850);
            continue;
          }
          if (now - pending.since < 800) {
            passiveTurnState.dirtyTurns.set(ref.key, { ...ref, reason: 'terminal-settle' });
            continue;
          }
          passiveTurnState.pending.delete(storageKey);
          passiveTurnState.emitted.set(storageKey, signature);
          savePassiveEmitted(sessionId);
          const artifacts = Array.isArray(snapshot.artifacts)
            ? snapshot.artifacts.map((artifact) => ({ ...artifact, sourceClientId: getClientId(), observed: true }))
            : [];
          send({
            type: 'observed.turn.terminal',
            observedAt: new Date().toISOString(),
            reason,
            session,
            url: location.href,
            title: document.title,
            turnKey: snapshot.turnKey,
            turnIndex: snapshot.turnIndex,
            messageId: snapshot.messageId || '',
            modelSlug: snapshot.modelSlug || '',
            answer: snapshot.answer || '',
            responseBlocks: snapshot.responseBlocks || [],
            parserAudit: snapshot.parserAudit || null,
            artifacts,
          });
          if (afterPromptBoundary) passiveTurnState.promptBoundary = null;
          diagnostic('observed.turn.terminal', {
            sessionId,
            turnKey: snapshot.turnKey,
            artifactCount: artifacts.length,
            answerLength: String(snapshot.answer || '').length,
          });
        }
        for (const [key, pending] of Array.from(passiveTurnState.pending.entries())) {
          if (now - Number(pending.since || 0) > 30_000) passiveTurnState.pending.delete(key);
        }
        savePassiveEmitted(sessionId);
      } finally {
        passiveTurnState.scanRunning = false;
        if (passiveTurnState.scanAgain) {
          passiveTurnState.scanAgain = false;
          schedulePassiveTurnScan('scan-queued', 0);
        } else if (passiveTurnState.promptBoundary) {
          queuePromptBoundaryTurns('passive-prompt-watch');
          if (passiveTurnState.promptBoundary) schedulePassiveTurnScan('passive-prompt-watch', 850);
        }
      }
    }

    function attachPassiveTurnObserver() {
      const root = findChatMain();
      if (!root) {
        schedulePassiveTurnScan('root-missing', 750);
        return;
      }
      if (passiveTurnState.root === root && passiveTurnState.observer) return;
      try { passiveTurnState.observer?.disconnect(); } catch {}
      passiveTurnState.root = root;
      passiveTurnState.observer = new MutationObserver((records) => {
        markPassiveMutationRecords(records);
        if (passiveTurnState.dirtyTurns.size) schedulePassiveTurnScan('mutation', 250);
      });
      passiveTurnState.observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['data-state', 'data-message-id', 'data-turn-id', 'data-testid', 'aria-label', 'aria-expanded', 'href', 'download'],
      });
      schedulePassiveTurnScan('observer-attached', 500);
    }

    function startPassiveTurnObserver() {
      attachPassiveTurnObserver();
      ensurePassiveSession('first-observer-start');
      if (passiveTurnState.interval) clearInterval(passiveTurnState.interval);
      passiveTurnState.interval = setInterval(() => {
        attachPassiveTurnObserver();
        const sessionIdNow = ensurePassiveSession('poll-session-change');
        const recent = currentAssistantTurnRefs(4);
        for (const ref of recent) {
          const storageKey = `${sessionIdNow}:${ref.key}`;
          if (!passiveTurnState.emitted.has(storageKey) || passiveTurnState.pending.has(storageKey)) {
            passiveTurnState.dirtyTurns.set(ref.key, { ...ref, reason: 'poll' });
          }
        }
        if (passiveTurnState.dirtyTurns.size) schedulePassiveTurnScan('poll', 0);
      }, 5_000);
    }

    function injectNetworkHook() {
      if (!CONFIG.networkStreamEnabled || networkHookInjected) return;
      networkHookInjected = true;
      const script = document.createElement('script');
      script.textContent = `(() => {
        if (window.__chatgptBridgeNetworkHookInstalled) return;
        window.__chatgptBridgeNetworkHookInstalled = true;
        const SOURCE = ${JSON.stringify(HOOK_SOURCE)};
        const NONCE = ${JSON.stringify(HOOK_NONCE)};
        const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
        const shouldWatch = (url, contentType = '') => /chatgpt|openai|conversation|backend-api|responses|stream|event-stream/i.test(String(url || '') + ' ' + String(contentType || ''));
        const post = (payload) => window.postMessage({ source: SOURCE, nonce: NONCE, ...payload }, '*');
        const watchBody = async (kind, url, response) => {
          try {
            if (!response || !response.body || !decoder) return;
            const contentType = response.headers && response.headers.get ? response.headers.get('content-type') : '';
            if (!shouldWatch(url, contentType)) return;
            const reader = response.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) post({ type: 'network.chunk', kind, url: String(url || ''), text: decoder.decode(value, { stream: true }) });
            }
            post({ type: 'network.done', kind, url: String(url || '') });
          } catch (err) {
            post({ type: 'network.error', kind, url: String(url || ''), message: err && err.message ? err.message : String(err) });
          }
        };
        const originalFetch = window.fetch;
        if (typeof originalFetch === 'function') {
          window.fetch = async function bridgeFetch(input, init) {
            const response = await originalFetch.apply(this, arguments);
            try {
              const url = typeof input === 'string' ? input : input && input.url;
              watchBody('fetch', url, response.clone());
            } catch {}
            return response;
          };
        }
      })();`;
      (document.documentElement || document.head || document.body).appendChild(script);
      script.remove();
    }

    function handleNetworkMessage(event) {
      const activeRequest = getActiveRequest();
      if (event.source !== window) return;
      const payload = event.data;
      if (!payload || payload.source !== HOOK_SOURCE || payload.nonce !== HOOK_NONCE || !activeRequest) return;
      if (payload.type === 'network.done') {
        activeRequest.networkDone = true;
        diagnostic('network.done', { requestId: activeRequest.requestId, kind: payload.kind, url: payload.url });
        collectAndEmit(activeRequest);
      } else if (payload.type === 'network.error') {
        diagnostic('network.error', { requestId: activeRequest.requestId, kind: payload.kind, message: payload.message });
      }
    }

    function handlePageLocationChange() {
      schedulePageStatus('page.changed');
      scheduleTabObservation('location.changed', 0);
      setTimeout(syncFloatingPanelVisibility, 0);
      setTimeout(() => {
        attachPassiveTurnObserver();
        ensurePassiveSession('location-change');
        schedulePassiveTurnScan('location-change', 500);
      }, 250);
    }

    function handleForegroundResync(reason = 'page.foreground') {
      schedulePageStatus('page.changed', 0);
      scheduleTabObservation(reason, 0);
      const activeRequest = getActiveRequest();
      if (!activeRequest || activeRequest.finished || document.visibilityState !== 'visible') return;
      diagnostic('request.foreground_resync', {
        requestId: activeRequest.requestId,
        reason,
        phase: activeRequest.phase || '',
      });
      attachDomObserver(activeRequest);
      scheduleCollect(activeRequest, reason, 0);
    }

    function start() {
      const originalPushState = history.pushState;
      history.pushState = function bridgePushState() {
        const result = originalPushState.apply(this, arguments);
        handlePageLocationChange();
        return result;
      };

      const originalReplaceState = history.replaceState;
      history.replaceState = function bridgeReplaceState() {
        const result = originalReplaceState.apply(this, arguments);
        handlePageLocationChange();
        return result;
      };

      window.addEventListener('popstate', handlePageLocationChange);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') handleForegroundResync('visibility.visible');
        else schedulePageStatus('page.changed', 0);
      });
      window.addEventListener('focus', () => handleForegroundResync('window.focus'));
      window.addEventListener('pageshow', () => handleForegroundResync('page.show'));
      window.addEventListener('blur', () => schedulePageStatus('page.changed', 0));
      window.addEventListener('message', handleNetworkMessage);
      injectNetworkHook();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          syncFloatingPanelVisibility();
          schedulePageStatus('page.changed', 0);
        }, { once: true });
      } else {
        syncFloatingPanelVisibility();
      }
      window.addEventListener('load', () => schedulePageStatus('page.changed', 0), { once: true });
      startPageReadinessMonitor();
      startPassiveTurnObserver();
      startTabObserver();
      connect();
    }

    return {
      baselinePassiveTurns,
      attachPassiveTurnObserver,
      markPassiveTurnDirty,
      emitPassiveUserTurn,
      ensurePassiveSession,
      handleForegroundResync,
      registerPassivePromptBoundary,
      schedulePassiveTurnScan,
      start,
    };
  }

  globalThis.ChatGptPageRuntimeObservers = Object.freeze({ createPageRuntimeObservers });
})();
