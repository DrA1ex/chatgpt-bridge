import fs from 'node:fs/promises';
import path from 'node:path';

async function statFile(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    return stat?.isFile() && !stat.isSymbolicLink() ? stat : null;
  } catch {
    return null;
  }
}

function downloadConflictCandidates(filePath = '', preferredName = '') {
  const absolute = path.resolve(String(filePath || ''));
  const dir = path.dirname(absolute);
  const baseName = path.basename(absolute);
  const names = new Set([baseName]);
  if (preferredName) names.add(path.basename(String(preferredName)));
  const patterns = [];
  for (const name of names) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    if (!stem) continue;
    patterns.push({ stem, ext });
  }
  return { dir, patterns };
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function fileCreationTimestamp(stat = {}) {
  return Number(stat.birthtimeMs) || Number(stat.ctimeMs) || Number(stat.mtimeMs) || 0;
}

function newestFileTimestamp(stat = {}) {
  return Math.max(fileCreationTimestamp(stat), Number(stat.mtimeMs) || 0);
}

function capturedDownloadWindow(identity = {}, now = Date.now()) {
  const startedAt = Math.max(
    timestampMs(identity.browserDownloadStartTime),
    timestampMs(identity.browserCaptureStartedAt),
  );
  const capturedAt = Math.max(
    timestampMs(identity.browserDownloadEndTime),
    timestampMs(identity.browserCapturedAt),
    startedAt,
  );
  // Browser/FS timestamps can differ slightly, but a captured E2E artifact
  // should never resolve to a file that predates the active capture by minutes.
  return {
    minMs: startedAt ? startedAt - 5_000 : now - 120_000,
    maxMs: Math.max(now + 5_000, capturedAt + 5_000),
  };
}

function statIdentity(stat = {}) {
  return {
    dev: Number(stat.dev) || 0,
    ino: Number(stat.ino) || 0,
    size: Number(stat.size) || 0,
    birthtimeMs: Number(stat.birthtimeMs) || 0,
    ctimeMs: Number(stat.ctimeMs) || 0,
    mtimeMs: Number(stat.mtimeMs) || 0,
  };
}

function sameStatIdentity(left = {}, right = {}) {
  if (left.dev && right.dev && left.dev !== right.dev) return false;
  if (left.ino && right.ino && left.ino !== right.ino) return false;
  return left.size === right.size
    && left.birthtimeMs === right.birthtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.mtimeMs === right.mtimeMs;
}

function normalizeConflictDownloadName(value = '') {
  return path.basename(String(value || '')).toLowerCase().replace(/ \([0-9]+\)(?=\.[^.]+$|$)/, '');
}

function validateCapturedDownloadCandidate(candidatePath, stat, identity = {}) {
  const absolute = path.resolve(candidatePath);
  const actualName = path.basename(absolute);
  const capturedActualName = String(identity.browserActualName || '').trim();
  if (capturedActualName && normalizeConflictDownloadName(actualName) !== normalizeConflictDownloadName(capturedActualName)) {
    return { ok: false, reason: `name mismatch (${actualName} != ${capturedActualName})` };
  }
  const expectedSize = Number(identity.size) || 0;
  if (expectedSize && Number(stat.size) !== expectedSize) {
    return { ok: false, reason: `size mismatch (${stat.size} != ${expectedSize})` };
  }
  const { minMs, maxMs } = capturedDownloadWindow(identity);
  const createdAt = fileCreationTimestamp(stat);
  if (!createdAt || createdAt < minMs || createdAt > maxMs) {
    return { ok: false, reason: `file creation timestamp ${createdAt || 0} is outside capture window ${minMs}-${maxMs}` };
  }
  return {
    ok: true,
    path: absolute,
    stat,
    statIdentity: statIdentity(stat),
    minMs,
    maxMs,
    captureIdentity: {
      captureSource: String(identity.captureSource || ''),
      downloadId: identity.downloadId ?? null,
      browserCaptureStartedAt: Number(identity.browserCaptureStartedAt) || 0,
      browserCapturedAt: Number(identity.browserCapturedAt) || 0,
      browserActualName: capturedActualName,
    },
  };
}

export async function resolveBrowserDownloadedPath(filePath = '', preferredName = '', identity = {}) {
  const rawPath = String(filePath || '');
  if (!rawPath || !path.isAbsolute(rawPath)) throw new Error('Captured browser download path is missing or not absolute');
  const absolute = path.resolve(rawPath);
  const exactStat = await statFile(absolute);
  if (exactStat) {
    const exact = validateCapturedDownloadCandidate(absolute, exactStat, identity);
    if (!exact.ok) throw new Error(`Captured browser download failed safety validation at ${absolute}: ${exact.reason}`);
    return { ...exact, resolution: 'exact' };
  }

  const { dir, patterns } = downloadConflictCandidates(absolute, preferredName);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    throw new Error(`Captured browser download is not readable at the exact path: ${absolute}`);
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const matched = patterns.some(({ stem, ext }) => {
      if (name === `${stem}${ext}`) return true;
      const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedExt = ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^${escapedStem} \\([0-9]+\\)${escapedExt}$`).test(name);
    });
    if (!matched) continue;
    const candidatePath = path.join(dir, name);
    const stat = await statFile(candidatePath);
    if (!stat) continue;
    const checked = validateCapturedDownloadCandidate(candidatePath, stat, identity);
    if (checked.ok) candidates.push(checked);
  }

  candidates.sort((a, b) => newestFileTimestamp(b.stat) - newestFileTimestamp(a.stat) || b.stat.size - a.stat.size);
  if (candidates.length !== 1) {
    throw new Error(`Could not safely resolve captured browser download ${absolute}: ${candidates.length} fresh matching files`);
  }
  return { ...candidates[0], resolution: 'conflict-name' };
}

export async function removeCapturedBrowserDownload(resolved = {}) {
  const rawPath = String(resolved.path || '');
  if (!rawPath || !path.isAbsolute(rawPath) || !resolved.statIdentity) {
    return { removed: false, reason: 'missing_resolved_identity' };
  }
  const absolute = path.resolve(rawPath);
  const capture = resolved.captureIdentity || {};
  if (capture.captureSource !== 'chrome-downloads') return { removed: false, reason: 'untrusted_capture_source', path: absolute };
  if (capture.downloadId == null || !capture.browserCaptureStartedAt || !capture.browserActualName) {
    return { removed: false, reason: 'incomplete_browser_download_identity', path: absolute };
  }
  if (normalizeConflictDownloadName(path.basename(absolute)) !== normalizeConflictDownloadName(capture.browserActualName)) {
    return { removed: false, reason: 'captured_name_changed', path: absolute };
  }
  const current = await statFile(absolute);
  if (!current) return { removed: true, reason: 'already_missing', path: absolute };
  if (!sameStatIdentity(resolved.statIdentity, statIdentity(current))) {
    return { removed: false, reason: 'identity_changed_after_import', path: absolute };
  }
  await fs.unlink(absolute);
  return { removed: true, reason: 'captured_source_deleted', path: absolute };
}

