import { handleInputEditorKey, parseKey } from 'terlio.js';

const BRACKETED_PASTE_START = '\u001b[200~';
const BRACKETED_PASTE_END = '\u001b[201~';

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
      if (this.pending.startsWith(BRACKETED_PASTE_START)) {
        const endIndex = this.pending.indexOf(BRACKETED_PASTE_END, BRACKETED_PASTE_START.length);
        if (endIndex < 0 && !force) break;
        if (endIndex < 0) {
          keys.push(normalizeTerlioKey(this.pending));
          this.pending = '';
          break;
        }
        const end = endIndex + BRACKETED_PASTE_END.length;
        keys.push(normalizeTerlioKey(this.pending.slice(0, end)));
        this.pending = this.pending.slice(end);
        continue;
      }

      if (!force && isIncompleteEscapeSequence(this.pending)) break;
      const parsed = normalizeTerlioKey(this.pending);
      if (parsed.name !== 'unknown') {
        keys.push(parsed);
        this.pending = '';
        break;
      }

      keys.push(parsed);
      this.pending = '';
    }
    return keys;
  }
}

export function normalizeTerlioKey(data) {
  const sequence = Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '');

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
    deleteWordForward(editor);
    return {
      handled: true,
      changed: before !== editor.value || beforeCursor !== editor.cursor,
      value: editor.value,
      cursor: editor.cursor,
    };
  }
  return handleInputEditorKey(editor, key, options);
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

function isIncompleteEscapeSequence(sequence) {
  if (sequence === '\u001b') return true;
  if (!sequence.startsWith('\u001b')) return false;
  if (sequence.startsWith(BRACKETED_PASTE_START) && !sequence.includes(BRACKETED_PASTE_END)) return true;
  if (/^\u001b(?:\[|O)?[0-9;?]*$/.test(sequence)) return true;
  return false;
}

function keyOverride(base, overrides) {
  return { ...base, ...overrides, printable: false, text: '' };
}
