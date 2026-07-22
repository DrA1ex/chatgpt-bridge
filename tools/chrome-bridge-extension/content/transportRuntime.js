(() => {
  'use strict';

  function createTransportRuntime({
    CONFIG,
    EXTENSION_API,
    PAGE_ARTIFACT_CONTENT_SOURCE = 'chatgpt-browser-bridge-artifact-content-v1',
    PAGE_ARTIFACT_MAIN_SOURCE = 'chatgpt-browser-bridge-artifact-main-v1',
    RECONNECT_RUNTIME,
    RUNTIME_CONFIG,
    applyCompatibilityStatus,
    executionStore,
    getClientId,
    helloPayload,
    handleServerMessage,
    onBridgeConnectionChange = () => {},
    recordLocalLog,
    safeJsonParse,
    safeLaunchBridgeServerUrl,
    safeUrlPath,
    setPanelStatus,
    summarizePayload,
    temporaryConnectionOverride,
  } = {}) {
    let extensionPort = null;
    let browserTabId = null;
    let browserLaunchToken = '';
    let browserRequestedUrl = '';
    let browserLaunchServerUrl = '';
    let extensionRequestSeq = 0;
    const extensionRequests = new Map();
    const pageArtifactCaptures = new Map();
    let pageArtifactCaptureSeq = 0;
    let artifactActionQueue = Promise.resolve();
    let reconnectTimer = null;
    let bridgeConnected = false;

    function setBridgeConnected(value, reason = '') {
      const next = Boolean(value);
      if (bridgeConnected === next) return;
      bridgeConnected = next;
      if (!next) cancelAllPageArtifactCaptures(reason || 'bridge_disconnected');
      try { onBridgeConnectionChange(next, reason); } catch (error) {
        recordLocalLog('runtime.connection_callback_failed', { message: error?.message || String(error), reason });
      }
    }

    function initializeLaunchMetadata(metadata = {}) {
      browserLaunchToken = String(metadata.launchToken || '');
      browserRequestedUrl = String(metadata.requestedUrl || '');
      browserLaunchServerUrl = String(metadata.launchServerUrl || '');
    }

    function send(payload) {
      if (!extensionPort) {
        recordLocalLog('out.drop', { type: payload?.type || 'unknown', reason: 'extension_port_not_ready' });
        return false;
      }
      try {
        extensionPort.postMessage({ type: 'bridge.payload', payload });
        recordLocalLog('out.extension', summarizePayload(payload));
        return true;
      } catch (err) {
        recordLocalLog('out.extension_failed', { error: err.message || String(err), payload: summarizePayload(payload) });
        return false;
      }
    }

    function hasExtensionRuntime() {
      try { return Boolean(globalThis.chrome?.runtime?.id && typeof chrome.runtime.connect === 'function'); } catch { return false; }
    }

    function connect() {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (!CONFIG.token) {
        setBridgeConnected(false, 'not_configured');
        setPanelStatus('not configured', 'Paste BRIDGE_TOKEN from /setup');
        return;
      }
      connectExtensionTransport();
    }

    function connectExtensionTransport() {
      if (!hasExtensionRuntime()) {
        setBridgeConnected(false, 'extension_unavailable');
        setPanelStatus('extension unavailable', 'Install/load the ChatGPT Bridge extension');
        return;
      }
      try {
        extensionPort = chrome.runtime.connect({ name: 'chatgpt-bridge-tab' });
      } catch (err) {
        extensionPort = null;
        setBridgeConnected(false, 'extension_connect_failed');
        setPanelStatus('extension error', err.message || String(err));
        scheduleReconnect();
        return;
      }
      extensionPort.onMessage.addListener(handleExtensionMessage);
      extensionPort.onDisconnect.addListener(() => {
        extensionPort = null;
        setBridgeConnected(false, 'extension_disconnected');
        for (const [requestId, pending] of extensionRequests.entries()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Extension background disconnected'));
          extensionRequests.delete(requestId);
        }
        setPanelStatus('extension disconnected', chrome.runtime.lastError?.message || 'Background service worker disconnected');
        scheduleReconnect();
      });
      extensionPort.postMessage({
        type: 'bridge.connect',
        serverUrl: CONFIG.serverUrl,
        token: CONFIG.token,
        clientId: getClientId(),
        page: helloPayload(),
      });
    }

    function handleExtensionMessage(message) {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'extension.response') {
        const pending = extensionRequests.get(message.requestId);
        if (pending) {
          extensionRequests.delete(message.requestId);
          clearTimeout(pending.timer);
          if (message.error) {
            const error = new Error(String(message.error));
            error.code = String(message.errorCode || '');
            const details = message.errorDetails && typeof message.errorDetails === 'object' ? message.errorDetails : {};
            error.eventType = String(details.eventType || '');
            error.tabId = Number.isInteger(details.tabId) ? details.tabId : null;
            error.stateBytes = Math.max(0, Number(details.stateBytes) || 0);
            error.compactedFromBytes = Math.max(0, Number(details.compactedFromBytes) || 0);
            error.persistenceCauseMessage = String(details.causeMessage || details.reclaimRetryCauseMessage || details.firstCauseMessage || '');
            error.reclaimedKeys = Array.isArray(details.reclaimedKeys) ? details.reclaimedKeys : [];
            error.reclaimedBytes = Math.max(0, Number(details.reclaimedBytes) || 0);
            error.storageExaminedBytes = Math.max(0, Number(details.storageExaminedBytes) || 0);
            pending.reject(error);
          } else pending.resolve(message.result || {});
        }
        return;
      }
      if (message.type === 'extension.connected') {
        browserTabId = Number.isInteger(message.browserTabId) ? message.browserTabId : null;
        browserLaunchToken = String(message.launchToken || (browserLaunchToken.startsWith('bridge-reload-') ? '' : browserLaunchToken) || '');
        browserRequestedUrl = String(message.requestedUrl || browserRequestedUrl || '');
        browserLaunchServerUrl = safeLaunchBridgeServerUrl(message.serverUrl || browserLaunchServerUrl || '');
        if (browserLaunchServerUrl) CONFIG.serverUrl = browserLaunchServerUrl;
        if (temporaryConnectionOverride.applied && browserLaunchServerUrl === temporaryConnectionOverride.serverUrl) RUNTIME_CONFIG.removeTemporaryConnectionOverride();
        const recovery = RECONNECT_RUNTIME.recoverForHandshake(executionStore, message.recovery);
        if (recovery.error) recordLocalLog('request.recovery_failed', { requestId: recovery.requestId, reason: recovery.error });
        setPanelStatus(recovery.error ? 'connected; recovery degraded' : 'connected', recovery.error || 'Extension WebSocket connected');
        send({ ...helloPayload(), transportHealth: message.health || null, ...(recovery.error ? { recoveryError: recovery.error } : {}) });
        return;
      }
      if (message.type === 'extension.status') {
        if (/disconnect|unreachable|connecting|checking|queue|reconnect|closed|offline|failed|error/i.test(String(message.status || ''))) {
          setBridgeConnected(false, String(message.status || 'extension_status'));
        }
        if (message.compatibility) applyCompatibilityStatus(message.compatibility, message.status || 'extension status');
        else setPanelStatus(message.status || 'extension status', message.detail || '');
        return;
      }
      if (message.type === 'extension.auth_error') {
        setBridgeConnected(false, 'auth_error');
        setPanelStatus('auth failed', message.detail || 'Invalid BRIDGE_TOKEN. Paste the token from /setup and click Save & Connect.');
        recordLocalLog('extension.auth_error', { status: message.httpStatus || 0, message: message.detail || '' });
        return;
      }
      if (message.type === 'extension.error') {
        setBridgeConnected(false, 'extension_error');
        setPanelStatus('extension error', message.message || 'Unknown extension error');
        recordLocalLog('extension.error', { message: message.message || '' });
        return;
      }
      if (message.type === 'server.message') {
        if (message.payload?.type === 'server.hello') setBridgeConnected(true, 'server.hello');
        handleServerMessage(message.payload);
      }
    }

    function extensionRequest(type, payload = {}, timeoutMs = 30_000) {
      if (!extensionPort) return Promise.reject(new Error('Extension port is not connected'));
      const requestId = `ext-${Date.now().toString(36)}-${(extensionRequestSeq += 1).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          extensionRequests.delete(requestId);
          reject(new Error(`Timed out waiting for extension response: ${type}`));
        }, Math.max(1_000, Number(timeoutMs) || 30_000));
        extensionRequests.set(requestId, { resolve, reject, timer });
        try { extensionPort.postMessage({ type, ...payload, requestId }); }
        catch (err) {
          clearTimeout(timer);
          extensionRequests.delete(requestId);
          reject(err);
        }
      });
    }

    function cancelAllPageArtifactCaptures(reason = 'bridge_disconnected') {
      for (const [captureId, state] of pageArtifactCaptures.entries()) {
        if (state.settled) continue;
        state.settled = true;
        clearTimeout(state.timer);
        state.reject(new Error(`Page artifact capture ${reason}`));
        postPageArtifactMessage('artifact.capture.cancel', { captureId });
      }
      pageArtifactCaptures.clear();
    }

    function nextPageArtifactCaptureId() {
      pageArtifactCaptureSeq += 1;
      return `page-artifact-${Date.now().toString(36)}-${pageArtifactCaptureSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }
    function postPageArtifactMessage(type, payload = {}) {
      window.postMessage({ source: PAGE_ARTIFACT_CONTENT_SOURCE, type, ...payload }, '*');
    }
    function settlePageArtifactCapture(captureId, method, value) {
      const state = pageArtifactCaptures.get(captureId);
      if (!state || state.settled) return;
      state.settled = true;
      clearTimeout(state.timer);
      pageArtifactCaptures.delete(captureId);
      state[method](value);
    }
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const message = event.data || {};
      if (message.source !== PAGE_ARTIFACT_MAIN_SOURCE) return;
      const captureId = String(message.captureId || '');
      const state = pageArtifactCaptures.get(captureId);
      if (!state) return;
      if (message.type === 'artifact.capture.armed') {
        state.armed = true;
        state.armedResolve?.(true);
      } else if (message.type === 'artifact.capture.candidate') {
        settlePageArtifactCapture(captureId, 'resolve', {
          kind: String(message.kind || 'url'), url: String(message.url || ''), downloadName: String(message.downloadName || ''),
          mime: String(message.mime || ''), size: Number(message.size || 0), blob: message.blob instanceof Blob ? message.blob : null,
          observedAt: Number(message.observedAt || Date.now()),
        });
      }
    });

    async function armPageArtifactCapture(artifact = {}, timeoutMs = 45_000) {
      const captureId = nextPageArtifactCaptureId();
      let armedResolve;
      let armedReject;
      const armedPromise = new Promise((resolve, reject) => { armedResolve = resolve; armedReject = reject; });
      const candidatePromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pageArtifactCaptures.delete(captureId);
          postPageArtifactMessage('artifact.capture.cancel', { captureId });
          reject(new Error(`Timed out waiting for page-generated artifact: ${artifact.name || artifact.id || captureId}`));
        }, Math.max(1_000, Number(timeoutMs) || 45_000));
        pageArtifactCaptures.set(captureId, { resolve, reject, timer, armedResolve, armedReject, armed: false, settled: false });
      });
      postPageArtifactMessage('artifact.capture.arm', { captureId, expectedName: artifact.name || '', expectedNames: [artifact.name || artifact.fileName || ''].filter(Boolean), timeoutMs });
      const ackTimer = setTimeout(() => armedReject(new Error('Page artifact capture bridge did not acknowledge arm request')), 1_500);
      try { await armedPromise; }
      catch (err) {
        const state = pageArtifactCaptures.get(captureId);
        if (state && !state.settled) {
          state.settled = true;
          clearTimeout(state.timer);
          pageArtifactCaptures.delete(captureId);
          state.reject(err);
          candidatePromise.catch(() => {});
        }
        throw err;
      } finally { clearTimeout(ackTimer); }
      return {
        captureId,
        wait: candidatePromise,
        addExpectedNames(expectedNames = []) { postPageArtifactMessage('artifact.capture.expect', { captureId, expectedNames: Array.from(expectedNames || []).filter(Boolean) }); },
        cancel(reason = 'cancelled') {
          const state = pageArtifactCaptures.get(captureId);
          if (state && !state.settled) {
            state.settled = true;
            clearTimeout(state.timer);
            pageArtifactCaptures.delete(captureId);
            state.reject(new Error(`Page artifact capture ${reason}`));
          }
          postPageArtifactMessage('artifact.capture.cancel', { captureId });
        },
      };
    }

    function enqueueArtifactAction(task) {
      const run = artifactActionQueue.then(task, task);
      artifactActionQueue = run.catch(() => {});
      return run;
    }

    function extensionHttpJson({ method = 'GET', url, data = undefined, timeout = 30_000, signal = null }) {
      recordLocalLog('http.request', { method, path: safeUrlPath(url), hasBody: data !== undefined, timeout });
      return new Promise((resolve, reject) => {
        if (typeof EXTENSION_API.httpRequest !== 'function') return reject(new Error('Extension HTTP transport is not available'));
        if (signal?.aborted) {
          const abortErr = new Error(`Request aborted: ${url}`);
          abortErr.name = 'AbortError';
          reject(abortErr);
          return;
        }
        let settled = false;
        let request = null;
        const cleanup = () => { if (signal && abortHandler) try { signal.removeEventListener('abort', abortHandler); } catch {} };
        const finish = (fn, value) => { if (!settled) { settled = true; cleanup(); fn(value); } };
        const abortHandler = () => {
          try { request?.abort?.(); } catch {}
          const err = new Error(`Request aborted: ${url}`);
          err.name = 'AbortError';
          recordLocalLog('http.aborted', { method, path: safeUrlPath(url), reason: signal?.reason || '' });
          finish(reject, err);
        };
        if (signal) signal.addEventListener('abort', abortHandler, { once: true });
        request = EXTENSION_API.httpRequest({
          method, url, data: data === undefined ? undefined : JSON.stringify(data), headers: data === undefined ? undefined : { 'Content-Type': 'application/json' }, responseType: 'json', timeout,
          onload(response) {
            if (response.status < 200 || response.status >= 300) {
              recordLocalLog('http.error', { method, path: safeUrlPath(url), status: response.status });
              finish(reject, new Error(`HTTP ${response.status}: ${typeof response.responseText === 'string' ? response.responseText.slice(0, 200) : ''}`));
              return;
            }
            recordLocalLog('http.response', { method, path: safeUrlPath(url), status: response.status });
            finish(resolve, response.response && typeof response.response === 'object' ? response.response : safeJsonParse(response.responseText) || {});
          },
          onerror() { recordLocalLog('http.failed', { method, path: safeUrlPath(url) }); finish(reject, new Error(`Request failed: ${url}`)); },
          ontimeout() { recordLocalLog('http.timeout', { method, path: safeUrlPath(url), timeout }); finish(reject, new Error(`Request timed out: ${url}`)); },
          onabort() { abortHandler(); },
        });
      });
    }

    function scheduleReconnect() {
      if (!reconnectTimer) reconnectTimer = setTimeout(connect, CONFIG.reconnectMs);
    }
    function disconnectTransport() {
      setBridgeConnected(false, 'transport_disconnected');
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      try { extensionPort?.disconnect?.(); } catch {}
      extensionPort = null;
    }

    return Object.freeze({
      armPageArtifactCapture,
      connect,
      disconnectTransport,
      enqueueArtifactAction,
      extensionHttpJson,
      extensionRequest,
      getBrowserLaunchServerUrl: () => browserLaunchServerUrl,
      getBrowserLaunchToken: () => browserLaunchToken,
      getBrowserRequestedUrl: () => browserRequestedUrl,
      getBrowserTabId: () => browserTabId,
      getExtensionPort: () => extensionPort,
      hasExtensionRuntime,
      isBridgeConnected: () => bridgeConnected,
      initializeLaunchMetadata,
      send,
    });
  }

  globalThis.ChatGptContentTransportRuntime = Object.freeze({ createTransportRuntime });
})();
