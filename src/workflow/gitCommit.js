import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

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

function parsePorcelainPaths(status = '') {
  const paths = [];
  const records = String(status || '').split('\0').filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const code = record.slice(0, 2);
    const value = record.slice(3);
    if (value) paths.push(value);
    if ((code.includes('R') || code.includes('C')) && records[index + 1]) {
      paths.push(records[index + 1]);
      index += 1;
    }
  }
  return Array.from(new Set(paths.map((item) => String(item).replace(/\\/g, '/')).filter(Boolean)));
}

function normalizeCommitPaths(root, paths = []) {
  const projectRoot = path.resolve(root);
  return Array.from(new Set((paths || []).map((value) => {
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(projectRoot, value);
    const relative = path.relative(projectRoot, absolute).split(path.sep).join('/');
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return '';
    return relative;
  }).filter(Boolean)));
}

async function pathOwnershipState(root, relative) {
  const absolute = path.resolve(root, relative);
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat) return { type: 'missing' };
  if (!stat.isFile()) return { type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'other' };
  const data = await fs.readFile(absolute);
  return {
    type: 'file',
    size: data.length,
    mode: stat.mode & 0o777,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

export async function captureGitPathStates(root, paths = []) {
  const states = {};
  for (const relative of normalizeCommitPaths(root, paths)) states[relative] = await pathOwnershipState(root, relative);
  return states;
}

export async function verifyGitPathStates(root, expected = {}) {
  const conflicts = [];
  for (const [relative, state] of Object.entries(expected || {})) {
    const current = await pathOwnershipState(root, relative);
    if (JSON.stringify(current) !== JSON.stringify(state)) conflicts.push({ path: relative, expected: state, current });
  }
  return { ok: conflicts.length === 0, conflicts };
}

export async function inspectGitRepository(root) {
  let insideResult;
  try {
    insideResult = await git(root, ['rev-parse', '--is-inside-work-tree']);
  } catch (error) {
    // Git localizes stderr, so never expose its translated wording as a
    // machine-facing reason. Exit code 128 is the stable signal used by
    // rev-parse when the target is not inside a repository.
    if (Number(error?.code) === 128) return { available: false, reason: 'not-a-git-repository' };
    return { available: false, reason: 'git-unavailable', detail: error?.message || String(error) };
  }
  if (insideResult.stdout.trim() !== 'true') return { available: false, reason: 'not-a-work-tree' };
  try {
    const status = (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout;
    const diff = (await git(root, ['diff', '--no-ext-diff', '--binary', '--stat'])).stdout;
    const head = (await git(root, ['rev-parse', 'HEAD']).catch(() => ({ stdout: '' }))).stdout.trim();
    const paths = parsePorcelainPaths(status);
    return { available: true, dirty: paths.length > 0, status, paths, head, diffStat: diff };
  } catch (error) {
    return { available: false, reason: 'git-inspection-failed', detail: error?.message || String(error) };
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

export async function createGitCommit({ root, message, paths = null, authorName = '', authorEmail = '' }) {
  const normalized = String(message || '').trim();
  if (!normalized) return { committed: false, reason: 'empty-message' };
  const info = await inspectGitRepository(root);
  if (!info.available) return { committed: false, reason: info.reason || 'git-unavailable' };
  if (!info.dirty) return { committed: false, reason: 'no-changes' };
  const selectedPaths = normalizeCommitPaths(root, paths == null ? info.paths : paths);
  if (!selectedPaths.length) return { committed: false, reason: 'no-workflow-changes' };
  await git(root, ['add', '-A', '--', ...selectedPaths]);
  const staged = (await git(root, ['diff', '--cached', '--name-only', '-z'])).stdout.split('\0').filter(Boolean);
  if (!staged.length) return { committed: false, reason: 'no-workflow-changes' };
  const env = { ...process.env };
  if (authorName) env.GIT_AUTHOR_NAME = authorName;
  if (authorEmail) env.GIT_AUTHOR_EMAIL = authorEmail;
  if (authorName) env.GIT_COMMITTER_NAME = authorName;
  if (authorEmail) env.GIT_COMMITTER_EMAIL = authorEmail;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-bridge-commit-'));
  const messageFile = path.join(tempDir, 'message.txt');
  try {
    await fs.writeFile(messageFile, `${normalized}\n`, 'utf8');
    const result = await git(root, ['commit', '--only', '-F', messageFile, '--', ...selectedPaths], { env });
    const sha = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    return { committed: true, sha, message: normalized, paths: staged, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    await git(root, ['reset', 'HEAD', '--', ...selectedPaths]).catch(() => {});
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}


export async function squashGitCommits({ root, baseSha, commitShas = [], message, paths = [], refName = 'workflow', authorName = '', authorEmail = '' } = {}) {
  const commits = Array.from(new Set((commitShas || []).map(String).filter(Boolean)));
  if (!baseSha || commits.length < 2) return { squashed: false, reason: commits.length < 2 ? 'not-enough-checkpoints' : 'missing-base' };
  const info = await inspectGitRepository(root);
  if (!info.available) return { squashed: false, reason: info.reason || 'git-unavailable' };
  const expectedHead = commits.at(-1);
  if (info.head !== expectedHead) return { squashed: false, reason: 'head-changed', expectedHead, actualHead: info.head };
  const actual = (await git(root, ['rev-list', '--reverse', `${baseSha}..${info.head}`])).stdout.trim().split('\n').filter(Boolean);
  if (actual.length !== commits.length || actual.some((sha, index) => sha !== commits[index])) {
    return { squashed: false, reason: 'non-workflow-commits-present', actual, expected: commits };
  }
  const safeRef = String(refName || 'workflow').replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/^[-/]+|[-/]+$/g, '') || 'workflow';
  const backupRef = `refs/bridge/workflows/${safeRef}`;
  await git(root, ['update-ref', backupRef, info.head]);
  await git(root, ['reset', '--soft', baseSha]);
  try {
    const result = await createGitCommit({ root, message, paths, authorName, authorEmail });
    if (!result.committed) throw new Error(`Final squash commit was not created: ${result.reason}`);
    return { squashed: true, baseSha, checkpointShas: commits, backupRef, ...result };
  } catch (error) {
    await git(root, ['reset', '--soft', expectedHead]).catch(() => {});
    error.backupRef = backupRef;
    throw error;
  }
}


export async function restoreGitWorkflowState({ root, baseSha, commitShas = [], paths = [], refName = 'workflow' } = {}) {
  const selectedPaths = normalizeCommitPaths(root, paths);
  if (!baseSha) return { restored: false, reason: 'missing-base' };
  if (!selectedPaths.length) return { restored: false, reason: 'no-workflow-changes' };
  const info = await inspectGitRepository(root);
  if (!info.available) return { restored: false, reason: info.reason || 'git-unavailable' };

  const commits = Array.from(new Set((commitShas || []).map(String).filter(Boolean)));
  let rewound = false;
  let backupRef = '';
  if (commits.length && info.head === commits.at(-1)) {
    const actual = (await git(root, ['rev-list', '--reverse', `${baseSha}..${info.head}`])).stdout.trim().split('\n').filter(Boolean);
    if (actual.length === commits.length && actual.every((sha, index) => sha === commits[index])) {
      const safeRef = String(refName || 'workflow').replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/^[-/]+|[-/]+$/g, '') || 'workflow';
      backupRef = `refs/bridge/workflows/${safeRef}-before-restore`;
      await git(root, ['update-ref', backupRef, info.head]);
      await git(root, ['reset', '--soft', baseSha]);
      rewound = true;
    }
  }

  for (const relative of selectedPaths) {
    const existsAtBase = await git(root, ['cat-file', '-e', `${baseSha}:${relative}`]).then(() => true, () => false);
    if (existsAtBase) {
      await git(root, ['restore', `--source=${baseSha}`, '--staged', '--worktree', '--', relative]);
    } else {
      await git(root, ['rm', '-f', '--cached', '--ignore-unmatch', '--', relative]).catch(() => {});
      await fs.rm(path.resolve(root, relative), { recursive: true, force: true });
    }
  }
  return { restored: true, baseSha, paths: selectedPaths, rewound, backupRef };
}
