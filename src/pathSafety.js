import fs from 'node:fs/promises';
import path from 'node:path';

function makePathError(code, message, details = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, details);
  return err;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve a project-relative path while rejecting existing symlink components.
 * The root itself is treated as the trusted boundary and may itself resolve
 * through a symlink; descendants must remain beneath its real path.
 */
export async function resolveSafeDescendant(rootPath, relativePath, options = {}) {
  const root = path.resolve(String(rootPath || ''));
  const rel = String(relativePath || '').replace(/\\/g, '/');
  const absolute = path.resolve(root, rel);
  if (!isInside(root, absolute)) {
    throw makePathError(
      options.code || 'UNSAFE_TARGET_PATH',
      `Unsafe target path outside root: ${relativePath}`,
      { root, relativePath: rel, absolutePath: absolute },
    );
  }

  const rootReal = await fs.realpath(root).catch((err) => {
    if (err?.code === 'ENOENT') return '';
    throw err;
  });
  if (!rootReal) return absolute;

  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = await fs.lstat(current).catch((err) => {
      if (err?.code === 'ENOENT') return null;
      throw err;
    });
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw makePathError(
        options.symlinkCode || 'UNSAFE_SYMLINK_PATH',
        `Refusing to access path through symlink: ${path.relative(root, current) || '.'}`,
        { root, relativePath: rel, absolutePath: absolute, symlinkPath: current },
      );
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw makePathError(
        options.code || 'UNSAFE_TARGET_PATH',
        `Target path has a non-directory parent: ${path.relative(root, current)}`,
        { root, relativePath: rel, absolutePath: absolute, parentPath: current },
      );
    }
    const currentReal = await fs.realpath(current);
    if (!isInside(rootReal, currentReal)) {
      throw makePathError(
        options.code || 'UNSAFE_TARGET_PATH',
        `Resolved target path escapes root: ${relativePath}`,
        { root, rootReal, relativePath: rel, absolutePath: absolute, resolvedPath: currentReal },
      );
    }
  }
  return absolute;
}
