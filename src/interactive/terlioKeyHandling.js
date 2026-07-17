import {
  commandSuggestions,
  completeCommand,
  shouldCompleteSlashCommand,
} from './commands.js';
import { applyTerlioEditorKey } from './terlioInput.js';
import { isInteractiveThemeName } from './terlioThemes.js';
import { resetTranscriptScroll } from './terlioScroll.js';

export async function handleRuntimeKey(runtime, key) {
  const text = key.text || (key.printable ? key.sequence : '');

  if (runtime.workflowWizard?.opened) return runtime.handleWorkflowWizardKey(key);
  if (runtime.confirmPrompt) return runtime.handleConfirmKey(key, text);
  if (runtime.workflowExitPrompt) return runtime.handleWorkflowExitKey(key, text);
  if (runtime.interruptPrompt) return runtime.handleInterruptKey(key, text);

  if (key.name === 'ctrl-c') return runtime.handleInterrupt();
  if (key.ctrl && key.name === 't') return runtime.togglePointerOverride();
  if (key.ctrl && key.name === 'b') return toggleDetails(runtime);
  if (key.name === 'page-up' || key.name === 'page-down') return runtime.scrollVisiblePane(key.name);
  if (isShiftVerticalKey(key)) return runtime.scrollVisiblePane(key.name);
  if (key.ctrl && (key.name === 'home' || key.name === 'end')) return runtime.scrollVisiblePane(key.name);
  if (key.name === 'ctrl-d') {
    if (runtime.editor.value) runtime.editor.deleteForward();
    else runtime.exit(0);
    return runtime.invalidate();
  }
  if (key.name === 'redraw') return runtime.clearTranscript();
  if (key.name === 'escape') return handleEscape(runtime);
  if (key.name === 'tab') return completeInput(runtime);
  if (key.name === 'enter' && !key.shift && !key.ctrl) return submitEditor(runtime);
  if (key.name === 'enter' && (key.shift || key.ctrl)) {
    markInputTouched(runtime);
    runtime.editor.insertLineBreak();
    return runtime.invalidate();
  }
  if (key.name === 'up' || key.name === 'down') return handleVerticalKey(runtime, key.name);

  const result = applyTerlioEditorKey(runtime.editor, key, { multiline: true });
  if (result.handled) {
    markInputTouched(runtime);
    runtime.suggestionIndex = 0;
    syncThemePreview(runtime);
    runtime.invalidate();
  }
}

export function completeInput(runtime) {
  markInputTouched(runtime, { preserveSuggestionNavigation: true });
  const suggestions = commandSuggestions(runtime.editor.value, suggestionContext(runtime));
  if (runtime.editor.value.trimStart().startsWith('/') && suggestions.length) {
    const selected = suggestions[boundedSuggestionIndex(runtime, suggestions)];
    if (selected?.executeBare && String(runtime.editor.value).trimEnd() === selected.insert) {
      syncThemePreview(runtime);
      return runtime.invalidate();
    }
    if (selected && shouldCompleteSlashCommand(runtime.editor.value, selected)) {
      runtime.editor.set(selected.insert);
      runtime.suggestionIndex = 0;
      runtime.suggestionNavigationActive = false;
      syncThemePreview(runtime);
      return runtime.invalidate();
    }
  }
  runtime.editor.set(completeCommand(runtime.editor.value));
  runtime.suggestionNavigationActive = false;
  syncThemePreview(runtime);
  runtime.invalidate();
}

export function submitEditor(runtime) {
  const line = runtime.editor.getSubmissionValue?.() ?? runtime.editor.value;
  const suggestions = activeSuggestions(runtime);
  if (suggestions.length) {
    const selected = suggestions[boundedSuggestionIndex(runtime, suggestions)];
    const exactExecutable = suggestions.find((item) => item.executeBare && item.insert === String(line).trimEnd());
    if (!exactExecutable && selected && shouldCompleteSlashCommand(line, selected)) {
      runtime.editor.set(selected.insert);
      runtime.suggestionIndex = 0;
      runtime.suggestionNavigationActive = false;
      syncThemePreview(runtime);
      return runtime.invalidate();
    }
  }
  const preserveThemePreview = /^\s*\/theme\s+\S+/i.test(String(line || ''));
  const record = runtime.editor.serialize?.() || { text: line, pastes: [] };
  runtime.editor.clear();
  resetInputNavigation(runtime, { preserveThemePreview });
  runtime.invalidate();
  void runtime.submitLine(line, { historyRecord: record });
}

export function activeSuggestions(runtime) {
  return runtime.shouldNavigateSuggestions()
    ? commandSuggestions(runtime.editor.value, suggestionContext(runtime))
    : [];
}

export function suggestionContext(runtime) {
  return {
    state: runtime.state,
    health: runtime.options.bridge.health(),
    workflows: runtime.options.workflowManager?.list?.() || [],
  };
}

export function setInputFromHistory(runtime, record) {
  clearThemePreview(runtime);
  runtime.historyBrowsing = true;
  runtime.historyRevision = runtime.inputRevision;
  runtime.completionActive = false;
  runtime.suggestionNavigationActive = false;
  runtime.suggestionIndex = 0;
  if (typeof runtime.editor.restore === 'function') runtime.editor.restore(record);
  else runtime.editor.set(record?.text || record || '');
  runtime.invalidate();
}

