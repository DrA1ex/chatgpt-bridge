export function clampCursor(value, cursor) {
  const length = String(value || '').length;
  return Math.max(0, Math.min(length, Number(cursor) || 0));
}

export function previousWordIndex(value, cursor) {
  const text = String(value || '');
  let index = clampCursor(text, cursor);
  while (index > 0 && /\s/.test(text[index - 1])) index -= 1;
  while (index > 0 && !/\s/.test(text[index - 1])) index -= 1;
  return index;
}

export function nextWordIndex(value, cursor) {
  const text = String(value || '');
  let index = clampCursor(text, cursor);
  while (index < text.length && /\s/.test(text[index])) index += 1;
  while (index < text.length && !/\s/.test(text[index])) index += 1;
  return index;
}

export function insertAtCursor(value, cursor, input) {
  const text = String(value || '');
  const index = clampCursor(text, cursor);
  const chunk = String(input || '');
  return { value: `${text.slice(0, index)}${chunk}${text.slice(index)}`, cursor: index + chunk.length };
}

export function backspaceAtCursor(value, cursor) {
  const text = String(value || '');
  const index = clampCursor(text, cursor);
  if (index <= 0) return { value: text, cursor: index };
  return { value: `${text.slice(0, index - 1)}${text.slice(index)}`, cursor: index - 1 };
}

export function deleteAtCursor(value, cursor) {
  const text = String(value || '');
  const index = clampCursor(text, cursor);
  if (index >= text.length) return { value: text, cursor: index };
  return { value: `${text.slice(0, index)}${text.slice(index + 1)}`, cursor: index };
}

export function deleteWordLeftAtCursor(value, cursor) {
  const text = String(value || '');
  const index = clampCursor(text, cursor);
  const start = previousWordIndex(text, index);
  if (start === index) return { value: text, cursor: index };
  return { value: `${text.slice(0, start)}${text.slice(index)}`, cursor: start };
}

export function deleteWordRightAtCursor(value, cursor) {
  const text = String(value || '');
  const index = clampCursor(text, cursor);
  const end = nextWordIndex(text, index);
  if (end === index) return { value: text, cursor: index };
  return { value: `${text.slice(0, index)}${text.slice(end)}`, cursor: index };
}

export function killLineLeftAtCursor(value, cursor) {
  const text = String(value || '');
  const index = clampCursor(text, cursor);
  return { value: text.slice(index), cursor: 0 };
}

export function killLineRightAtCursor(value, cursor) {
  const text = String(value || '');
  const index = clampCursor(text, cursor);
  return { value: text.slice(0, index), cursor: index };
}

export const BRACKETED_PASTE_START = '\u001b[200~';
export const BRACKETED_PASTE_END = '\u001b[201~';

export function pastedTextFromInput(inputChar = '') {
  const raw = String(inputChar || '');
  if (!raw) return '';
  if (raw.includes(BRACKETED_PASTE_START) || raw.includes(BRACKETED_PASTE_END)) {
    const start = raw.indexOf(BRACKETED_PASTE_START);
    const end = raw.indexOf(BRACKETED_PASTE_END, start >= 0 ? start + BRACKETED_PASTE_START.length : 0);
    let value = raw;
    if (start >= 0) value = value.slice(start + BRACKETED_PASTE_START.length);
    if (end >= 0) {
      const adjustedEnd = start >= 0 ? end - (start + BRACKETED_PASTE_START.length) : end;
      value = value.slice(0, Math.max(0, adjustedEnd));
    }
    return value.replaceAll(BRACKETED_PASTE_START, '').replaceAll(BRACKETED_PASTE_END, '');
  }
  if (raw.length <= 1) return '';
  if (raw.includes('\u001b')) return '';
  return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw) ? '' : raw;
}

function keySequence(inputChar, key = {}) {
  return String(inputChar || key.sequence || key.raw || '');
}

function keyName(key = {}) {
  return String(key.name || key.key || '').toLowerCase();
}

function controlCode(sequence) {
  const value = String(sequence || '');
  return value.length === 1 ? value.charCodeAt(0) : 0;
}

function matchesAny(value, patterns) {
  const sequence = String(value || '');
  return patterns.some((pattern) => pattern instanceof RegExp ? pattern.test(sequence) : sequence === pattern);
}

export function isControlSequence(inputChar, key = {}) {
  const sequence = keySequence(inputChar, key);
  if (!sequence) return false;
  if (key.ctrl || key.meta || key.alt || key.option) return true;
  if (sequence.length !== 1) return true;
  return sequence.charCodeAt(0) < 32 || sequence.charCodeAt(0) === 127;
}

