import {
  Box,
  Column,
  Row,
  Text,
  TextEditorView,
  color,
  fitInline,
  themes,
  truncateVisible,
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
import {
  resolveTranscriptScroll,
  scrollbarForWindow,
  transcriptScrollLabel,
} from './terlioScroll.js';
import { workflowDashboard, workflowStage } from '../workflow/ux/workflowView.js';

export const INTERACTIVE_THEME = themes.slate;

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
  const theme = model.theme || INTERACTIVE_THEME;
  const health = model.health || {};
  const state = model.state || {};
  const workflow = model.workflow || null;
  const workflowView = workflow ? workflowDashboard(workflow, { currentSessionId: state.sessionId }) : null;
  const suggestions = suggestionRows(model, width);
  const editorRows = Math.max(1, Math.min(4, String(model.editor?.value || '').split('\n').length));
  const inputHeight = editorRows + 2 + (suggestions.length ? suggestions.length : 1);
  const overlay = renderOverlay(model, theme);
  const overlayHeight = overlay ? 5 : 0;
  const layout = resolveInteractiveLayout({ width, height, inputHeight, overlayHeight });
  const chatLines = buildChatLines(model, Math.max(18, layout.chatWidth - 6), theme);
  const visibleRows = Math.max(1, layout.mainHeight - 2);
  const transcript = resolveTranscriptScroll(model.transcriptScroll || {}, { totalRows: chatLines.length, visibleRows });
  const header = renderHeader({ health, state, workflow, busy: model.busy, phase: model.phase, tick: model.tick, width, theme });
  const main = model.detailsOpen
    ? renderDetailsPanel({ model, workflow, width, height: layout.mainHeight, theme })
    : renderMain({ model, workflow, layout, chatLines, transcript, theme });
  const input = renderCenteredInput({ model, suggestions, layout, height: inputHeight, editorRows, theme, hint: workflowView?.actions?.join('  ·  ') || '' });
  const footer = Text(color(theme, 'muted', footerHint(model, layout.mode, transcript)), { wrap: false });
  const node = Column({ height }, header, main, overlay, input, footer);
  return { node, transcript, layout };
}

export function renderInteractiveView(model, viewport = {}) {
  return prepareInteractiveView(model, viewport).node;
}

export function renderHeader({ health = {}, state = {}, workflow = null, busy = false, phase = 'idle', tick = 0, width = 100, theme = INTERACTIVE_THEME } = {}) {
  const activeClient = health.activeClient || health.clients?.[0] || null;
  const status = health.ok ? 'CONNECTED' : health.needsSelection ? 'SELECT TAB' : 'OFFLINE';
  const statusToken = health.ok ? 'success' : health.needsSelection ? 'warning' : 'danger';
  const runtime = deriveInteractiveRuntimeStatus(health, busy, phase);
  const spinner = runtime.active ? `${['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][tick % 10]} ${runtime.label}` : runtime.label;
  const projectName = state.projectRoot ? state.projectRoot.split(/[\\/]/).filter(Boolean).at(-1) : 'none';
  const workflowView = workflow ? workflowDashboard(workflow, { currentSessionId: state.sessionId }) : null;
  const workflowLabel = workflowView ? `${workflowView.id}: ${workflowView.stage.label}` : 'workflow: none';
  const first = `${color(theme, statusToken, status)}  ${compactTabLabel(activeClient)}  ·  tabs ${health.clients?.length || 0}`;
  const right = runtime.requestId ? `${spinner} · ${runtime.requestId}` : spinner;
  const second = width <= 85
    ? `${projectName}  ·  ${state.sessionId || 'current tab'}  ·  ${workflowLabel}`
    : [
        `Project ${projectName}`,
        `Session ${state.sessionId || 'current tab'}`,
        `Model ${state.model || 'default'}`,
        `Effort ${state.effort || 'default'}`,
        `Files ${state.pendingAttachments?.length || 0}`,
        workflowLabel,
      ].join('  ·  ');
  const leftWidth = Math.max(20, Math.floor(width * 0.68));
  return Box({ border: true, borderColor: health.ok ? theme.success : health.needsSelection ? theme.warning : theme.danger, padding: { left: 1, right: 1 }, title: ' ChatGPT Bridge ', height: 4 },
    Row({ gap: 2, widths: [leftWidth, Math.max(12, width - leftWidth - 6)] }, Text(first, { wrap: false }), Text(color(theme, runtimeToken(runtime.color), right), { wrap: false })),
    Text(color(theme, 'muted', second), { wrap: false }),
  );
}

