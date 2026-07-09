function safeBlockPath(name = '') {
  const raw = String(name || '').trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw.includes('\0')) return '';
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return '';
  if (/^[a-zA-Z]:/.test(parts[0])) return '';
  if (parts[0] === '.git' || parts.includes('node_modules')) return '';
  return parts.join('/');
}

export function extractFileBlocks(answer = '') {
  const text = String(answer || '');
  const blocks = [];
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(text))) {
    const info = String(match[1] || '').trim();
    const body = String(match[2] || '').replace(/\n$/, '');
    const fileMatch = info.match(/^(?:file|path)\s*:\s*(.+)$/i) || info.match(/^([^\s`]+\.[A-Za-z0-9._-]{1,12})$/);
    if (!fileMatch) continue;
    const name = safeBlockPath(fileMatch[1]);
    if (!name) continue;
    blocks.push({ name, data: Buffer.from(body, 'utf8') });
  }
  return blocks;
}
