import path from 'node:path';

const TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml',
  '.py', '.go', '.rs', '.php', '.rb', '.java', '.kt', '.kts', '.swift', '.c', '.h',
  '.cpp', '.hpp', '.cs', '.css', '.scss', '.html', '.vue', '.svelte', '.sh', '.zsh',
  '.bash', '.ps1', '.sql', '.toml', '.ini', '.env', '.txt', '.xml', '.gradle',
]);

export function isLikelyTextFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  const base = path.basename(file).toLowerCase();
  return ['dockerfile', 'makefile', 'gemfile', 'rakefile', 'license', 'readme', 'changelog'].includes(base);
}

export function detectSymbols(rel, text) {
  const patterns = [
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
    /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=]*?\)?\s*=>/,
    /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^export\s+default\s+(?:async\s+)?function\s*([A-Za-z_$][\w$]*)?/,
    /^def\s+([A-Za-z_][\w]*)\s*\(/,
    /^class\s+([A-Za-z_][\w]*)\s*[:(]/,
    /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/,
    /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/,
    /^(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/,
    /^(?:public|private|protected|static|final|abstract|\s)*\s*(?:class|interface|enum)\s+([A-Za-z_][\w]*)/,
    /^function\s+([A-Za-z_][\w]*)\s*\(/,
  ];
  const lines = String(text || '').split(/\r?\n/);
  const raw = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        raw.push({ file: rel, name: match[1] || 'default', lineStart: i + 1, signature: line.slice(0, 180) });
        break;
      }
    }
  }
  for (let i = 0; i < raw.length; i += 1) raw[i].lineEnd = raw[i + 1] ? Math.max(raw[i].lineStart, raw[i + 1].lineStart - 1) : lines.length;
  return raw;
}
