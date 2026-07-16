import fs from 'node:fs/promises';
import path from 'node:path';
import { writeZip } from '../../zipWriter.js';

function normalizeRelative(value = '') {
  return String(value).split(path.sep).join('/');
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function tail(filePath, maxBytes = 24_000) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, Math.max(0, stat.size - size));
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function writeAutomationSummary({ reportDir, cycle, validation, workflowId, automationId }) {
  const sections = [];
  for (const result of validation.results || []) {
    const stderr = await tail(result.stderrPath).catch(() => '');
    const stdout = await tail(result.stdoutPath).catch(() => '');
    sections.push([
      `## Step ${result.index + 1}: ${result.name || result.id || result.command}`,
      '',
      `\`${result.command}\``,
      '',
      `- Result: **${result.ok ? 'passed' : 'failed'}**`,
      `- Working directory: \`${result.cwd}\``,
      `- Exit code: ${result.code ?? '(none)'}`,
      `- Signal: ${result.signal || '(none)'}`,
      `- Timed out: ${result.timedOut ? 'yes' : 'no'}`,
      `- Aborted: ${result.aborted ? 'yes' : 'no'}`,
      `- Duration: ${result.durationMs} ms`,
      '',
      '### stderr tail',
      '',
      '```text',
      stderr,
      '```',
      '',
      '### stdout tail',
      '',
      '```text',
      stdout,
      '```',
    ].join('\n'));
  }
  const summary = [
    '# Workflow automation diagnostics',
    '',
    `- Workflow: \`${workflowId}\``,
    `- Automation run: \`${automationId}\``,
    `- Cycle: ${cycle}`,
    `- Result: **${validation.ok ? 'passed' : 'failed'}**`,
    `- Steps run: ${(validation.results || []).length}`,
    `- Failed steps: ${(validation.failed || []).length}`,
    '',
    sections.join('\n\n'),
    '',
  ].join('\n');
  const summaryPath = path.join(reportDir, 'SUMMARY.md');
  await fs.writeFile(summaryPath, summary, 'utf8');
  return { summary, summaryPath };
}

async function copyIncludedFile({ source, destination, state }) {
  const stat = await fs.stat(source);
  if (!stat.isFile()) return;
  if (state.bytes + stat.size > state.maxBytes) {
    state.skipped.push({ path: source, reason: 'max-included-bytes', size: stat.size });
    return;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  state.bytes += stat.size;
  state.files += 1;
}

async function copyIncludedTree({ source, destination, state, excludedRoot }) {
  if (excludedRoot && isInside(excludedRoot, source)) {
    state.skipped.push({ path: source, reason: 'current-report-directory' });
    return;
  }
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    state.skipped.push({ path: source, reason: 'symlink' });
    return;
  }
  if (stat.isFile()) {
    await copyIncludedFile({ source, destination, state });
    return;
  }
  if (!stat.isDirectory()) {
    state.skipped.push({ path: source, reason: 'unsupported-type' });
    return;
  }
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    await copyIncludedTree({
      source: path.join(source, entry.name),
      destination: path.join(destination, entry.name),
      state,
      excludedRoot,
    });
  }
}

export async function collectAutomationDiagnostics({ projectRoot, reportDir, include = [], maxIncludedBytes }) {
  const collectionRoot = path.join(reportDir, 'collected');
  const state = { bytes: 0, files: 0, maxBytes: Math.max(1, Number(maxIncludedBytes) || 1), skipped: [], included: [] };
  for (const configured of include) {
    const source = path.resolve(projectRoot, configured);
    if (!isInside(projectRoot, source)) {
      state.skipped.push({ path: configured, reason: 'outside-project-root' });
      continue;
    }
    if (isInside(reportDir, source)) {
      state.skipped.push({ path: configured, reason: 'current-report-directory' });
      continue;
    }
    const stat = await fs.lstat(source).catch(() => null);
    if (!stat) {
      state.skipped.push({ path: configured, reason: 'missing' });
      continue;
    }
    const relative = normalizeRelative(path.relative(projectRoot, source));
    const destination = relative ? path.join(collectionRoot, ...relative.split('/')) : collectionRoot;
    await copyIncludedTree({ source, destination, state, excludedRoot: reportDir });
    state.included.push({ path: relative || '.', type: stat.isDirectory() ? 'directory' : 'file' });
  }
  const manifest = {
    projectRoot,
    collectedAt: new Date().toISOString(),
    files: state.files,
    bytes: state.bytes,
    included: state.included,
    skipped: state.skipped,
  };
  await fs.writeFile(path.join(reportDir, 'collected.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

async function collectFiles(root, current, output, excluded) {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = normalizeRelative(path.relative(root, absolute));
    if (!relative || excluded.has(relative)) continue;
    if (entry.isDirectory()) await collectFiles(root, absolute, output, excluded);
    else if (entry.isFile()) output.push({ name: relative, path: absolute });
  }
}

export async function createAutomationBundle({ reportDir, bundlePath }) {
  const entries = [];
  const excluded = new Set([normalizeRelative(path.relative(reportDir, bundlePath))]);
  await collectFiles(reportDir, reportDir, entries, excluded);
  if (!entries.length) throw new Error(`Automation report has no files: ${reportDir}`);
  await fs.mkdir(path.dirname(bundlePath), { recursive: true });
  const result = await writeZip(bundlePath, entries, { compression: 'deflate', compressionLevel: 6 });
  const stat = await fs.stat(bundlePath);
  return { ...result, bundlePath, size: stat.size, entries: entries.length };
}

export async function pruneAutomationReports(reportRoot, keepReports) {
  const entries = await fs.readdir(reportRoot, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
    const absolute = path.join(reportRoot, entry.name);
    const stat = await fs.stat(absolute).catch(() => null);
    if (stat) candidates.push({ absolute, mtimeMs: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of candidates.slice(Math.max(1, keepReports))) {
    await fs.rm(stale.absolute, { recursive: true, force: true });
  }
}
