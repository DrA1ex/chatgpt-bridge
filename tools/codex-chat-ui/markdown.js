// Safe local Markdown subset: only generated HTML tags, escaped text and
// attributes, HTTP(S) links. No remote scripts or raw HTML.
const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function safeLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function inline(source, depth = 0) {
  if (depth > 8) return escape(source);
  const pattern = /(\x60+)([^\n]*?)\1|\[([^\]\n]+)\]\(([^)\s]+)\)|(\*\*|__)(.+?)\5|(\*|_)([^*\n_]+)\7|~~(.+?)~~/g;
  let result = '';
  let end = 0;
  for (const match of source.matchAll(pattern)) {
    result += escape(source.slice(end, match.index));
    if (match[1]) result += '<code>' + escape(match[2]) + '</code>';
    else if (match[3]) {
      const href = safeLink(match[4]);
      result += href ? '<a href="' + escape(href) + '" target="_blank" rel="noopener noreferrer">' + inline(match[3], depth + 1) + '</a>' : escape(match[0]);
    } else if (match[5]) result += '<strong>' + inline(match[6], depth + 1) + '</strong>';
    else if (match[7]) result += '<em>' + inline(match[8], depth + 1) + '</em>';
    else result += '<del>' + inline(match[9], depth + 1) + '</del>';
    end = match.index + match[0].length;
  }
  return result + escape(source.slice(end));
}

const listItem = /^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/;
const heading = /^(#{1,6})\s+(.+)$/;
const fence = /^\s{0,3}(\x60{3,}|~{3,})(.*)$/;
const rule = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const cells = line => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
const isTable = (line, separator) => line?.includes('|') && separator?.includes('|') &&
  cells(separator).every(cell => /^:?-{3,}:?$/.test(cell)) &&
  cells(line).length === cells(separator).length;

export function renderMarkdown(value, depth = 0) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  if (depth > 8) return '<p>' + escape(value) + '</p>';
  const blocks = [];
  let i = 0;
  const boundary = index => !lines[index]?.trim() || fence.test(lines[index]) || heading.test(lines[index])
    || rule.test(lines[index]) || listItem.test(lines[index]) || /^\s*>/.test(lines[index])
    || isTable(lines[index], lines[index + 1]);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const opening = line.match(fence);
    if (opening) {
      const code = [];
      i++;
      while (i < lines.length) {
        const closing = lines[i].match(fence);
        if (closing && closing[1][0] === opening[1][0] && closing[1].length >= opening[1].length && !closing[2].trim()) { i++; break; }
        code.push(lines[i++]);
      }
      blocks.push('<pre><code>' + escape(code.join('\n')) + '</code></pre>');
    } else if (heading.test(line)) {
      const [, marks, title] = line.match(heading);
      blocks.push('<h' + marks.length + '>' + inline(title) + '</h' + marks.length + '>');
      i++;
    } else if (rule.test(line)) { blocks.push('<hr>'); i++; }
    else if (isTable(line, lines[i + 1])) {
      const header = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const row = cells(lines[i++]);
        rows.push('<tr>' + header.map((_, j) => '<td>' + inline(row[j] || '') + '</td>').join('') + '</tr>');
      }
      blocks.push('<div class="md-table"><table><thead><tr>' + header.map(cell => '<th>' + inline(cell) + '</th>').join('') +
        '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>');
    } else if (listItem.test(line)) {
      const ordered = /^\d/.test(line.match(listItem)[1]);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (i < lines.length) {
        const match = lines[i].match(listItem);
        if (!match || /^\d/.test(match[1]) !== ordered) break;
        items.push('<li>' + inline(match[2]) + '</li>');
        i++;
      }
      blocks.push('<' + tag + '>' + items.join('') + '</' + tag + '>');
    } else if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push('<blockquote>' + renderMarkdown(quote.join('\n'), depth + 1) + '</blockquote>');
    } else {
      const paragraph = [line];
      i++;
      while (i < lines.length && !boundary(i)) paragraph.push(lines[i++]);
      blocks.push('<p>' + paragraph.map(part => inline(part)).join('<br>') + '</p>');
    }
  }
  return blocks.join('\n');
}