export function renderWorkflowPanel({ workflow, currentSessionId = '', theme = INTERACTIVE_THEME, height = 8 } = {}) {
  const view = workflowDashboard(workflow, { currentSessionId });
  const cycle = view.cycle || view.maxCycles ? `${view.cycle || 0}/${view.maxCycles || '?'}` : '—';
  const session = view.boundSessionId || view.nextSession || '(none)';
  const lines = [
    `${color(theme, stageToken(view.stage.tone), view.stage.label)}${view.runId ? `  ${color(theme, 'muted', view.runId)}` : ''}`,
    color(theme, 'muted', `Cycle ${cycle}`),
    color(theme, 'muted', `${view.active ? 'Session' : 'Next'} ${session}`),
  ];
  if (view.error) lines.push(color(theme, 'danger', truncate(view.error, 160)));
  else if (view.actions.length) lines.push(...view.actions.slice(0, 3).map((item) => color(theme, 'info', item)));
  else lines.push(color(theme, 'muted', 'No action required'));
  return panelFromLines(` Workflow · ${view.id} `, lines, { height, theme, token: null, tail: false });
}

export function renderWorkflowExitPrompt(workflow, theme = INTERACTIVE_THEME) {
  const stage = workflowStage(workflow);
  return Box({ border: true, borderColor: theme.warning, padding: { left: 1, right: 1 }, title: ' Active workflow action ', height: 5 },
    Text(color(theme, 'warning', `${workflow.id} · ${stage.label}`), { wrap: false }),
    Text('Press y to stop the run and exit, n/Esc to continue.'),
    Text(color(theme, 'muted', 'Press Ctrl+C again to force exit.'), { wrap: false }),
  );
}

export function renderMain({ model, workflow, layout, chatLines, transcript, theme = INTERACTIVE_THEME } = {}) {
  const chatPane = renderScrollableChat({ lines: chatLines, width: layout.chatWidth, height: layout.mainHeight, transcript, theme });
  if (layout.mode === 'narrow') return chatPane;
  if (layout.mode === 'centered') return centerNode(chatPane, layout.leftWidth, layout.chatWidth, layout.rightWidth, layout.mainHeight);

  const left = renderLeftSidebar({ model, width: layout.leftWidth, height: layout.mainHeight, theme });
  const right = renderRightSidebar({ model, workflow, width: layout.rightWidth, height: layout.mainHeight, theme });
  return Row({ gap: 1, widths: [layout.leftWidth, layout.chatWidth, layout.rightWidth], height: layout.mainHeight }, left, chatPane, right);
}

export function renderInput({ model, suggestions = [], width = 100, height = 4, editorRows = 1, theme = INTERACTIVE_THEME, hint = '' } = {}) {
  const editor = model.editor;
  const busy = Boolean(model.busy || model.confirmPrompt);
  const placeholder = busy ? 'request is running; type /stop or press Ctrl+C' : hint || 'type a message or /help';
  const title = busy ? ' busy › ' : ' bridge › ';
  const editorHeight = Math.max(1, Math.min(4, Number(editorRows) || 1));
  const editorNode = TextEditorView({
    title,
    value: editor?.value || '',
    cursor: editor?.cursor || 0,
    width,
    height: editorHeight,
    placeholder,
    lineNumbers: false,
  });
  if (!suggestions.length) return Column({ height }, editorNode, Text(color(theme, 'muted', 'Enter sends · Tab completes · ↑/↓ input history · PgUp/PgDn chat history'), { wrap: false }));
  const rows = suggestions.map((item) => Text(item.selected ? color(theme, 'selected', item.text) : color(theme, 'suggestion', item.text), { wrap: false }));
  return Column({ height }, editorNode, ...rows);
}

export function suggestionRows(model, width = 100) {
  if (!model.completionActive) return [];
  const suggestions = commandSuggestions(model.editor?.value || '');
  if (!suggestions.length) return [];
  const safeIndex = Math.max(0, Math.min(model.suggestionIndex || 0, suggestions.length - 1));
  const offset = Math.max(0, Math.min(Math.max(0, suggestions.length - 3), safeIndex - 1));
  return suggestions.slice(offset, offset + 3).map((item, row) => {
    const selected = offset + row === safeIndex;
    const usageWidth = Math.min(34, Math.max(20, Math.floor(width * 0.35)));
    return {
      selected,
      text: `${selected ? '› ' : '  '}${String(item.usage).padEnd(usageWidth)} ${item.description}`,
      command: item.cmd,
    };
  });
}

