// Generated artifact interaction module extracted from the extension content runtime.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createArtifactPreview(deps = {}) {
    const {
      CONFIG,
      DOM_PARSER,
      arrayBufferToBase64,
      artifactSourceRoot,
      collectArtifactsFromNode,
      delay,
      diagnostic,
      isUsableButton,
      isVisible,
      normalizeComparable,
      normalizeText,
      unique,
    } = deps;

    function artifactPreviewShell(container) {
      return container?.querySelector?.('[data-testid="fullscreen-shell-body"]') || container || null;
    }
  
    function artifactPreviewToolbar(container) {
      const shell = artifactPreviewShell(container);
      return shell?.querySelector?.('[data-testid="popcorn-toolbar"]')
        || shell?.querySelector?.('header')
        || null;
    }
  
    function artifactPreviewControls(container) {
      const toolbar = artifactPreviewToolbar(container);
      if (!toolbar) return [];
      const actionsRoot = toolbar.querySelector?.('[data-testid="popcorn-toolbar-actions"]') || toolbar;
      return Array.from(actionsRoot.querySelectorAll('a, button, [role="button"]')).filter(isVisible);
    }
  
    function artifactPreviewHasVisibleLoader(container) {
      const selectors = [
        '[aria-busy="true"]',
        '[role="progressbar"]',
        '[data-state="loading"]',
        '[data-loading="true"]',
        '[data-testid*="loading" i]',
        '[data-testid*="loader" i]',
        '[data-testid*="spinner" i]',
        '[class*="animate-spin"]',
      ];
      return selectors.some((selector) => Array.from(container?.querySelectorAll?.(selector) || []).some(isVisible));
    }
  
    function leafTextCandidates(root) {
      if (!root) return [];
      const selector = 'span, h1, h2, h3, [role="heading"]';
      const elements = [
        ...(root.matches?.(selector) ? [root] : []),
        ...Array.from(root.querySelectorAll?.(selector) || []),
      ].filter((element) => !element.querySelector?.(selector));
      return unique(elements.map((element) => normalizeText(element.textContent || '')).filter(Boolean));
    }
  
    function artifactPreviewTitleMetadata(container) {
      const shell = artifactPreviewShell(container);
      const toolbar = artifactPreviewToolbar(container);
      if (!shell || !toolbar) return { fileNameCandidates: [], displayTitleCandidates: [], formatLabels: [] };
  
      const fileNameCandidates = [];
      const displayTitleCandidates = [];
      const formatLabels = [];
      const popcornTitle = toolbar.querySelector?.('[data-testid="popcorn-file-title"]') || null;
      if (popcornTitle) {
        const leaves = leafTextCandidates(popcornTitle);
        if (leaves[0]) displayTitleCandidates.push(leaves[0]);
        if (leaves.length > 1) formatLabels.push(...leaves.slice(1));
      }
  
      const titleRoots = [
        ...Array.from(toolbar.querySelectorAll?.('[data-testid*="file-title" i]') || []),
        ...Array.from(toolbar.querySelectorAll?.('h1, h2, h3, [role="heading"]') || []),
        ...Array.from(toolbar.querySelectorAll?.('[class*="text-token-text-primary"][class*="truncate"]') || []),
      ];
      for (const root of titleRoots) {
        for (const text of leafTextCandidates(root)) {
          const extracted = DOM_PARSER.extractFileLikeNames(text);
          if (extracted.length) fileNameCandidates.push(...extracted);
          else if (text.length <= 220 && !formatLabels.includes(text)) displayTitleCandidates.push(text);
        }
        const rootText = normalizeText(root.textContent || '');
        const extracted = DOM_PARSER.extractFileLikeNames(rootText);
        if (extracted.length) fileNameCandidates.push(...extracted);
      }
  
      return {
        fileNameCandidates: unique(fileNameCandidates),
        displayTitleCandidates: unique(displayTitleCandidates),
        formatLabels: unique(formatLabels),
      };
    }
  
    function artifactPreviewFileNameCandidates(container) {
      return artifactPreviewTitleMetadata(container).fileNameCandidates;
    }
  
    function artifactPreviewContainerKind(container) {
      if (container?.matches?.('[role="dialog"], [role="alertdialog"]')) return 'dialog';
      if (container?.matches?.('[slot="content"]')) return 'slot-content';
      return 'unknown';
    }
  
    function artifactPreviewIdentityContext(artifact) {
      const expectedFormat = DOM_PARSER.artifactFormatToken({
        name: artifact.name || artifact.fileName || '',
        extension: artifact.extension || '',
        mime: artifact.mime || '',
      });
      if (!expectedFormat) return { expectedFormat: '', allowFormatOnly: false, sameFormatCount: 0 };
      const root = artifactSourceRoot(artifact);
      if (!root) return { expectedFormat, allowFormatOnly: false, sameFormatCount: 0 };
      const seen = new Set();
      const sameFormat = collectArtifactsFromNode(root, { turnKey: artifact.sourceTurnKey || '' })
        .filter((item) => item.phase === 'READY')
        .filter((item) => {
          const key = item.id || `${item.name || ''}:${item.blockStart || ''}:${item.blockEnd || ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return DOM_PARSER.artifactFormatToken({
            name: item.name || item.fileName || '',
            extension: item.extension || '',
            mime: item.mime || '',
          }) === expectedFormat;
        });
      return {
        expectedFormat,
        allowFormatOnly: sameFormat.length === 1,
        sameFormatCount: sameFormat.length,
      };
    }
  
    function artifactPreviewDescriptor(container, artifact, identityContext = null) {
      const controls = artifactPreviewControls(container);
      const desiredName = artifact.name || artifact.fileName || '';
      const desiredComparable = normalizeComparable(desiredName);
      const previewRoots = Array.from(container?.querySelectorAll?.('[id^="artifact-text-preview-"]') || []);
      const previewIds = previewRoots.map((element) => element.id || '').filter(Boolean);
      const toolbar = artifactPreviewToolbar(container);
      const heading = normalizeText(toolbar?.querySelector?.('h1, h2, h3, [role="heading"]')?.textContent || '');
      const dialogLabel = container?.getAttribute?.('aria-label') || '';
      const titleMetadata = artifactPreviewTitleMetadata(container);
      const context = identityContext || artifactPreviewIdentityContext(artifact);
      const controlDescriptors = controls.map((element) => ({
        tagName: element.tagName || '',
        testId: element.getAttribute?.('data-testid') || '',
        ariaLabel: element.getAttribute?.('aria-label') || '',
        title: element.getAttribute?.('title') || '',
        hasDownloadAttribute: element.hasAttribute?.('download') || false,
      }));
      const plan = DOM_PARSER.planArtifactPreviewDownload({
        desiredName,
        desiredExtension: artifact.extension || '',
        desiredMime: artifact.mime || '',
        dialogLabel,
        heading,
        fileNameCandidates: titleMetadata.fileNameCandidates,
        displayTitleCandidates: titleMetadata.displayTitleCandidates,
        formatLabels: titleMetadata.formatLabels,
        previewIds,
        controls: controlDescriptors,
        allowFormatOnly: context.allowFormatOnly,
      });
      const matchingTextRoot = previewRoots.find((element) => {
        const name = DOM_PARSER.artifactPreviewNameFromId(element.id || '');
        return normalizeComparable(name) === desiredComparable;
      }) || null;
      const textContentNode = matchingTextRoot?.querySelector?.('.cm-content code, pre code, code') || null;
      const action = plan.ok && Number.isInteger(plan.downloadControlIndex)
        ? controls[plan.downloadControlIndex] || null
        : null;
      const closeAction = plan.ok && Number.isInteger(plan.closeControlIndex)
        ? controls[plan.closeControlIndex] || null
        : controls.find((element, index) => DOM_PARSER.artifactPreviewActionKind(controlDescriptors[index]) === 'close') || null;
      const loaderVisible = artifactPreviewHasVisibleLoader(container);
      const readiness = DOM_PARSER.artifactPreviewReadiness({
        plan,
        downloadControlUsable: isUsableButton(action),
        textContentMounted: Boolean(textContentNode),
        loaderVisible,
      });
      const observedNames = [
        dialogLabel,
        heading,
        ...titleMetadata.fileNameCandidates,
        ...titleMetadata.displayTitleCandidates,
        ...previewIds.map((id) => DOM_PARSER.artifactPreviewNameFromId(id)),
      ].map(normalizeComparable).filter(Boolean);
      return {
        container,
        dialog: container,
        containerKind: artifactPreviewContainerKind(container),
        controls,
        controlDescriptors,
        previewIds,
        heading,
        dialogLabel,
        fileNameCandidates: titleMetadata.fileNameCandidates,
        displayTitleCandidates: titleMetadata.displayTitleCandidates,
        formatLabels: titleMetadata.formatLabels,
        observedNames,
        plan,
        action,
        closeAction,
        matchingTextRoot,
        textContentNode,
        loaderVisible,
        readiness,
        filenameMatched: Boolean(plan.ok),
        identityContext: context,
      };
    }
  
    function visibleArtifactPreviewContainers() {
      const isPreviewLike = (container) => {
        const metadata = artifactPreviewTitleMetadata(container);
        return Boolean(
          container.querySelector?.('[data-testid="fullscreen-shell-body"]')
          || container.querySelector?.('[data-testid="popcorn-toolbar"]')
          || container.querySelector?.('[id^="artifact-text-preview-"]')
          || metadata.fileNameCandidates.length
          || metadata.displayTitleCandidates.length,
        );
      };
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
        .filter(isVisible)
        .filter(isPreviewLike);
      const slots = Array.from(document.querySelectorAll('[slot="content"]'))
        .filter(isVisible)
        .filter((container) => !dialogs.some((dialog) => dialog.contains(container)))
        .filter(isPreviewLike);
      return [...dialogs, ...slots];
    }
  
    async function waitForArtifactPreview(artifact, containersBefore = new Set(), timeoutMs = 45_000, control = null, previewState = null, options = {}) {
      const started = Date.now();
      const identityContext = artifactPreviewIdentityContext(artifact);
      let lastDiagnosticKey = '';
      let lastDiagnosticAt = 0;
      while (Date.now() - started < timeoutMs) {
        if (control?.cancelled) throw new Error('Artifact preview readiness wait cancelled');
        const candidates = visibleArtifactPreviewContainers()
          .filter((container) => !containersBefore.has(container))
          .map((container) => artifactPreviewDescriptor(container, artifact, identityContext));
        const likely = candidates.find((candidate) => candidate.filenameMatched)
          || (candidates.length === 1 ? candidates[0] : null);
        if (likely && previewState) previewState.preview = likely;
        const match = candidates.find((candidate) => candidate.filenameMatched && candidate.readiness.ready);
        if (match) {
          if (previewState) previewState.preview = match;
          diagnostic('artifact.preview.ready', {
            artifactId: artifact.id || '',
            name: artifact.name || '',
            elapsedMs: Date.now() - started,
            source: match.plan.source || '',
            closeSource: match.plan.closeSource || '',
            containerKind: match.containerKind,
            controlCount: match.controls.length,
            previewIds: match.previewIds,
            loaderVisible: match.loaderVisible,
            identitySource: match.plan.identitySource || '',
            expectedFormat: match.plan.expectedFormat || '',
            observedFormats: match.plan.observedFormats || [],
            displayTitles: match.plan.displayTitles || [],
            allowFormatOnly: Boolean(match.identityContext?.allowFormatOnly),
            sameFormatCount: match.identityContext?.sameFormatCount || 0,
          });
          return { status: 'ready', preview: match };
        }
  
        if (options.returnForeignPreview !== false) {
          const foreign = candidates.find((candidate) => !candidate.filenameMatched && candidate.observedNames.length && candidate.closeAction);
          if (foreign) {
            diagnostic('artifact.preview.foreign_detected', {
              artifactId: artifact.id || '',
              name: artifact.name || '',
              elapsedMs: Date.now() - started,
              containerKind: foreign.containerKind,
              observedNames: foreign.observedNames,
              closeSource: foreign.plan.closeSource || '',
            });
            return { status: 'foreign', preview: foreign };
          }
        }
  
        const diagnosticState = likely ? {
          reason: likely.readiness.reason || likely.plan.reason || 'preview_not_ready',
          filenameMatched: likely.filenameMatched,
          containerKind: likely.containerKind,
          heading: likely.heading,
          fileNameCandidates: likely.fileNameCandidates,
          previewIds: likely.previewIds,
          controlCount: likely.controls.length,
          controlLabels: likely.controlDescriptors.map((item) => ({ testId: item.testId, ariaLabel: item.ariaLabel, title: item.title })),
          loaderVisible: likely.loaderVisible,
          textContentMounted: Boolean(likely.textContentNode),
          displayTitleCandidates: likely.displayTitleCandidates,
          formatLabels: likely.formatLabels,
          expectedFormat: likely.plan.expectedFormat || likely.identityContext?.expectedFormat || '',
          observedFormats: likely.plan.observedFormats || [],
          allowFormatOnly: Boolean(likely.identityContext?.allowFormatOnly),
          sameFormatCount: likely.identityContext?.sameFormatCount || 0,
        } : {
          reason: candidates.length ? 'matching_preview_not_identified' : 'preview_container_not_visible',
          candidateCount: candidates.length,
        };
        const diagnosticKey = JSON.stringify(diagnosticState);
        if (diagnosticKey !== lastDiagnosticKey || Date.now() - lastDiagnosticAt >= 1_000) {
          diagnostic('artifact.preview.waiting', {
            artifactId: artifact.id || '',
            name: artifact.name || '',
            elapsedMs: Date.now() - started,
            ...diagnosticState,
          });
          lastDiagnosticKey = diagnosticKey;
          lastDiagnosticAt = Date.now();
        }
        await delay(150);
      }
      diagnostic('artifact.preview.readiness_timeout', {
        artifactId: artifact.id || '',
        name: artifact.name || '',
        timeoutMs,
      });
      return { status: 'timeout', preview: previewState?.preview || null };
    }
  
    async function waitForLateArtifactPreview(artifact, containersBefore, timeoutMs = 5_000) {
      const started = Date.now();
      const identityContext = artifactPreviewIdentityContext(artifact);
      while (Date.now() - started < timeoutMs) {
        const match = visibleArtifactPreviewContainers()
          .filter((container) => !containersBefore.has(container))
          .map((container) => artifactPreviewDescriptor(container, artifact, identityContext))
          .find((candidate) => candidate.filenameMatched && isUsableButton(candidate.closeAction));
        if (match) {
          diagnostic('artifact.preview.late_detected', {
            artifactId: artifact.id || '',
            name: artifact.name || '',
            elapsedMs: Date.now() - started,
            containerKind: match.containerKind,
            closeSource: match.plan.closeSource || '',
          });
          return match;
        }
        await delay(150);
      }
      diagnostic('artifact.preview.late_not_seen', {
        artifactId: artifact.id || '',
        name: artifact.name || '',
        timeoutMs,
      });
      return null;
    }
  
    function textArtifactPreviewContent(preview) {
      if (!preview?.plan?.textPreview) return null;
      const code = preview.textContentNode
        || preview.matchingTextRoot?.querySelector?.('.cm-content code, pre code, code')
        || null;
      if (!code) return null;
      return String(code.textContent || '');
    }
  
    async function materializeArtifactPreview(artifact, containersBefore, control, previewState) {
      const configuredTimeoutMs = Number(CONFIG.artifactDownloadTimeoutMs) || 45_000;
      const previewTimeoutMs = Math.min(30_000, Math.max(10_000, Math.floor(configuredTimeoutMs * 0.67)));
      const outcome = await waitForArtifactPreview(artifact, containersBefore, previewTimeoutMs, control, previewState, { returnForeignPreview: true });
  
      if (outcome?.status === 'foreign' && outcome.preview) {
        previewState.preview = outcome.preview;
        await closeArtifactPreview(outcome.preview);
        previewState.preview = null;
        const observed = outcome.preview.observedNames?.filter(Boolean).join(', ') || 'unknown file';
        const error = new Error(`Artifact action opened a different file preview (${observed}) while ${artifact.name || artifact.id || 'artifact'} was requested`);
        error.artifactFatal = true;
        error.code = 'ARTIFACT_ACTION_TARGET_MISMATCH';
        diagnostic('artifact.action.target_mismatch', {
          artifactId: artifact.id || '',
          expectedName: artifact.name || artifact.fileName || '',
          observedNames: outcome.preview.observedNames || [],
          containerKind: outcome.preview.containerKind || '',
        });
        throw error;
      }
  
      if (outcome?.status !== 'ready' || !outcome.preview) {
        throw new Error(`Artifact preview was not ready within ${previewTimeoutMs}ms`);
      }
      const preview = outcome.preview;
      previewState.preview = preview;
      const action = preview.action || preview.controls[preview.plan.downloadControlIndex] || null;
      if (!isUsableButton(action)) throw new Error(`Artifact preview download control is not ready for ${artifact.name || artifact.id || 'artifact'}`);
  
      const downloadNameAliases = Array.from(preview.plan.downloadNameAliases || []).filter(Boolean);
      if (downloadNameAliases.length && typeof control?.addExpectedNames === 'function') {
        await control.addExpectedNames(downloadNameAliases);
        diagnostic('artifact.preview.download_aliases_added', {
          artifactId: artifact.id || '',
          name: artifact.name || '',
          aliases: downloadNameAliases,
          identitySource: preview.plan.identitySource || '',
        });
      }
  
      action.click();
      diagnostic('artifact.preview.download_clicked', {
        artifactId: artifact.id || '',
        name: artifact.name || '',
        source: preview.plan.source || '',
        closeSource: preview.plan.closeSource || '',
        containerKind: preview.containerKind,
        controlCount: preview.controls.length,
        previewIds: preview.previewIds,
      });
  
      // Browser/page capture normally wins immediately. Text previews retain a
      // byte-producing DOM fallback so a UI-only preview cannot stall the whole
      // artifact fetch for the browser-download timeout.
      if (!preview.plan.textPreview) throw new Error('Artifact preview download was clicked; waiting for browser capture');
      const fallbackStarted = Date.now();
      while (Date.now() - fallbackStarted < 2_500) {
        if (control?.cancelled) throw new Error('Artifact preview materialization cancelled');
        await delay(100);
      }
      if (control?.cancelled) throw new Error('Artifact preview materialization cancelled');
      const text = textArtifactPreviewContent(preview);
      if (text == null) throw new Error('Text artifact preview did not expose readable content');
      const bytes = new TextEncoder().encode(text);
      return {
        name: artifact.name || artifact.fileName || 'artifact.txt',
        mime: artifact.mime || 'text/plain',
        size: bytes.byteLength,
        contentBase64: arrayBufferToBase64(bytes.buffer),
        captureSource: 'text-preview-dom',
      };
    }
  
    function currentArtifactPreviewCloseAction(preview) {
      const container = preview?.container || preview?.dialog || null;
      if (!container) return null;
      const stable = container.querySelector?.('button[data-testid="close-button"]');
      if (isUsableButton(stable)) return stable;
      const controls = artifactPreviewControls(container);
      return controls.find((element) => DOM_PARSER.artifactPreviewActionKind({
        tagName: element.tagName || '',
        testId: element.getAttribute?.('data-testid') || '',
        ariaLabel: element.getAttribute?.('aria-label') || '',
        title: element.getAttribute?.('title') || '',
        hasDownloadAttribute: element.hasAttribute?.('download') || false,
      }) === 'close') || null;
    }
  
    async function closeArtifactPreview(preview) {
      const container = preview?.container || preview?.dialog || null;
      if (!container || !isVisible(container)) return;
  
      let closeSource = '';
      const close = currentArtifactPreviewCloseAction(preview) || preview.closeAction || null;
      if (isUsableButton(close)) {
        closeSource = close.getAttribute?.('data-testid') === 'close-button' ? 'stable_close_testid' : 'localized_close_label';
        try { close.click(); } catch {}
        for (let attempt = 0; attempt < 20 && isVisible(container); attempt += 1) await delay(100);
      }
  
      if (isVisible(container)) {
        closeSource ||= 'escape_fallback';
        try { container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); } catch {}
        try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); } catch {}
        for (let attempt = 0; attempt < 20 && isVisible(container); attempt += 1) await delay(100);
      }
  
      if (isVisible(container)) {
        const delayedCloseStarted = Date.now();
        while (Date.now() - delayedCloseStarted < 8_000 && isVisible(container)) {
          const delayedClose = currentArtifactPreviewCloseAction(preview);
          if (isUsableButton(delayedClose)) {
            closeSource = delayedClose.getAttribute?.('data-testid') === 'close-button' ? 'stable_close_testid_delayed' : 'localized_close_label_delayed';
            try { delayedClose.click(); } catch {}
          }
          await delay(150);
        }
      }
  
      const closed = !isVisible(container);
      diagnostic('artifact.preview.closed', {
        source: preview.plan?.source || '',
        closeSource,
        containerKind: preview.containerKind || artifactPreviewContainerKind(container),
        closed,
      });
      if (!closed) throw new Error('Artifact preview remained open after download materialization');
    }
  
    function isTextLikeArtifact(artifact) {
      return DOM_PARSER.isTextLikeArtifactDescriptor(artifact);
    }
  
    async function closeVisibleArtifactPreviewsBeforeAction(artifact) {
      const visible = visibleArtifactPreviewContainers();
      const identityContext = artifactPreviewIdentityContext(artifact);
      for (const container of visible) {
        const preview = artifactPreviewDescriptor(container, artifact, identityContext);
        if (!preview.closeAction && !currentArtifactPreviewCloseAction(preview)) continue;
        diagnostic('artifact.preview.preexisting_detected', {
          artifactId: artifact.id || '',
          name: artifact.name || '',
          filenameMatched: preview.filenameMatched,
          observedNames: preview.observedNames,
          containerKind: preview.containerKind,
        });
        await closeArtifactPreview(preview);
      }
    }
  
  
    return Object.freeze({
      closeArtifactPreview,
      closeVisibleArtifactPreviewsBeforeAction,
      materializeArtifactPreview,
      visibleArtifactPreviewContainers,
      waitForLateArtifactPreview,
    });
  }

  globalThis.ChatGptArtifactPreview = Object.freeze({ createArtifactPreview });
})();
