import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

async function git(root, args, options = {}) {
  return await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...options });
}

export function extractMarkedBlock(text, beginMarker, endMarker) {
  const source = String(text || '');
  const begin = source.indexOf(beginMarker);
  if (begin < 0) return '';
  const contentStart = begin + beginMarker.length;
  const end = source.indexOf(endMarker, contentStart);
  if (end < 0) return '';
  return source.slice(contentStart, end).trim();
}

export async function inspectGitRepository(root) {
  try {
    const inside = (await git(root, ['rev-parse', '--is-inside-work-tree'])).stdout.trim() === 'true';
    if (!inside) return { available: false, reason: 'not-a-work-tree' };
    const status = (await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
    const diff = (await git(root, ['diff', '--no-ext-diff', '--binary', '--stat'])).stdout;
    return { available: true, dirty: Boolean(status.trim()), status, diffStat: diff };
  } catch (error) {
    return { available: false, reason: error.message };
  }
}

export async function buildCommitContext(root, targetFile, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const status = (await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
  const stat = (await git(root, ['diff', '--no-ext-diff', '--stat', 'HEAD'])).stdout;
  const diff = (await git(root, ['diff', '--no-ext-diff', '--unified=3', 'HEAD'])).stdout;
  const untrackedRaw = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout;
  const untrackedSections = [];
  for (const rel of untrackedRaw.split('\0').filter(Boolean)) {
    const absolute = path.resolve(root, rel);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) continue;
    const statInfo = await fs.lstat(absolute).catch(() => null);
    if (!statInfo?.isFile()) continue;
    const data = await fs.readFile(absolute).catch(() => null);
    if (!data) continue;
    const binary = data.subarray(0, Math.min(data.length, 8_192)).includes(0);
    if (binary) {
      untrackedSections.push(`## ${relative}\n[binary file: ${data.length} bytes]`);
      continue;
    }
    const perFileLimit = 128 * 1024;
    const body = data.length > perFileLimit
      ? `${data.subarray(0, perFileLimit).toString('utf8')}\n[untracked file truncated: ${data.length} bytes]`
      : data.toString('utf8');
    untrackedSections.push(`## ${relative}\n${body}`);
  }
  const full = [
    '# Git status',
    status,
    '# Diff stat',
    stat,
    '# Tracked diff',
    diff,
    '# Untracked files',
    untrackedSections.length ? untrackedSections.join('\n\n') : '(none)',
  ].join('\n\n');
  const limit = Math.max(32_768, Number(maxBytes) || 2 * 1024 * 1024);
  let content = full;
  let truncated = false;
  if (Buffer.byteLength(full) > limit) {
    const marker = '\n\n# Context truncated by ChatGPT Browser Bridge\n';
    const budget = Math.max(0, limit - Buffer.byteLength(marker));
    content = Buffer.from(full).subarray(0, budget).toString('utf8') + marker;
    truncated = true;
  }
  await fs.mkdir(path.dirname(targetFile), { recursive: true });
  await fs.writeFile(targetFile, content, 'utf8');
  return {
    targetFile,
    status,
    stat,
    untrackedFiles: untrackedSections.length,
    bytes: Buffer.byteLength(content),
    originalBytes: Buffer.byteLength(full),
    truncated,
  };
}

export async function createGitCommit({ root, message, authorName = '', authorEmail = '' }) {
  const normalized = String(message || '').trim();
  if (!normalized) return { committed: false, reason: 'empty-message' };
  const info = await inspectGitRepository(root);
  if (!info.available) return { committed: false, reason: info.reason || 'git-unavailable' };
  if (!info.dirty) return { committed: false, reason: 'no-changes' };
  await git(root, ['add', '-A']);
  const env = { ...process.env };
  if (authorName) env.GIT_AUTHOR_NAME = authorName;
  if (authorEmail) env.GIT_AUTHOR_EMAIL = authorEmail;
  if (authorName) env.GIT_COMMITTER_NAME = authorName;
  if (authorEmail) env.GIT_COMMITTER_EMAIL = authorEmail;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-bridge-commit-'));
  const messageFile = path.join(tempDir, 'message.txt');
  try {
    await fs.writeFile(messageFile, `${normalized}\n`, 'utf8');
    const result = await git(root, ['commit', '-F', messageFile], { env });
    const sha = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    return { committed: true, sha, message: normalized, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    await git(root, ['reset', '--mixed', 'HEAD']).catch(() => {});
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
