const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit',
  '.cache', '.turbo', '.parcel-cache', '.vite', '.gradle', '.idea', '.vs',
  'bin', 'obj', 'target', 'venv', '.venv', '__pycache__', '__MACOSX', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', '.tox', '.eggs', '.terraform', '.serverless',
]);

const DEFAULT_EXCLUDED_FILES = [
  '.DS_Store', '._*', 'Thumbs.db', '*.log', '*.tmp', '*.temp', '*.swp', '*.swo',
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.sqlite', '*.sqlite3',
  '*.db', '*.dump', '*.bak', '*.zip', '*.tar', '*.tgz', '*.gz', '*.7z', '*.rar',
];

function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const source = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${source}$`);
}

export function parseIgnoreFile(content = '') {
  const rules = [];
  for (const raw of String(content).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1).trim();
    }
    if (!line) continue;
    rules.push({ pattern: line.replace(/^\//, ''), negated, directoryOnly: line.endsWith('/') });
  }
  return rules;
}

export function matchSimpleGlob(pattern, rel, isDir) {
  let source = pattern.replace(/\\/g, '/').replace(/\/$/, '');
  const target = rel.replace(/\\/g, '/');
  if (!source) return false;
  if (pattern.endsWith('/') && !isDir) return false;
  if (!/[/*?]/.test(source)) return target === source || target.split('/').includes(source);
  if (!source.includes('/')) return target.split('/').some((segment) => globToRegExp(source).test(segment));
  return globToRegExp(source).test(target);
}

export function isDefaultIgnored(rel, isDir) {
  const target = rel.replace(/\\/g, '/');
  const segments = target.split('/').filter(Boolean);
  if (segments.some((segment) => DEFAULT_EXCLUDED_DIRS.has(segment))) return true;
  if (isDir && DEFAULT_EXCLUDED_DIRS.has(segments.at(-1))) return true;
  return DEFAULT_EXCLUDED_FILES.some((pattern) => matchSimpleGlob(pattern, target, isDir));
}

export function isIgnoredByRules(rel, isDir, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDir) continue;
    if (matchSimpleGlob(rule.pattern, rel, isDir)) ignored = !rule.negated;
  }
  return ignored;
}
