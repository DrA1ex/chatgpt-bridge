import { DownloadStatus } from './stateV4.js';

export function createDownloadCoordinator({ backgroundState }) {
  const downloadCaptures = new Map();
  let sequence = 0;

  function captureId() {
    sequence += 1;
    return `dl-${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function portMatches(left, right) { return left === right; }

  function normalizeName(value = '') {
    const raw = String(value || '').split(/[\\/]/).pop() || '';
    try { return decodeURIComponent(raw).trim().toLowerCase(); }
    catch { return raw.trim().toLowerCase(); }
  }

  function normalizeConflictName(value = '') {
    const name = normalizeName(value);
    const dot = name.lastIndexOf('.');
    const stem = dot >= 0 ? name.slice(0, dot) : name;
    const extension = dot >= 0 ? name.slice(dot) : '';
    return `${stem.replace(/ \([0-9]+\)$/i, '')}${extension}`;
  }

  function candidateNames(item = {}) {
    return [...new Set([item.filename, item.url, item.finalUrl]
      .filter(Boolean)
      .map(normalizeConflictName)
      .filter(Boolean))];
  }

  function expectedNames(state = {}) {
    return [...new Set([
      state.expectedName,
      state.artifact?.name,
      ...(Array.isArray(state.expectedNames) ? state.expectedNames : []),
    ].map(normalizeConflictName).filter(Boolean))];
  }

  function expectedIdentity(options = {}) {
    const artifact = options.artifact && typeof options.artifact === 'object' ? options.artifact : {};
    return Object.freeze({
      requirementId: String(options.artifactRequirementId || artifact.requirementId || ''),
      candidateId: String(options.artifactCandidateId || artifact.id || ''),
      sourceTurnKey: String(artifact.sourceTurnKey || ''),
      name: String(options.expectedName || artifact.name || ''),
      kind: String(artifact.kind || ''),
    });
  }

  function identityScore(state, item = {}) {
    if (!state || state.done || state.itemId != null) return -Infinity;
    const identity = state.expectedArtifactIdentity || {};
    if (!identity.candidateId || !identity.sourceTurnKey) return -Infinity;
    const expected = expectedNames(state);
    const candidates = candidateNames(item);
    if (!expected.length || !candidates.length) return -Infinity;
    const itemStartedAt = Date.parse(String(item.startTime || ''));
    if (Number.isFinite(itemStartedAt)) {
      const earliest = state.startedAt - 2_000;
      const latest = state.startedAt + state.timeoutMs;
      if (itemStartedAt < earliest || itemStartedAt > latest) return -Infinity;
    } else if (Date.now() - state.startedAt > Math.min(state.timeoutMs, 15_000)) return -Infinity;
    for (const name of expected) {
      if (candidates.some((candidate) => candidate === name)) return 500;
    }
    return -Infinity;
  }

  function findPendingCapture(item = {}) {
    const ranked = [...downloadCaptures.values()]
      .filter((state) => !state.done && state.itemId == null)
      .map((state) => ({ state, score: identityScore(state, item) }))
      .filter((entry) => Number.isFinite(entry.score) && entry.score > 0)
      .sort((left, right) => right.score - left.score || left.state.startedAt - right.state.startedAt);
    if (!ranked.length) return null;
    if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
    return ranked[0].state;
  }

  function cleanup(id, delayMs = 30_000) {
    setTimeout(() => {
      const state = downloadCaptures.get(id);
      if (!state || state.waiting) return;
      downloadCaptures.delete(id);
    }, delayMs);
  }

  function publicItem(item = {}, state = null) {
    return {
      id: item.id,
      url: item.url || '',
      finalUrl: item.finalUrl || '',
      filename: item.filename || '',
      name: item.filename ? item.filename.split(/[\\/]/).pop() : '',
      mime: item.mime || '',
      fileSize: item.fileSize || 0,
      bytesReceived: item.bytesReceived || 0,
      state: item.state || '',
      danger: item.danger || '',
      exists: item.exists !== false,
      startTime: item.startTime || '',
      endTime: item.endTime || '',
      captureId: state?.captureId || '',
      captureStartedAt: state?.startedAt || 0,
      capturedAt: Date.now(),
      expectedNames: state ? expectedNames(state) : [],
      artifactIdentity: state?.expectedArtifactIdentity || null,
    };
  }

  async function persistTransition(state, status, extra = {}) {
    const runtime = await backgroundState.read(state.tabId);
    if (state.requestId && (
      runtime.lease?.requestId !== state.requestId
      || runtime.lease?.leaseId !== state.leaseId
    )) {
      return { accepted: false, reason: 'download_lease_inactive', state: runtime };
    }
    return backgroundState.transition(state.tabId, {
      type: 'download.transition',
      captureId: state.captureId,
      status,
      requestId: state.requestId,
      leaseId: state.leaseId,
      effectId: state.effectId,
      artifactRequirementId: state.expectedArtifactIdentity.requirementId,
      artifactCandidateId: state.expectedArtifactIdentity.candidateId,
      expectedArtifactIdentity: state.expectedArtifactIdentity,
      expectedNames: expectedNames(state),
      downloadId: extra.downloadId ?? state.itemId,
      bindingSource: extra.bindingSource || state.bindingSource || '',
      contentEpoch: runtime.contentEpoch,
    });
  }

  function bindingResult(state) {
    const item = state?.item || (state?.itemId != null ? { id: state.itemId } : null);
    return {
      captureId: state?.captureId || '',
      bound: state?.itemId != null,
      complete: Boolean(state?.done && state?.result),
      failed: Boolean(state?.done && state?.error),
      item: item ? publicItem(item, state) : null,
      result: state?.result || null,
      error: state?.error?.message || '',
      artifactIdentity: state?.expectedArtifactIdentity || null,
    };
  }

  function notifyBound(state) {
    if (!state?.boundWaiters?.size) return;
    const result = bindingResult(state);
    for (const waiter of state.boundWaiters) waiter.resolve(result);
    state.boundWaiters.clear();
  }

  async function beginDownloadCapture(port, options = {}) {
    if (!chrome.downloads?.onCreated || !chrome.downloads?.search) {
      throw new Error('chrome.downloads API is unavailable; add the downloads permission');
    }
    const id = captureId();
    const timeoutMs = Math.max(1_000, Math.min(Number(options.timeoutMs) || 45_000, 15 * 60_000));
    const runtime = await backgroundState.read(port?.sender?.tab?.id ?? null);
    const identity = expectedIdentity(options);
    const state = {
      captureId: id,
      port,
      tabId: port?.sender?.tab?.id ?? null,
      requestId: String(runtime.lease?.requestId || ''),
      leaseId: String(runtime.lease?.leaseId || ''),
      effectId: String(options.effectId || ''),
      startedAt: Date.now(),
      timeoutMs,
      expectedName: String(options.expectedName || options.artifact?.name || ''),
      expectedNames: Array.from(options.expectedNames || []).map(String).filter(Boolean),
      expectedArtifactIdentity: identity,
      itemId: null,
      item: null,
      bindingSource: '',
      done: false,
      result: null,
      error: null,
      waiting: null,
      boundWaiters: new Set(),
      timer: null,
      artifact: options.artifact || null,
    };
    if (!expectedNames(state).length && !identity.candidateId) {
      throw new Error('Download capture requires an expected artifact identity');
    }
    const planned = await persistTransition(state, DownloadStatus.PLANNED);
    if (!planned.accepted) throw new Error(`Unable to persist download capture: ${planned.reason}`);
    downloadCaptures.set(id, state);
    const armed = await persistTransition(state, DownloadStatus.ARMED);
    if (!armed.accepted) {
      downloadCaptures.delete(id);
      throw new Error(`Unable to arm download capture: ${armed.reason}`);
    }
    state.timer = setTimeout(() => { void rejectDownloadCapture(state, new Error(`Timed out waiting for browser download after ${timeoutMs}ms`)); }, timeoutMs);
    return {
      captureId: id,
      timeoutMs,
      expectedName: state.expectedName,
      expectedNames: state.expectedNames,
      artifactIdentity: identity,
    };
  }

  async function bindDownloadCapture(state, item = {}, { direct = false } = {}) {
    if (!state || state.done) return false;
    const downloadId = item.id;
    if (downloadId == null) return false;
    if (state.itemId === downloadId) {
      state.item = { ...(state.item || {}), ...item };
      return true;
    }
    if (state.itemId != null) return false;
    if (!direct && identityScore(state, item) <= 0) return false;
    const bindingSource = direct ? 'direct_download_id' : 'browser_event_strict_capture_identity';
    const persisted = await persistTransition(state, DownloadStatus.BOUND, { downloadId, bindingSource });
    if (!persisted.accepted) return false;
    state.itemId = downloadId;
    state.item = { ...(state.item || {}), ...item };
    state.bindingSource = bindingSource;
    notifyBound(state);
    return true;
  }

  async function resolveDownloadCapture(state, result) {
    if (!state || state.done) return false;
    const persisted = await persistTransition(state, DownloadStatus.COMPLETED, { downloadId: state.itemId });
    if (!persisted.accepted) {
      await rejectDownloadCapture(state, new Error(`Captured download lost its active lease: ${persisted.reason}`), { persist: false });
      return false;
    }
    state.done = true;
    state.result = result;
    clearTimeout(state.timer);
    notifyBound(state);
    const waiter = state.waiting;
    state.waiting = null;
    if (waiter) waiter.resolve(result);
    cleanup(state.captureId);
    return true;
  }

  async function rejectDownloadCapture(state, error, { persist = true } = {}) {
    if (!state || state.done) return false;
    if (persist) await persistTransition(state, DownloadStatus.FAILED, { downloadId: state.itemId });
    state.done = true;
    state.error = error;
    clearTimeout(state.timer);
    notifyBound(state);
    const waiter = state.waiting;
    state.waiting = null;
    if (waiter) waiter.reject(error);
    cleanup(state.captureId);
    return true;
  }

  async function addDownloadCaptureExpectedNames(port, id, names = []) {
    const state = downloadCaptures.get(id);
    if (!state) throw new Error(`Unknown download capture: ${id}`);
    if (!portMatches(state.port, port)) throw new Error('Download capture belongs to another tab');
    if (state.done || state.itemId != null) return { captureId: id, updated: false, expectedNames: expectedNames(state) };
    state.expectedNames = [...new Set([...(state.expectedNames || []), ...Array.from(names || []).map(String).filter(Boolean)])];
    const runtime = await backgroundState.read(state.tabId);
    const updated = await backgroundState.transition(state.tabId, {
      type: 'download.identity_updated',
      captureId: id,
      requestId: state.requestId,
      leaseId: state.leaseId,
      expectedNames: expectedNames(state),
      expectedArtifactIdentity: state.expectedArtifactIdentity,
      contentEpoch: runtime.contentEpoch,
    });
    if (!updated.accepted) throw new Error(`Unable to persist download identity: ${updated.reason}`);
    return { captureId: id, updated: true, expectedNames: expectedNames(state) };
  }

  async function cancelDownloadCapture(port, id, reason = 'cancelled') {
    const state = downloadCaptures.get(id);
    if (!state) return { captureId: id, cancelled: false, missing: true };
    if (!portMatches(state.port, port)) throw new Error('Download capture belongs to another tab');
    if (state.itemId != null) return { ...bindingResult(state), cancelled: false };
    await rejectDownloadCapture(state, new Error(`Browser download capture ${reason}`));
    downloadCaptures.delete(id);
    return { captureId: id, cancelled: true, bound: false };
  }

  async function startDownloadCapture(port, id, url = '') {
    const state = downloadCaptures.get(id);
    if (!state) throw new Error(`Unknown download capture: ${id}`);
    if (!portMatches(state.port, port)) throw new Error('Download capture belongs to another tab');
    const target = String(url || '');
    if (!/^https:\/\//i.test(target)) throw new Error('Captured download requires an HTTPS URL');
    const downloadId = await new Promise((resolve, reject) => chrome.downloads.download({ url: target, saveAs: false }, (value) => {
      if (chrome.runtime.lastError || value == null) reject(new Error(chrome.runtime.lastError?.message || 'Chrome did not start the download'));
      else resolve(value);
    }));
    const items = await new Promise((resolve, reject) => chrome.downloads.search({ id: downloadId }, (found) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(found || []);
    }));
    const item = items[0] || { id: downloadId, url: target, state: 'in_progress' };
    if (!await bindDownloadCapture(state, item, { direct: true })) throw new Error('Download capture lost its lease before binding');
    await updateCaptureWithDownloadItem(item);
    return { captureId: id, downloadId, bound: true, artifactIdentity: state.expectedArtifactIdentity };
  }

  async function updateCaptureWithDownloadItem(item) {
    if (!item) return;
    const state = [...downloadCaptures.values()].find((candidate) => !candidate.done && candidate.itemId === item.id);
    if (!state) return;
    if (!await bindDownloadCapture(state, item, { direct: state.bindingSource === 'direct_download_id' })) return;
    if (item.state === 'complete' && item.filename) await resolveDownloadCapture(state, publicItem(item, state));
    if (item.state === 'interrupted') await rejectDownloadCapture(state, new Error(`Browser download interrupted: ${item.error || item.danger || item.id}`));
  }

  function restoreDownloadCapturesForPort(port, runtime) {
    for (const persisted of Object.values(runtime?.downloads || {})) {
      if (!persisted?.captureId || [DownloadStatus.COMPLETED, DownloadStatus.FAILED, DownloadStatus.RELEASED].includes(persisted.status)) continue;
      if (downloadCaptures.has(persisted.captureId)) continue;
      const state = {
        captureId: persisted.captureId,
        port,
        tabId: runtime.tabId,
        requestId: String(persisted.requestId || ''),
        leaseId: String(persisted.leaseId || ''),
        effectId: String(persisted.effectId || ''),
        startedAt: Number(persisted.updatedAt) || Date.now(),
        timeoutMs: 45_000,
        expectedName: String(persisted.expectedNames?.[0] || ''),
        expectedNames: Array.from(persisted.expectedNames || []),
        expectedArtifactIdentity: persisted.expectedArtifactIdentity || Object.freeze({
          requirementId: String(persisted.artifactRequirementId || ''),
          candidateId: String(persisted.artifactCandidateId || ''),
          sourceTurnKey: '', name: String(persisted.expectedNames?.[0] || ''), kind: '',
        }),
        itemId: persisted.downloadId ?? null,
        item: null,
        bindingSource: String(persisted.bindingSource || ''),
        done: false,
        result: null,
        error: null,
        waiting: null,
        boundWaiters: new Set(),
        timer: null,
        artifact: null,
      };
      state.timer = setTimeout(() => { void rejectDownloadCapture(state, new Error('Recovered browser download did not settle')); }, state.timeoutMs);
      downloadCaptures.set(state.captureId, state);
      if (state.itemId != null) {
        chrome.downloads.search({ id: state.itemId }, (items) => {
          if (chrome.runtime.lastError) return;
          if (items?.[0]) void updateCaptureWithDownloadItem(items[0]);
        });
      }
    }
  }

  if (chrome.downloads?.onCreated) {
    chrome.downloads.onCreated.addListener((item) => {
      const state = findPendingCapture(item);
      if (!state) return;
      void (async () => {
        if (!await bindDownloadCapture(state, item)) return;
        if (item.state === 'complete' && item.filename) await resolveDownloadCapture(state, publicItem(item, state));
      })();
    });
  }

  if (chrome.downloads?.onChanged) {
    chrome.downloads.onChanged.addListener((delta) => {
      chrome.downloads.search({ id: delta.id }, (items) => {
        const known = [...downloadCaptures.values()].find((candidate) => !candidate.done && candidate.itemId === delta.id);
        if (chrome.runtime.lastError) {
          if (known) void rejectDownloadCapture(known, new Error(chrome.runtime.lastError.message));
          return;
        }
        const item = items?.[0] || { id: delta.id, state: delta.state?.current || '' };
        const state = known || findPendingCapture(item);
        if (!state) return;
        void (async () => {
          if (state.itemId == null && !await bindDownloadCapture(state, item)) return;
          await updateCaptureWithDownloadItem(item);
        })();
      });
    });
  }

  function waitDownloadCapture(port, id, timeoutMs = 45_000) {
    const state = downloadCaptures.get(id);
    if (!state) return Promise.reject(new Error(`Unknown download capture: ${id}`));
    if (!portMatches(state.port, port)) return Promise.reject(new Error('Download capture belongs to another tab'));
    if (state.done) return state.error ? Promise.reject(state.error) : Promise.resolve(state.result);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (state.waiting?.resolve === resolve) state.waiting = null;
        reject(new Error(`Timed out waiting for captured download: ${id}`));
      }, Math.max(1_000, Number(timeoutMs) || 45_000));
      state.waiting = {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      };
    });
  }

  function waitDownloadCaptureBound(port, id, timeoutMs = 1_200) {
    const state = downloadCaptures.get(id);
    if (!state) return Promise.resolve({ captureId: id, bound: false, missing: true });
    if (!portMatches(state.port, port)) return Promise.reject(new Error('Download capture belongs to another tab'));
    if (state.itemId != null || state.done) return Promise.resolve(bindingResult(state));
    return new Promise((resolve) => {
      const waiter = {
        resolve(value) {
          clearTimeout(timer);
          state.boundWaiters.delete(waiter);
          resolve(value);
        },
      };
      const timer = setTimeout(() => waiter.resolve(bindingResult(state)), Math.max(50, Number(timeoutMs) || 1_200));
      state.boundWaiters.add(waiter);
    });
  }

  async function releaseDownloadCapture(port, id, reason = 'released', graceMs = 1_500) {
    const binding = await waitDownloadCaptureBound(port, id, graceMs);
    if (binding.bound) return { ...binding, cancelled: false, retained: true };
    return cancelDownloadCapture(port, id, reason);
  }

  return Object.freeze({
    downloadCaptures,
    portMatches,
    beginDownloadCapture,
    addDownloadCaptureExpectedNames,
    startDownloadCapture,
    waitDownloadCapture,
    waitDownloadCaptureBound,
    releaseDownloadCapture,
    cancelDownloadCapture,
    restoreDownloadCapturesForPort,
    rejectDownloadCapture,
  });
}