export function markInputTouched(runtime, { completion = true, preserveSuggestionNavigation = false } = {}) {
  runtime.inputRevision += 1;
  if (runtime.historyBrowsing) {
    runtime.historyIndex = null;
    runtime.historyDraft = null;
  }
  runtime.historyBrowsing = false;
  runtime.historyRevision = -1;
  if (!preserveSuggestionNavigation) runtime.suggestionNavigationActive = false;
  if (completion) runtime.completionActive = true;
}

export function resetInputNavigation(runtime, { preserveThemePreview = false } = {}) {
  runtime.historyBrowsing = false;
  runtime.historyIndex = null;
  runtime.historyDraft = null;
  runtime.historyRevision = -1;
  runtime.completionActive = false;
  runtime.suggestionNavigationActive = false;
  runtime.suggestionIndex = 0;
  if (!preserveThemePreview) clearThemePreview(runtime);
}

export function syncThemePreview(runtime) {
  const value = String(runtime.editor.value || '').trimStart();
  if (!runtime.completionActive || !/^\/theme(?:\s|$)/i.test(value)) {
    clearThemePreview(runtime);
    return;
  }
  const suggestions = commandSuggestions(value, suggestionContext(runtime));
  const selected = suggestions[boundedSuggestionIndex(runtime, suggestions)];
  const explicit = /^\/theme\s+(\S+)/i.exec(value)?.[1] || '';
  const next = selected?.previewTheme || (isInteractiveThemeName(explicit) ? explicit : '');
  if (!next) {
    clearThemePreview(runtime);
    return;
  }
  runtime.themePreviewName = next;
}

export function clearThemePreview(runtime) {
  runtime.themePreviewName = '';
}

function toggleDetails(runtime) {
  runtime.detailsOpen = !runtime.detailsOpen;
  runtime.detailsScroll = resetTranscriptScroll();
  return runtime.invalidate();
}

function handleEscape(runtime) {
  if (runtime.detailsOpen) {
    runtime.detailsOpen = false;
    runtime.detailsScroll = resetTranscriptScroll();
    return runtime.invalidate();
  }
  if (runtime.editor.value) runtime.rememberEditorDraft?.();
  runtime.editor.clear();
  resetInputNavigation(runtime);
  clearThemePreview(runtime);
  return runtime.invalidate();
}

function handleVerticalKey(runtime, keyName) {
  const delta = keyName === 'up' ? -1 : 1;
  const width = runtime.editorContentWidth();
  if (runtime.editor.value && runtime.editor.canMoveVisualVertical?.(delta, width)) {
    runtime.editor.moveVisualVertical(delta, width);
    runtime.suggestionNavigationActive = false;
    return runtime.invalidate();
  }

  const suggestions = activeSuggestions(runtime);
  if (suggestions.length && String(runtime.editor.value).trimStart().startsWith('/')) {
    runtime.suggestionNavigationActive = true;
    runtime.suggestionRevision = runtime.inputRevision;
    runtime.suggestionIndex = Math.max(0, Math.min(
      suggestions.length - 1,
      runtime.suggestionIndex + (keyName === 'up' ? -1 : 1),
    ));
    syncThemePreview(runtime);
    return runtime.invalidate();
  }

  const canBrowseHistory = !runtime.editor.value || (runtime.historyBrowsing && runtime.historyRevision === runtime.inputRevision);
  if (!canBrowseHistory) return;
  if (keyName === 'up') return historyUp(runtime);
  return historyDown(runtime);
}

function historyUp(runtime) {
  runtime.ensureHistoryScope?.();
  if (!runtime.history.length) return;
  if (runtime.historyIndex == null) runtime.historyDraft = runtime.editor.serialize?.() || { text: runtime.editor.value, pastes: [] };
  runtime.historyIndex = runtime.historyIndex == null ? 0 : Math.min(runtime.historyIndex + 1, runtime.history.length - 1);
  setInputFromHistory(runtime, runtime.history[runtime.historyIndex]);
}

function historyDown(runtime) {
  runtime.ensureHistoryScope?.();
  if (!runtime.history.length || runtime.historyIndex == null) return;
  const next = runtime.historyIndex - 1;
  if (next < 0) {
    const draft = runtime.historyDraft || { text: '', pastes: [] };
    runtime.historyIndex = null;
    runtime.historyDraft = null;
    runtime.historyBrowsing = false;
    runtime.historyRevision = -1;
    runtime.completionActive = false;
    if (typeof runtime.editor.restore === 'function') runtime.editor.restore(draft);
    else runtime.editor.set(draft.text || '');
  } else {
    runtime.historyIndex = next;
    setInputFromHistory(runtime, runtime.history[next]);
  }
  runtime.invalidate();
}

function boundedSuggestionIndex(runtime, suggestions) {
  return Math.max(0, Math.min(runtime.suggestionIndex || 0, Math.max(0, suggestions.length - 1)));
}

function isShiftVerticalKey(key) {
  if (key.name !== 'up' && key.name !== 'down') return false;
  if (key.shift) return true;
  return /^\u001b\[1;(?:2|4|6|8)[AB]$/.test(String(key.sequence || ''));
}
