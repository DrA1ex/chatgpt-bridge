import {
  Box,
  Column,
  Row,
  SelectableText,
  Text,
  TextEditorView,
  color,
  createTextLineSource,
  fitInline,
  truncateVisible,
  visibleLength,
  visibleWindowLines,
  wrapText,
} from 'terlio.js';
import { commandSuggestions } from './commands.js';
import {
  buildLiveLines,
  compactTabLabel,
  deriveInteractiveRuntimeStatus,
  shouldShowDebugEvents,
  transcriptBodyText,
  truncate,
} from './view.js';
import { resolveInteractiveLayout } from './terlioLayout.js';
import { DEFAULT_INTERACTIVE_THEME_NAME, resolveInteractiveTheme } from './terlioThemes.js';
import { SIDEBAR_KEYBOARD_SHORTCUTS, keyboardGridLines } from './terlioHelp.js';
import {
  resolveTranscriptScroll,
  scrollbarForWindow,
  transcriptScrollLabel,
} from './terlioScroll.js';
import { renderWorkflowSurface } from './workflowSurfaces/index.js';

export const INTERACTIVE_THEME = resolveInteractiveTheme(DEFAULT_INTERACTIVE_THEME_NAME);

const ENTRY_TOKEN = {
  system: 'system',
  user: 'user',
  assistant: 'assistant',
  command: 'accent',
  error: 'error',
  artifact: 'warning',
};

export function prepareInteractiveView(model, viewport = {}) {
  const width = Math.max(40, Number(viewport.width) || 100);
  const height = Math.max(18, Number(viewport.height) || 34);
  const theme = model.theme || resolveInteractiveTheme(model.state?.themeName);
  const health = model.health || {};
  const state = model.state || {};
  const editorDisplay = model.editor?.getDisplayModel?.() || { value: String(model.editor?.value || ''), cursor: Number(model.editor?.cursor) || 0 };
  const editorRows = Math.max(1, Math.min(5, model.editor?.visualLineCount?.(Math.max(4, width - 4)) || String(editorDisplay.value || '').split('\n').length));
  const surfaceOpen = Boolean(model.workflowSurface?.opened);
  const surfaceInputOpen = Boolean(model.workflowSurface?.input?.opened);
  const suggestionCapacity = model.detailsOpen || surfaceOpen ? 0 : resolveSuggestionCapacity(width, height);
  const suggestions = suggestionRows(model, width, suggestionCapacity);
  const visibleSuggestionRows = suggestions.length;
  const surfaceEditor = model.workflowSurface?.input?.editor;
  const surfaceEditorRows = Math.max(1, Math.min(
    5,
    surfaceEditor?.visualLineCount?.(Math.max(4, width - 4)) || 1,
  ));
  const inputHeight = surfaceInputOpen
    ? surfaceEditorRows + 2
    : model.detailsOpen || surfaceOpen ? 0 : editorRows + 2 + visibleSuggestionRows;
  const overlay = renderOverlay(model, theme);
  const overlayHeight = overlay ? 5 : 0;
  const layout = resolveInteractiveLayout({ width, height, inputHeight, overlayHeight });
  layout.editorRows = editorRows;
  layout.inputHeight = inputHeight;
  const chatLines = buildChatLines(model, Math.max(18, layout.chatWidth - 6), theme);
  const visibleRows = Math.max(1, layout.mainHeight - 2);
  const transcript = resolveTranscriptScroll(model.transcriptScroll || {}, { totalRows: chatLines.length, visibleRows });
  const detailsLines = model.detailsOpen ? buildDetailsLines({ model, width, theme }) : [];
  const details = model.detailsOpen
    ? resolveTranscriptScroll(model.detailsScroll || {}, { totalRows: detailsLines.length, visibleRows })
    : model.detailsScroll || null;
  const header = renderHeader({ health, state, busy: model.busy, phase: model.phase, tick: model.tick, width, theme });
  const main = surfaceOpen
    ? renderWorkflowSurfacePanel({ model, width, height: layout.mainHeight, theme })
    : model.detailsOpen
    ? renderDetailsPanel({ model, lines: detailsLines, width, height: layout.mainHeight, details, theme })
    : renderMain({ model, layout, chatLines, transcript, theme });
  const input = surfaceInputOpen ? renderInput({
    model,
    suggestions: [],
    suggestionCapacity: 0,
    width: layout.inputWidth,
    height: inputHeight,
    editorRows: surfaceEditorRows,
    editorDisplay: surfaceEditor?.getDisplayModel?.(),
    editor: surfaceEditor,
    theme,
    titleOverride: ' action input JSON › ',
    placeholderOverride: '{}',
  }) : model.detailsOpen || surfaceOpen ? null : renderInput({
    model,
    suggestions,
    suggestionCapacity: visibleSuggestionRows,
    width: layout.inputWidth,
    height: inputHeight,
    editorRows,
    editorDisplay,
    theme,
    hint: '',
  });
  const footer = Text(fitInline(color(theme, 'muted', footerHint(model, layout, transcript, suggestions.length)), width), { wrap: false });
  const children = [header, main, overlay, input, footer].filter(Boolean);
  const node = Column({ height }, ...children);
  return { node, transcript, details, layout };
}

