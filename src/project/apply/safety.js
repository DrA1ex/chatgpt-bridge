import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function previewLines(text, limit = 20) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit);
}

async function git(root, args) {
  return await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
}

export async function checkProjectApplySafety(projectRoot) {
  const root = path.resolve(projectRoot || '');
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Project path is not a directory: ${root}`);

  const warnings = [];
  let gitInfo = { available: false, root: '', dirty: false, dirtyCount: 0, dirtyPreview: [] };

  try {
    const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
    if (inside.stdout.trim() !== 'true') throw new Error('not inside work tree');
    const topLevel = await git(root, ['rev-parse', '--show-toplevel']);
    const status = await git(root, ['status', '--porcelain', '--untracked-files=all']);
    const dirtyPreview = previewLines(status.stdout, 25);
    gitInfo = {
      available: true,
      root: topLevel.stdout.trim(),
      dirty: dirtyPreview.length > 0,
      dirtyCount: dirtyPreview.length,
      dirtyPreview,
    };
    if (gitInfo.dirty) {
      warnings.push({
        code: 'DIRTY_WORKTREE',
        message: `Git worktree has uncommitted changes (${gitInfo.dirtyCount} shown). Applying a ZIP result may overwrite local work.`,
        preview: dirtyPreview,
      });
    }
  } catch (err) {
    warnings.push({
      code: 'NO_GIT_OR_GIT_STATUS_FAILED',
      message: `Could not confirm a clean git worktree for this project. ${err.message || err}`,
    });
  }

  return {
    ok: true,
    projectRoot: root,
    safe: warnings.length === 0,
    warnings,
    git: gitInfo,
  };
}
