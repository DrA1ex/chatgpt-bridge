import { InputEditor } from 'terlio.js';

export const COLLAPSED_PASTE_THRESHOLD = 250;

export class PromptEditor {
  constructor(value = '', options = {}) {
    this.inner = new InputEditor(String(value ?? ''));
    this.pastes = normalizePastes(options.pastes, this.inner.value);
  }

  get value() { return this.inner.value; }
  set value(value) {
    this.inner.value = String(value ?? '');
    this.pastes = normalizePastes(this.pastes, this.inner.value);
  }

  get cursor() { return this.inner.cursor; }
  set cursor(value) { this.inner.cursor = clampIndex(value, this.value); }

  set(value, options = {}) {
    this.inner.set(String(value ?? ''));
    this.pastes = normalizePastes(options.pastes, this.inner.value);
  }

  restore(record = {}) {
    if (typeof record === 'string') this.set(record);
    else this.set(record.text || '', { pastes: record.pastes || [] });
  }

  serialize() {
    return {
      text: this.value,
      pastes: this.pastes.map((item) => ({
        start: item.start,
        end: item.end,
        chars: item.chars,
        ...(typeof item.original === 'string' ? { original: item.original } : {}),
        ...(item.collapsed === false ? { collapsed: false } : {}),
      })),
    };
  }

  getSubmissionValue() {
    const actual = Array.from(this.value);
    const segments = this.pastes
      .filter((item) => item.start >= 0 && item.end <= actual.length && item.end > item.start && typeof item.original === 'string')
      .sort((a, b) => a.start - b.start);
    const output = [];
    let cursor = 0;
    for (const segment of segments) {
      if (segment.start < cursor) continue;
      output.push(actual.slice(cursor, segment.start).join(''));
      output.push(segment.original);
      cursor = segment.end;
    }
    output.push(actual.slice(cursor).join(''));
    return output.join('');
  }

  clear() {
    this.inner.clear();
    this.pastes = [];
  }

  insert(text) {
    return this.#insert(text);
  }

