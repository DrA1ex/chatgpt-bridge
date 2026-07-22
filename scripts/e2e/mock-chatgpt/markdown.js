function inlineCodeSpans(text = '') {
  const values = [];
  const source = String(text || '');
  for (const match of source.matchAll(/``\s*([^\n]*?)\s*``|`([^`\n]+)`/g)) values.push(match[1] ?? match[2] ?? '');
  return values;
}

export function markdownProjection(markdown = '') {
  const source = String(markdown || '').replace(/\r\n/g, '\n').trim();
  const blocks = [];
  const codeBlocks = [];
  const lines = source.split('\n');
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join('\n').trim();
    if (text) blocks.push({ type: 'paragraph', markdown: text, text, inlineCode: inlineCodeSpans(text) });
    paragraph = [];
  };
  for (let index = 0; index < lines.length;) {
    const fence = lines[index].match(/^(`{3,})([^`]*)$/);
    if (fence) {
      flushParagraph();
      const marker = fence[1];
      const language = String(fence[2] || '').trim().toLowerCase();
      index += 1;
      const content = [];
      while (index < lines.length && !lines[index].startsWith(marker)) content.push(lines[index++]);
      if (index < lines.length) index += 1;
      const code = content.join('\n');
      const block = { type: 'code_block', markdown: `${marker}${language}\n${code}\n${marker}`, language, code };
      blocks.push(block);
      codeBlocks.push({ language, code });
      continue;
    }
    if (!lines[index].trim()) flushParagraph();
    else paragraph.push(lines[index]);
    index += 1;
  }
  flushParagraph();
  return {
    blocks,
    codeBlocks,
    parserAudit: {
      coverage: {
        contentLeaves: Math.max(1, blocks.length),
        interfaceLeaves: 0,
        artifactLeaves: 0,
        reasoningLeaves: 0,
        unknownLeaves: 0,
        unknownVisualElements: 0,
        duplicateLeaves: 0,
        coveragePercent: 100,
      },
      unknownItems: [],
    },
  };
}