export function renderInteractiveView(model, viewport = {}) {
  return prepareInteractiveView(model, viewport).node;
}

export function renderHeader({ health = {}, state = {}, busy = false, phase = 'idle', tick = 0, width = 100, theme = INTERACTIVE_THEME } = {}) {
  const activeClient = health.activeClient || health.clients?.[0] || null;
  const status = health.ok ? 'CONNECTED' : health.needsSelection ? 'SELECT TAB' : 'OFFLINE';
  const statusToken = health.ok ? 'success' : health.needsSelection ? 'warning' : 'danger';
  const runtime = deriveInteractiveRuntimeStatus(health, busy, phase);
  const spinner = runtime.active ? `${['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][tick % 10]} ${runtime.label}` : runtime.label;
  const projectName = state.projectRoot ? state.projectRoot.split(/[\\/]/).filter(Boolean).at(-1) : 'none';
  const innerWidth = Math.max(12, width - 4);
  const left = `${color(theme, statusToken, status)}  ${compactTabLabel(activeClient)}${innerWidth >= 58 ? `  ·  tabs ${health.clients?.length || 0}` : ''}`;
  const requestRef = runtime.requestId ? shortRef(runtime.requestId, innerWidth >= 110 ? 18 : 10) : '';
  const rightText = requestRef ? `${spinner} · ${requestRef}` : spinner;
  const right = color(theme, runtimeToken(runtime.color), rightText);
  const metadata = packMetadataLine([
    { long: `Project ${projectName}`, short: `P ${shortRef(projectName, 14)}`, required: true },
    { long: `Session ${state.sessionId || 'current tab'}`, short: `S ${shortRef(state.sessionId || 'current', 14)}`, required: true },
    { long: `Model ${state.currentModel || state.model || 'default'}`, short: `M ${shortRef(state.currentModel || state.model || 'default', 14)}` },
    { long: `Effort ${state.currentEffort || state.effort || 'default'}`, short: `E ${state.currentEffort || state.effort || 'default'}` },
    { long: `Files ${state.pendingAttachments?.length || 0}`, short: `F ${state.pendingAttachments?.length || 0}` },
    { long: `Theme ${state.themeName || DEFAULT_INTERACTIVE_THEME_NAME}`, short: `T ${state.themeName || DEFAULT_INTERACTIVE_THEME_NAME}` },
  ].filter(Boolean), innerWidth);
  return Box({ border: true, borderColor: health.ok ? theme.success : health.needsSelection ? theme.warning : theme.danger, padding: { left: 1, right: 1 }, title: ' ChatGPT Bridge ', height: 4 },
    Text(edgeAlignedLine(left, right, innerWidth), { wrap: false }),
    Text(color(theme, 'muted', fitInline(metadata, innerWidth)), { wrap: false }),
  );
}