  insertPaste(text) {
    const original = String(text ?? '');
    const normalized = normalizePasteText(original);
    return this.#insert(normalized, {
      paste: { original, chars: charLength(original), collapsed: charLength(original) > COLLAPSED_PASTE_THRESHOLD },
    });
  }

  insertLineBreak() {
    return this.#insert('\n');
  }

  backspace() {
    const token = this.#tokenEndingAt(this.cursor);
    if (token) return this.expandPaste(token);
    this.#expandContaining(this.cursor - 1);
    const index = this.cursor - 1;
    const changed = this.inner.backspace();
    if (changed) this.#applyDelete(index, 1);
    return changed;
  }

  deleteForward() {
    const token = this.#tokenStartingAt(this.cursor);
    if (token) return this.expandPaste(token);
    this.#expandContaining(this.cursor);
    const index = this.cursor;
    const changed = this.inner.deleteForward();
    if (changed) this.#applyDelete(index, 1);
    return changed;
  }

  move(delta) {
    const direction = Math.sign(Number(delta) || 0);
    if (!direction) return;
    if (direction < 0) {
      const token = this.#tokenEndingAt(this.cursor);
      if (token) {
        this.cursor = token.start;
        return;
      }
    } else {
      const token = this.#tokenStartingAt(this.cursor);
      if (token) {
        this.cursor = token.end;
        return;
      }
    }
    this.inner.move(direction);
    this.#snapCursor(direction);
  }

  moveWord(delta) {
    const direction = Math.sign(Number(delta) || 0);
    if (!direction) return;
    const boundary = direction < 0 ? this.#tokenEndingAt(this.cursor) : this.#tokenStartingAt(this.cursor);
    if (boundary) {
      this.cursor = direction < 0 ? boundary.start : boundary.end;
      return;
    }
    this.inner.moveWord(direction);
    this.#snapCursor(direction);
  }

  moveVertical(delta, width = Infinity) {
    return this.moveVisualVertical(delta, width);
  }

  moveVisualVertical(delta, width = Infinity) {
    const display = this.getDisplayModel();
    const temporary = new InputEditor(display.value);
    temporary.cursor = display.cursor;
    moveWrappedCursor(temporary, delta, width);
    this.cursor = display.toActual(temporary.cursor);
    return this.cursor;
  }

  canMoveVisualVertical(delta, width = Infinity) {
    const display = this.getDisplayModel();
    const lines = visualLines(display.value, width);
    const position = visualCursorPosition(display.value, display.cursor, width);
    return delta < 0 ? position.line > 0 : position.line < lines.length - 1;
  }

  lineStart() {
    const display = this.getDisplayModel();
    const temporary = new InputEditor(display.value);
    temporary.cursor = display.cursor;
    temporary.lineStart();
    this.cursor = display.toActual(temporary.cursor);
  }

  lineEnd() {
    const display = this.getDisplayModel();
    const temporary = new InputEditor(display.value);
    temporary.cursor = display.cursor;
    temporary.lineEnd();
    this.cursor = display.toActual(temporary.cursor);
  }

  home() { this.inner.home(); }
  end() { this.inner.end(); }

  killToStart() {
    this.#invalidateAllPastes();
    return this.inner.killToStart();
  }

  killToEnd() {
    this.#invalidateAllPastes();
    return this.inner.killToEnd();
  }

  deleteWordBack() {
    this.#invalidateAllPastes();
    return this.inner.deleteWordBack();
  }

  deleteWordForward() {
    this.#invalidateAllPastes();
    const chars = Array.from(this.value);
    let end = this.cursor;
    while (end < chars.length && /\s/.test(chars[end])) end += 1;
    while (end < chars.length && !/\s/.test(chars[end])) end += 1;
    if (end <= this.cursor) return false;
    chars.splice(this.cursor, end - this.cursor);
    this.inner.value = chars.join('');
    return true;
  }

  getCursorPosition(width = Infinity) {
    const display = this.getDisplayModel();
    return visualCursorPosition(display.value, display.cursor, width);
  }

  getParts() {
    const display = this.getDisplayModel();
    const chars = Array.from(display.value);
    return {
      before: chars.slice(0, display.cursor).join(''),
      current: chars[display.cursor] ?? ' ',
      after: chars.slice(display.cursor + 1).join(''),
    };
  }

  getDisplayModel() {
    const actual = Array.from(this.value);
    const collapsed = this.pastes
      .filter((item) => item.collapsed !== false && item.start >= 0 && item.end <= actual.length && item.end > item.start)
      .sort((a, b) => a.start - b.start);
    const output = [];
    const boundaries = [0];
    let actualIndex = 0;
    let displayCursor = 0;

    const appendChar = (char, nextActual) => {
      output.push(char);
      boundaries.push(nextActual);
    };

    for (const token of collapsed) {
      if (token.start < actualIndex) continue;
      while (actualIndex < token.start) {
        if (actualIndex < this.cursor) displayCursor += 1;
        appendChar(actual[actualIndex], actualIndex + 1);
        actualIndex += 1;
      }
      const label = `[pasted ${token.chars} symbols]`;
      const labelChars = Array.from(label);
      if (this.cursor >= token.end) displayCursor += labelChars.length;
      else if (this.cursor > token.start) displayCursor += 0;
      labelChars.forEach((char, index) => {
        const halfway = index + 1 >= labelChars.length / 2;
        appendChar(char, halfway ? token.end : token.start);
      });
      actualIndex = token.end;
    }

    while (actualIndex < actual.length) {
      if (actualIndex < this.cursor) displayCursor += 1;
      appendChar(actual[actualIndex], actualIndex + 1);
      actualIndex += 1;
    }

    if (this.cursor === actual.length) displayCursor = output.length;
    const value = output.join('');
    return {
      value,
      cursor: Math.max(0, Math.min(displayCursor, output.length)),
      toActual: (displayIndex) => boundaries[Math.max(0, Math.min(Number(displayIndex) || 0, boundaries.length - 1))] ?? actual.length,
    };
  }

  visualLineCount(width = Infinity) {
    return visualLines(this.getDisplayModel().value, width).length;
  }

  expandPaste(token) {
    const index = this.pastes.indexOf(token);
    if (index < 0 || token.collapsed === false) return false;
    this.pastes[index] = { ...token, collapsed: false };
    return true;
  }

  expandAllPastes() {
    const changed = this.pastes.some((item) => item.collapsed !== false);
    this.pastes = this.pastes.map((item) => ({ ...item, collapsed: false }));
    return changed;
  }

  #insert(text, { paste = null } = {}) {
    const normalized = sanitizeInsertedText(text, { multiline: Boolean(paste) || String(text ?? '').includes('\n') });
    if (!normalized) return false;
    this.#invalidateContaining(this.cursor);
    const start = this.cursor;
    const length = charLength(normalized);
    insertAtCursor(this.inner, normalized);
    this.pastes = this.pastes.map((item) => item.start >= start
      ? { ...item, start: item.start + length, end: item.end + length }
      : item);
    if (paste) this.pastes.push({
      start,
      end: start + length,
      chars: Math.max(0, Number(paste.chars) || charLength(paste.original)),
      original: String(paste.original ?? ''),
      collapsed: Boolean(paste.collapsed),
    });
    this.pastes.sort((a, b) => a.start - b.start);
    return true;
  }

  #applyDelete(index, length) {
    const end = index + length;
    this.pastes = this.pastes.flatMap((item) => {
      if (item.end <= index) return [item];
      if (item.start >= end) return [{ ...item, start: item.start - length, end: item.end - length }];
      return [];
    });
  }

  #tokenStartingAt(index) { return this.pastes.find((item) => item.collapsed !== false && item.start === index) || null; }
  #tokenEndingAt(index) { return this.pastes.find((item) => item.collapsed !== false && item.end === index) || null; }

  #expandContaining(index) {
    const token = this.pastes.find((item) => item.collapsed !== false && index > item.start && index < item.end);
    if (token) this.expandPaste(token);
  }

  #invalidateContaining(index) {
    this.pastes = this.pastes.filter((item) => !(index > item.start && index < item.end));
  }

  #invalidateAllPastes() {
    const changed = this.pastes.length > 0;
    this.pastes = [];
    return changed;
  }

  #snapCursor(direction) {
    const token = this.pastes.find((item) => item.collapsed !== false && this.cursor > item.start && this.cursor < item.end);
    if (token) this.cursor = direction < 0 ? token.start : token.end;
  }
}