export function decodeInputAction(inputChar, key = {}) {
  const sequence = keySequence(inputChar, key);
  const name = keyName(key);
  const lowerInput = String(inputChar || '').toLowerCase();
  const code = controlCode(sequence);
  const ctrl = Boolean(key.ctrl || key.control);
  const alt = Boolean(key.option || key.alt);
  const meta = Boolean(key.meta);

  if (sequence === BRACKETED_PASTE_START) return 'paste-start';
  if (sequence === BRACKETED_PASTE_END) return 'paste-end';
  if (key.return || name === 'return' || name === 'enter' || code === 10 || code === 13) return 'submit';

  if ((ctrl && lowerInput === 'c') || code === 3 || name === 'c-c') return 'interrupt';
  if ((ctrl && lowerInput === 'l') || code === 12 || name === 'c-l') return 'clear-screen';
  if ((ctrl && lowerInput === 'a') || code === 1 || name === 'c-a') return 'line-start';
  if ((ctrl && lowerInput === 'e') || code === 5 || name === 'c-e') return 'line-end';
  if ((ctrl && lowerInput === 'b') || code === 2 || name === 'c-b') return 'left';
  if ((ctrl && lowerInput === 'f') || code === 6 || name === 'c-f') return 'right';
  if ((ctrl && lowerInput === 'p') || code === 16 || name === 'c-p') return 'history-prev';
  if ((ctrl && lowerInput === 'n') || code === 14 || name === 'c-n') return 'history-next';
  if ((ctrl && lowerInput === 'k') || code === 11 || name === 'c-k') return 'kill-line-right';
  if ((ctrl && lowerInput === 'u') || code === 21 || name === 'c-u') return 'kill-line-left';
  if ((ctrl && lowerInput === 'w') || code === 23 || name === 'c-w') return 'delete-word-left';
  if ((ctrl && lowerInput === 'd') || code === 4 || name === 'c-d') return 'delete-or-exit';
  if (code === 8 || name === 'c-h') return 'backspace';
  if (key.backspace || name === 'backspace' || sequence === '\u007f' || sequence === '\u0008') return 'backspace';

  const explicitForwardDelete = matchesAny(sequence, ['\u001b[3~', '\u001b[3;2~', '\u001b[3;3~', '\u001b[3;5~', '\u001b[3;9~']);
  if (explicitForwardDelete) return 'delete';
  if (key.delete || name === 'delete') return 'backspace';

  if (matchesAny(sequence, ['\u001b\u007f', '\u001b\u0008'])) return 'delete-word-left';
  if (matchesAny(sequence, ['\u001bd', '\u001bD'])) return 'delete-word-right';
  if (matchesAny(sequence, [
    '\u001bb', '\u001bB', '\u001b\u001b[D', '\u001b[1;3D', '\u001b[1;5D', '\u001b[1;7D', '\u001b[1;9D',
    '\u001b[5D', '\u001b[5;3D', '\u001b[5;5D', '\u001b[1;3~', /\u001b\[.*;(?:3|5|9)D$/
  ])) return 'word-left';
  if (matchesAny(sequence, [
    '\u001bf', '\u001bF', '\u001b\u001b[C', '\u001b[1;3C', '\u001b[1;5C', '\u001b[1;7C', '\u001b[1;9C',
    '\u001b[5C', '\u001b[5;3C', '\u001b[5;5C', '\u001b[1;3~', /\u001b\[.*;(?:3|5|9)C$/
  ])) return 'word-right';

  if (key.home || name === 'home' || matchesAny(sequence, [
    '\u001b[H', '\u001bOH', '\u001b[1~', '\u001b[7~', '\u001b[1;13D', '\u001b[1;14D',
    /\u001b\[.*;(?:13|14)D$/
  ])) return 'line-start';
  if (key.end || name === 'end' || matchesAny(sequence, [
    '\u001b[F', '\u001bOF', '\u001b[4~', '\u001b[8~', '\u001b[1;13C', '\u001b[1;14C',
    /\u001b\[.*;(?:13|14)C$/
  ])) return 'line-end';

  if ((ctrl || key.ctrl) && (key.leftArrow || name === 'left')) return 'word-left';
  if ((ctrl || key.ctrl) && (key.rightArrow || name === 'right')) return 'word-right';
  if (alt && (key.leftArrow || name === 'left')) return 'word-left';
  if (alt && (key.rightArrow || name === 'right')) return 'word-right';
  if (meta && (key.leftArrow || name === 'left')) return 'word-left';
  if (meta && (key.rightArrow || name === 'right')) return 'word-right';
  if (key.leftArrow || name === 'left' || sequence === '\u001b[D' || sequence === '\u001bOD') return 'left';
  if (key.rightArrow || name === 'right' || sequence === '\u001b[C' || sequence === '\u001bOC') return 'right';
  if (key.upArrow || name === 'up' || sequence === '\u001b[A' || sequence === '\u001bOA') return 'history-prev';
  if (key.downArrow || name === 'down' || sequence === '\u001b[B' || sequence === '\u001bOB') return 'history-next';

  if (key.escape || name === 'escape' || sequence === '\u001b') return 'escape';
  return null;
}
