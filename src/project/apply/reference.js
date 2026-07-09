import { isProtectedApplyPath, normalizeRel } from './pathPolicy.js';

function collectReferenceSources(options = {}) {
  const sources = [];
  if (Array.isArray(options.referenceFiles)) sources.push(...options.referenceFiles);
  if (Array.isArray(options.referenceManifest?.files)) sources.push(...options.referenceManifest.files);
  if (Array.isArray(options.referenceSnapshot?.files)) sources.push(...options.referenceSnapshot.files);
  return sources;
}

export function normalizeReferenceFiles(options = {}) {
  const files = [];
  const seen = new Set();
  for (const item of collectReferenceSources(options)) {
    const rel = normalizeRel(typeof item === 'string' ? item : item?.path || item?.targetPath || '');
    if (!rel || seen.has(rel) || isProtectedApplyPath(rel)) continue;
    seen.add(rel);
    files.push(rel);
  }
  return files.sort();
}

export function referenceFileMap(options = {}) {
  const map = new Map();
  for (const item of collectReferenceSources(options)) {
    const rel = normalizeRel(typeof item === 'string' ? item : item?.path || item?.targetPath || '');
    if (!rel || isProtectedApplyPath(rel) || map.has(rel)) continue;
    map.set(rel, {
      path: rel,
      sha256: typeof item === 'object' && item?.sha256 ? String(item.sha256) : '',
      size: typeof item === 'object' && Number.isFinite(Number(item?.size)) ? Number(item.size) : undefined,
      mtimeMs: typeof item === 'object' && Number.isFinite(Number(item?.mtimeMs)) ? Number(item.mtimeMs) : undefined,
    });
  }
  return map;
}
