export function posixPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

export function normalizeRel(value) {
  return posixPath(value)
    .replace(/^\/+/, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

export function isProtectedApplyPath(rel) {
  const parts = normalizeRel(rel).split('/').filter(Boolean);
  if (!parts.length) return 'empty-path';
  if (parts[0] === '.git') return 'git-internals';
  if (parts[0] === '.bridge') return 'bridge-metadata';
  if (parts.length === 1 && parts[0] === '.gitignore') return 'project-gitignore';
  if (parts.includes('node_modules')) return 'node_modules';
  return '';
}

export function normalizeSelectedSet(value) {
  if (!value) return null;
  if (value instanceof Set) return new Set(Array.from(value).map(normalizeRel).filter(Boolean));
  if (Array.isArray(value)) return new Set(value.map(normalizeRel).filter(Boolean));
  if (typeof value === 'object') {
    return new Set(
      Object.entries(value)
        .filter(([, selected]) => selected)
        .map(([rel]) => normalizeRel(rel))
        .filter(Boolean),
    );
  }
  return null;
}
