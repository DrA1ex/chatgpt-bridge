export const INTERACTIVE_KEYBOARD_SHORTCUTS = [
  ['Enter', 'send the input or accept the selected suggestion'],
  ['Shift/Ctrl+Enter', 'insert a line break'],
  ['Tab', 'complete the selected command or parameter'],
  ['↑ / ↓', 'move suggestions, otherwise browse input history'],
  ['PgUp / PgDn', 'scroll the transcript by one page'],
  ['Shift/Option+↑↓', 'scroll the transcript one line'],
  ['Ctrl+Home / End', 'jump to transcript start / follow the tail'],
  ['Ctrl+B', 'open or close full connection, workflow, and key details'],
  ['Ctrl+A / E', 'move to the start / end of input'],
  ['Option+← / →', 'move one word in input'],
  ['Ctrl+W / Opt+⌫', 'delete the previous word'],
  ['Option+D', 'delete the next word'],
  ['Ctrl+U / K', 'delete before / after the cursor'],
  ['Ctrl+L', 'clear the transcript'],
  ['Esc', 'cancel suggestions or clear the current input'],
  ['Ctrl+C', 'cancel, detach, or exit according to current work'],
  ['Ctrl+D', 'delete forward, or exit when input is empty'],
];

export const SIDEBAR_KEYBOARD_SHORTCUTS = [
  ['PgUp/PgDn', 'scroll chat'],
  ['Shift+↑/↓', 'scroll lines'],
  ['Ctrl+Home/End', 'top / follow'],
  ['Ctrl+B', 'full details'],
  ['↑/↓', 'suggestions / history'],
  ['Tab', 'complete'],
  ['Ctrl+C', 'stop / exit'],
];

export function keyboardHelpText() {
  return INTERACTIVE_KEYBOARD_SHORTCUTS
    .map(([key, description]) => `  ${String(key).padEnd(20)} ${description}`)
    .join('\n');
}

export function keyboardGridLines(width = 76) {
  const safeWidth = Math.max(24, Number(width) || 76);
  const columnCount = safeWidth >= 66 ? 2 : 1;
  if (columnCount === 1) {
    return INTERACTIVE_KEYBOARD_SHORTCUTS.map(([key, description]) => `${String(key).padEnd(18)} ${description}`);
  }
  const gap = 3;
  const columnWidth = Math.max(28, Math.floor((safeWidth - gap) / 2));
  const rows = [];
  const midpoint = Math.ceil(INTERACTIVE_KEYBOARD_SHORTCUTS.length / 2);
  for (let index = 0; index < midpoint; index += 1) {
    const left = formatShortcutCell(INTERACTIVE_KEYBOARD_SHORTCUTS[index], columnWidth);
    const right = formatShortcutCell(INTERACTIVE_KEYBOARD_SHORTCUTS[index + midpoint], columnWidth);
    rows.push(`${left}${' '.repeat(gap)}${right}`.trimEnd());
  }
  return rows;
}

function formatShortcutCell(shortcut, width) {
  if (!shortcut) return ' '.repeat(width);
  const [key, description] = shortcut;
  const keyWidth = Math.min(18, Math.max(10, Math.floor(width * 0.38)));
  const text = `${String(key).padEnd(keyWidth)} ${description}`;
  return text.length >= width ? text.slice(0, width) : text.padEnd(width);
}
