import { handleInputEditorKey, parseKey, parsePointer } from 'terlio.js';

const BRACKETED_PASTE_START = '\u001b[200~';
const BRACKETED_PASTE_END = '\u001b[201~';

export const BRACKETED_PASTE_ENABLE = '\u001b[?2004h';
export const BRACKETED_PASTE_DISABLE = '\u001b[?2004l';

export class TerlioInputDecoder {
  constructor() {
    this.pending = '';
  }

  feed(data) {
    const chunk = Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '');
    if (!chunk) return [];
    this.pending += chunk;
    return this.#drain(false);
  }

  flush() {
    return this.#drain(true);
  }

  hasPending() {
    return Boolean(this.pending);
  }

  reset() {
    this.pending = '';
  }

  #drain(force) {
    const keys = [];
    while (this.pending) {
      const extracted = extractSequence(this.pending, force);
      if (!extracted) break;
      this.pending = this.pending.slice(extracted.length);
      keys.push(normalizeTerlioKey(extracted.sequence));
    }
    return keys;
  }
}

export function normalizeTerlioKey(data) {
  const sequence = Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '');

  const pointer = parsePointer(sequence);
  if (pointer) return pointer;

  // macOS terminals do not agree on Option+Backspace and Command+Arrow
  // encodings. Normalize the variants that the previous interactive editor
  // supported, then delegate the remaining key grammar to Terlio.
  if (sequence === '\u001b\u007f' || sequence === '\u001b\b') {
    return keyOverride(parseKey('\u0017'), { sequence, meta: true });
  }
  if (sequence === '\u001bd' || sequence === '\u001bD') {
    return keyOverride(parseKey(sequence), { name: 'delete-word-right', sequence, meta: true });
  }
  if (sequence === '\u001b[1;13D' || sequence === '\u001b[1;9D') {
    return keyOverride(parseKey(sequence), { name: 'home', sequence, cmd: true });
  }
  if (sequence === '\u001b[1;13C' || sequence === '\u001b[1;9C') {
    return keyOverride(parseKey(sequence), { name: 'end', sequence, cmd: true });
  }

  const parsed = parseKey(sequence);
  if ((parsed.name === 'left' || parsed.name === 'right') && parsed.ctrl) {
    return keyOverride(parsed, { word: true });
  }
  return parsed;
}

export function applyTerlioEditorKey(editor, key, options = {}) {
  if (key?.name === 'delete-word-right') {
    const before = editor.value;
    const beforeCursor = editor.cursor;
    const changed = typeof editor.deleteWordForward === 'function'
      ? editor.deleteWordForward()
      : deleteWordForward(editor);
    return {
      handled: true,
      changed: Boolean(changed) || before !== editor.value || beforeCursor !== editor.cursor,
      value: editor.value,
      cursor: editor.cursor,
    };
  }
  return handleInputEditorKey(editor, key, options);
}

export function isLikelyRawPaste(data) {
  const value = Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '');
  if (!value || value.startsWith('\u001b')) return false;
  return Array.from(value).length > 250 || /[\r\n]/.test(value) && Array.from(value).length > 1;
}

function deleteWordForward(editor) {
  const chars = Array.from(String(editor.value ?? ''));
  let end = Math.max(0, Math.min(Number(editor.cursor) || 0, chars.length));
  while (end < chars.length && /\s/.test(chars[end])) end += 1;
  while (end < chars.length && !/\s/.test(chars[end])) end += 1;
  if (end <= editor.cursor) return false;
  chars.splice(editor.cursor, end - editor.cursor);
  editor.value = chars.join('');
  return true;
}

function extractSequence(buffer, force) {
  if (!buffer) return null;

  if (buffer.startsWith(BRACKETED_PASTE_START)) {
    const endIndex = buffer.indexOf(BRACKETED_PASTE_END, BRACKETED_PASTE_START.length);
    if (endIndex < 0) {
      if (!force) return null;
      return { sequence: buffer, length: buffer.length };
    }
    const length = endIndex + BRACKETED_PASTE_END.length;
    return { sequence: buffer.slice(0, length), length };
  }

  if (buffer.startsWith('\u001b[<')) {
    const match = /^\u001b\[<\d+;\d+;\d+[Mm]/.exec(buffer);
    if (!match) return force ? { sequence: buffer, length: buffer.length } : null;
    return { sequence: match[0], length: match[0].length };
  }

  if (buffer.startsWith('\u001b[')) {
    const match = /^\u001b\[[0-?]*[ -/]*[@-~]/.exec(buffer);
    if (!match) return force ? { sequence: buffer, length: buffer.length } : null;
    return { sequence: match[0], length: match[0].length };
  }

  if (buffer.startsWith('\u001bO')) {
    if (buffer.length < 3) return force ? { sequence: buffer, length: buffer.length } : null;
    return { sequence: buffer.slice(0, 3), length: 3 };
  }

  if (buffer[0] === '\u001b') {
    if (buffer.length === 1) return force ? { sequence: buffer, length: 1 } : null;
    return { sequence: buffer.slice(0, 2), length: 2 };
  }

  const first = buffer.codePointAt(0);
  if (first === undefined) return null;
  const firstChar = String.fromCodePoint(first);
  if (first < 32 || first === 127) return { sequence: firstChar, length: firstChar.length };

  let index = 0;
  while (index < buffer.length) {
    const code = buffer.codePointAt(index);
    if (code === undefined || code < 32 || code === 127) break;
    const char = String.fromCodePoint(code);
    index += char.length;
  }
  return { sequence: buffer.slice(0, index), length: index };
}

function keyOverride(base, overrides) {
  return { ...base, ...overrides, printable: false, text: '' };
}