export function renderMain({ model, layout, chatLines, transcript, theme = INTERACTIVE_THEME } = {}) {
  const chatPane = renderScrollableChat({
    lines: chatLines,
    width: layout.chatWidth,
    height: layout.mainHeight,
    transcript,
    theme,
    onWheel: model.onTranscriptWheel,
    onPointer: model.onTranscriptPointer,
    selection: model.transcriptSelection,
    onSelectionChange: model.onTranscriptSelectionChange,
    onCopy: model.onTranscriptCopy,
  });
  if (layout.mode === 'chat') return chatPane;

  const left = renderLeftSidebar({ model, width: layout.leftWidth, height: layout.mainHeight, theme });
  if (layout.mode === 'sidebar') {
    return Row({ gap: 1, widths: [layout.leftWidth, layout.chatWidth], height: layout.mainHeight }, left, chatPane);
  }

  const right = renderRightSidebar({ model, width: layout.rightWidth, height: layout.mainHeight, theme });
  return Row({ gap: 1, widths: [layout.leftWidth, layout.chatWidth, layout.rightWidth], height: layout.mainHeight }, left, chatPane, right);
}

export function renderInput({ model, suggestions = [], suggestionCapacity = 5, width = 100, height = 4, editorRows = 1, editorDisplay = null, editor = null, theme = INTERACTIVE_THEME, hint = '', titleOverride = '', placeholderOverride = '' } = {}) {
  const activeEditor = editor || model.editor;
  const busy = Boolean(model.busy || model.confirmPrompt);
  const placeholder = placeholderOverride || (busy ? 'request is running; type /stop or press Ctrl+C' : hint || 'type a message or /help');
  const title = titleOverride || (busy ? ' busy › ' : ' bridge › ');
  const editorHeight = Math.max(1, Math.min(5, Number(editorRows) || 1));
  const display = editorDisplay || activeEditor?.getDisplayModel?.() || { value: activeEditor?.value || '', cursor: activeEditor?.cursor || 0 };
  const editorNode = TextEditorView({
    title,
    value: display.value || '',
    cursor: display.cursor || 0,
    width,
    height: editorHeight,
    placeholder,
    lineNumbers: false,
  });
  const rows = suggestions.map((item) => Text(item.selected ? color(theme, 'selected', item.text) : color(theme, 'suggestion', item.text), { wrap: false }));
  return Column({ height }, ...rows.slice(-suggestionCapacity), editorNode);
}

function renderWorkflowSurfacePanel({ model, width, height, theme }) {
  const view = renderWorkflowSurface(model.workflowSurface?.surface || {});
  const navigation = model.workflowSurface?.navigation || {};
  const contentWidth = Math.max(12, width - 6);
  const lines = [
    color(theme, 'accent', view.title || 'Workflow'),
    view.summary ? color(theme, 'muted', view.summary) : '',
    ...view.lines,
    '',
    color(theme, 'accent', 'Actions'),
    ...view.actions.map((action, index) => {
      const selected = action.id === navigation.focusActionId;
      const marker = selected ? '›' : ' ';
      const detail = action.enabled ? action.description : action.disabledReason;
      const token = !action.enabled
        ? 'muted'
        : selected
          ? 'selected'
          : action.role === 'destructive' ? 'danger' : 'suggestion';
      return color(theme, token, `${marker} [${index + 1}] ${action.label}${detail ? ` · ${detail}` : ''}`);
    }),
  ];
  const wrapped = lines.flatMap((line) => wrapText(line, contentWidth));
  const visibleRows = Math.max(1, height - 2);
  const scroll = resolveTranscriptScroll(model.workflowSurface?.scroll || {}, {
    totalRows: wrapped.length,
    visibleRows,
  });
  const window = visibleWindowLines(wrapped, { height: visibleRows, scroll: scroll.scroll });
  const gutter = scrollbarForWindow({ totalRows: wrapped.length, visibleRows, scroll: window.scroll });
  if (model.workflowSurface?.scroll) model.workflowSurface.scroll.scroll = window.scroll;
  const rows = window.lines.map((line, index) => Text(
    `${fitInline(line, contentWidth)} ${color(theme, 'muted', gutter[index])}`,
    { wrap: false },
  ));
  const status = model.workflowSurface?.busy
    ? ' · working'
    : model.workflowSurface?.lastError?.message
      ? ` · ${model.workflowSurface.lastError.message}`
      : '';
  return Box({
    border: true,
    borderColor: model.workflowSurface?.lastError ? theme.danger : theme.accent,
    padding: { left: 1, right: 1 },
    title: ` Workflow${status} · Esc close `,
    height,
  }, ...rows);
}

