export const INTERACTIVE_KEYBOARD_SHORTCUTS = [
  ['Enter', 'send the input or accept the selected suggestion'],
  ['Shift/Ctrl+Enter', 'insert a line break'],
  ['Tab', 'complete the selected command or parameter'],
  ['↑ / ↓', 'move within multiline input; otherwise suggestions or input history'],
  ['PgUp / PgDn', 'scroll the transcript by one page'],
  ['Shift/Option+↑↓', 'scroll the transcript one line'],
  ['Mouse wheel', 'scroll the pane under the pointer'],
  ['Mouse drag/click', 'select transcript text; click the selection to copy'],
  ['Scrollbar', 'click or drag to move through the current pane'],
  ['Ctrl+Home / End', 'jump to transcript start / follow the tail'],
  ['Ctrl+B', 'open or close full connection, workflow, and key details'],
  ['Ctrl+T', 'toggle mouse capture for native terminal text selection'],
  ['Ctrl+A / E', 'move to the start / end of input'],
  ['Option+← / →', 'move one word in input'],
  ['Ctrl+W / Opt+⌫', 'delete the previous word'],
  ['Option+D', 'delete the next word'],
  ['Ctrl+U / K', 'delete before / after the cursor'],
  ['Ctrl+L', 'clear the transcript'],
  ['Esc', 'close details or cancel input; cancelled input remains in history'],
  ['Ctrl+C', 'cancel, detach, or exit according to current work'],
  ['Paste', 'insert multiline text; large pastes appear as one compact token'],
  ['Backspace on paste', 'expand a compact pasted block without deleting it'],
  ['Ctrl+D', 'delete forward, or exit when input is empty'],
];

export const SIDEBAR_KEYBOARD_SHORTCUTS = [
  ['PgUp/PgDn', 'scroll chat'],
  ['Shift+↑/↓', 'scroll lines'],
  ['Wheel', 'scroll pane'],
  ['Ctrl+Home/End', 'top / follow'],
  ['Ctrl+B', 'full details'],
  ['↑/↓', 'input / history'],
  ['Tab', 'complete'],
  ['Ctrl+C', 'stop / exit'],
];

export function keyboardHelpText() {
  return keyboardListLines(88, { columns: 1 })
    .map((line) => `  ${line}`)
    .join('\n');
}

export function keyboardGridLines(width = 76, options = {}) {
  const safeWidth = Math.max(24, Number(width) || 76);
  const terminalWidth = Math.max(safeWidth, Number(options.terminalWidth) || safeWidth);
  const columns = options.columns ?? (terminalWidth >= 120 ? 2 : 1);
  return keyboardListLines(safeWidth, { columns });
}

export function keyboardListLines(width = 76, { columns = 1 } = {}) {
  const safeWidth = Math.max(24, Number(width) || 76);
  const columnCount = Number(columns) >= 2 ? 2 : 1;
  if (columnCount === 1) {
    return INTERACTIVE_KEYBOARD_SHORTCUTS.flatMap((shortcut) => formatShortcutEntry(shortcut, safeWidth));
  }

  const gap = 3;
  const columnWidth = Math.max(28, Math.floor((safeWidth - gap) / 2));
  const rows = [];
  const midpoint = Math.ceil(INTERACTIVE_KEYBOARD_SHORTCUTS.length / 2);
  for (let index = 0; index < midpoint; index += 1) {
    const left = formatShortcutEntry(INTERACTIVE_KEYBOARD_SHORTCUTS[index], columnWidth);
    const right = formatShortcutEntry(INTERACTIVE_KEYBOARD_SHORTCUTS[index + midpoint], columnWidth);
    const rowHeight = Math.max(left.length, right.length);
    for (let line = 0; line < rowHeight; line += 1) {
      rows.push(`${fitCell(left[line] || '', columnWidth)}${' '.repeat(gap)}${fitCell(right[line] || '', columnWidth)}`.trimEnd());
    }
  }
  return rows;
}

export function formatShortcutEntry(shortcut, width) {
  if (!shortcut) return [];
  const [key, description] = shortcut;
  const safeWidth = Math.max(24, Number(width) || 24);
  const keyWidth = Math.min(22, Math.max(12, Math.floor(safeWidth * 0.34)));
  const descriptionWidth = Math.max(8, safeWidth - keyWidth - 1);
  const wrapped = wrapWords(String(description || ''), descriptionWidth);
  return wrapped.map((line, index) => `${index === 0 ? String(key).padEnd(keyWidth) : ' '.repeat(keyWidth)} ${line}`.trimEnd());
}

function wrapWords(value, width) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) {
      line = word;
      continue;
    }
    if (`${line} ${word}`.length <= width) {
      line += ` ${word}`;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines;
}

function fitCell(value, width) {
  const text = String(value || '');
  return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}