export function buildTranscriptLines(entries = [], width = 80, theme = INTERACTIVE_THEME) {
  const lines = [];
  for (const entry of entries) {
    const token = ENTRY_TOKEN[entry.kind] || 'muted';
    const title = entry.title || entry.kind || 'Entry';
    lines.push(color(theme, token, title));
    if (entry.subtitle) lines.push(color(theme, 'muted', `  ${entry.subtitle}`));
    const body = transcriptBodyText(entry);
    if (body) lines.push(...wrapText(body, Math.max(12, width)).map((line) => `  ${line}`));
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
  append('Assistant · streaming', model.answer, 'assistant');
  if (!sections.length) return [];
  return [color(theme, 'muted', '─ current response ─'), '', ...sections];
}

function renderScrollableChat({ lines, width, height, transcript, theme }) {
  const innerHeight = Math.max(1, height - 2);
  const window = visibleWindowLines(lines, { height: innerHeight, scroll: transcript.scroll });
  const gutter = scrollbarForWindow({ totalRows: lines.length, visibleRows: innerHeight, scroll: window.scroll });
  const contentWidth = Math.max(8, width - 6);
  const rows = window.lines.map((line, index) => Text(`${fitInline(line, contentWidth)} ${color(theme, 'muted', gutter[index])}`, { wrap: false }));
  const title = ` Chat · ${transcriptScrollLabel({ ...transcript, scroll: window.scroll })} `;
  return Box({ border: true, borderColor: theme.border, padding: { left: 1, right: 1 }, title, height }, ...rows);
}

function renderLeftSidebar({ model, width, height, theme }) {
  const contextHeight = Math.max(9, Math.min(13, Math.floor(height * 0.5)));
  const shortcutHeight = Math.max(5, height - contextHeight);
  return Column({ height },
    panelFromLines(' Context ', contextLines(model), { height: contextHeight, theme, token: null, tail: false }),
    panelFromLines(' Navigation ', shortcutLines(), { height: shortcutHeight, theme, token: null, tail: false }),
  );
}

function renderRightSidebar({ model, workflow, width, height, theme }) {
  const workflowHeight = workflow ? Math.max(8, Math.min(12, Math.floor(height * 0.46))) : 0;
  const activityHeight = Math.max(5, height - workflowHeight);
  const liveLines = buildLiveLines({
    activityLines: model.activityLines || [],
    thinking: model.thinking,
    progress: model.progress,
    answer: '',
    maxLines: Math.max(1, activityHeight - 2),
    maxColumns: Math.max(18, width - 4),
  });
  const debugLines = shouldShowDebugEvents(model.state) ? (model.eventLines || []).slice(-20) : [];
  const activity = liveLines.length ? liveLines : debugLines.length ? debugLines : ['No active request.', '', 'Completed answers remain in Chat.'];
  if (!workflow) return panelFromLines(' Activity ', activity, { height, theme, token: liveLines.length ? 'info' : 'muted' });
  return Column({ height },
    renderWorkflowPanel({ workflow, currentSessionId: model.state?.sessionId, theme, height: workflowHeight }),
    panelFromLines(liveLines.length ? ' Current activity ' : debugLines.length ? ' Debug events ' : ' Activity ', activity, { height: activityHeight, theme, token: liveLines.length ? 'info' : 'muted' }),
  );
}

function renderDetailsPanel({ model, workflow, width, height, theme }) {
  const lines = [
    color(theme, 'accent', 'Connection and context'),
    ...compactContextLines(model),
    '',
  ];
  if (workflow) {
    const view = workflowDashboard(workflow, { currentSessionId: model.state?.sessionId });
    lines.push(color(theme, 'accent', `Workflow · ${view.id}`));
    lines.push(`Status: ${view.stage.label}`);
    lines.push(`Run: ${view.runId || 'idle'}`);
    lines.push(`Cycle: ${view.cycle || 0}/${view.maxCycles || '?'}`);
    lines.push(`Session: ${view.boundSessionId || view.nextSession || '(none)'}`);
    if (view.actions.length) lines.push(`Actions: ${view.actions.join(' · ')}`);
    if (view.error) lines.push(color(theme, 'danger', `Error: ${view.error}`));
    lines.push('');
  }
  lines.push(color(theme, 'accent', 'Navigation'));
  lines.push('PgUp/PgDn chat · Shift+↑/↓ lines');
  lines.push('Ctrl+Home/End top / follow');
  lines.push('Ctrl+B close · Ctrl+C stop / exit');
  lines.push('', color(theme, 'muted', 'Mouse click support requires a future Terlio pointer API.'));
  return panelFromLines(' Details ', lines, { height, theme, token: null, tail: false });
}

function compactContextLines(model) {
  const state = model.state || {};
  const health = model.health || {};
  const active = health.activeClient || health.clients?.[0] || null;
  return [
    `Connection: ${health.ok ? 'connected' : health.needsSelection ? 'select tab' : 'offline'} · ${active?.title || active?.id || '(no tab)'}`,
    `Project: ${state.projectRoot ? state.projectRoot.split(/[\\/]/).filter(Boolean).at(-1) : '(none)'}`,
    `Session: ${state.sessionId || 'current tab'}`,
    `Model: ${state.model || 'default'} · ${state.effort || 'default'}`,
    `Files: ${state.pendingAttachments?.length || 0}`,
  ];
}

function contextLines(model) {
  const state = model.state || {};
  const health = model.health || {};
  const active = health.activeClient || health.clients?.[0] || null;
  const artifacts = Array.isArray(state.lastArtifacts) ? state.lastArtifacts.slice(-3) : [];
  return [
    `Connection: ${health.ok ? 'connected' : health.needsSelection ? 'select tab' : 'offline'}`,
    `Tab: ${active?.title || active?.id || '(none)'}`,
    `Project: ${state.projectRoot ? state.projectRoot.split(/[\\/]/).filter(Boolean).at(-1) : '(none)'}`,
    `Session: ${state.sessionId || 'current tab'}`,
    `Model: ${state.model || 'default'}`,
    `Effort: ${state.effort || 'default'}`,
    `Queued files: ${state.pendingAttachments?.length || 0}`,
    ...(artifacts.length ? ['Recent artifacts:', ...artifacts.map((item) => `  ${item.name || item.filename || item.id || 'artifact'}`)] : []),
  ];
}

function shortcutLines() {
  return [
    'PgUp / PgDn  scroll chat',
    'Shift+↑ / ↓   scroll lines',
    'Ctrl+Home/End top / follow',
    'Ctrl+B        details',
    '↑ / ↓         input history',
    'Tab           complete command',
    'Ctrl+C        stop / exit',
  ];
}

function renderCenteredInput({ model, suggestions, layout, height, editorRows, theme, hint }) {
  const node = renderInput({ model, suggestions, width: layout.inputWidth, height, editorRows, theme, hint });
  if (layout.mode === 'narrow') return node;
  return centerNode(node, layout.leftWidth, layout.inputWidth, layout.rightWidth, height, layout.mode === 'wide' ? 1 : 0);
}

function centerNode(node, leftWidth, centerWidth, rightWidth, height, gap = 0) {
  return Row({ widths: [leftWidth, centerWidth, rightWidth], height, gap }, blankPane(height), node, blankPane(height));
}

function blankPane(height) {
  return Column({ height }, Text(''));
}

function renderOverlay(model, theme) {
  if (model.confirmPrompt) {
    return Box({ border: true, borderColor: theme.warning, padding: { left: 1, right: 1 }, title: ' Confirmation ', height: 5 },
      Text(color(theme, 'warning', model.confirmPrompt || 'Confirm? [y/N]')),
      Text(color(theme, 'muted', 'Press y to accept, n/Esc/Enter to cancel.'), { wrap: false }),
    );
  }
  if (model.workflowExitPrompt) return renderWorkflowExitPrompt(model.workflowExitPrompt, theme);
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

function footerHint(model, mode, transcript) {
  if (model.confirmPrompt) return 'y approve  ·  n/Esc cancel';
  if (model.workflowExitPrompt) return 'y stop and exit  ·  n/Esc continue  ·  Ctrl+C force exit';
  if (model.interruptPrompt) return 'c cancel request  ·  d detach and exit  ·  Esc continue';
  if (model.detailsOpen) return 'Ctrl+B close details  ·  PgUp/PgDn scroll details unavailable until pointer/focus support';
  const history = transcriptScrollLabel(transcript);
  if (model.busy) return `/stop cancel  ·  PgUp/PgDn chat  ·  Ctrl+B details  ·  ${history}`;
  return `${mode === 'wide' ? 'side panels active' : 'chat focus'}  ·  PgUp/PgDn scroll  ·  Ctrl+B details  ·  Ctrl+C exit`;
}

function runtimeToken(value) {
  return value === 'red' ? 'danger' : value === 'yellow' ? 'warning' : value === 'green' ? 'success' : value === 'cyan' ? 'info' : 'muted';
}

function stageToken(tone) {
  return tone === 'red' ? 'danger' : tone === 'yellow' ? 'warning' : tone === 'green' ? 'success' : tone === 'cyan' || tone === 'blue' ? 'info' : 'muted';
}

function stageBorder(tone, theme) {
  return tone === 'red' ? theme.danger : tone === 'yellow' ? theme.warning : tone === 'green' ? theme.success : tone === 'cyan' || tone === 'blue' ? theme.info : theme.border;
}