export function suggestionRows(model, width = 100, visibleCount = 5) {
  if (!model.completionActive || visibleCount <= 0) return [];
  const suggestions = commandSuggestions(model.editor?.value || '', suggestionContext(model));
  if (!suggestions.length) return [];
  const safeIndex = Math.max(0, Math.min(model.suggestionIndex || 0, suggestions.length - 1));
  const count = Math.max(1, Number(visibleCount) || 1);
  const offset = Math.max(0, Math.min(Math.max(0, suggestions.length - count), safeIndex - 1));
  return suggestions.slice(offset, offset + count).map((item, row) => {
    const selected = offset + row === safeIndex;
    const label = String(item.label || item.usage || item.cmd || item.value || '');
    const detail = String(item.detail || '');
    const left = detail ? `${label}  ${detail}` : label;
    const leftWidth = Math.min(52, Math.max(18, Math.floor(width * 0.46)));
    return {
      selected,
      text: `${selected ? '› ' : '  '}${fitInline(left, leftWidth)} ${item.description || ''}`,
      command: item.cmd,
      insert: item.insert,
      previewTheme: item.previewTheme || '',
    };
  });
}

function suggestionContext(model = {}) {
  return {
    state: model.state || {},
    health: model.health || {},
    workflow: model.workflow || null,
  };
}

export function buildTranscriptLines(entries = [], width = 80, theme = INTERACTIVE_THEME) {
  const lines = [];
  for (const entry of entries) {
    const token = ENTRY_TOKEN[entry.kind] || 'muted';
    const title = entry.title || entry.kind || 'Entry';
    lines.push(color(theme, token, title));
    if (entry.subtitle) lines.push(color(theme, 'muted', `  ${entry.subtitle}`));
    const body = transcriptBodyText(entry);
    if (body) lines.push(...formatTranscriptBody(body, Math.max(12, width), theme));
    lines.push('');
  }
  return lines.length ? lines : ['No transcript entries yet.'];
}

export function buildChatLines(model, width = 80, theme = INTERACTIVE_THEME) {
  const lines = buildTranscriptLines(model.entries || [], width, theme);
  const live = buildLiveTranscriptLines(model, width, theme);
  if (live.length) lines.push(...live);
  return lines;
}

function buildLiveTranscriptLines(model, width, theme) {
  const sections = [];
  const append = (label, value, token) => {
    const text = String(value || '').trim();
    if (!text) return;
    sections.push(color(theme, token, label));
    sections.push(...wrapText(text, Math.max(12, width)).map((line) => `  ${line}`));
    sections.push('');
  };
  append('Thinking · live', model.thinking, 'muted');
  append('Progress · live', model.progress, 'info');
  if (!sections.length) return [];
  return [color(theme, 'muted', '─ current response ─'), '', ...sections];
}

function renderScrollableChat({
  lines,
  width,
  height,
  transcript,
  theme,
  onWheel = null,
  onPointer = null,
  selection = null,
  onSelectionChange = null,
  onCopy = null,
}) {
  const innerHeight = Math.max(1, height - 2);
  const contentWidth = Math.max(8, width - 6);
  const sourceLines = createTextLineSource(lines, {
    transform: (line) => fitInline(line, contentWidth),
  });
  const window = visibleWindowLines(sourceLines, { height: innerHeight, scroll: transcript.scroll });
  const gutter = scrollbarForWindow({ totalRows: sourceLines.length, visibleRows: innerHeight, scroll: window.scroll });
  const selectable = SelectableText({
    lines: window.lines,
    selectionLines: sourceLines,
    selectionOffsetY: window.start,
    selection,
    pointerId: 'bridge:chat:selection',
    pointerWidth: contentWidth,
    onWheel,
    onSelectionChange,
    onCopy,
    copyOnRelease: false,
    copyOnSelectionClick: true,
    nativeSelectionModifier: 'shift',
  });
  const scrollbar = Column({ height: innerHeight }, ...gutter.map((item) => Text(color(theme, 'muted', item), { wrap: false })));
  const body = Row({ gap: 1, widths: [contentWidth, 1], height: innerHeight }, selectable, scrollbar);
  const selectedCount = Array.from(String(selection?.text || '')).length;
  const selectionState = selectedCount ? `${selectedCount} selected · click highlight to copy` : transcriptScrollLabel({ ...transcript, scroll: window.scroll });
  const title = ` Chat · ${selectionState} `;
  return Box({
    border: true,
    borderColor: theme.border,
    padding: { left: 1, right: 1 },
    title,
    height,
    pointerId: 'bridge:chat',
    pointerWidth: 'fill',
    onWheel,
    onClick: onPointer,
    onDrag: onPointer,
  }, body);
}