export function normalizeHistoryRecord(value) {
  if (typeof value === 'string') return { text: value, pastes: [] };
  const text = String(value?.text || '');
  return { text, pastes: normalizePastes(value?.pastes, text) };
}

function normalizePastes(pastes, value) {
  const length = charLength(value);
  return Array.isArray(pastes) ? pastes
    .map((item) => {
      const normalized = {
        start: Math.max(0, Math.trunc(Number(item?.start) || 0)),
        end: Math.max(0, Math.trunc(Number(item?.end) || 0)),
        chars: Math.max(0, Math.trunc(Number(item?.chars) || 0)),
      };
      if (typeof item?.original === 'string') normalized.original = item.original;
      if (item?.collapsed === false) normalized.collapsed = false;
      return normalized;
    })
    .filter((item) => item.end > item.start && item.end <= length)
    .sort((a, b) => a.start - b.start) : [];
}

function normalizePasteText(text) {
  return sanitizeInsertedText(String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '  '), { multiline: true });
}

function sanitizeInsertedText(text, { multiline = false } = {}) {
  return Array.from(String(text ?? ''))
    .filter((char) => multiline && char === '\n' || isPrintableCharacter(char))
    .join('');
}

function isPrintableCharacter(char) {
  const code = char.codePointAt(0);
  return code != null && code >= 32 && code !== 127;
}

function insertAtCursor(editor, text) {
  const chars = Array.from(editor.value);
  const inserted = Array.from(String(text ?? ''));
  chars.splice(editor.cursor, 0, ...inserted);
  editor.value = chars.join('');
  editor.cursor += inserted.length;
}

function moveWrappedCursor(editor, delta, width) {
  const value = String(editor.value || '');
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : Number.MAX_SAFE_INTEGER;
  const position = visualCursorPosition(value, editor.cursor, safeWidth);
  const lines = visualLines(value, safeWidth);
  const targetLine = Math.max(0, Math.min(position.line + Math.sign(delta), lines.length - 1));
  const target = lines[targetLine];
  editor.cursor = target.start + Math.min(position.column, target.length);
}

function visualCursorPosition(value, cursor, width) {
  const lines = visualLines(value, width);
  const safeCursor = Math.max(0, Math.min(Number(cursor) || 0, charLength(value)));
  let selected = lines[0] || { start: 0, length: 0 };
  let line = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines[index];
    if (safeCursor <= candidate.start + candidate.length || index === lines.length - 1) {
      selected = candidate;
      line = index;
      break;
    }
  }
  return { line, column: Math.max(0, safeCursor - selected.start) };
}

function visualLines(value, width) {
  const chars = Array.from(String(value ?? ''));
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : Number.MAX_SAFE_INTEGER;
  const lines = [];
  let start = 0;
  let length = 0;
  chars.forEach((char, index) => {
    if (char === '\n') {
      lines.push({ start, length });
      start = index + 1;
      length = 0;
      return;
    }
    if (length >= safeWidth) {
      lines.push({ start, length });
      start = index;
      length = 0;
    }
    length += 1;
  });
  lines.push({ start, length });
  return lines.length ? lines : [{ start: 0, length: 0 }];
}

function clampIndex(value, text) {
  return Math.max(0, Math.min(Math.trunc(Number(value) || 0), charLength(text)));
}

function charLength(value) {
  return Array.from(String(value ?? '')).length;
}
