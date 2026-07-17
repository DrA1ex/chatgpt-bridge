// Generated artifact interaction module extracted from the extension content runtime.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createArtifactTransfer(deps = {}) {
    const {
      CONFIG,
      DOM_PARSER,
      EXTENSION_API,
      armPageArtifactCapture,
      artifactFileName,
      artifactLocatorMeta,
      closeArtifactPreview,
      closeVisibleArtifactPreviewsBeforeAction,
      collectArtifactsFromNode,
      delay,
      diagnostic,
      enqueueArtifactAction,
      extensionRequest,
      findTurnByKey,
      getExtensionPort,
      guessMime,
      guessNameFromUrl,
      isBrowserOnlyArtifactUrl,
      isCurrentPageNavigationUrl,
      isExcludedArtifactAction,
      isUsableButton,
      isVisible,
      materializeArtifactPreview,
      normalizeComparable,
      queryAllWithSelf,
      send,
      visibleArtifactPreviewContainers,
      waitForLateArtifactPreview,
    } = deps;

    if (typeof isBrowserOnlyArtifactUrl !== 'function') {
      throw new TypeError('ChatGptArtifactTransfer requires isBrowserOnlyArtifactUrl(deps)');
    }
    if (typeof isCurrentPageNavigationUrl !== 'function') {
      throw new TypeError('ChatGptArtifactTransfer requires isCurrentPageNavigationUrl(deps)');
    }

    async function handleArtifactFetch(payload) {
      const artifact = { ...(payload.artifact || {}) };
      const commandId = payload.commandId;
      try {
        const initialUrl = artifact.downloadUrl || artifact.url || artifact.src || '';
        const needsAction = ['action', 'canvas'].includes(artifact.kind)
          || (!initialUrl && artifact.kind === 'file')
          || isBrowserOnlyArtifactUrl(initialUrl)
          || isCurrentPageNavigationUrl(initialUrl);
        if (needsAction) {
          const materialized = await enqueueArtifactAction(() => materializeArtifactAction(artifact));
          await streamArtifactPayload(commandId, artifact, materialized);
          return;
        }
        if (!initialUrl) throw new Error('Artifact has no downloadable URL or scoped download action');
        await streamArtifactData(commandId, artifact, initialUrl);
      } catch (err) {
        diagnostic('artifact.fetch.failed', { artifactId: artifact.id || '', name: artifact.name || '', message: err.message || String(err) });
        send({ type: 'command.error', commandId, message: err.message || String(err) });
      }
    }
  
    async function cancelBackgroundDownloadCapture(captureId, reason = 'another capture path completed') {
      if (!captureId || !getExtensionPort()) return { captureId, cancelled: false, missing: true };
      return await extensionRequest('bridge.download.capture.cancel', { captureId, reason }, 5_000).catch(() => null);
    }
  
    async function releaseBackgroundDownloadCapture(captureId, reason = 'another capture path completed', graceMs = 1_800) {
      if (!captureId || !getExtensionPort()) return { captureId, cancelled: false, missing: true };
      return await extensionRequest('bridge.download.capture.release', { captureId, reason, graceMs }, Math.max(5_000, graceMs + 2_000)).catch(() => null);
    }
  
    function materializedBrowserDownload(download = {}, artifact = {}) {
      return {
        filePath: download.filename,
        filename: download.filename,
        name: download.name || artifact.name,
        mime: download.mime || artifact.mime,
        size: download.fileSize || download.bytesReceived || 0,
        downloadId: download.id,
        downloadUrl: download.url || download.finalUrl || '',
        browserDownloadStartTime: download.startTime || '',
        browserDownloadEndTime: download.endTime || '',
        browserCaptureStartedAt: download.captureStartedAt || 0,
        browserCapturedAt: download.capturedAt || 0,
        browserExpectedNames: Array.isArray(download.expectedNames) ? download.expectedNames : [],
        captureSource: 'chrome-downloads',
      };
    }
  
    async function materializePageArtifactCandidate(candidate, artifact) {
      if (candidate?.blob instanceof Blob) {
        const buffer = await candidate.blob.arrayBuffer();
        return {
          name: candidate.downloadName || artifact.name || 'artifact',
          mime: candidate.mime || candidate.blob.type || artifact.mime || 'application/octet-stream',
          size: candidate.blob.size || buffer.byteLength,
          contentBase64: validateArtifactBuffer(buffer, {
            ...artifact,
            name: candidate.downloadName || artifact.name,
            mime: candidate.mime || candidate.blob.type || artifact.mime,
          }, candidate.url || ''),
          captureSource: 'page-blob',
          downloadUrl: candidate.url || '',
        };
      }
      const url = String(candidate?.url || '');
      if (!url) throw new Error('Page artifact capture did not expose Blob data or URL');
      const data = await fetchArtifactData(url, {
        ...artifact,
        name: candidate.downloadName || artifact.name,
        mime: candidate.mime || artifact.mime,
      });
      return { ...data, captureSource: 'page-url', downloadUrl: url };
    }
  
    async function materializeArtifactAction(artifact) {
      const initialSourceRoot = artifactSourceRoot(artifact) || document.body;
      const before = new Map(collectArtifactsFromNode(initialSourceRoot, { turnKey: artifact.sourceTurnKey || '' })
        .map((item) => [item.id, item.downloadUrl || item.url || item.src || '']));
      const timeoutMs = Math.min(60_000, Math.max(15_000, Number(CONFIG.artifactDownloadTimeoutMs) || 45_000));
      const startedAt = Date.now();
  
      // Finish any already-visible preview before resolving the next artifact.
      // This is a state wait, not a blind retry of the file action.
      await closeVisibleArtifactPreviewsBeforeAction(artifact);
      const containersBeforeAction = new Set(visibleArtifactPreviewContainers());
      const previewState = { preview: null };
  
      let pageCapture = null;
      try {
        pageCapture = await armPageArtifactCapture(artifact, timeoutMs);
        diagnostic('artifact.page_capture.armed', { artifactId: artifact.id, captureId: pageCapture.captureId, timeoutMs });
      } catch (err) {
        diagnostic('artifact.page_capture.unavailable', { artifactId: artifact.id, message: err.message || String(err) });
      }
  
      let browserCapture = null;
      let browserDownloadPromise = null;
      let browserCaptureReleased = false;
      if (getExtensionPort()) {
        try {
          browserCapture = await extensionRequest('bridge.download.capture.begin', {
            timeoutMs,
            expectedName: artifact.name || artifact.fileName || '',
            artifact: {
              id: artifact.id,
              name: artifact.name,
              kind: artifact.kind,
              text: artifact.text,
              actionLabel: artifact.actionLabel,
              sourceTurnKey: artifact.sourceTurnKey || '',
            },
          }, 5_000);
          diagnostic('artifact.download_capture.armed', { artifactId: artifact.id, captureId: browserCapture.captureId, timeoutMs });
        } catch (err) {
          diagnostic('artifact.download_capture.unavailable', { artifactId: artifact.id, message: err.message || String(err) });
        }
      }
  
      let rejectFatal = null;
      const materializationControl = {
        cancelled: false,
        fatal: new Promise((_, reject) => { rejectFatal = reject; }),
        async addExpectedNames(expectedNames = []) {
          const names = Array.from(expectedNames || []).filter(Boolean);
          if (!names.length) return;
          pageCapture?.addExpectedNames?.(names);
          if (browserCapture?.captureId && getExtensionPort()) {
            await extensionRequest('bridge.download.capture.add_expected_names', {
              captureId: browserCapture.captureId,
              expectedNames: names,
            }, 5_000).catch((err) => {
              diagnostic('artifact.download_capture.alias_update_failed', {
                artifactId: artifact.id || '',
                captureId: browserCapture.captureId,
                message: err.message || String(err),
              });
            });
          }
        },
      };
  
      const addAttempt = (attempts, source, promise) => {
        attempts.push(Promise.resolve(promise).catch((err) => {
          diagnostic('artifact.materialization_path.failed', {
            artifactId: artifact.id || '',
            name: artifact.name || artifact.fileName || '',
            source,
            elapsedMs: Date.now() - startedAt,
            fatal: Boolean(err?.artifactFatal),
            message: err?.message || String(err),
          });
          if (err?.artifactFatal) rejectFatal?.(err);
          throw err;
        }));
      };
  
      try {
        const actionWaitMs = Math.min(8_000, Math.max(3_000, Math.floor(timeoutMs * 0.18)));
        const actionStartedAt = Date.now();
        let backoffMs = 100;
        let lastError = null;
        let resolvedAction = null;
  
        while (Date.now() - actionStartedAt < actionWaitMs) {
          if (materializationControl.cancelled) throw new Error('Artifact action wait cancelled');
          try {
            resolvedAction = findArtifactActionButton(artifact, { withResolution: true });
            if (resolvedAction && isUsableButton(resolvedAction.element)) break;
            lastError = new Error('exact filename-bound artifact action is not currently usable');
          } catch (err) {
            lastError = err;
          }
          await delay(backoffMs);
          backoffMs = Math.min(1_000, Math.ceil(backoffMs * 1.7));
        }
  
        if (!resolvedAction || !isUsableButton(resolvedAction.element)) {
          throw new Error(`Exact artifact action did not become ready within ${actionWaitMs}ms for ${artifact.name || artifact.id || 'artifact'}${lastError ? `: ${lastError.message || lastError}` : ''}`);
        }
  
        diagnostic('artifact.action.resolved', {
          artifactId: artifact.id || '',
          expectedName: artifact.name || artifact.fileName || '',
          candidateName: resolvedAction.descriptor?.name || '',
          exactName: Boolean(resolvedAction.selection?.exactName),
          locatorIdentity: Boolean(resolvedAction.selection?.locatorIdentity),
          score: resolvedAction.selection?.score || 0,
          selectorHintMatched: Boolean(resolvedAction.descriptor?.selectorMatched),
          waitedMs: Date.now() - actionStartedAt,
        });
        resolvedAction.element.click();
        diagnostic('artifact.action.clicked', {
          artifactId: artifact.id || '',
          expectedName: artifact.name || artifact.fileName || '',
          candidateName: resolvedAction.descriptor?.name || '',
          sourceTurnKey: artifact.sourceTurnKey || '',
          waitedMs: Date.now() - actionStartedAt,
        });
  
        const attempts = [];
        addAttempt(attempts, 'preview', materializeArtifactPreview(
          artifact,
          containersBeforeAction,
          materializationControl,
          previewState,
        ));
        if (pageCapture) {
          addAttempt(attempts, 'page-capture', pageCapture.wait.then((candidate) => materializePageArtifactCandidate(candidate, artifact)));
        }
        addAttempt(attempts, 'dom-url', waitForMaterializedArtifactData(
          artifact,
          before,
          initialSourceRoot,
          Math.min(15_000, timeoutMs),
          materializationControl,
        ));
        if (browserCapture?.captureId) {
          browserDownloadPromise = extensionRequest(
            'bridge.download.capture.wait',
            { captureId: browserCapture.captureId, timeoutMs },
            timeoutMs + 2_000,
          ).then((download) => materializedBrowserDownload(download, artifact));
          addAttempt(attempts, 'chrome-downloads', browserDownloadPromise);
        }
  
        let result = await Promise.race([
          Promise.any(attempts),
          materializationControl.fatal,
        ]);
  
        // A direct page/preview path can expose bytes before Chrome reports the
        // download started by the same click. Stop all remaining click paths,
        // then give the already-armed browser capture a short atomic grace
        // window. If a download has received a chrome.downloads id, it becomes
        // authoritative: only that path carries enough identity to import and
        // remove the exact source file from Downloads safely.
        if (result.captureSource !== 'chrome-downloads' && browserCapture?.captureId && browserDownloadPromise) {
          materializationControl.cancelled = true;
          const release = await releaseBackgroundDownloadCapture(
            browserCapture.captureId,
            `${result.captureSource || 'direct'} materialization completed`,
            1_800,
          );
          if (release?.bound) {
            diagnostic('artifact.download_capture.adopted', {
              artifactId: artifact.id || '',
              captureId: browserCapture.captureId,
              downloadId: release.item?.id ?? release.result?.id ?? null,
              directSource: result.captureSource || 'direct',
            });
            result = await browserDownloadPromise;
            browserCaptureReleased = true;
          } else {
            browserCaptureReleased = Boolean(release?.cancelled || release?.missing);
            diagnostic('artifact.download_capture.released_unbound', {
              artifactId: artifact.id || '',
              captureId: browserCapture.captureId,
              directSource: result.captureSource || 'direct',
              cancelled: Boolean(release?.cancelled),
            });
          }
        } else if (result.captureSource === 'chrome-downloads') {
          browserCaptureReleased = true;
        }
        diagnostic('artifact.materialized', {
          artifactId: artifact.id,
          expectedName: artifact.name || artifact.fileName || '',
          name: result.name || artifact.name || '',
          source: result.captureSource || 'dom',
          size: result.size || 0,
          elapsedMs: Date.now() - startedAt,
          hasFilePath: Boolean(result.filePath || result.filename),
          hasContent: Boolean(result.contentBase64),
        });
  
        // A page URL capture can finish slightly before a text preview mounts.
        // Observe that narrow condition briefly, then move on; the next artifact
        // also closes any pre-existing preview before its own exact action click.
        const needsLatePreviewCleanup = DOM_PARSER.shouldWaitForLateArtifactPreview({
          artifact,
          result,
          previewObserved: Boolean(previewState.preview),
        });
        if (needsLatePreviewCleanup) {
          materializationControl.cancelled = true;
          pageCapture?.cancel?.('direct text artifact capture completed');
          const latePreview = await waitForLateArtifactPreview(artifact, containersBeforeAction, 5_000);
          if (latePreview) {
            previewState.preview = latePreview;
            await closeArtifactPreview(latePreview);
            previewState.preview = null;
          }
        }
        return result;
      } catch (err) {
        // A preview/DOM path may fail after the click even though Chrome has
        // already accepted the exact same download. Recover through the bound
        // chrome.downloads capture so the bridge can import and safely remove
        // the physical source instead of leaving an unowned file behind.
        if (!browserCaptureReleased && browserCapture?.captureId && browserDownloadPromise) {
          materializationControl.cancelled = true;
          const release = await releaseBackgroundDownloadCapture(
            browserCapture.captureId,
            'recovering bound download after materialization error',
            1_800,
          );
          if (release?.bound) {
            diagnostic('artifact.download_capture.recovered_after_error', {
              artifactId: artifact.id || '',
              captureId: browserCapture.captureId,
              downloadId: release.item?.id ?? release.result?.id ?? null,
              materializationError: err?.message || String(err),
            });
            browserCaptureReleased = true;
            return await browserDownloadPromise;
          }
          browserCaptureReleased = Boolean(release?.cancelled || release?.missing);
        }
        const messages = Array.isArray(err?.errors)
          ? err.errors.map((item) => item?.message || String(item))
          : [err?.message || String(err)];
        throw new Error(`Artifact materialization failed after ${Date.now() - startedAt}ms: ${messages.join('; ')}`);
      } finally {
        materializationControl.cancelled = true;
        pageCapture?.cancel?.('materialization finished');
        if (!browserCaptureReleased) {
          const release = await releaseBackgroundDownloadCapture(browserCapture?.captureId, 'materialization finished', 1_000);
          if (release?.bound) {
            diagnostic('artifact.download_capture.bound_after_materialization', {
              artifactId: artifact.id || '',
              captureId: browserCapture?.captureId || '',
              downloadId: release.item?.id ?? release.result?.id ?? null,
            });
          }
        }
        await closeArtifactPreview(previewState.preview);
      }
    }
  
    function artifactSourceRoot(artifact) {
      if (!artifact?.sourceTurnKey) return null;
      return findTurnByKey(artifact.sourceTurnKey, artifact.sourceTurnIndex) || null;
    }
  
    async function waitForMaterializedArtifactData(artifact, before, root, timeoutMs = 20_000, control = null) {
      const started = Date.now();
      const desiredName = normalizeComparable(artifact.name || artifact.fileName || '');
      while (Date.now() - started < timeoutMs) {
        if (control?.cancelled) throw new Error('Artifact DOM materialization cancelled');
        await delay(250);
        if (control?.cancelled) throw new Error('Artifact DOM materialization cancelled');
        const currentRoot = artifactSourceRoot(artifact) || root;
        const candidates = collectArtifactsFromNode(currentRoot, { turnKey: artifact.sourceTurnKey || '' })
          .filter((item) => item.phase === 'READY' && (item.downloadUrl || item.url || item.src));
        const ranked = candidates
          .map((item) => {
            const url = item.downloadUrl || item.url || item.src || '';
            const oldUrl = before.get(item.id) || '';
            let score = url && url !== oldUrl ? 20 : 0;
            const candidateName = normalizeComparable(item.name || '');
            if (item.id === artifact.id) score += 100;
            if (desiredName && candidateName === desiredName) score += 80;
            else if (desiredName && (candidateName.includes(desiredName) || desiredName.includes(candidateName))) score += 30;
            return { item, score };
          })
          .filter((entry) => entry.score > 0)
          .sort((left, right) => right.score - left.score);
        if (!ranked.length) continue;
        const matched = ranked[0].item;
        const url = matched.downloadUrl || matched.url || matched.src || '';
        const data = await fetchArtifactData(url, { ...artifact, name: matched.name || artifact.name, mime: matched.mime || artifact.mime });
        return { ...data, captureSource: 'dom-url', downloadUrl: url };
      }
      throw new Error('Artifact action did not expose a readable URL in its assistant turn');
    }
  
    function artifactActionCandidateDescriptor(element, artifact, root, selectorMatched = false) {
      const locator = artifactLocatorMeta(element, root);
      const href = element?.href || element?.getAttribute?.('href') || '';
      return {
        name: artifactFileName(element, root, href),
        fileName: artifactFileName(element, root, href),
        blockStart: locator.blockStart,
        blockEnd: locator.blockEnd,
        blockTestId: locator.blockTestId,
        actionOrdinal: locator.actionOrdinal,
        actionTag: locator.actionTag,
        actionRole: locator.actionRole,
        actionTestId: locator.actionTestId,
        actionAriaLabel: locator.actionAriaLabel,
        selectorMatched,
      };
    }
  
    function artifactActionCandidateScore(element, artifact, root, selectorMatched = false) {
      if (!element || !isVisible(element) || isExcludedArtifactAction(element)) return -Infinity;
      return DOM_PARSER.scoreArtifactActionCandidate(
        artifact,
        artifactActionCandidateDescriptor(element, artifact, root, selectorMatched),
      ).score;
    }
  
    function findArtifactActionButton(artifact, options = {}) {
      const root = artifactSourceRoot(artifact) || document.body;
      if (artifact.sourceTurnKey && root === document.body) return null;
  
      const hinted = new Set();
      if (artifact.selectorHint) {
        try {
          for (const element of queryAllWithSelf(root, artifact.selectorHint)) hinted.add(element);
        } catch {
          // Dynamic selector hints can become invalid after React replacement.
        }
      }
  
      const entries = queryAllWithSelf(root, 'button, [role="button"], a[href]')
        .filter((element) => isVisible(element) && !isExcludedArtifactAction(element))
        .map((element) => ({
          element,
          descriptor: artifactActionCandidateDescriptor(element, artifact, root, hinted.has(element)),
        }));
      const selection = DOM_PARSER.selectArtifactActionCandidate(artifact, entries.map((entry) => entry.descriptor));
      if (!selection.ok) {
        if (selection.reason === 'artifact_action_identity_ambiguous') {
          throw new Error(`Artifact action is ambiguous for ${artifact.name || artifact.id || 'artifact'} (${selection.score} points)`);
        }
        return null;
      }
      const selected = entries[selection.index];
      if (!selected?.element) return null;
      return options.withResolution
        ? { element: selected.element, descriptor: selected.descriptor, selection }
        : selected.element;
    }
  
    async function streamArtifactData(commandId, artifact, url) {
      const data = await fetchArtifactData(url, artifact);
      await streamArtifactPayload(commandId, artifact, data);
    }
  
    async function streamArtifactPayload(commandId, artifact, data = {}) {
      if (data.filePath || data.filename) {
        await streamArtifactDownloadedFile(commandId, artifact, data);
        return;
      }
      const base64 = String(data.contentBase64 || '');
      if (!base64) throw new Error(`Artifact materialization returned no bytes: ${artifact.name || artifact.id || 'artifact'}`);
      const chunkSize = Number(artifact.chunkSize || CONFIG.artifactChunkSize) || CONFIG.artifactChunkSize;
      const totalChunks = Math.max(1, Math.ceil(base64.length / chunkSize));
      send({ type: 'artifact.data.started', commandId, artifactId: artifact.id, name: data.name || artifact.name, mime: data.mime || artifact.mime, encodedSize: base64.length, size: data.size || 0, totalChunks, captureSource: data.captureSource || '' });
      for (let offset = 0, index = 0; offset < base64.length; offset += chunkSize, index += 1) {
        send({ type: 'artifact.data.chunk', commandId, artifactId: artifact.id, index, offset, totalChunks, contentBase64: base64.slice(offset, offset + chunkSize) });
        await delay(0);
      }
      send({ type: 'artifact.data.done', commandId, artifactId: artifact.id, name: data.name || artifact.name, mime: data.mime || artifact.mime, encodedSize: base64.length, size: data.size || 0, totalChunks, captureSource: data.captureSource || '' });
    }
  
    async function streamArtifactDownloadedFile(commandId, artifact, download) {
      const filePath = download.filePath || download.filename || '';
      if (!filePath) throw new Error('Captured browser download has no local filename');
      const name = download.name || filePath.split(/[\/]/).pop() || artifact.name || 'artifact';
      const mime = download.mime || artifact.mime || guessMime(name, download.downloadUrl || download.url || '');
      const browserDownloadIdentity = {
        downloadId: download.downloadId ?? null,
        browserDownloadStartTime: download.browserDownloadStartTime || '',
        browserDownloadEndTime: download.browserDownloadEndTime || '',
        browserCaptureStartedAt: download.browserCaptureStartedAt || 0,
        browserCapturedAt: download.browserCapturedAt || 0,
        browserExpectedNames: Array.isArray(download.browserExpectedNames) ? download.browserExpectedNames : [],
      };
      send({ type: 'artifact.data.started', commandId, artifactId: artifact.id, name, mime, filePath, size: download.size || 0, totalChunks: 0, encodedSize: 0, captureSource: download.captureSource || 'chrome-downloads', ...browserDownloadIdentity });
      send({ type: 'artifact.data.done', commandId, artifactId: artifact.id, name, mime, filePath, size: download.size || 0, totalChunks: 0, encodedSize: 0, captureSource: download.captureSource || 'chrome-downloads', ...browserDownloadIdentity });
    }
  
    async function fetchArtifactData(url, artifact) {
      if (url.startsWith('data:')) {
        const match = url.match(/^data:([^;,]+)?;base64,(.+)$/);
        if (!match) throw new Error('Unsupported data URL artifact');
        validateArtifactBase64(match[2], { ...artifact, name: artifact.name || 'artifact', mime: match[1] || artifact.mime }, url);
        return { name: artifact.name || 'artifact', mime: match[1] || artifact.mime || 'application/octet-stream', contentBase64: match[2] };
      }
  
      try {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        const mime = response.headers.get('content-type') || artifact.mime || 'application/octet-stream';
        const contentDisposition = response.headers.get('content-disposition') || '';
        const name = filenameFromContentDisposition(contentDisposition) || artifact.name || guessNameFromUrl(url) || 'artifact';
        return { name, mime, contentBase64: validateArtifactBuffer(buffer, { ...artifact, name, mime }, url) };
      } catch (fetchErr) {
        if (typeof EXTENSION_API.httpRequest !== 'function') throw new Error(`Could not fetch artifact: ${fetchErr.message || fetchErr}`);
        return await gmFetchArtifact(url, artifact, fetchErr);
      }
    }
  
    function gmFetchArtifact(url, artifact, originalError) {
      return new Promise((resolve, reject) => {
        EXTENSION_API.httpRequest({
          method: 'GET',
          url,
          responseType: 'arraybuffer',
          anonymous: false,
          onload(response) {
            if (response.status < 200 || response.status >= 300) {
              reject(new Error(`Could not fetch artifact through extension HTTP transport: HTTP ${response.status}; page fetch failed: ${originalError?.message || originalError}`));
              return;
            }
            const headers = parseHeaders(response.responseHeaders || '');
            const mime = headers['content-type'] || artifact.mime || 'application/octet-stream';
            const name = filenameFromContentDisposition(headers['content-disposition'] || '') || artifact.name || guessNameFromUrl(url) || 'artifact';
            try {
              resolve({ name, mime, contentBase64: validateArtifactBuffer(response.response, { ...artifact, name, mime }, url) });
            } catch (validationError) {
              reject(validationError);
            }
          },
          onerror() { reject(new Error(`Could not fetch artifact through extension HTTP transport; page fetch failed: ${originalError?.message || originalError}`)); },
          ontimeout() { reject(new Error('Timed out fetching artifact through extension HTTP transport')); },
        });
      });
    }
  
    function expectedArtifactType(artifact = {}, url = '') {
      const name = String(artifact.name || artifact.fileName || guessNameFromUrl(url) || '').toLowerCase();
      const mime = String(artifact.mime || '').toLowerCase();
      const identity = [
        name,
        artifact.text,
        artifact.actionLabel,
        artifact.title,
        artifact.extension,
      ].filter(Boolean).join(' ').toLowerCase();
      if (name.endsWith('.zip') || mime.includes('zip') || /(?:\bzip\b|zip archive|архив zip)/i.test(identity)) return 'zip';
      if (name.endsWith('.pdf') || mime.includes('pdf')) return 'pdf';
      if (name.endsWith('.png') || mime.includes('png')) return 'png';
      if (name.endsWith('.jpg') || name.endsWith('.jpeg') || mime.includes('jpeg')) return 'jpeg';
      return '';
    }

    function bytesStartWith(bytes, expected) {
      if (bytes.length < expected.length) return false;
      return expected.every((value, index) => bytes[index] === value);
    }

    function looksLikeTextError(bytes = new Uint8Array()) {
      const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart().toLowerCase();
      return prefix.startsWith('<!doctype html')
        || prefix.startsWith('<html')
        || prefix.startsWith('{')
        || prefix.startsWith('[')
        || prefix.includes('<title>chatgpt');
    }

    function validateArtifactBytes(bytes, artifact = {}, url = '') {
      const expected = expectedArtifactType(artifact, url);
      let valid = true;
      if (expected === 'zip') {
        valid = bytesStartWith(bytes, [0x50, 0x4b, 0x03, 0x04])
          || bytesStartWith(bytes, [0x50, 0x4b, 0x05, 0x06])
          || bytesStartWith(bytes, [0x50, 0x4b, 0x07, 0x08]);
      } else if (expected === 'pdf') valid = bytesStartWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
      else if (expected === 'png') valid = bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      else if (expected === 'jpeg') valid = bytesStartWith(bytes, [0xff, 0xd8, 0xff]);
      else if (looksLikeTextError(bytes) && !String(artifact.mime || '').toLowerCase().startsWith('text/')) {
        throw new Error(`Artifact source returned HTML/JSON instead of binary content for ${artifact.name || artifact.id || 'artifact'}`);
      }
      if (!valid) {
        throw new Error(`Artifact source returned invalid ${expected.toUpperCase()} bytes for ${artifact.name || artifact.id || 'artifact'}`);
      }
      return bytes;
    }

    function validateArtifactBuffer(buffer, artifact = {}, url = '') {
      const bytes = validateArtifactBytes(new Uint8Array(buffer), artifact, url);
      return arrayBufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }

    function validateArtifactBase64(contentBase64, artifact = {}, url = '') {
      const binary = atob(String(contentBase64 || ''));
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      validateArtifactBytes(bytes, artifact, url);
      return contentBase64;
    }

    function parseHeaders(raw) {
      const result = {};
      for (const line of String(raw || '').split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        result[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      return result;
    }
  
    function filenameFromContentDisposition(value) {
      const match = String(value || '').match(/filename\*?=(?:UTF-8''|\")?([^";]+)/i);
      if (!match) return '';
      try { return decodeURIComponent(match[1].replace(/"/g, '').trim()); } catch { return match[1].replace(/"/g, '').trim(); }
    }
  
    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    }
  
  
    return Object.freeze({
      arrayBufferToBase64,
      artifactSourceRoot,
      handleArtifactFetch,
      validateArtifactBase64,
      validateArtifactBytes,
    });
  }

  globalThis.ChatGptArtifactTransfer = Object.freeze({ createArtifactTransfer });
})();