function renderLeftSidebar({ model, height, theme }) {
  if (!showsSidebarKeyHelp(height)) {
    return panelFromLines(' Context ', contextLines(model), { height, theme, token: null, tail: false });
  }
  const contextHeight = Math.max(8, Math.min(11, Math.floor(height * 0.46)));
  const shortcutHeight = Math.max(8, height - contextHeight);
  return Column({ height },
    panelFromLines(' Context ', contextLines(model), { height: contextHeight, theme, token: null, tail: false }),
    panelFromLines(' Keys ', shortcutLines(), { height: shortcutHeight, theme, token: null, tail: false }),
  );
}

function renderRightSidebar({ model, width, height, theme }) {
  const liveLines = buildLiveLines({
    activityLines: model.activityLines || [],
    thinking: model.thinking,
    progress: model.progress,
    answer: '',
    maxLines: Math.max(1, height - 2),
    maxColumns: Math.max(18, width - 4),
  });
  const debugLines = shouldShowDebugEvents(model.state) ? (model.eventLines || []).slice(-20) : [];
  const activity = liveLines.length ? liveLines : debugLines.length ? debugLines : ['No active request.', '', 'Completed answers remain in Chat.'];
  return panelFromLines(liveLines.length ? ' Current activity ' : debugLines.length ? ' Debug events ' : ' Activity ', activity, {
    height, theme, token: liveLines.length ? 'info' : 'muted',
  });
}

function buildDetailsLines({ model, width, theme }) {
  const columns = width >= 120 ? 2 : 1;
  const lines = [color(theme, 'accent', 'Keyboard'), ...keyboardGridLines(Math.max(24, width - 4), { terminalWidth: width, columns }), ''];
  lines.push(color(theme, 'accent', 'Connection and context'), ...compactContextLines(model).flatMap((line) => wrapText(line, Math.max(20, width - 6))), '');
  lines.push(color(theme, 'muted', 'Wheel, Shift+↑/↓, PgUp/PgDn, and the scrollbar move this panel.'));
  return lines;
}

function renderDetailsPanel({ model, lines, width, height, details, theme }) {
  const innerHeight = Math.max(1, height - 2);
  const window = visibleWindowLines(lines, { height: innerHeight, scroll: details?.scroll || 0 });
  const gutter = scrollbarForWindow({ totalRows: lines.length, visibleRows: innerHeight, scroll: window.scroll });
  const contentWidth = Math.max(8, width - 6);
  const rows = window.lines.map((line, index) => Text(`${fitInline(line, contentWidth)} ${color(theme, 'muted', gutter[index])}`, { wrap: false }));
  return Box({
    border: true,
    borderColor: theme.border,
    padding: { left: 1, right: 1 },
    title: ` Details · Ctrl+B close · ${transcriptScrollLabel({ ...details, scroll: window.scroll })} `,
    height,
    pointerId: 'bridge:details',
    pointerWidth: 'fill',
    onWheel: model.onDetailsWheel,
    onClick: model.onDetailsPointer,
    onDrag: model.onDetailsPointer,
  }, ...rows);
}

function compactContextLines(model) {
  const state = model.state || {};
  const health = model.health || {};
  const active = health.activeClient || health.clients?.[0] || null;
  const artifacts = Array.isArray(state.lastArtifacts) ? state.lastArtifacts.slice(-3) : [];
  return [
    `Connection: ${health.ok ? 'connected' : health.needsSelection ? 'select tab' : 'offline'} · ${active?.title || active?.id || '(no tab)'}`,
    `Tab id: ${active?.id || '(none)'}`,
    `Project: ${state.projectRoot || '(none)'}`,
    `Session: ${state.sessionId || 'current tab'}`,
    `Model: ${state.currentModel || state.model || 'default'} · Effort: ${state.currentEffort || state.effort || 'default'}`,
    `Files: ${state.pendingAttachments?.length || 0} · Theme: ${state.themeName || DEFAULT_INTERACTIVE_THEME_NAME}`,
    ...(artifacts.length ? [`Artifacts: ${artifacts.map((item) => item.name || item.filename || item.id || 'artifact').join(' · ')}`] : []),
  ];
}

function contextLines(model) {
  const state = model.state || {};
  const health = model.health || {};
  const active = health.activeClient || health.clients?.[0] || null;
  return [
    `Connection: ${health.ok ? 'connected' : health.needsSelection ? 'select tab' : 'offline'}`,
    `Tab: ${active?.title || active?.id || '(none)'}`,
    `Project: ${state.projectRoot ? state.projectRoot.split(/[\\/]/).filter(Boolean).at(-1) : '(none)'}`,
    `Session: ${shortRef(state.sessionId || 'current tab', 24)}`,
    `Model: ${shortRef(state.currentModel || state.model || 'default', 22)}`,
    `Effort: ${state.currentEffort || state.effort || 'default'}`,
    `Files: ${state.pendingAttachments?.length || 0} · Theme: ${state.themeName || DEFAULT_INTERACTIVE_THEME_NAME}`,
  ];
}

function shortcutLines() {
  return SIDEBAR_KEYBOARD_SHORTCUTS.map(([key, description]) => `${String(key).padEnd(14)} ${description}`);
}

function renderOverlay(model, theme) {
  if (model.confirmPrompt) {
    return Box({ border: true, borderColor: theme.warning, padding: { left: 1, right: 1 }, title: ' Confirmation ', height: 5 },
      Text(color(theme, 'warning', model.confirmPrompt || 'Confirm? [y/N]')),
      Text(color(theme, 'muted', 'Press y to accept, n/Esc/Enter to cancel.'), { wrap: false }),
    );
  }
  if (model.interruptPrompt) {
    return Box({ border: true, borderColor: theme.warning, padding: { left: 1, right: 1 }, title: ' Request is still running ', height: 5 },
      Text('Press c to cancel the ChatGPT prompt.'),
      Text('Press d to detach/exit and leave it running.'),
      Text(color(theme, 'muted', 'Press Esc to continue.'), { wrap: false }),
    );
  }
  return null;
}

function panelFromLines(title, lines, { height, theme, token, tail = true }) {
  const inner = Math.max(1, Number(height) - 2);
  const source = Array.from(lines || []);
  const visible = tail ? source.slice(-inner) : source.slice(0, inner);
  while (visible.length < inner) tail ? visible.unshift('') : visible.push('');
  return Box({ border: true, borderColor: theme.border, padding: { left: 1, right: 1 }, title, height },
    ...visible.map((line) => Text(token ? color(theme, token, truncateVisible(line, 400)) : truncateVisible(line, 400), { wrap: false })),
  );
}

function footerHint(model, layout, transcript, suggestionCount = 0) {
  if (model.workflowSurface?.opened) {
    if (model.workflowSurface.input?.opened) return 'Enter run  ·  Shift+Enter newline  ·  Esc cancel input';
    return '↑/↓ choose action  ·  Enter run  ·  1–9 select  ·  PgUp/PgDn scroll  ·  Esc close';
  }
  if (model.confirmPrompt) return 'y approve  ·  n/Esc cancel';
  if (model.interruptPrompt) return 'c cancel  ·  d detach  ·  Esc continue';
  if (model.detailsOpen) return 'Ctrl+B close details';
  if (suggestionCount) return '↑/↓ choose  ·  Enter use  ·  Tab complete  ·  Esc cancel';
  const history = transcriptScrollLabel(transcript);
  const keyHelpVisible = layout.mode !== 'chat' && showsSidebarKeyHelp(layout.mainHeight);
  if (keyHelpVisible) return model.busy ? `/stop cancel  ·  ${history}` : `/ commands  ·  ${history}`;
  if (model.busy) return `/stop  ·  PgUp chat  ·  Ctrl+B info  ·  ${history}`;
  return 'PgUp chat  ·  Ctrl+B info  ·  Ctrl+C exit';
}

function resolveSuggestionCapacity(width, height) {
  if (height <= 22) return 3;
  if (width < 72 || height <= 28) return 4;
  return 5;
}

function formatTranscriptBody(body, width, theme) {
  const output = [];
  for (const rawLine of String(body || '').split('\n')) {
    if (!rawLine) {
      output.push('');
      continue;
    }
    const wrapped = wrapText(rawLine, width);
    for (const [index, line] of wrapped.entries()) {
      output.push(`  ${semanticTranscriptLine(line, theme, { continuation: index > 0 })}`);
    }
  }
  return output;
}

function semanticTranscriptLine(line, theme, { continuation = false } = {}) {
  const text = String(line || '');
  if (/^https?:\/\//i.test(text.trim())) return color(theme, 'muted', text);
  if (/^\s*\/[a-z][\w-]*/i.test(text)) return color(theme, 'accent', text);
  if (/^[A-Z][^:]{0,42}:\s*$/.test(text)) return color(theme, 'accent', text);

  const indexed = text.match(/^(\s*)(\*| )\s*\[(\d+)\]\s+(.+)$/);
  if (indexed) {
    const [, indent, marker, index, rest] = indexed;
    const markerText = marker === '*' ? color(theme, 'success', '●') : color(theme, 'muted', ' ');
    return `${indent}${markerText} ${color(theme, 'info', `[${index}]`)} ${rest}`;
  }

  const pair = text.match(/^(\s*)([A-Za-z][A-Za-z /_-]{1,34}:)\s*(.*)$/);
  if (pair) {
    const [, indent, label, value] = pair;
    const lower = label.toLowerCase();
    const valueToken = lower.includes('error') || lower.includes('failed')
      ? 'danger'
      : lower.includes('theme') || lower.includes('session') || lower.includes('client') || lower.includes('tab') || lower.includes('model') || lower.includes('effort')
        ? 'accent'
        : lower.includes('status')
          ? 'success'
          : 'info';
    return `${indent}${color(theme, 'muted', label)} ${color(theme, valueToken, value)}`;
  }
  return text;
}

function packMetadataLine(items, width) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const required = items.filter((item) => item.required);
  const optional = items.filter((item) => !item.required);
  const separator = '  ·  ';
  const requiredLong = required.map((item) => item.long);
  const requiredShort = required.map((item) => item.short || item.long);
  let selected = visibleLength(requiredLong.join(separator)) <= safeWidth
    ? requiredLong
    : fitRequiredMetadata(requiredShort, safeWidth, separator);

  for (const item of optional) {
    const longCandidate = [...selected, item.long].join(separator);
    if (visibleLength(longCandidate) <= safeWidth) {
      selected.push(item.long);
      continue;
    }
    const shortCandidate = [...selected, item.short || item.long].join(separator);
    if (visibleLength(shortCandidate) <= safeWidth) selected.push(item.short || item.long);
  }
  return truncateVisible(selected.join(separator), safeWidth);
}

function fitRequiredMetadata(values, width, separator) {
  if (!values.length) return [];
  const separatorsWidth = separator.length * Math.max(0, values.length - 1);
  const available = Math.max(values.length, width - separatorsWidth);
  const base = Math.max(1, Math.floor(available / values.length));
  let remainder = Math.max(0, available - base * values.length);
  return values.map((value) => {
    const share = base + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return truncateVisible(value, share);
  });
}

function showsSidebarKeyHelp(height) {
  return Number(height) >= 17;
}

function edgeAlignedLine(left, right, width) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeRight = truncateVisible(right, Math.max(0, safeWidth - 8));
  const rightWidth = visibleLength(safeRight);
  const gap = rightWidth ? 1 : 0;
  const leftWidth = Math.max(0, safeWidth - rightWidth - gap);
  const safeLeft = truncateVisible(left, leftWidth);
  const spaces = Math.max(gap, safeWidth - visibleLength(safeLeft) - rightWidth);
  return `${safeLeft}${' '.repeat(spaces)}${safeRight}`;
}

function shortRef(value, max = 16) {
  const text = String(value || '');
  if (visibleLength(text) <= max) return text;
  return truncateVisible(text, max);
}

function runtimeToken(value) {
  return value === 'red' ? 'danger' : value === 'yellow' ? 'warning' : value === 'green' ? 'success' : value === 'cyan' ? 'info' : 'muted';
}

function stageToken(tone) {
  return tone === 'red' ? 'danger' : tone === 'yellow' ? 'warning' : tone === 'green' ? 'success' : tone === 'cyan' || tone === 'blue' ? 'info' : 'muted';
}
